import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
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

loadEnv({ path: join(__dirname, '..', '.env') });

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

const DATASET_BASE =
  'https://huggingface.co/datasets/benitomartin/fashion-product-images-small-900x1200/resolve/main/data';
const SHARD_COUNT = 14;

function shardUrl(index: number): string {
  const n = String(index).padStart(5, '0');
  return `${DATASET_BASE}/train-${n}-of-00014.parquet`;
}

const META_COLUMNS = [
  'id',
  'gender',
  'articleType',
  'baseColour',
  'season',
  'year',
  'usage',
  'productDisplayName',
];

interface MyntraRow {
  id: number;
  gender: string;
  articleType: string;
  baseColour: string;
  season: string | null;
  year: number | null;
  usage: string | null;
  productDisplayName: string;
}

const ARTICLE_TYPE_TO_PRODUCT_TYPE: Record<string, ProductType> = {
  Tshirts: 'T_SHIRT',
  Shirts: 'LONG_SLEEVE',
  Shorts: 'SHORTS',
  Trousers: 'PANTS',
  Jeans: 'PANTS',
  'Track Pants': 'PANTS',
  Dresses: 'DRESS',
};

const COLOUR_HEX: Record<string, string> = {
  Black: '#111111',
  White: '#f5f5f0',
  Blue: '#2b4c7e',
  Brown: '#5a3d2b',
  Grey: '#9a9a9a',
  Red: '#a3241f',
  Green: '#2f4f36',
  Pink: '#d98ba1',
  'Navy Blue': '#1b2a4a',
  Purple: '#5c4a72',
  Silver: '#b8bcc2',
  Yellow: '#d8c23a',
  Beige: '#c9b896',
  Gold: '#b6963f',
  Maroon: '#6d2333',
  Orange: '#c9701f',
  Olive: '#6b6b3a',
  Multi: '#7d7d7d',
  Cream: '#efe6d5',
  Steel: '#7a8b99',
  Charcoal: '#36393f',
  Peach: '#f0b48a',
  'Off White': '#efece2',
  Skin: '#e6c2a6',
  Lavender: '#b9a5d1',
  'Grey Melange': '#a8a8a3',
  Khaki: '#c3b091',
  Magenta: '#b0327d',
  Teal: '#2b7d7d',
  Tan: '#c9a87c',
  Mustard: '#c9a227',
  Bronze: '#8c6239',
  Copper: '#a85c32',
  'Turquoise Blue': '#3fb8c4',
  Rust: '#a3521f',
  Burgundy: '#6d2333',
  Metallic: '#a7adb5',
  'Coffee Brown': '#4a3225',
  Mauve: '#a97f92',
  'Sea Green': '#2e8b73',
  Rose: '#d4788f',
  Nude: '#e0c0a8',
  'Mushroom Brown': '#8a7a6d',
  Taupe: '#8b7d70',
  'Lime Green': '#8fbf3f',
  'Fluorescent Green': '#6fe23f',
};
const FALLBACK_COLOUR = '#36393f';

function deriveCategory(productType: ProductType, name: string, usage: string | null): ProductCategory {
  const lower = name.toLowerCase();

  if (productType === 'T_SHIRT') {
    if (/\bv[-\s]?neck\b/.test(lower)) return 'V_NECK';
    if (/\b(printed|print|graphic|logo|typography|slogan)\b/.test(lower)) return 'GRAPHIC';
    return 'CREW_NECK';
  }

  if (productType === 'LONG_SLEEVE') {
    if (/\bhenley\b/.test(lower)) return 'HENLEY';
    if (/\bwaffle\b/.test(lower)) return 'WAFFLE_KNIT';
    return 'BUTTON_UP';
  }

  if (productType === 'SHORTS' || productType === 'PANTS') {
    if (/\b(denim|jeans?)\b/.test(lower)) return 'DENIM';
    if (usage === 'Sports' || /\b(sport|training|running|track|active|gym)\b/.test(lower)) {
      return 'ATHLETIC';
    }
    return 'CHINO';
  }

  if (/\bgown\b/.test(lower)) return 'BALL_GOWN';
  if (/\bmaxi\b/.test(lower)) return 'MAXI';
  if (/\bwrap\b/.test(lower)) return 'WRAP';
  if (/\bslip\b/.test(lower)) return 'SLIP';
  if (/\bbodycon\b/.test(lower)) return 'BODYCON';
  if (/\ba[-\s]?line\b/.test(lower)) return 'A_LINE';
  return 'SHIFT';
}

