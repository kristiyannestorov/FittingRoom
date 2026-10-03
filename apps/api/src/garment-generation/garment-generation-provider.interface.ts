import type { GarmentGenerationProviderKey } from '@zed/contracts';

export interface GarmentSourceFile {
  buffer: Buffer;
  contentType: string;
}

export interface GarmentGenerationInput {
  garmentId: string;
  garmentType: string;
  garmentCategory: string;
  garmentGender: string;
  garmentSlug?: string;
  sourceFiles: GarmentSourceFile[];
}

export interface GarmentGenerationResult {
  modelBuffer: Buffer | null;
  textureBuffer: Buffer | null;
  textureMesh: { source: string; name: string } | null;
  previewBuffer: Buffer | null;
  confidenceScore: number;
}

export interface GarmentGenerationProvider {
  readonly key: GarmentGenerationProviderKey;

  generate(input: GarmentGenerationInput): Promise<GarmentGenerationResult>;
}

export const GARMENT_GENERATION_PROVIDERS_TOKEN = 'GARMENT_GENERATION_PROVIDERS';
