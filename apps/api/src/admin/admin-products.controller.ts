import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  adminProductQuerySchema,
  createProductSchema,
  updateProductSchema,
  type AdminProductQuery,
  type CreateProductInput,
  type UpdateProductInput,
} from '@zed/contracts';
import { ProductsService } from '../assets/products.service';
import { Roles } from '../common/roles.decorator';
import { zodBody } from '../common/zod-validation.pipe';

const variantSchema = z.object({
  name: z.string().min(1).max(80),
  colorName: z.string().min(1).max(60),
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  patternName: z.string().max(60).optional(),
  priceDeltaMinor: z.number().int().default(0),
});

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES_PER_UPLOAD = 10;

@ApiTags('admin/products')
@Roles('ADMIN')
@Controller('admin/products')
export class AdminProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@Query(zodBody(adminProductQuerySchema)) query: AdminProductQuery) {
    return this.products.listForAdmin(query);
  }

  @Post()
  create(@Body(zodBody(createProductSchema)) dto: CreateProductInput) {
    return this.products.createProduct(dto);
  }

  @Get(':productId')
  get(@Param('productId') productId: string) {
    return this.products.getForAdmin(productId);
  }

  @Patch(':productId')
  update(
    @Param('productId') productId: string,
    @Body(zodBody(updateProductSchema)) dto: UpdateProductInput,
  ) {
    return this.products.updateProduct(productId, dto);
  }

  @Delete(':productId')
  remove(@Param('productId') productId: string) {
    return this.products.deleteProduct(productId);
  }

  @Patch(':productId/publish')
  publish(@Param('productId') productId: string, @Query('published') published: string) {
    return this.products.publishProduct(productId, published !== 'false');
  }

  @Post(':productId/images')
  @UseInterceptors(
    FilesInterceptor('files', MAX_IMAGES_PER_UPLOAD, {
      limits: { fileSize: MAX_IMAGE_BYTES },
      fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
    }),
  )
  addImages(
    @Param('productId') productId: string,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one image is required (field name "files")');
    }
    return this.products.addImages(productId, files);
  }

  @Delete(':productId/images')
  removeImage(@Param('productId') productId: string, @Query('key') key: string) {
    return this.products.removeImage(productId, key);
  }

  @Post(':productId/variants')
  createVariant(
    @Param('productId') productId: string,
    @Body(zodBody(variantSchema)) dto: z.infer<typeof variantSchema>,
  ) {
    return this.products.createVariant(productId, dto);
  }

  @Patch('variants/:variantId/publish')
  publishVariant(
    @Param('variantId') variantId: string,
    @Query('published') published: string,
  ) {
    return this.products.publishVariant(variantId, published !== 'false');
  }

}
