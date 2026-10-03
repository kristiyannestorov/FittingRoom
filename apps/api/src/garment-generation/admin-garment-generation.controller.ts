import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { GARMENT_GENERATION_PROVIDERS, type GarmentGenerationProviderKey } from '@zed/contracts';
import { Roles } from '../common/roles.decorator';
import { GarmentGenerationService } from './garment-generation.service';
import { GarmentGenerationRegistry } from './garment-generation.registry';
import { GarmentClassifierService } from './garment-classifier.service';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 20;

@ApiTags('admin/garment-generation')
@Roles('ADMIN')
@Controller()
export class AdminGarmentGenerationController {
  constructor(
    private readonly garmentGeneration: GarmentGenerationService,
    private readonly registry: GarmentGenerationRegistry,
    private readonly classifier: GarmentClassifierService,
  ) {}

  @Post('admin/products/:productId/generate-3d')
  @UseInterceptors(FilesInterceptor('files', MAX_FILES, { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async generate(
    @Param('productId') productId: string,
    @Body('provider') providerRaw: string | undefined,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file upload is required (field name "files")');
    }

    const provider = (providerRaw?.toUpperCase() ?? this.registry.default().key) as GarmentGenerationProviderKey;
    if (!GARMENT_GENERATION_PROVIDERS.includes(provider)) {
      throw new BadRequestException(`Unknown provider "${providerRaw}"`);
    }

    const { garmentId, jobId } = await this.garmentGeneration.requestGeneration(
      productId,
      files.map((f) => ({ buffer: f.buffer, contentType: f.mimetype })),
      provider,
    );

    return { garmentId, jobId, status: 'processing' as const };
  }

  @Post('admin/garment-generation/classify')
  @UseInterceptors(FilesInterceptor('files', 4, { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  classify(
    @Body('productType') productType: string | undefined,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ) {
    const photos = (files ?? []).filter((f) => f.mimetype.startsWith('image/'));
    if (photos.length === 0) {
      throw new BadRequestException('At least one photo is required (field name "files")');
    }
    return this.classifier.classify(
      photos.map((f) => ({ buffer: f.buffer, contentType: f.mimetype })),
      productType?.toUpperCase() || undefined,
    );
  }

  @Post('admin/products/:productId/classify')
  classifyProduct(@Param('productId') productId: string, @Body('productType') productType?: string) {
    return this.classifier.classifyProduct(productId, productType?.toUpperCase() || undefined);
  }

  @Get('admin/garment-generation/jobs/:garmentId')
  status(@Param('garmentId') garmentId: string) {
    return this.garmentGeneration.getStatus(garmentId);
  }
}
