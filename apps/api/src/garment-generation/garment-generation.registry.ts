import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GarmentGenerationProviderKey } from '@zed/contracts';
import type { Env } from '../config/configuration';
import {
  GARMENT_GENERATION_PROVIDERS_TOKEN,
  type GarmentGenerationProvider,
} from './garment-generation-provider.interface';

@Injectable()
export class GarmentGenerationRegistry {
  private readonly byKey: Map<GarmentGenerationProviderKey, GarmentGenerationProvider>;

  constructor(
    @Inject(GARMENT_GENERATION_PROVIDERS_TOKEN) providers: GarmentGenerationProvider[],
    private readonly config: ConfigService<Env, true>,
  ) {
    this.byKey = new Map(providers.map((provider) => [provider.key, provider]));
  }

  get(key: string): GarmentGenerationProvider {
    const provider = this.byKey.get(key as GarmentGenerationProviderKey);
    if (!provider) {
      throw new BadRequestException(`Garment generation provider ${key} is not configured`);
    }
    return provider;
  }

  default(): GarmentGenerationProvider {
    const key = this.config
      .get('DEFAULT_GARMENT_GENERATION_PROVIDER', { infer: true })
      .toUpperCase() as GarmentGenerationProviderKey;
    return this.get(key);
  }
}
