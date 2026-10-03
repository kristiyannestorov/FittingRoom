import { BadRequestException } from '@nestjs/common';
import { TryOnService, tryOnGarmentKey } from './try-on.service';

type Product = {
  slug: string;
  name: string;
  productType: string;
  isPublished: boolean;
  imageKeys: string[];
  thumbnailKey: string | null;
  variants: { id: string; thumbnailKey: string | null }[];
  garment3D: { sourceKeys: string[] } | null;
};

function product(overrides: Partial<Product>): Product {
  return {
    slug: 'tee',
    name: 'Tee',
    productType: 'T_SHIRT',
    isPublished: true,
    imageKeys: ['public/products/tee/images/a.webp'],
    thumbnailKey: 'public/products/tee/thumb.webp',
    variants: [],
    garment3D: null,
    ...overrides,
  };
}

function buildService(products: Product[], meta: Record<string, string> = {}) {
  const multi = {
    hset: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  };
  const redis = {
    multi: jest.fn(() => multi),
    hgetall: jest.fn().mockResolvedValue({ status: 'queued', ...meta }),
    getBuffer: jest.fn().mockResolvedValue(Buffer.from('photo')),
    hset: jest.fn().mockResolvedValue(1),
    del: jest.fn().mockResolvedValue(1),
  };
  const prisma = {
    product: {
      findUnique: jest.fn(({ where }: { where: { slug: string } }) =>
        Promise.resolve(products.find((p) => p.slug === where.slug) ?? null),
      ),
    },
  };
  const storage = { getBuffer: jest.fn((key: string) => Promise.resolve(Buffer.from(key))) };
  const queue = {
    enqueueOnce: jest.fn(),
    getQueue: jest.fn(() => ({ getWaiting: jest.fn().mockResolvedValue([]) })),
  };
  const service = new TryOnService(
    prisma as never,
    storage as never,
    {} as never,
    queue as never,
    redis as never,
  );
  return { service, redis, multi, queue, storage };
}

const photo = { buffer: Buffer.from('jpeg'), contentType: 'image/jpeg' };

describe('tryOnGarmentKey', () => {
  it('prefers the chosen colour, then product photos, then the 3D bake photo', () => {
    const withVariant = product({ variants: [{ id: 'v1', thumbnailKey: 'variant.webp' }] });
    expect(tryOnGarmentKey(withVariant, 'v1')).toBe('variant.webp');
    expect(tryOnGarmentKey(withVariant)).toBe('public/products/tee/images/a.webp');

    const bakedOnly = product({
      imageKeys: [],
      thumbnailKey: null,
      garment3D: { sourceKeys: ['private/garment-uploads/g/0.jpg'] },
    });
    expect(tryOnGarmentKey(bakedOnly)).toBe('private/garment-uploads/g/0.jpg');
    expect(tryOnGarmentKey(product({ imageKeys: [], thumbnailKey: null }))).toBeNull();
  });
});

describe('TryOnService.start', () => {
  const tee = product({});
  const jeans = product({
    slug: 'jeans',
    name: 'Jeans',
    productType: 'PANTS',
    imageKeys: [],
    thumbnailKey: null,
    garment3D: { sourceKeys: ['private/garment-uploads/jeans/0.jpg'] },
  });
  const dress = product({ slug: 'dress', name: 'Dress', productType: 'DRESS' });

  it('queues a top and a bottom together as one outfit', async () => {
    const { service, multi, queue } = buildService([tee, jeans], {
      garments: JSON.stringify([{}, {}]),
    });

    const view = await service.start([{ slug: 'tee' }, { slug: 'jeans' }], photo);

    const stored = JSON.parse(multi.hset.mock.calls[0][1].garments);
    expect(stored).toEqual([
      { key: 'public/products/tee/images/a.webp', productType: 'T_SHIRT' },
      { key: 'private/garment-uploads/jeans/0.jpg', productType: 'PANTS' },
    ]);
    expect(queue.enqueueOnce).toHaveBeenCalledTimes(1);
    expect(view.pieces).toBe(2);
  });

  it('rejects pieces that are worn in the same place', async () => {
    const { service, queue } = buildService([tee, dress]);

    await expect(service.start([{ slug: 'tee' }, { slug: 'dress' }], photo)).rejects.toThrow(
      BadRequestException,
    );
    expect(queue.enqueueOnce).not.toHaveBeenCalled();
  });

  it('rejects a product without any photo to try on', async () => {
    const bare = product({ slug: 'bare', imageKeys: [], thumbnailKey: null });
    const { service } = buildService([bare]);

    await expect(service.start([{ slug: 'bare' }], photo)).rejects.toThrow(/no photo/);
  });
});

describe('TryOnService.process', () => {
  it('still runs a single-garment job queued before outfits existed', async () => {
    const { service, storage } = buildService([], {
      garmentKey: 'public/products/tee/images/a.webp',
      productType: 'T_SHIRT',
      contentType: 'image/jpeg',
    });
    const render = jest
      .spyOn(service as never as { render: () => Promise<Buffer> }, 'render')
      .mockResolvedValue(Buffer.from('result'));

    await service.process('job');

    expect(storage.getBuffer).toHaveBeenCalledWith('public/products/tee/images/a.webp');
    expect(render).toHaveBeenCalledWith('job', Buffer.from('photo'), 'image/jpeg', [
      { photo: Buffer.from('public/products/tee/images/a.webp'), productType: 'T_SHIRT' },
    ]);
  });
});
