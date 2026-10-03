import { BadRequestException } from '@nestjs/common';
import { GarmentGenerationService } from './garment-generation.service';

function buildDeps(overrides: { generationStatus?: string } = {}) {
  const garment = {
    id: 'g1',
    productId: 'p1',
    generationStatus: overrides.generationStatus ?? 'PENDING',
    generationProvider: 'MANUAL',
    sourceKeys: ['private/garment-uploads/g1/0.glb'],
    product: { productType: 'T_SHIRT', category: 'CREW_NECK' },
  };

  const prisma = {
    garment3D: {
      findUnique: jest.fn().mockResolvedValue(garment),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...garment, ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn(),
    },
  };
  const storage = { getBuffer: jest.fn(), put: jest.fn(), delete: jest.fn() };
  const queue = { enqueueOnce: jest.fn() };
  const registry = { get: jest.fn() };

  return { prisma, storage, queue, registry, garment };
}

describe('GarmentGenerationService', () => {
  it('refuses to process a garment in a state it cannot start from', async () => {
    const { prisma, storage, queue, registry } = buildDeps({ generationStatus: 'NOT_A_STATUS' });
    const service = new GarmentGenerationService(prisma as never, storage as never, queue as never, registry as never);

    await expect(service.processJob('g1')).rejects.toThrow(BadRequestException);
  });

  it('resumes a garment left PROCESSING by a worker that died mid-bake', async () => {
    const { prisma, storage, queue, registry } = buildDeps({ generationStatus: 'PROCESSING' });
    storage.getBuffer.mockResolvedValue(Buffer.from('photo'));
    storage.put.mockResolvedValue(undefined);
    registry.get.mockReturnValue({
      generate: jest.fn().mockResolvedValue({
        modelBuffer: null,
        textureBuffer: Buffer.from('png-bytes'),
        textureMesh: null,
        previewBuffer: null,
        confidenceScore: 0.75,
      }),
    });

    const service = new GarmentGenerationService(prisma as never, storage as never, queue as never, registry as never);
    await service.processJob('g1');

    const { data } = prisma.garment3D.updateMany.mock.calls.at(-1)![0];
    expect(data.generationStatus).toBe('COMPLETED');
  });

  it('publishes the product when a batch-created garment finishes baking', async () => {
    const { prisma, storage, queue, registry, garment } = buildDeps({ generationStatus: 'PENDING' });
    Object.assign(garment, { publishOnComplete: true });
    const productUpdate = jest.fn().mockResolvedValue({ count: 1 });
    Object.assign(prisma, { product: { updateMany: productUpdate } });
    storage.getBuffer.mockResolvedValue(Buffer.from('photo'));
    storage.put.mockResolvedValue(undefined);
    registry.get.mockReturnValue({
      generate: jest.fn().mockResolvedValue({
        modelBuffer: null,
        textureBuffer: Buffer.from('png-bytes'),
        textureMesh: null,
        previewBuffer: null,
        confidenceScore: 0.75,
      }),
    });

    const service = new GarmentGenerationService(prisma as never, storage as never, queue as never, registry as never);
    await service.processJob('g1');

    expect(productUpdate).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { isPublished: true } });
  });

  it('marks the garment FAILED with the validation reason when the provider rejects the source file', async () => {
    const { prisma, storage, queue, registry } = buildDeps({ generationStatus: 'PENDING' });
    storage.getBuffer.mockResolvedValue(Buffer.from('bad'));
    const { InvalidGlbError } = await import('./glb');
    registry.get.mockReturnValue({ generate: jest.fn().mockRejectedValue(new InvalidGlbError('bad glb')) });

    const service = new GarmentGenerationService(prisma as never, storage as never, queue as never, registry as never);
    await service.processJob('g1');

    expect(prisma.garment3D.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'g1' },
      data: { generationStatus: 'FAILED', failureReason: 'bad glb' },
    });
  });
  it('stores a texture-only provider result under textureKey and leaves modelKey null', async () => {
    const { prisma, storage, queue, registry } = buildDeps({ generationStatus: 'PENDING' });
    storage.getBuffer.mockResolvedValue(Buffer.from('photo'));
    storage.put.mockResolvedValue(undefined);
    registry.get.mockReturnValue({
      generate: jest.fn().mockResolvedValue({
        modelBuffer: null,
        textureBuffer: Buffer.from('png-bytes'),
        textureMesh: { source: 'HOODIE.glb', name: 'Wolf3D_Outfit_Top' },
        previewBuffer: null,
        confidenceScore: 0.75,
      }),
    });

    const service = new GarmentGenerationService(prisma as never, storage as never, queue as never, registry as never);
    await service.processJob('g1');

    expect(storage.put).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/png' }),
    );
    const { data } = prisma.garment3D.updateMany.mock.calls.at(-1)![0];
    expect(data.generationStatus).toBe('COMPLETED');
    expect(data.modelKey).toBeNull();
    expect(data.textureKey).toEqual(expect.stringContaining('texture.'));
    expect(data.textureMeshSource).toBe('HOODIE.glb');
    expect(data.textureMeshName).toBe('Wolf3D_Outfit_Top');
  });

  it('stores a mesh-only provider result under modelKey and leaves textureKey null', async () => {
    const { prisma, storage, queue, registry } = buildDeps({ generationStatus: 'PENDING' });
    storage.getBuffer.mockResolvedValue(Buffer.from('photo'));
    storage.put.mockResolvedValue(undefined);
    registry.get.mockReturnValue({
      generate: jest.fn().mockResolvedValue({
        modelBuffer: Buffer.from('glb-bytes'),
        textureBuffer: null,
        textureMesh: null,
        previewBuffer: null,
        confidenceScore: 0.6,
      }),
    });

    const service = new GarmentGenerationService(prisma as never, storage as never, queue as never, registry as never);
    await service.processJob('g1');

    const { data } = prisma.garment3D.updateMany.mock.calls.at(-1)![0];
    expect(data.generationStatus).toBe('COMPLETED');
    expect(data.textureKey).toBeNull();
    expect(data.modelKey).toEqual(expect.stringContaining('model.'));
    expect(data.textureMeshSource).toBeNull();
    expect(data.textureMeshName).toBeNull();
  });

  it('skips a queued job whose garment was deleted before it ran', async () => {
    const { prisma, storage, queue, registry } = buildDeps();
    prisma.garment3D.findUnique.mockResolvedValue(null);

    const service = new GarmentGenerationService(prisma as never, storage as never, queue as never, registry as never);
    await expect(service.processJob('g1')).resolves.toBeUndefined();
    expect(registry.get).not.toHaveBeenCalled();
  });

  it('discards the result when the garment is deleted while the bake runs', async () => {
    const { prisma, storage, queue, registry } = buildDeps();
    storage.getBuffer.mockResolvedValue(Buffer.from('photo'));
    storage.put.mockResolvedValue(undefined);
    prisma.garment3D.updateMany.mockResolvedValue({ count: 0 });
    registry.get.mockReturnValue({
      generate: jest.fn().mockResolvedValue({
        modelBuffer: null,
        textureBuffer: Buffer.from('png-bytes'),
        textureMesh: null,
        previewBuffer: null,
        confidenceScore: 0.75,
      }),
    });

    const service = new GarmentGenerationService(prisma as never, storage as never, queue as never, registry as never);
    await expect(service.processJob('g1')).resolves.toBeUndefined();
    expect(prisma.garment3D.updateMany).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(expect.stringContaining('texture.'));
  });
});
