import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { StorageKeys } from '../src/storage/storage.service';
import { DEFAULT_AVATAR_ID } from '../src/assets/products.service';

loadEnv({ path: join(__dirname, '..', '.env') });

const GARMENT3D_DIR = join(__dirname, '..', '..', 'garment3d-service');
const DEFAULT_TEXTURE_PATH = join(GARMENT3D_DIR, 'baked-tee.png');
const AVATAR_PATH = join(GARMENT3D_DIR, 'avatar-default.glb');

const DEFAULT_SLUG = 'tshirt';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'dev',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'dev',
  },
});
const BUCKET = process.env.S3_BUCKET ?? 'zed-assets';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
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

async function main(): Promise<void> {
  if (!process.env.S3_ENDPOINT) throw new Error('S3_ENDPOINT is not set - is apps/api/.env loaded?');
  const TEXTURE_PATH = argValue('texture') ?? DEFAULT_TEXTURE_PATH;
  for (const path of [TEXTURE_PATH, AVATAR_PATH]) {
    if (!existsSync(path)) {
      throw new Error(`Missing ${path} - run apps/garment3d-service/bake_texture.py first`);
    }
  }

  const slug = argValue('slug') ?? DEFAULT_SLUG;
  const product = await prisma.product.findUnique({ where: { slug } });
  if (!product) throw new Error(`No product with slug "${slug}"`);

  const avatarBuffer = await readFile(AVATAR_PATH);
  const avatarKey = StorageKeys.avatarModel(DEFAULT_AVATAR_ID);
  await putObject(avatarKey, avatarBuffer, 'model/gltf-binary');
  console.log(`Uploaded avatar -> ${avatarKey} (${avatarBuffer.byteLength} bytes)`);

  const textureBuffer = await readFile(TEXTURE_PATH);
  const textureHash = createHash('sha256').update(textureBuffer).digest('hex').slice(0, 16);
  const textureKey = StorageKeys.garmentTexture(product.id, textureHash);
  await putObject(textureKey, textureBuffer, 'image/png');
  console.log(`Uploaded texture -> ${textureKey} (${textureBuffer.byteLength} bytes)`);

  const textureMeshSource = argValue('mesh-source') ?? null;
  const textureMeshName = argValue('mesh-name') ?? (textureMeshSource ? 'Garment' : null);

  await prisma.garment3D.upsert({
    where: { productId: product.id },
    create: {
      productId: product.id,
      textureKey,
      textureMeshSource,
      textureMeshName,
      generationStatus: 'COMPLETED',
      generationProvider: 'LOCAL_BAKE',
      confidenceScore: 0.75,
    },
    update: {
      textureKey,
      textureMeshSource,
      textureMeshName,
      modelKey: null,
      generationStatus: 'COMPLETED',
      generationProvider: 'LOCAL_BAKE',
      confidenceScore: 0.75,
      failureReason: null,
    },
  });

  console.log(`\nAttached baked garment to "${product.name}" (/products/${product.slug})`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
