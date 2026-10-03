import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FormData as UndiciFormData, fetch as undiciFetch } from 'undici';
import {
  PRODUCT_TYPES,
  type GarmentClassification,
  type ProductType,
} from '@zed/contracts';
import type { Env } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

const CLASSIFY_TIMEOUT_MS = 2 * 60_000;

@Injectable()
export class GarmentClassifierService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async classifyProduct(productId: string, productType?: string): Promise<GarmentClassification> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        productType: true,
        imageKeys: true,
        thumbnailKey: true,
        garment3D: { select: { sourceKeys: true } },
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    const key = product.garment3D?.sourceKeys[0] ?? product.imageKeys[0] ?? product.thumbnailKey;
    if (!key) throw new BadRequestException('This product has no photos to detect its category from');
    const buffer = await this.storage.getBuffer(key);
    const contentType = key.endsWith('.png') ? 'image/png' : key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return this.classify([{ buffer, contentType }], productType ?? product.productType);
  }

  async classify(
    photos: { buffer: Buffer; contentType: string }[],
    productType?: string,
  ): Promise<GarmentClassification> {
    if (productType && !PRODUCT_TYPES.includes(productType as ProductType)) {
      throw new BadRequestException(`Unknown product type "${productType}"`);
    }

    const form = new UndiciFormData();
    if (productType) form.append('product_type', productType);
    photos.forEach((photo, index) => {
      form.append('images', new Blob([photo.buffer], { type: photo.contentType }), `${index}.img`);
    });

    const baseUrl = this.config.get('GARMENT3D_SERVICE_URL', { infer: true }).replace(/\/+$/, '');
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(`${baseUrl}/classify`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `Could not reach garment3d-service at ${baseUrl} to classify the photo: ${(error as Error).message}`,
      );
    }
    if (res.status === 400) throw new BadRequestException(await res.text());
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `garment3d-service classify failed: HTTP ${res.status} ${await res.text()}`,
      );
    }
    return (await res.json()) as GarmentClassification;
  }
}
