import { BadRequestException, Body, Controller, Get, Post, Query, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { MAX_BATCH_PRODUCTS, batchProductsSchema } from '@zed/contracts';
import { Roles } from '../common/roles.decorator';
import { AdminProductBatchService, type BatchPhotos } from './admin-product-batch.service';

const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const PHOTO_FIELD = /^(front|back)-(\d+)$/;

@ApiTags('admin/products')
@Roles('ADMIN')
@Controller('admin/products')
export class AdminProductBatchController {
  constructor(private readonly batch: AdminProductBatchService) {}

  @Post('batch')
  @UseInterceptors(
    AnyFilesInterceptor({
      limits: { fileSize: MAX_PHOTO_BYTES, files: MAX_BATCH_PRODUCTS * 2 },
      fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
    }),
  )
  create(
    @Body('items') itemsRaw: string | undefined,
    @Body('runAt') runAt: string | undefined,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ) {
    let items: unknown;
    try {
      items = JSON.parse(itemsRaw ?? '');
    } catch {
      throw new BadRequestException('`items` must be a JSON array of products');
    }
    const parsed = batchProductsSchema.safeParse({ items, runAt: runAt || undefined });
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Batch rejected',
        errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    const photos: BatchPhotos[] = parsed.data.items.map(() => ({}));
    for (const file of files ?? []) {
      const match = PHOTO_FIELD.exec(file.fieldname);
      const row = match ? Number(match[2]) : -1;
      if (!match || row >= photos.length) {
        throw new BadRequestException(`Unexpected file field "${file.fieldname}"`);
      }
      photos[row][match[1] as 'front' | 'back'] = file;
    }
    return this.batch.create(parsed.data.items, photos, parsed.data.runAt);
  }

  @Get('batch/status')
  status(@Query('ids') ids: string | undefined) {
    const productIds = (ids ?? '').split(',').filter(Boolean);
    if (productIds.length === 0 || productIds.length > MAX_BATCH_PRODUCTS) {
      throw new BadRequestException(`Pass 1-${MAX_BATCH_PRODUCTS} product ids as ?ids=a,b,c`);
    }
    return this.batch.status(productIds);
  }
}