function mapGender(value: string): Gender | null {
  if (value === 'Men') return 'MALE';
  if (value === 'Women') return 'FEMALE';
  return null;
}

const PRICE_DECILES_INR: Record<'TOPWEAR' | 'SHORTS' | 'ONE_PIECE', number[]> = {
  TOPWEAR: [899, 999, 1199, 1299, 1399, 1499, 1699, 1895, 2199],
  SHORTS: [750, 990, 1198, 1299, 1299, 1499, 1499, 1797, 2199],
  ONE_PIECE: [1799, 2049, 2200, 2499, 2700, 2999, 3499, 3999, 4999],
};

const INR_TO_EUR = 0.011;

function priceBandFor(productType: ProductType): keyof typeof PRICE_DECILES_INR {
  if (productType === 'SHORTS' || productType === 'PANTS') return 'SHORTS';
  if (productType === 'DRESS') return 'ONE_PIECE';
  return 'TOPWEAR';
}

function basePriceMinorFor(productType: ProductType, id: number): number {
  const deciles = PRICE_DECILES_INR[priceBandFor(productType)];
  const bucket = parseInt(createHash('sha256').update(String(id)).digest('hex').slice(0, 8), 16);
  const inr = deciles[bucket % deciles.length];
  return Math.round(inr * INR_TO_EUR * 100);
}

const DEFAULT_SIZES: ClothingSize[] = ['XS', 'S', 'M', 'L', 'XL'];

function slugifyTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

function shortHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  if (!s3) {
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

function buildDescription(row: MyntraRow, productType: ProductType): string {
  const garment = productType.toLowerCase().replace(/_/g, ' ');
  const parts = [`${row.baseColour} ${garment}`];
  if (row.usage) parts.push(`${row.usage.toLowerCase()} wear`);
  if (row.season && row.year) parts.push(`${row.season} ${row.year} collection`);
  return `${row.productDisplayName}. ${parts.join(', ')}.`;
}

async function importProduct(row: MyntraRow, imageBytes: Uint8Array): Promise<boolean> {
  const productType = ARTICLE_TYPE_TO_PRODUCT_TYPE[row.articleType];
  const gender = mapGender(row.gender);
  if (!productType || !gender) return false;

  const slug = `myntra-${row.id}-${slugifyTitle(row.productDisplayName)}`.slice(0, 120);
  const colorName = row.baseColour || 'Multi';
  const colorHex = COLOUR_HEX[colorName] ?? FALLBACK_COLOUR;

  const product = await prisma.product.upsert({
    where: { slug },
    create: {
      slug,
      name: row.productDisplayName,
      description: buildDescription(row, productType),
      productType,
      category: deriveCategory(productType, row.productDisplayName, row.usage),
      gender,
      basePriceMinor: basePriceMinorFor(productType, row.id),
      currency: 'EUR',
      availableSizes: DEFAULT_SIZES,
      fulfillmentType: 'STOCKED',
      materials: ['Cotton blend'],
      careInstructions: 'Machine wash cold, tumble dry low.',
      weightGrams: productType === 'DRESS' ? 350 : 250,
      isPublished: true,
    },
    update: { isPublished: true },
  });

  const existingVariant = await prisma.productVariant.findFirst({
    where: { productId: product.id },
  });
  const variant = existingVariant
    ? await prisma.productVariant.update({
        where: { id: existingVariant.id },
        data: { colorName, colorHex, isPublished: true },
      })
    : await prisma.productVariant.create({
        data: {
          productId: product.id,
          name: colorName,
          colorName,
          colorHex,
          isPublished: true,
        },
      });

  for (const size of product.availableSizes) {
    const sku = InventoryService.buildSku(product.slug, variant.id, size);
    await prisma.inventoryItem.upsert({
      where: {
        productId_variantId_size: { productId: product.id, variantId: variant.id, size },
      },
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

  const thumbnail = await sharp(Buffer.from(imageBytes))
    .resize(600, 600, { fit: 'cover' })
    .webp()
    .toBuffer();
  const hash = shortHash(thumbnail);
  const productThumbnailKey = StorageKeys.productThumbnail(product.id, hash);
  const variantThumbnailKey = StorageKeys.variantThumbnail(product.id, variant.id, hash);

  await putObject(productThumbnailKey, thumbnail, 'image/webp');
  await putObject(variantThumbnailKey, thumbnail, 'image/webp');

  await prisma.product.update({
    where: { id: product.id },
    data: { thumbnailKey: productThumbnailKey },
  });
  await prisma.productVariant.update({
    where: { id: variant.id },
    data: { thumbnailKey: variantThumbnailKey },
  });

  return true;
}

const esmImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<any>;

function toNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = all ? Infinity : Number(limitArg?.split('=')[1] ?? 2000);

  const { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects } =
    await esmImport('hyparquet');

  console.log(
    `Importing real Myntra catalog data (target: ${all ? 'all matches' : `${limit} products`})...`,
  );
  if (!s3) console.warn('  S3_ENDPOINT unset, thumbnails will not be uploaded.');

  let imported = 0;
  let scanned = 0;
  let skippedNonAdult = 0;

  for (let shard = 0; shard < SHARD_COUNT && imported < limit; shard++) {
    const url = shardUrl(shard);
    const file = await asyncBufferFromUrl({ url });
    const metadata = await parquetMetadataAsync(file);

    const meta: any[] = await parquetReadObjects({ file, columns: META_COLUMNS });
    scanned += meta.length;

    const wanted = new Map<number, MyntraRow>();
    meta.forEach((r, index) => {
      const articleType = r.articleType as string;
      if (!ARTICLE_TYPE_TO_PRODUCT_TYPE[articleType]) return;
      const gender = r.gender as string;
      if (!mapGender(gender)) {
        skippedNonAdult++;
        return;
      }
      wanted.set(index, {
        id: toNumber(r.id),
        gender,
        articleType,
        baseColour: r.baseColour as string,
        season: (r.season as string) ?? null,
        year: r.year != null ? toNumber(r.year) : null,
        usage: (r.usage as string) ?? null,
        productDisplayName: r.productDisplayName as string,
      });
    });

    console.log(
      `Shard ${shard + 1}/${SHARD_COUNT}: ${meta.length} rows, ${wanted.size} match the catalog schema`,
    );

    let rowStart = 0;
    for (const group of metadata.row_groups) {
      if (imported >= limit) break;
      const rowEnd = rowStart + toNumber(group.num_rows);

      const indices = [...wanted.keys()].filter((i) => i >= rowStart && i < rowEnd);
      if (indices.length === 0) {
        rowStart = rowEnd;
        continue;
      }

      const images: any[] = await parquetReadObjects({
        file,
        columns: ['image'],
        rowStart,
        rowEnd,
        utf8: false,
      });

      for (const index of indices) {
        if (imported >= limit) break;
        const row = wanted.get(index)!;
        const bytes = images[index - rowStart]?.image?.bytes;
        if (!bytes) continue;
        try {
          if (await importProduct(row, bytes)) {
            imported++;
            if (imported % 100 === 0) console.log(`  imported ${imported}...`);
          }
        } catch (error) {
          console.warn(`  Failed ${row.id} (${row.productDisplayName}): ${(error as Error).message}`);
        }
      }

      rowStart = rowEnd;
    }
  }

  console.log(
    `\nImported ${imported} real products (scanned ${scanned} catalog rows, skipped ${skippedNonAdult} unisex/kidswear).`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
