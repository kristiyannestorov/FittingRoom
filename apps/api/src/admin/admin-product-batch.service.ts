import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { BatchProductItemInput, BatchProductResult, BatchProductStatus } from '@zed/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from '../assets/products.service';
import { GarmentGenerationService } from '../garment-generation/garment-generation.service';

const MAX_SCHEDULE_MS = 30 * 24 * 3600 * 1000;

export interface BatchPhotos {
  front?: Express.Multer.File;
  back?: Express.Multer.File;
}

@Injectable()
export class AdminProductBatchService {
  private readonly logger = new Logger(AdminProductBatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly garmentGeneration: GarmentGenerationService,
  ) {}

  async create(
    items: BatchProductItemInput[],
    photos: BatchPhotos[],
    runAt: string | undefined,
  ): Promise<{ runAt: string; results: BatchProductResult[] }> {
    const start = runAt ? new Date(runAt) : new Date();
    const delayMs = Math.max(0, start.getTime() - Date.now());
    if (delayMs > MAX_SCHEDULE_MS) throw new BadRequestException('runAt is more than 30 days away');
    await this.validate(items, photos);

    const results: BatchProductResult[] = [];
    for (const [row, item] of items.entries()) {
      const result: BatchProductResult = { row, slug: item.slug, productId: null, garmentId: null, error: null };
      try {
        const { colorName, colorHex, stock, ...product } = item;
        const created = await this.products.createProduct(product);
        result.productId = created.id;
        await this.prisma.productVariant.updateMany({
          where: { productId: created.id },
          data: { name: colorName, colorName, colorHex },
        });
        await this.prisma.inventoryItem.updateMany({
          where: { productId: created.id },
          data: { quantityAvailable: stock },
        });

        const files = [photos[row].front!, ...(photos[row].back ? [photos[row].back] : [])];
        await this.products.addImages(created.id, files);
        const { garmentId } = await this.garmentGeneration.requestGeneration(
          created.id,
          files.map((f) => ({ buffer: f.buffer, contentType: f.mimetype })),
          'LOCAL_BAKE',
          { delayMs, publishOnComplete: true },
        );
        result.garmentId = garmentId;
      } catch (error) {
        result.error = (error as Error).message;
        this.logger.warn(`Batch row ${row} (${item.slug}) failed: ${result.error}`);
      }
      results.push(result);
    }
    this.logger.log(
      `Batch of ${items.length}: ${results.filter((r) => !r.error).length} queued to bake from ${start.toISOString()}`,
    );
    return { runAt: start.toISOString(), results };
  }

  async status(productIds: string[]): Promise<BatchProductStatus[]> {
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: {
        id: true,
        slug: true,
        name: true,
        isPublished: true,
        garment3D: { select: { generationStatus: true, failureReason: true } },
      },
    });
    return products.map((p) => ({
      productId: p.id,
      slug: p.slug,
      name: p.name,
      isPublished: p.isPublished,
      generationStatus: p.garment3D?.generationStatus ?? null,
      failureReason: p.garment3D?.failureReason ?? null,
    }));
  }

  private async validate(items: BatchProductItemInput[], photos: BatchPhotos[]): Promise<void> {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const [row, item] of items.entries()) {
      if (seen.has(item.slug)) problems.push(`row ${row + 1}: slug "${item.slug}" is used twice in this batch`);
      seen.add(item.slug);
      if (!photos[row]?.front) problems.push(`row ${row + 1}: a front photo is required`);
    }
    const taken = await this.prisma.product.findMany({
      where: { slug: { in: [...seen] } },
      select: { slug: true },
    });
    for (const { slug } of taken) problems.push(`slug "${slug}" is already in use`);
    if (problems.length > 0) throw new BadRequestException({ message: 'Batch rejected', errors: problems });
  }
}
