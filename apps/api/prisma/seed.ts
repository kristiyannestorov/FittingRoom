import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as argon2 from 'argon2';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  type ClothingSize,
  type Gender,
  type ProductCategory,
  type ProductType,
} from '@zed/contracts';
import sharp from 'sharp';
import { InventoryService } from '../src/inventory/inventory.service';
import { StorageKeys } from '../src/storage/storage.service';
import { AVATAR_IDS, DEFAULT_AVATAR_ID } from '../src/assets/products.service';
import { solidColorPng } from './placeholder-thumbnail';
import { buildTshirtGlb } from './glb-placeholder';

loadEnv({ path: join(__dirname, '..', '.env') });

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const s3Endpoint = process.env.S3_ENDPOINT;
const s3Disabled = !s3Endpoint;
const s3 = !s3Disabled ? new S3Client({
  endpoint: s3Endpoint,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'dev',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'dev',
  },
}) : null;
const BUCKET = process.env.S3_BUCKET ?? 'zed-assets';

interface SeedProduct {
  slug: string;
  name: string;
  productType: ProductType;
  category: ProductCategory;
  gender: Gender;
  basePriceMinor: number;
  colorName: string;
  colorHex: string;
  imageUrl?: string;
}

async function main(): Promise<void> {
  console.log('Seeding admin and demo customer...');
  const adminPassword = 'ChangeMe123!';
  const customerPassword = 'ChangeMe123!';

  const admin = await prisma.user.upsert({
    where: { email: 'admin@projectzed.bg' },
    create: {
      email: 'admin@projectzed.bg',
      fullName: 'Store Admin',
      role: 'ADMIN',
      passwordHash: await argon2.hash(adminPassword),
    },
    update: {},
  });

  const customer = await prisma.user.upsert({
    where: { email: 'customer@example.com' },
    create: {
      email: 'customer@example.com',
      fullName: 'Demo Customer',
      role: 'CUSTOMER',
      passwordHash: await argon2.hash(customerPassword),
    },
    update: {},
  });

  console.log(`  admin@projectzed.bg / ${adminPassword}`);
  console.log(`  customer@example.com / ${customerPassword}`);

  console.log('Seeding catalog...');

  await seedProduct({
    slug: 'demo-shift-dress',
    name: 'Demo Shift Dress',
    description: 'A classic shift dress in comfortable cotton blend.',
    productType: 'DRESS',
    category: 'SHIFT',
    gender: 'FEMALE',
    basePriceMinor: 12900,
    availableSizes: ['XS', 'S', 'M', 'L', 'XL'],
    materials: ['Cotton blend'],
    careInstructions: 'Machine wash cold, hang dry.',
    weightGrams: 350,
    colorName: 'Black',
    colorHex: '#111111',
  });

  const tshirts = buildTshirts();
  for (const product of tshirts) {
    await seedProduct(product);
  }

  console.log('Seeding 3D fitting room demo (shared avatar + one garment)...');
  try {
    await seedFittingRoomDemo(tshirts[0]);
  } catch (error) {
    console.warn(`  Skipping 3D fitting room seed: ${(error as Error).message}`);
  }

  for (const product of buildShorts()) {
    await seedProduct(product);
  }
  for (const product of buildPants()) {
    await seedProduct(product);
  }
  for (const product of buildLongSleeves()) {
    await seedProduct(product);
  }

  console.log('Importing real catalog data from DummyJSON...');
  try {
    const realProducts = await fetchDummyJsonProducts();
    for (const product of realProducts) {
      await seedProduct(product);
    }
    console.log(`  imported ${realProducts.length} real products`);
  } catch (error) {
    console.warn(`  Skipping DummyJSON import: ${(error as Error).message}`);
  }

  console.log(`Seed complete: admin ${admin.id}, customer ${customer.id}`);
}

const TSHIRT_COLORS: { name: string; hex: string }[] = [
  { name: 'Black', hex: '#111111' },
  { name: 'White', hex: '#f5f5f0' },
  { name: 'Heather Grey', hex: '#9a9a9a' },
  { name: 'Navy', hex: '#1b2a4a' },
  { name: 'Forest Green', hex: '#2f4f36' },
  { name: 'Burgundy', hex: '#6d2333' },
  { name: 'Sand', hex: '#c9b896' },
  { name: 'Sky Blue', hex: '#8fb8d8' },
  { name: 'Charcoal', hex: '#36393f' },
  { name: 'Rust', hex: '#a3521f' },
];

