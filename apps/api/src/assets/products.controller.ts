import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import {
  productQuerySchema,
  tryOnPiecesSchema,
  type ProductQuery,
  type TryOnPieceInput,
} from '@zed/contracts';
import { ProductsService } from './products.service';
import { TryOnService } from './try-on.service';
import { ZodValidationPipe, zodBody } from '../common/zod-validation.pipe';
import { Public } from '../common/public.decorator';

const MAX_TRY_ON_PHOTO_BYTES = 15 * 1024 * 1024;

function tryOnPhoto(photo: Express.Multer.File | undefined) {
  if (!photo) throw new BadRequestException('A photo is required (field name "photo")');
  return { buffer: photo.buffer, contentType: photo.mimetype };
}

const parseJsonField = {
  transform(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      throw new BadRequestException('pieces must be a JSON array');
    }
  },
};

@ApiTags('products')
@Controller()
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly tryOnService: TryOnService,
  ) {}

  @Public()
  @Get('products')
  list(@Query(zodBody(productQuerySchema)) query: ProductQuery) {
    return this.products.list(query);
  }

  @Public()
  @Get('products/:slug')
  get(@Param('slug') slug: string) {
    return this.products.getBySlug(slug);
  }

  @Public()
  @Post('products/:slug/try-on')
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_TRY_ON_PHOTO_BYTES } }))
  startTryOn(
    @Param('slug') slug: string,
    @Body('variantId') variantId: string | undefined,
    @UploadedFile() photo: Express.Multer.File | undefined,
  ) {
    return this.tryOnService.start(
      [{ slug, variantId: variantId || undefined }],
      tryOnPhoto(photo),
    );
  }

  @Public()
  @Post('try-on')
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: MAX_TRY_ON_PHOTO_BYTES } }))
  startOutfitTryOn(
    @Body('pieces', parseJsonField, new ZodValidationPipe(tryOnPiecesSchema)) pieces: TryOnPieceInput[],
    @UploadedFile() photo: Express.Multer.File | undefined,
  ) {
    return this.tryOnService.start(pieces, tryOnPhoto(photo));
  }

  @Public()
  @Get('try-on/:id')
  @Header('Cache-Control', 'no-store')
  tryOnStatus(@Param('id') id: string) {
    return this.tryOnService.status(id);
  }

  @Public()
  @Get('try-on/:id/image')
  @Header('Content-Type', 'image/jpeg')
  @Header('Cache-Control', 'private, no-store')
  async tryOnImage(@Param('id') id: string) {
    return new StreamableFile(await this.tryOnService.result(id));
  }
}
