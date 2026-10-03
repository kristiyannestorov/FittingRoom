import 'dotenv/config';
import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Queue } from 'bullmq';
import { JOB, QUEUE, bullConnectionOptions } from '../src/queue/queue.constants';

loadEnv({ path: join(__dirname, '..', '.env') });

const RPM_AVATAR_FILENAME = 'avatar-default.glb';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const queue = new Queue(QUEUE.GARMENT_GENERATION, {
    connection: bullConnectionOptions(process.env.REDIS_URL ?? 'redis://localhost:6379'),
  });

  try {
    const mesh = argValue('mesh');
    const slug = argValue('slug');
    const garments = await prisma.garment3D.findMany({
      where: {
        textureMeshSource: mesh ? mesh : { not: RPM_AVATAR_FILENAME },
        NOT: { textureMeshSource: null },
        ...(slug ? { product: { slug } } : {}),
      },
      include: { product: { select: { slug: true } } },
    });

    for (const garment of garments) {
      const label = `${garment.product.slug} (${garment.textureMeshSource})`;
      if (garment.sourceKeys.length === 0) {
        console.log(`skipped  ${label} - no stored photos, re-attach by hand`);
        continue;
      }
      await prisma.garment3D.update({
        where: { id: garment.id },
        data: { generationStatus: 'PENDING', failureReason: null },
      });
      await queue.add(
        JOB.GENERATE_GARMENT,
        { garmentId: garment.id },
        { jobId: `${garment.id}-${Date.now()}` },
      );
      console.log(`queued   ${label}`);
    }
  } finally {
    await queue.close();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