const TSHIRT_STYLES: { category: ProductCategory; label: string }[] = [
  { category: 'CREW_NECK', label: 'Crew Neck Tee' },
  { category: 'V_NECK', label: 'V-Neck Tee' },
  { category: 'GRAPHIC', label: 'Graphic Tee' },
];

function buildTshirts(): SeedProduct[] {
  const products: SeedProduct[] = [];
  let index = 0;
  for (const style of TSHIRT_STYLES) {
    for (const color of TSHIRT_COLORS) {
      const gender: Gender = index % 2 === 0 ? 'FEMALE' : 'MALE';
      const priceMinor = 2900 + (index % 5) * 300;
      products.push({
        slug: `tshirt-${slugify(style.category)}-${slugify(color.name)}-${gender.toLowerCase()}`,
        name: `${color.name} ${style.label}`,
        productType: 'T_SHIRT',
        category: style.category,
        gender,
        basePriceMinor: priceMinor,
        colorName: color.name,
        colorHex: color.hex,
      });
      index += 1;
    }
  }
  return products.slice(0, 30);
}

const SHORTS_STYLES: { category: ProductCategory; label: string; color: { name: string; hex: string } }[] = [
  { category: 'CHINO', label: 'Chino Shorts', color: { name: 'Khaki', hex: '#c3b091' } },
  { category: 'DENIM', label: 'Denim Shorts', color: { name: 'Washed Blue', hex: '#5b7c99' } },
  { category: 'ATHLETIC', label: 'Athletic Shorts', color: { name: 'Black', hex: '#111111' } },
];

function buildShorts(): SeedProduct[] {
  return SHORTS_STYLES.map((style, index) => ({
    slug: `shorts-${slugify(style.category)}-${index}`,
    name: `${style.color.name} ${style.label}`,
    productType: 'SHORTS' as ProductType,
    category: style.category,
    gender: (index % 2 === 0 ? 'MALE' : 'FEMALE') as Gender,
    basePriceMinor: 3900 + index * 400,
    colorName: style.color.name,
    colorHex: style.color.hex,
  }));
}

const LONG_SLEEVE_STYLES: { category: ProductCategory; label: string; color: { name: string; hex: string } }[] = [
  { category: 'HENLEY', label: 'Henley', color: { name: 'Oatmeal', hex: '#ddd2bd' } },
  { category: 'WAFFLE_KNIT', label: 'Waffle Knit Top', color: { name: 'Charcoal', hex: '#36393f' } },
  { category: 'BUTTON_UP', label: 'Button-Up Shirt', color: { name: 'White', hex: '#f5f5f0' } },
];

const PANTS_STYLES: { category: ProductCategory; label: string; color: { name: string; hex: string } }[] = [
  { category: 'CHINO', label: 'Chinos', color: { name: 'Stone', hex: '#b9ae95' } },
  { category: 'DENIM', label: 'Straight Jeans', color: { name: 'Indigo', hex: '#31456b' } },
  { category: 'ATHLETIC', label: 'Track Pants', color: { name: 'Slate', hex: '#4a4f57' } },
];

function buildPants(): SeedProduct[] {
  return PANTS_STYLES.map((style, index) => ({
    slug: `pants-${slugify(style.category)}-${index}`,
    name: `${style.color.name} ${style.label}`,
    productType: 'PANTS' as ProductType,
    category: style.category,
    gender: (index % 2 === 0 ? 'MALE' : 'FEMALE') as Gender,
    basePriceMinor: 5900 + index * 500,
    colorName: style.color.name,
    colorHex: style.color.hex,
  }));
}

