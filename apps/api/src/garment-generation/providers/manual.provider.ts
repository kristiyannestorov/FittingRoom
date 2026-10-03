import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GarmentGenerationProviderKey } from '@zed/contracts';
import type { Env } from '../../config/configuration';
import { InvalidGlbError, parseGlb } from '../glb';
import type {
  GarmentGenerationInput,
  GarmentGenerationProvider,
  GarmentGenerationResult,
} from '../garment-generation-provider.interface';

@Injectable()
export class ManualGarmentGenerationProvider implements GarmentGenerationProvider {
  readonly key: GarmentGenerationProviderKey = 'MANUAL';

  constructor(private readonly config: ConfigService<Env, true>) {}

  async generate(input: GarmentGenerationInput): Promise<GarmentGenerationResult> {
    if (input.sourceFiles.length !== 1) {
      throw new InvalidGlbError('Manual provider expects exactly one pre-made GLB file upload');
    }
    const sourceFileBuffer = input.sourceFiles[0].buffer;

    const maxBytes = this.config.get('GARMENT_MAX_GLB_BYTES', { infer: true });
    const maxTriangles = this.config.get('GARMENT_MAX_TRIANGLES', { infer: true });

    if (sourceFileBuffer.length > maxBytes) {
      throw new InvalidGlbError(
        `GLB is ${sourceFileBuffer.length} bytes, exceeds the ${maxBytes} byte limit`,
      );
    }

    const parsed = parseGlb(sourceFileBuffer);
    if (parsed.triangleCount > maxTriangles) {
      throw new InvalidGlbError(
        `GLB has ~${parsed.triangleCount} triangles, exceeds the ${maxTriangles} triangle budget`,
      );
    }

    return {
      modelBuffer: sourceFileBuffer,
      textureBuffer: null,
      textureMesh: null,
      previewBuffer: null,
      confidenceScore: 1.0,
    };
  }
}
