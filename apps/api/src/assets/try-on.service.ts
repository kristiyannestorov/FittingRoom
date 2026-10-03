import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import { Agent, FormData as UndiciFormData, fetch as undiciFetch } from 'undici';
import {
  garmentSlotForProductType,
  garmentSlotsConflict,
  type ProductType,
  type TryOnPieceInput,
  type TryOnStatus,
  type TryOnStatusView,
} from '@zed/contracts';
import type { Env } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { QueueService } from '../queue/queue.service';
import { JOB, QUEUE } from '../queue/queue.constants';

export const TRY_ON_CONTENT_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

export const TRY_ON_PRODUCT_TYPES = new Set([
  'T_SHIRT',
  'LONG_SLEEVE',
  'HOODIE',
  'SHORTS',
  'PANTS',
  'DRESS',
]);

const TRY_ON_TTL_SECONDS = 60 * 60;

const TRY_ON_TIMEOUT_MS = 60 * 60_000;

const NO_TIMEOUT_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export interface TryOnPhoto {
  buffer: Buffer;
  contentType: string;
}

interface TryOnGarment {
  key: string;
  productType: string;
}

interface TryOnGarmentSource {
  imageKeys: string[];
  thumbnailKey: string | null;
  variants: { id: string; thumbnailKey: string | null }[];
  garment3D: { sourceKeys: string[] } | null;
}

export function tryOnGarmentKey(product: TryOnGarmentSource, variantId?: string): string | null {
  const variant = variantId ? product.variants.find((v) => v.id === variantId) : undefined;
  return (
    variant?.thumbnailKey ??
    product.imageKeys[0] ??
    product.thumbnailKey ??
    product.garment3D?.sourceKeys[0] ??
    null
  );
}

class TryOnRejectedError extends Error {}

const keys = {
  meta: (id: string) => `try-on:${id}`,
  photo: (id: string) => `try-on:${id}:photo`,
  result: (id: string) => `try-on:${id}:result`,
};

