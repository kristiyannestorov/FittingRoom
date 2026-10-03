import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { StorageKeys } from '../src/storage/storage.service';

loadEnv({ path: join(__dirname, '..', '.env') });

const GARMENT3D_DIR = join(__dirname, '..', '..', 'garment3d-service');
const LIBRARY_DIR = join(GARMENT3D_DIR, 'garments');

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

async function putGlb(key: string, path: string): Promise<number> {
  const body = await readFile(path);
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: 'model/gltf-binary',
      CacheControl: 'public, max-age=300',
    }),
  );
  return body.byteLength;
}

async function main(): Promise<void> {
  if (!process.env.S3_ENDPOINT) throw new Error('S3_ENDPOINT is not set - is apps/api/.env loaded?');
  const files = existsSync(LIBRARY_DIR)
    ? (await readdir(LIBRARY_DIR, { recursive: true, encoding: 'utf8' }))
        .filter((name) => name.endsWith('.glb'))
        .map((name) => name.split(sep).join('/'))
    : [];
  if (files.length === 0) throw new Error(`No .glb files in ${LIBRARY_DIR}`);

  for (const filename of files) {
    const key = StorageKeys.garmentLibraryMesh(filename);
    const bytes = await putGlb(key, join(LIBRARY_DIR, filename));
    console.log(`${filename.padEnd(18)} -> ${key} (${bytes} bytes)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
