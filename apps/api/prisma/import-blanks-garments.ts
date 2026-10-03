import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  type ClothingSize,
  type Gender,
  type ProductCategory,
  type ProductType,
} from '@zed/contracts';
import { InventoryService } from '../src/inventory/inventory.service';
import { StorageKeys } from '../src/storage/storage.service';
import { JOB, QUEUE, bullConnectionOptions } from '../src/queue/queue.constants';

loadEnv({ path: join(__dirname, '..', '.env') });

const PHOTO_DIR = join(__dirname, '..', '..', '..', 'testimg', 'garments');
const DEFAULT_SIZES: ClothingSize[] = ['XS', 'S', 'M', 'L', 'XL'];

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const s3Endpoint = process.env.S3_ENDPOINT;
const s3 = s3Endpoint
  ? new S3Client({
      endpoint: s3Endpoint,
      region: process.env.S3_REGION ?? 'us-east-1',
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'dev',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'dev',
      },
    })
  : null;
const BUCKET = process.env.S3_BUCKET ?? 'zed-assets';

interface Garment {
  productType: ProductType;
  category: ProductCategory;
  label: string;
}

function classify(handle: string): Garment | null {
  const h = handle.toLowerCase();

  if (h.includes('3-pack')) return null;

  if (h.includes('long-sleeve')) {
    return { productType: 'LONG_SLEEVE', category: h.includes('waffle') ? 'WAFFLE_KNIT' : 'CREW_NECK', label: 'Long Sleeve' };
  }
  if (h.includes('zip-hoodie')) return { productType: 'HOODIE', category: 'ZIP_UP', label: 'Zip Hoodie' };
  if (h.includes('hoodie')) return { productType: 'HOODIE', category: 'PULLOVER', label: 'Hoodie' };
  if (h.includes('1-4-zip')) return { productType: 'LONG_SLEEVE', category: 'ZIP_UP', label: 'Quarter Zip' };
  if (h.includes('tracksuit-pants')) return { productType: 'PANTS', category: 'ATHLETIC', label: 'Track Pants' };
  if (h.includes('tracksuit')) return { productType: 'LONG_SLEEVE', category: 'ZIP_UP', label: 'Track Top' };
  if (h.includes('jogger')) return { productType: 'PANTS', category: 'ATHLETIC', label: 'Jogger' };
  if (h.includes('shorts')) return { productType: 'SHORTS', category: 'ATHLETIC', label: 'Shorts' };
  if (h.includes('crewneck') || h.includes('crew-neck')) {
    return { productType: 'LONG_SLEEVE', category: 'CREW_NECK', label: 'Crewneck' };
  }
  if (h.includes('vest')) return { productType: 'T_SHIRT', category: 'WAFFLE_KNIT', label: 'Vest' };
  if (h.includes('tee') || h.includes('t-shirt')) {
    const printed = h.includes('talk-nice') || h.includes('earf');
    return { productType: 'T_SHIRT', category: printed ? 'GRAPHIC' : 'CREW_NECK', label: 'T-Shirt' };
  }
  return null;
}

const COLOURS: Record<string, string> = {
  white: '#f5f5f0',
  black: '#111111',
  grey: '#9a9a9a',
  steel: '#7a8b99',
  sand: '#c9b896',
  forest: '#2f4f36',
  rust: '#9c4a2a',
  navy: '#1b2a4a',
  khaki: '#8a7f5c',
  natural: '#e8e0cf',
  rfd: '#e3ddcd',
};

function colourFor(handle: string): { colorName: string; colorHex: string } {
  for (const [name, hex] of Object.entries(COLOURS)) {
    if (handle.toLowerCase().includes(name)) {
      const label = name === 'rfd' ? 'Natural' : name[0].toUpperCase() + name.slice(1);
      return { colorName: label, colorHex: hex };
    }
  }
  return { colorName: 'Natural', colorHex: '#e3ddcd' };
}