@Injectable()
export class TryOnService {
  private readonly logger = new Logger(TryOnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService<Env, true>,
    private readonly queue: QueueService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async start(pieces: TryOnPieceInput[], photo: TryOnPhoto): Promise<TryOnStatusView> {
    if (!TRY_ON_CONTENT_TYPES.has(photo.contentType)) {
      throw new BadRequestException('Send a JPEG, PNG or WebP photo');
    }
    if (new Set(pieces.map((piece) => piece.slug)).size !== pieces.length) {
      throw new BadRequestException('Each piece can only be tried on once');
    }

    const garments = await Promise.all(pieces.map((piece) => this.garmentFor(piece)));
    garments.forEach((a, i) =>
      garments.slice(i + 1).forEach((b) => {
        const [slotA, slotB] = [a, b].map((g) => garmentSlotForProductType(g.productType));
        if (garmentSlotsConflict(slotA, slotB)) {
          throw new BadRequestException(
            `${a.name} and ${b.name} are worn in the same place, try them on one at a time`,
          );
        }
      }),
    );

    const id = randomBytes(18).toString('base64url');
    const stored: TryOnGarment[] = garments.map(({ key, productType }) => ({ key, productType }));
    await this.redis
      .multi()
      .hset(keys.meta(id), {
        status: 'queued',
        garments: JSON.stringify(stored),
        contentType: photo.contentType,
      })
      .expire(keys.meta(id), TRY_ON_TTL_SECONDS)
      .set(keys.photo(id), photo.buffer, 'EX', TRY_ON_TTL_SECONDS)
      .exec();
    await this.queue.enqueueOnce(QUEUE.TRY_ON, JOB.RUN_TRY_ON, id, { tryOnId: id });

    return this.status(id);
  }

  private async garmentFor({ slug, variantId }: TryOnPieceInput) {
    const product = await this.prisma.product.findUnique({
      where: { slug },
      include: {
        variants: { where: { isPublished: true } },
        garment3D: { select: { sourceKeys: true } },
      },
    });
    if (!product || !product.isPublished) throw new NotFoundException('Product not found');
    if (!TRY_ON_PRODUCT_TYPES.has(product.productType)) {
      throw new BadRequestException(`Try-on is not available for ${product.name}`);
    }
    const key = tryOnGarmentKey(product, variantId);
    if (!key) {
      throw new BadRequestException(`${product.name} has no photo to try on yet`);
    }
    return { key, productType: product.productType as ProductType, name: product.name };
  }

  async status(id: string): Promise<TryOnStatusView> {
    const meta = await this.redis.hgetall(keys.meta(id));
    if (!meta.status) throw new NotFoundException('This try-on has expired, take a new photo');

    let position: number | null = null;
    if (meta.status === 'queued') {
      const waiting = await this.queue.getQueue(QUEUE.TRY_ON).getWaiting(0, 100);
      const index = [...waiting].reverse().findIndex((job) => job.id === id);
      position = index >= 0 ? index + 1 : null;
    }

    return {
      id,
      status: meta.status as TryOnStatus,
      error: meta.error ?? null,
      position,
      pieces: storedGarments(meta).length,
    };
  }

  async result(id: string): Promise<Buffer> {
    const image = await this.redis.getBuffer(keys.result(id));
    if (!image) throw new NotFoundException('This try-on is not ready or has expired');
    return image;
  }

  async process(id: string): Promise<void> {
    const meta = await this.redis.hgetall(keys.meta(id));
    const photo = await this.redis.getBuffer(keys.photo(id));
    if (!meta.status || !photo) {
      this.logger.warn(`Try-on ${id} expired before it could run`);
      return;
    }

    await this.redis.hset(keys.meta(id), 'status', 'processing');
    try {
      const garments = storedGarments(meta);
      const photos = await Promise.all(garments.map((g) => this.storage.getBuffer(g.key)));
      const image = await this.render(
        id,
        photo,
        meta.contentType,
        garments.map((g, i) => ({ photo: photos[i], productType: g.productType })),
      );
      await this.redis
        .multi()
        .set(keys.result(id), image, 'EX', TRY_ON_TTL_SECONDS)
        .hset(keys.meta(id), 'status', 'done')
        .exec();
    } catch (error) {
      const message =
        error instanceof TryOnRejectedError
          ? error.message
          : 'Try-on failed, try again with another photo';
      if (!(error instanceof TryOnRejectedError)) {
        this.logger.error(`Try-on ${id} failed: ${(error as Error).message}`);
      }
      await this.redis.hset(keys.meta(id), { status: 'failed', error: message });
    } finally {
      await this.redis.del(keys.photo(id));
    }
  }

  private async render(
    id: string,
    photo: Buffer,
    contentType: string,
    garments: { photo: Buffer; productType: string }[],
  ): Promise<Buffer> {
    const baseUrl = this.config.get('GARMENT3D_SERVICE_URL', { infer: true }).replace(/\/+$/, '');
    const form = new UndiciFormData();
    form.append('request_id', id);
    form.append('person', new Blob([photo], { type: contentType }), 'person.jpg');
    for (const garment of garments) {
      form.append('product_type', garment.productType);
      form.append('garment', new Blob([garment.photo]), 'garment.img');
    }

    const res = await undiciFetch(`${baseUrl}/tryon`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TRY_ON_TIMEOUT_MS),
      dispatcher: NO_TIMEOUT_DISPATCHER,
    });

    if (res.status === 400) {
      const body = (await res.json().catch(() => null)) as { detail?: string } | null;
      throw new TryOnRejectedError(body?.detail ?? 'Could not use this photo');
    }
    if (!res.ok) {
      throw new Error(`garment3d-service try-on failed: HTTP ${res.status} ${await res.text()}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

function storedGarments(meta: Record<string, string>): TryOnGarment[] {
  if (meta.garments) return JSON.parse(meta.garments) as TryOnGarment[];
  return meta.garmentKey ? [{ key: meta.garmentKey, productType: meta.productType }] : [];
}
