import type { ConfigService } from '@nestjs/config';
import { ManualGarmentGenerationProvider } from './manual.provider';
import { InvalidGlbError } from '../glb';

function buildGlb(json: unknown): Buffer {
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const padding = (4 - (jsonBuffer.length % 4)) % 4;
  const paddedJson = Buffer.concat([jsonBuffer, Buffer.alloc(padding, 0x20)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + paddedJson.length, 8);

  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(paddedJson.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4);

  return Buffer.concat([header, chunkHeader, paddedJson]);
}

function fakeConfig(overrides: Record<string, unknown> = {}): ConfigService<never, true> {
  const values: Record<string, unknown> = {
    GARMENT_MAX_GLB_BYTES: 1024 * 1024,
    GARMENT_MAX_TRIANGLES: 1000,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<never, true>;
}

describe('ManualGarmentGenerationProvider', () => {
  const validGlb = buildGlb({
    asset: { version: '2.0' },
    accessors: [{ count: 30 }],
    meshes: [{ primitives: [{ indices: 0, mode: 4 }] }],
  });

  it('rejects a non-GLB buffer', async () => {
    const provider = new ManualGarmentGenerationProvider(fakeConfig());
    await expect(
      provider.generate({
        garmentId: 'g1',
        garmentType: 'T_SHIRT',
      garmentCategory: 'CREW_NECK',
      garmentGender: 'MALE',
        sourceFiles: [{ buffer: Buffer.from('nope'), contentType: 'model/gltf-binary' }],
      }),
    ).rejects.toThrow(InvalidGlbError);
  });

  it('rejects a GLB over the triangle budget', async () => {
    const provider = new ManualGarmentGenerationProvider(fakeConfig({ GARMENT_MAX_TRIANGLES: 5 }));
    await expect(
      provider.generate({
        garmentId: 'g1',
        garmentType: 'T_SHIRT',
      garmentCategory: 'CREW_NECK',
      garmentGender: 'MALE',
        sourceFiles: [{ buffer: validGlb, contentType: 'model/gltf-binary' }],
      }),
    ).rejects.toThrow(InvalidGlbError);
  });

  it('rejects an oversized GLB', async () => {
    const provider = new ManualGarmentGenerationProvider(fakeConfig({ GARMENT_MAX_GLB_BYTES: 10 }));
    await expect(
      provider.generate({
        garmentId: 'g1',
        garmentType: 'T_SHIRT',
      garmentCategory: 'CREW_NECK',
      garmentGender: 'MALE',
        sourceFiles: [{ buffer: validGlb, contentType: 'model/gltf-binary' }],
      }),
    ).rejects.toThrow(InvalidGlbError);
  });

  it('rejects more than one source file', async () => {
    const provider = new ManualGarmentGenerationProvider(fakeConfig());
    await expect(
      provider.generate({
        garmentId: 'g1',
        garmentType: 'T_SHIRT',
      garmentCategory: 'CREW_NECK',
      garmentGender: 'MALE',
        sourceFiles: [
          { buffer: validGlb, contentType: 'model/gltf-binary' },
          { buffer: validGlb, contentType: 'model/gltf-binary' },
        ],
      }),
    ).rejects.toThrow(InvalidGlbError);
  });

  it('accepts a well-formed small GLB', async () => {
    const provider = new ManualGarmentGenerationProvider(fakeConfig());
    const result = await provider.generate({
      garmentId: 'g1',
      garmentType: 'T_SHIRT',
      garmentCategory: 'CREW_NECK',
      garmentGender: 'MALE',
      sourceFiles: [{ buffer: validGlb, contentType: 'model/gltf-binary' }],
    });
    expect(result.confidenceScore).toBe(1.0);
    expect(result.modelBuffer).toEqual(validGlb);
  });
});