const ADJECTIVES = [
  'Northwind', 'Quarry', 'Drifter', 'Meridian', 'Halcyon', 'Ironside', 'Lowland',
  'Saltwater', 'Foundry', 'Cobblestone', 'Tidal', 'Everglade', 'Wayfarer', 'Kestrel',
  'Larkspur', 'Overcast', 'Rookery', 'Sundial', 'Thicket', 'Windrow',
];
const NOUNS = [
  'Field', 'Harbour', 'Atlas', 'Union', 'Reserve', 'Standard', 'Works', 'Society',
  'Assembly', 'Provision', 'Supply', 'Course', 'Division', 'Company', 'Guild',
];

function nameFor(handle: string, label: string): string {
  const seed = parseInt(createHash('sha256').update(handle).digest('hex').slice(0, 8), 16);
  const rand = mulberry32(seed);
  return `${ADJECTIVES[Math.floor(rand() * ADJECTIVES.length)]} ${NOUNS[Math.floor(rand() * NOUNS.length)]} ${label}`;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRICE_MINOR: Record<ProductType, number> = {
  T_SHIRT: 2900,
  LONG_SLEEVE: 5900,
  HOODIE: 7900,
  SHORTS: 4500,
  PANTS: 6500,
  DRESS: 8900,
};

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  if (!s3) {
    console.log(`  [MOCK] would upload ${key}`);
    return;
  }
  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }),
  );
}

function shortHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

const CONTENT_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

async function readPair(dir: string): Promise<{ front: Photo; back: Photo | null } | null> {
  const files = await readdir(dir);
  const find = async (side: string): Promise<Photo | null> => {
    const match = files.find((f) => f.startsWith(`${side}.`));
    if (!match) return null;
    const ext = match.split('.').pop()!.toLowerCase();
    const contentType = CONTENT_TYPES[ext];
    if (!contentType) return null;
    return { buffer: await readFile(join(dir, match)), contentType, ext };
  };
  const front = await find('front');
  if (!front) return null;
  return { front, back: await find('back') };
}

interface Photo {
  buffer: Buffer;
  contentType: string;
  ext: string;
}

