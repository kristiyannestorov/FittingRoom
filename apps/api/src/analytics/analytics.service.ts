import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import type {
  ProductStatsRow,
  ProductStatsView,
  TrackProductEventInput,
} from '@zed/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';

const DEDUPE_WINDOW_SECONDS = 60 * 30;

interface StatsAggregateRow {
  productId: string;
  slug: string;
  name: string;
  productType: ProductStatsRow['productType'];
  isPublished: boolean;
  cardClicks: bigint;
  pageViews: bigint;
  uniqueVisitors: bigint;
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async track({ productId, kind, anonId }: TrackProductEventInput): Promise<boolean> {
    const key = `product-event:${anonId}:${productId}:${kind}`;
    const fresh = await this.redis.set(key, '1', 'EX', DEDUPE_WINDOW_SECONDS, 'NX');
    if (fresh === null) return false;

    const exists = await this.prisma.product.count({ where: { id: productId } });
    if (exists === 0) return false;

    await this.prisma.productEvent.create({ data: { productId, kind, anonId } });
    return true;
  }

  async productStats(days: number, limit: number): Promise<ProductStatsView> {
    const since = new Date(Date.now() - days * 86_400_000);

    const rows = await this.prisma.$queryRaw<StatsAggregateRow[]>`
      SELECT
        p."id"                                                              AS "productId",
        p."slug"                                                            AS "slug",
        p."name"                                                            AS "name",
        p."productType"                                                     AS "productType",
        p."isPublished"                                                     AS "isPublished",
        COUNT(*) FILTER (WHERE e."kind" = 'CARD_CLICK')                     AS "cardClicks",
        COUNT(*) FILTER (WHERE e."kind" = 'PAGE_VIEW')                      AS "pageViews",
        COUNT(DISTINCT e."anonId")                                          AS "uniqueVisitors"
      FROM "products" p
      JOIN "product_events" e ON e."productId" = p."id"
      WHERE e."createdAt" >= ${since}
      GROUP BY p."id", p."slug", p."name", p."productType", p."isPublished"
      ORDER BY COUNT(*) DESC
      LIMIT ${limit}
    `;

    const mapped: ProductStatsRow[] = rows.map((row) => {
      const cardClicks = Number(row.cardClicks);
      const pageViews = Number(row.pageViews);
      return {
        productId: row.productId,
        slug: row.slug,
        name: row.name,
        productType: row.productType,
        isPublished: row.isPublished,
        cardClicks,
        pageViews,
        uniqueVisitors: Number(row.uniqueVisitors),
        clickThroughRate: cardClicks === 0 ? null : Math.round((pageViews / cardClicks) * 100),
      };
    });

    return {
      days,
      totals: {
        cardClicks: mapped.reduce((sum, row) => sum + row.cardClicks, 0),
        pageViews: mapped.reduce((sum, row) => sum + row.pageViews, 0),
        trackedProducts: mapped.length,
      },
      rows: mapped,
    };
  }
}
