import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { GarmentGenerationProviderKey, GenerationStatus } from '@zed/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService, StorageKeys, contentHash } from '../storage/storage.service';
import { QueueService } from '../queue/queue.service';
import { QUEUE, JOB } from '../queue/queue.constants';
import { GarmentGenerationRegistry } from './garment-generation.registry';
import { InvalidGlbError } from './glb';
import type { GarmentSourceFile } from './garment-generation-provider.interface';

const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  glb: 'model/gltf-binary',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export interface GarmentSourceUpload {
  buffer: Buffer;
  contentType: string;
}

const GENERATION_TRANSITIONS: Record<GenerationStatus, readonly GenerationStatus[]> = {
  PENDING: ['PROCESSING'],
  PROCESSING: ['COMPLETED', 'FAILED', 'PROCESSING'],
  COMPLETED: ['PROCESSING'],
  FAILED: ['PROCESSING'],
};

function canTransition(from: GenerationStatus, to: GenerationStatus): boolean {
  return GENERATION_TRANSITIONS[from]?.includes(to) ?? false;
}

@Injectable()
export class GarmentGenerationService {
  private readonly logger = new Logger(GarmentGenerationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
    private readonly registry: GarmentGenerationRegistry,
  ) {}

  async requestGeneration(
    productId: string,
    files: GarmentSourceUpload[],
    provider: GarmentGenerationProviderKey,
    options: { delayMs?: number; publishOnComplete?: boolean } = {},
  ): Promise<{ garmentId: string; jobId: string }> {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException('Product not found');
    if (files.length === 0) throw new BadRequestException('At least one source file is required');

    const publishOnComplete = options.publishOnComplete ?? false;
    const garment = await this.prisma.garment3D.upsert({
      where: { productId },
      create: { productId, generationStatus: 'PENDING', generationProvider: provider, publishOnComplete },
      update: { generationStatus: 'PENDING', generationProvider: provider, failureReason: null, publishOnComplete },
    });

    const sourceKeys = await Promise.all(
      files.map((file, index) => {
        const ext = extensionFor(file.contentType);
        const key = StorageKeys.garmentSourceUpload(garment.id, index, ext);
        return this.storage
          .put({ key, body: file.buffer, contentType: file.contentType })
          .then(() => key);
      }),
    );
    await this.prisma.garment3D.update({ where: { id: garment.id }, data: { sourceKeys } });

    const jobId = await this.queue.enqueueOnce(
      QUEUE.GARMENT_GENERATION,
      JOB.GENERATE_GARMENT,
      `${garment.id}-${Date.now()}`,
      { garmentId: garment.id },
      options.delayMs ? { delay: options.delayMs } : undefined,
    );

    return { garmentId: garment.id, jobId };
  }

  async processJob(garmentId: string): Promise<void> {
    const garment = await this.prisma.garment3D.findUnique({
      where: { id: garmentId },
      include: { product: { select: { productType: true, category: true, gender: true, slug: true } } },
    });
    if (!garment) {
      this.logger.warn(`Garment ${garmentId} no longer exists; skipping generation`);
      return;
    }

    await this.transition(garmentId, garment.generationStatus, 'PROCESSING');

    try {
      const sourceFiles: GarmentSourceFile[] = await Promise.all(
        garment.sourceKeys.map(async (key) => ({
          buffer: await this.storage.getBuffer(key),
          contentType: EXT_TO_CONTENT_TYPE[key.split('.').pop() ?? ''] ?? 'application/octet-stream',
        })),
      );
      const provider = this.registry.get(garment.generationProvider);

      const result = await provider.generate({
        garmentId,
        garmentType: garment.product.productType,
        garmentCategory: garment.product.category,
        garmentGender: garment.product.gender,
        garmentSlug: garment.product.slug,
        sourceFiles,
      });

      const artifact = result.modelBuffer ?? result.textureBuffer;
      if (!artifact) {
        throw new Error('Provider returned neither a model nor a texture');
      }
      const hash = contentHash(artifact);

      let modelKey: string | null = null;
      let textureKey: string | null = null;
      if (result.modelBuffer) {
        modelKey = StorageKeys.garmentModel(garment.productId, hash);
        await this.storage.put({
          key: modelKey,
          body: result.modelBuffer,
          contentType: 'model/gltf-binary',
        });
      } else {
        textureKey = StorageKeys.garmentTexture(garment.productId, hash);
        await this.storage.put({
          key: textureKey,
          body: result.textureBuffer!,
          contentType: 'image/png',
        });
      }

      let previewKey: string | null = null;
      if (result.previewBuffer) {
        previewKey = StorageKeys.garmentPreview(garment.productId, hash);
        await this.storage.put({ key: previewKey, body: result.previewBuffer, contentType: 'image/webp' });
      }

      const { count } = await this.prisma.garment3D.updateMany({
        where: { id: garmentId },
        data: {
          generationStatus: 'COMPLETED',
          modelKey,
          textureKey,
          textureMeshSource: result.textureMesh?.source ?? null,
          textureMeshName: result.textureMesh?.name ?? null,
          previewKey,
          confidenceScore: result.confidenceScore,
          failureReason: null,
          generationVersion: { increment: 1 },
        },
      });
      if (count === 0) {
        this.logger.warn(`Garment ${garmentId} was deleted during generation; discarding the result`);
        await this.deleteQuietly([modelKey, textureKey, previewKey]);
        return;
      }
      this.logger.log(`Garment ${garmentId} generation completed`);
      if (garment.publishOnComplete) {
        await this.prisma.product.updateMany({ where: { id: garment.productId }, data: { isPublished: true } });
        this.logger.log(`Published product ${garment.productId} now that its garment is ready`);
      }
    } catch (error) {
      const reason = error instanceof InvalidGlbError ? error.message : 'Generation failed unexpectedly';
      await this.prisma.garment3D.updateMany({
        where: { id: garmentId },
        data: { generationStatus: 'FAILED', failureReason: reason },
      });
      this.logger.warn(`Garment ${garmentId} generation failed: ${reason}`);
      if (!(error instanceof InvalidGlbError)) throw error;
    }
  }

  async getStatus(garmentId: string) {
    const garment = await this.prisma.garment3D.findUnique({ where: { id: garmentId } });
    if (!garment) throw new NotFoundException('Garment generation job not found');
    return garment;
  }

  private async transition(garmentId: string, from: GenerationStatus, to: GenerationStatus): Promise<void> {
    if (!canTransition(from, to)) {
      throw new BadRequestException(`Cannot transition garment generation from ${from} to ${to}`);
    }
    await this.prisma.garment3D.update({ where: { id: garmentId }, data: { generationStatus: to } });
  }

  private async deleteQuietly(keys: (string | null)[]): Promise<void> {
    for (const key of keys) {
      if (!key) continue;
      try {
        await this.storage.delete(key);
      } catch (err) {
        this.logger.warn(`Failed to delete storage object ${key}: ${(err as Error).message}`);
      }
    }
  }
}

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'model/gltf-binary': 'glb',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function extensionFor(contentType: string): string {
  const ext = CONTENT_TYPE_TO_EXT[contentType];
  if (!ext) throw new BadRequestException(`Unsupported source file content type: ${contentType}`);
  return ext;
}