async function main(): Promise<void> {
  if (!existsSync(PHOTO_DIR)) {
    throw new Error(`No photos at ${PHOTO_DIR} - expected front/back pairs, one directory each`);
  }

  const dryRun = hasFlag('dry-run');
  const bake = !hasFlag('no-bake');
  const genderSplit = hasFlag('gender-split');
  const typeFilter = argValue('type')?.toUpperCase();
  const limit = Number(argValue('limit') ?? Number.POSITIVE_INFINITY);

  const queue =
    bake && !dryRun
      ? new Queue(QUEUE.GARMENT_GENERATION, {
          connection: bullConnectionOptions(process.env.REDIS_URL ?? 'redis://localhost:6379'),
        })
      : null;

  const manifest: { handle: string; dir: string }[] = JSON.parse(
    await readFile(join(PHOTO_DIR, 'manifest.json'), 'utf8'),
  );
  const entries = manifest
    .map((entry) => ({ handle: entry.handle, dirName: entry.dir.split(/[\\/]/).pop()! }))
    .sort((a, b) => a.dirName.localeCompare(b.dirName));

  let imported = 0;
  let queued = 0;
  const skipped: string[] = [];

  try {
    for (const [index, { handle, dirName }] of entries.entries()) {
      if (imported >= limit) break;

      const garment = classify(dirName);
      if (!garment) {
        skipped.push(`${dirName} - not a single-garment photo`);
        continue;
      }
      if (typeFilter && garment.productType !== typeFilter) continue;

      const pair = await readPair(join(PHOTO_DIR, dirName));
      if (!pair) {
        skipped.push(`${dirName} - no readable front photo`);
        continue;
      }

      const name = nameFor(dirName, garment.label);
      const { colorName, colorHex } = colourFor(dirName);
      const gender: Gender = genderSplit && index % 2 === 1 ? 'FEMALE' : 'MALE';
      const slug = `blanks-${handle}`;

      if (dryRun) {
        console.log(
          `${slug}\n  ${name} | ${garment.productType}/${garment.category} | ${gender} | ${colorName} | ${pair.back ? 'front+back' : 'front only'}`,
        );
        imported += 1;
        continue;
      }

      const product = await prisma.product.upsert({
        where: { slug },
        create: {
          slug,
          name,
          description: `${colorName} ${garment.label.toLowerCase()}, photographed front and back and baked onto the avatar in the fitting room.`,
          productType: garment.productType,
          category: garment.category,
          gender,
          basePriceMinor: PRICE_MINOR[garment.productType],
          currency: 'EUR',
          availableSizes: DEFAULT_SIZES,
          fulfillmentType: 'STOCKED',
          materials: ['Cotton'],
          careInstructions: 'Machine wash cold, tumble dry low.',
          weightGrams: garment.productType === 'HOODIE' ? 600 : 300,
          isPublished: true,
        },
        update: { name, productType: garment.productType, category: garment.category, gender, isPublished: true },
      });

      const existingVariant = await prisma.productVariant.findFirst({ where: { productId: product.id } });
      const variant = existingVariant
        ? await prisma.productVariant.update({
            where: { id: existingVariant.id },
            data: { name: colorName, colorName, colorHex, isPublished: true },
          })
        : await prisma.productVariant.create({
            data: { productId: product.id, name: colorName, colorName, colorHex, isPublished: true },
          });

      for (const size of product.availableSizes) {
        const sku = InventoryService.buildSku(product.slug, variant.id, size);
        await prisma.inventoryItem.upsert({
          where: { productId_variantId_size: { productId: product.id, variantId: variant.id, size } },
          create: { sku, productId: product.id, variantId: variant.id, size, quantityAvailable: 12, reorderThreshold: 3 },
          update: { sku },
        });
      }

      const thumbnail = await sharp(pair.front.buffer)
        .resize(600, 600, { fit: 'contain', background: '#e9e9e9' })
        .webp()
        .toBuffer();
      const hash = shortHash(thumbnail);
      const productThumbnailKey = StorageKeys.productThumbnail(product.id, hash);
      const variantThumbnailKey = StorageKeys.variantThumbnail(product.id, variant.id, hash);
      await putObject(productThumbnailKey, thumbnail, 'image/webp');
      await putObject(variantThumbnailKey, thumbnail, 'image/webp');
      await prisma.product.update({ where: { id: product.id }, data: { thumbnailKey: productThumbnailKey } });
      await prisma.productVariant.update({ where: { id: variant.id }, data: { thumbnailKey: variantThumbnailKey } });

      imported += 1;
      console.log(`product  ${slug} - ${name} (${garment.productType}/${garment.category}, ${gender})`);

      if (!bake) continue;

      const garment3d = await prisma.garment3D.upsert({
        where: { productId: product.id },
        create: { productId: product.id, generationStatus: 'PENDING', generationProvider: 'LOCAL_BAKE' },
        update: { generationStatus: 'PENDING', generationProvider: 'LOCAL_BAKE', failureReason: null },
      });

      const photos = [pair.front, ...(pair.back ? [pair.back] : [])];
      const sourceKeys: string[] = [];
      for (const [viewIndex, photo] of photos.entries()) {
        const key = StorageKeys.garmentSourceUpload(garment3d.id, viewIndex, photo.ext);
        await putObject(key, photo.buffer, photo.contentType);
        sourceKeys.push(key);
      }
      await prisma.garment3D.update({ where: { id: garment3d.id }, data: { sourceKeys } });

      await queue!.add(JOB.GENERATE_GARMENT, { garmentId: garment3d.id }, { jobId: `${garment3d.id}-${Date.now()}` });
      queued += 1;
      console.log(`  queued bake ${garment3d.id} (${photos.length} photo(s))`);
    }
  } finally {
    await queue?.close();
    await prisma.$disconnect();
  }

  console.log(`\n${dryRun ? 'Would import' : 'Imported'} ${imported} product(s); queued ${queued} bake(s).`);
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length}:`);
    for (const line of skipped) console.log(`  ${line}`);
  }
  if (queued > 0) {
    console.log(
      `\nBakes run one at a time at ~3 min each, so expect roughly ${Math.ceil((queued * 3) / 60)}h before the last one lands.` +
        `\nProgress: http://localhost:4000/api/admin/queues`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
