import { Module } from '@nestjs/common';
import { AdminGarmentGenerationController } from './admin-garment-generation.controller';
import { GarmentGenerationService } from './garment-generation.service';
import { GarmentGenerationRegistry } from './garment-generation.registry';
import { GARMENT_GENERATION_PROVIDERS_TOKEN } from './garment-generation-provider.interface';
import { ManualGarmentGenerationProvider } from './providers/manual.provider';
import { LocalBakeGarmentGenerationProvider } from './providers/local-bake.provider';
import { GarmentClassifierService } from './garment-classifier.service';

@Module({
  controllers: [AdminGarmentGenerationController],
  providers: [
    ManualGarmentGenerationProvider,
    LocalBakeGarmentGenerationProvider,
    {
      provide: GARMENT_GENERATION_PROVIDERS_TOKEN,
      inject: [ManualGarmentGenerationProvider, LocalBakeGarmentGenerationProvider],
      useFactory: (
        manual: ManualGarmentGenerationProvider,
        localBake: LocalBakeGarmentGenerationProvider,
      ) => [manual, localBake],
    },
    GarmentGenerationRegistry,
    GarmentGenerationService,
    GarmentClassifierService,
  ],
  exports: [GarmentGenerationService, GarmentGenerationRegistry],
})
export class GarmentGenerationModule {}