function buildLongSleeves(): SeedProduct[] {
  return LONG_SLEEVE_STYLES.map((style, index) => ({
    slug: `long-sleeve-${slugify(style.category)}-${index}`,
    name: `${style.color.name} ${style.label}`,
    productType: 'LONG_SLEEVE' as ProductType,
    category: style.category,
    gender: (index % 2 === 0 ? 'FEMALE' : 'MALE') as Gender,
    basePriceMinor: 4500 + index * 500,
    colorName: style.color.name,
    colorHex: style.color.hex,
  }));
}

const DUMMYJSON_CATEGORIES: { slug: string; gender: Gender; kind: 'shirt' | 'dress' }[] = [
  { slug: 'mens-shirts', gender: 'MALE', kind: 'shirt' },
  { slug: 'tops', gender: 'FEMALE', kind: 'dress' },
  { slug: 'womens-dresses', gender: 'FEMALE', kind: 'dress' },
];

const USD_TO_EUR = 0.92;

const COLOR_KEYWORDS: { name: string; hex: string }[] = [
  { name: 'Black', hex: '#111111' },
  { name: 'White', hex: '#f5f5f0' },
  { name: 'Red', hex: '#a3241f' },
  { name: 'Navy', hex: '#1b2a4a' },
  { name: 'Blue', hex: '#2b4c7e' },
  { name: 'Gray', hex: '#9a9a9a' },
  { name: 'Grey', hex: '#9a9a9a' },
  { name: 'Green', hex: '#2f4f36' },
  { name: 'Pink', hex: '#d98ba1' },
  { name: 'Purple', hex: '#5c4a72' },
  { name: 'Yellow', hex: '#d8c23a' },
  { name: 'Orange', hex: '#c9701f' },
  { name: 'Brown', hex: '#5a3d2b' },
  { name: 'Beige', hex: '#c9b896' },
  { name: 'Khaki', hex: '#c3b091' },
  { name: 'Tan', hex: '#c9a87c' },
  { name: 'Gold', hex: '#b6963f' },
  { name: 'Silver', hex: '#b8bcc2' },
  { name: 'Cream', hex: '#efe6d5' },
];
const DEFAULT_COLOR = { name: 'Charcoal', hex: '#36393f' };

function extractColor(title: string): { name: string; hex: string } {
  const lower = title.toLowerCase();
  return COLOR_KEYWORDS.find((c) => lower.includes(c.name.toLowerCase())) ?? DEFAULT_COLOR;
}

function classifyShirt(title: string): { productType: ProductType; category: ProductCategory } {
  const lower = title.toLowerCase();
  if (lower.includes('tshirt') || lower.includes('t-shirt') || lower.includes('tee')) {
    return { productType: 'T_SHIRT', category: 'GRAPHIC' };
  }
  return { productType: 'LONG_SLEEVE', category: 'BUTTON_UP' };
}

function classifyDress(title: string): ProductCategory {
  const lower = title.toLowerCase();
  if (lower.includes('gown')) return 'BALL_GOWN';
  if (lower.includes('maxi')) return 'MAXI';
  if (lower.includes('wrap')) return 'WRAP';
  if (lower.includes('slip')) return 'SLIP';
  if (lower.includes('bodycon')) return 'BODYCON';
  if (lower.includes('a-line') || lower.includes('aline')) return 'A_LINE';
  return 'SHIFT';
}

function slugifyTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

interface DummyJsonProduct {
  id: number;
  title: string;
  price: number;
  thumbnail: string;
}

async function fetchDummyJsonProducts(): Promise<(SeedProduct & { imageUrl: string })[]> {
  const results: (SeedProduct & { imageUrl: string })[] = [];

  for (const source of DUMMYJSON_CATEGORIES) {
    const res = await fetch(`https://dummyjson.com/products/category/${source.slug}?limit=100`);
    if (!res.ok) throw new Error(`DummyJSON ${source.slug} responded ${res.status}`);
    const body = (await res.json()) as { products: DummyJsonProduct[] };

    for (const item of body.products) {
      const color = extractColor(item.title);
      const basePriceMinor = Math.round(item.price * USD_TO_EUR * 100);
      const { productType, category } =
        source.kind === 'shirt' ? classifyShirt(item.title) : { productType: 'DRESS' as ProductType, category: classifyDress(item.title) };

      results.push({
        slug: `dummyjson-${item.id}-${slugifyTitle(item.title)}`,
        name: item.title,
        productType,
        category,
        gender: source.gender,
        basePriceMinor,
        colorName: color.name,
        colorHex: color.hex,
        imageUrl: item.thumbnail,
      });
    }
  }

  return results;
}

