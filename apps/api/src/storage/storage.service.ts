import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import type { Env } from '../config/configuration';

export const PUBLIC_PREFIX = 'public';
export const PRIVATE_PREFIX = 'private';

const SIGNED_URL_TTL_SECONDS = 15 * 60;

export interface PutObjectInput {
  key: string;
  body: Buffer | Uint8Array | string;
  contentType: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client | null;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
  private readonly isDisabled: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    const endpoint = config.get('S3_ENDPOINT', { infer: true });
    const publicBaseUrl = config.get('S3_PUBLIC_BASE_URL', { infer: true });

    this.isDisabled = !endpoint || !publicBaseUrl;
    if (!endpoint || !publicBaseUrl) {
      this.logger.warn('S3 storage is disabled - uploads will not be persisted');
      this.client = null;
      this.publicBaseUrl = 'http://localhost:3000';
    } else {
      this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
      this.client = new S3Client({
        endpoint,
        region: config.get('S3_REGION', { infer: true }),
        forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
        credentials: {
          accessKeyId: config.get('S3_ACCESS_KEY_ID', { infer: true }),
          secretAccessKey: config.get('S3_SECRET_ACCESS_KEY', { infer: true }),
        },
      });
    }
  }

  async put(input: PutObjectInput): Promise<string> {
    if (this.isDisabled) {
      this.logger.debug(`[MOCK] Would store ${input.key}`);
      return input.key;
    }
    await this.client!.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        CacheControl: input.cacheControl ?? this.defaultCacheControl(input.key),
        Metadata: input.metadata,
      }),
    );
    this.logger.debug(`Stored ${input.key}`);
    return input.key;
  }

  async getBuffer(key: string): Promise<Buffer> {
    if (this.isDisabled) {
      this.logger.debug(`[MOCK] Would get buffer for ${key}`);
      return Buffer.alloc(0);
    }
    const result = await this.client!.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const bytes = await result.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Object ${key} has no body`);
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    if (this.isDisabled) {
      this.logger.debug(`[MOCK] Would delete ${key}`);
      return;
    }
    await this.client!.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async resolveUrl(key: string | null | undefined): Promise<string | null> {
    if (!key) return null;
    if (key.startsWith(`${PUBLIC_PREFIX}/`)) {
      return `${this.publicBaseUrl}/${key}`;
    }
    return this.signedGetUrl(key);
  }

  async resolveUrls(keys: (string | null | undefined)[]): Promise<(string | null)[]> {
    return Promise.all(keys.map((key) => this.resolveUrl(key)));
  }

  async signedGetUrl(key: string, ttlSeconds = SIGNED_URL_TTL_SECONDS): Promise<string> {
    if (this.isDisabled) {
      return `${this.publicBaseUrl}/${key}`;
    }
    return getSignedUrl(
      this.client!,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  private defaultCacheControl(key: string): string {
    return key.startsWith(`${PUBLIC_PREFIX}/`)
      ? 'public, max-age=31536000, immutable'
      : 'private, no-store';
  }
}

export const StorageKeys = {
  productThumbnail: (productId: string, contentHash: string): string =>
    `${PUBLIC_PREFIX}/products/${productId}/thumb.${contentHash}.webp`,

  productImage: (productId: string, contentHash: string): string =>
    `${PUBLIC_PREFIX}/products/${productId}/images/${contentHash}.webp`,

  variantThumbnail: (productId: string, variantId: string, contentHash: string): string =>
    `${PUBLIC_PREFIX}/products/${productId}/variants/${variantId}/thumb.${contentHash}.webp`,

  shippingLabel: (shipmentId: string): string =>
    `${PRIVATE_PREFIX}/labels/${shipmentId}.pdf`,

  garmentModel: (productId: string, contentHash: string): string =>
    `${PUBLIC_PREFIX}/garments/${productId}/model.${contentHash}.glb`,

  garmentTexture: (productId: string, contentHash: string): string =>
    `${PUBLIC_PREFIX}/garments/${productId}/texture.${contentHash}.png`,

  garmentPreview: (productId: string, contentHash: string): string =>
    `${PUBLIC_PREFIX}/garments/${productId}/preview.${contentHash}.webp`,

  avatarModel: (avatarId: string): string =>
    `${PUBLIC_PREFIX}/avatars/${avatarId}/model.glb`,

  garmentLibraryMesh: (filename: string): string =>
    `${PUBLIC_PREFIX}/garment-library/${filename}`,

  garmentSourceUpload: (garmentId: string, index: number, ext: string): string =>
    `${PRIVATE_PREFIX}/garment-uploads/${garmentId}/${index}.${ext}`,
} as const;

export function contentHash(buffer: Buffer | Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

