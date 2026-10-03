import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Agent, FormData as UndiciFormData, fetch as undiciFetch } from 'undici';
import type { GarmentGenerationProviderKey } from '@zed/contracts';
import type { Env } from '../../config/configuration';
import { InvalidGlbError } from '../glb';
import type {
  GarmentGenerationInput,
  GarmentGenerationProvider,
  GarmentGenerationResult,
} from '../garment-generation-provider.interface';

const SUPPORTED_CONTENT_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

const VIEW_ORDER = ['front', 'back', 'left', 'right'] as const;

const BAKEABLE_PRODUCT_TYPES = new Set([
  'T_SHIRT',
  'LONG_SLEEVE',
  'HOODIE',
  'SHORTS',
  'PANTS',
  'DRESS',
]);

const NO_TIMEOUT_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

@Injectable()
export class LocalBakeGarmentGenerationProvider implements GarmentGenerationProvider {
  readonly key: GarmentGenerationProviderKey = 'LOCAL_BAKE';
  private readonly logger = new Logger(LocalBakeGarmentGenerationProvider.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  async generate(input: GarmentGenerationInput): Promise<GarmentGenerationResult> {
    const { sourceFiles } = input;
    if (!BAKEABLE_PRODUCT_TYPES.has(input.garmentType)) {
      throw new InvalidGlbError(
        `LOCAL_BAKE does not support ${input.garmentType} yet (supported: ${[...BAKEABLE_PRODUCT_TYPES].join(', ')})`,
      );
    }
    if (sourceFiles.length < 1 || sourceFiles.length > VIEW_ORDER.length) {
      throw new InvalidGlbError(
        `LOCAL_BAKE provider takes 1 to ${VIEW_ORDER.length} photos (front, back, left, right), got ${sourceFiles.length}`,
      );
    }
    for (const file of sourceFiles) {
      if (!SUPPORTED_CONTENT_TYPES.has(file.contentType)) {
        throw new InvalidGlbError(`Unsupported source photo content type: ${file.contentType}`);
      }
    }

    const baseUrl = this.config.get('GARMENT3D_SERVICE_URL', { infer: true }).replace(/\/+$/, '');
    const timeoutMs = this.config.get('GARMENT3D_SERVICE_TIMEOUT_MS', { infer: true });

    const form = new UndiciFormData();
    form.append('product_type', input.garmentType);
    form.append('category', input.garmentCategory);
    form.append('gender', input.garmentGender);
    if (input.garmentSlug) form.append('product_slug', input.garmentSlug);
    sourceFiles.forEach((file, index) => {
      const view = VIEW_ORDER[index];
      form.append('' + view, new Blob([file.buffer], { type: file.contentType }), `${view}.jpg`);
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(`${baseUrl}/bake`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
        dispatcher: NO_TIMEOUT_DISPATCHER,
      });
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw new Error(`garment3d-service did not respond within ${timeoutMs}ms`);
      }
      const cause = (error as { cause?: { code?: string } }).cause;
      if (cause?.code === 'ECONNREFUSED') {
        throw new Error(`Could not reach garment3d-service at ${baseUrl} - is it running?`);
      }
      throw new Error(
        `garment3d-service at ${baseUrl} dropped the connection mid-bake - it likely crashed ` +
          `or ran out of memory; check its logs (${cause?.code ?? (error as Error).message})`,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 400) throw new InvalidGlbError(`Unusable source photo: ${body}`);
      throw new Error(`garment3d-service bake failed: HTTP ${res.status} ${body}`);
    }

    const textureBuffer = Buffer.from(await res.arrayBuffer());
    const source = res.headers.get('x-garment-source');
    const name = res.headers.get('x-garment-mesh');
    if (!source || !name) {
      throw new Error(
        'garment3d-service did not report which mesh it baked against - it is likely an older build',
      );
    }
    this.logger.log(`Baked ${textureBuffer.byteLength} byte texture for ${name} of ${source}`);

    return {
      modelBuffer: null,
      textureBuffer,
      textureMesh: { source, name },
      previewBuffer: null,
      confidenceScore: sourceFiles.length >= 2 ? 0.75 : 0.6,
    };
  }
}