async function fetchImageBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function seedProduct(
  input: SeedProduct & {
    description?: string;
    availableSizes?: ClothingSize[];
    materials?: string[];
    careInstructions?: string;
    weightGrams?: number;
  },
): Promise<void> {
  const availableSizes = input.availableSizes ?? (['XS', 'S', 'M', 'L', 'XL'] as ClothingSize[]);

  const product = await prisma.product.upsert({
    where: { slug: input.slug },
    create: {
      slug: input.slug,
      name: input.name,
      description: input.description ?? `${input.name}.`,
      productType: input.productType,
      category: input.category,
      gender: input.gender,
      basePriceMinor: input.basePriceMinor,
      currency: 'EUR',
      availableSizes,
      fulfillmentType: 'STOCKED',
      materials: input.materials ?? ['Cotton blend'],
      careInstructions: input.careInstructions ?? 'Machine wash cold, tumble dry low.',
      weightGrams: input.weightGrams ?? 250,
      isPublished: true,
    },
    update: { isPublished: true },
  });

  const existingVariant = await prisma.productVariant.findFirst({ where: { productId: product.id } });
  const variant = existingVariant
    ? await prisma.productVariant.update({
        where: { id: existingVariant.id },
        data: { isPublished: true },
      })
    : await prisma.productVariant.create({
        data: {
          productId: product.id,
          name: input.colorName,
          colorName: input.colorName,
          colorHex: input.colorHex,
          isPublished: true,
        },
      });

  for (const size of product.availableSizes) {
    const sku = InventoryService.buildSku(product.slug, variant.id, size);
    await prisma.inventoryItem.upsert({
      where: { productId_variantId_size: { productId: product.id, variantId: variant.id, size } },
      create: {
        sku,
        productId: product.id,
        variantId: variant.id,
        size,
        quantityAvailable: 12,
        reorderThreshold: 3,
      },
      update: { sku },
    });
  }

  if (input.imageUrl) {
    try {
      const photo = await fetchImageBuffer(input.imageUrl);
      const thumbnail = await sharp(photo).resize(600, 600, { fit: 'cover' }).webp().toBuffer();
      const thumbnailHash = shortHash(thumbnail);
      const productThumbnailKey = StorageKeys.productThumbnail(product.id, thumbnailHash);
      const variantThumbnailKey = StorageKeys.variantThumbnail(product.id, variant.id, thumbnailHash);

      await putObject(productThumbnailKey, thumbnail, 'image/webp');
      await putObject(variantThumbnailKey, thumbnail, 'image/webp');

      await prisma.product.update({ where: { id: product.id }, data: { thumbnailKey: productThumbnailKey } });
      await prisma.productVariant.update({
        where: { id: variant.id },
        data: { thumbnailKey: variantThumbnailKey },
      });
      return;
    } catch (error) {
      console.warn(`  Photo import failed for ${input.slug}, falling back to swatch: ${(error as Error).message}`);
    }
  }

  const thumbnail = solidColorPng(input.colorHex);
  const thumbnailHash = shortHash(thumbnail);
  const productThumbnailKey = `public/products/${product.id}/thumb.${thumbnailHash}.png`;
  const variantThumbnailKey = `public/products/${product.id}/variants/${variant.id}/thumb.${thumbnailHash}.png`;
  await putObject(productThumbnailKey, thumbnail, 'image/png');
  await putObject(variantThumbnailKey, thumbnail, 'image/png');
  await prisma.product.update({ where: { id: product.id }, data: { thumbnailKey: productThumbnailKey } });
  await prisma.productVariant.update({
    where: { id: variant.id },
    data: { thumbnailKey: variantThumbnailKey },
  });
}

const AVATAR_SOURCE_URL =
  'https://raw.githubusercontent.com/readyplayerme/rpm-unity-sdk-core/main/Samples~/QuickStart/PreviewAvatar/PreviewMesh.glb';

const FEMALE_AVATAR_PATH = join(
  __dirname,
  '..',
  '..',
  'garment3d-service',
  'avatar-female.glb',
);

const BAKED_TEXTURE_PATH = join(__dirname, '..', '..', 'garment3d-service', 'baked-tee.png');

async function seedDemoGarment(productId: string, colorHex: string) {
  if (existsSync(BAKED_TEXTURE_PATH)) {
    const textureBuffer = await readFile(BAKED_TEXTURE_PATH);
    const textureKey = StorageKeys.garmentTexture(productId, shortHash(textureBuffer));
    await putObject(textureKey, textureBuffer, 'image/png');

    return prisma.garment3D.upsert({
      where: { productId },
      create: {
        productId,
        textureKey,
        generationStatus: 'COMPLETED',
        generationProvider: 'LOCAL_BAKE',
        confidenceScore: 0.75,
      },
      update: {
        textureKey,
        modelKey: null,
        generationStatus: 'COMPLETED',
        generationProvider: 'LOCAL_BAKE',
        confidenceScore: 0.75,
        failureReason: null,
      },
    });
  }

  const garmentBuffer = buildTshirtGlb(colorHex);
  const modelKey = StorageKeys.garmentModel(productId, shortHash(garmentBuffer));
  await putObject(modelKey, garmentBuffer, 'model/gltf-binary');

  return prisma.garment3D.upsert({
    where: { productId },
    create: {
      productId,
      modelKey,
      generationStatus: 'COMPLETED',
      generationProvider: 'MANUAL',
      confidenceScore: 1.0,
    },
    update: {
      modelKey,
      textureKey: null,
      generationStatus: 'COMPLETED',
      generationProvider: 'MANUAL',
      confidenceScore: 1.0,
      failureReason: null,
    },
  });
}

async function seedFittingRoomDemo(tshirt: SeedProduct): Promise<void> {
  const avatarBuffer = await fetchImageBuffer(AVATAR_SOURCE_URL);
  await putObject(StorageKeys.avatarModel(DEFAULT_AVATAR_ID), avatarBuffer, 'model/gltf-binary');

  if (existsSync(FEMALE_AVATAR_PATH)) {
    await putObject(
      StorageKeys.avatarModel(AVATAR_IDS.FEMALE),
      await readFile(FEMALE_AVATAR_PATH),
      'model/gltf-binary',
    );
  } else {
    console.warn(`  Female avatar missing at ${FEMALE_AVATAR_PATH}; viewer will only offer the male body.`);
  }

  const product = await prisma.product.findUniqueOrThrow({ where: { slug: tshirt.slug } });
  const garment = await seedDemoGarment(product.id, tshirt.colorHex);

  for (const size of ['S', 'M', 'L', 'XL'] as const) {
    const spec = SIZE_MEASUREMENT_DELTAS[size];
    await prisma.garmentMeasurement.upsert({
      where: { garmentId_size: { garmentId: garment.id, size } },
      create: { garmentId: garment.id, size, ...spec },
      update: spec,
    });
  }

  console.log(`  seeded avatar + placeholder garment for ${tshirt.slug}`);
}

const SIZE_MEASUREMENT_DELTAS: Record<'S' | 'M' | 'L' | 'XL', { chestCm: number; waistCm: number; shoulderCm: number; lengthCm: number; sleeveLengthCm: number }> = {
  S: { chestCm: 96, waistCm: 94, shoulderCm: 44, lengthCm: 68, sleeveLengthCm: 20 },
  M: { chestCm: 102, waistCm: 100, shoulderCm: 46, lengthCm: 70, sleeveLengthCm: 21 },
  L: { chestCm: 108, waistCm: 106, shoulderCm: 48, lengthCm: 72, sleeveLengthCm: 22 },
  XL: { chestCm: 114, waistCm: 112, shoulderCm: 50, lengthCm: 74, sleeveLengthCm: 23 },
};

function slugify(value: string): string {
  return value.toLowerCase().replace(/_/g, '-');
}

async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  if (s3Disabled || !s3) {
    console.log(`[MOCK] Would upload ${key}`);
    return;
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
}

function shortHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
