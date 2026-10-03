import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';

const REVENUE_STATUSES = ['PAID', 'IN_PRODUCTION', 'PACKED', 'SHIPPED', 'DELIVERED'] as const;

export interface AdminStats {
  revenue: {
    last30DaysMinor: number;
    allTimeMinor: number;
    currency: 'EUR';
  };
  orders: {
    total: number;
    last30Days: number;
    byStatus: Record<string, number>;
  };
  inventory: {
    lowStockCount: number;
  };
  production: {
    byStatus: Record<string, number>;
  };
  recentOrders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    totalMinor: number;
    currency: string;
    createdAt: string;
  }>;
}

@Injectable()
export class AdminStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  async getStats(): Promise<AdminStats> {
    const since30d = new Date(Date.now() - 30 * 86_400_000);

    const [
      revenueLast30,
      revenueAllTime,
      ordersTotal,
      ordersLast30,
      ordersByStatus,
      lowStockItems,
      productionByStatus,
      recentOrders,
    ] = await Promise.all([
      this.prisma.order.aggregate({
        _sum: { totalMinor: true },
        where: { status: { in: [...REVENUE_STATUSES] }, createdAt: { gte: since30d } },
      }),
      this.prisma.order.aggregate({
        _sum: { totalMinor: true },
        where: { status: { in: [...REVENUE_STATUSES] } },
      }),
      this.prisma.order.count(),
      this.prisma.order.count({ where: { createdAt: { gte: since30d } } }),
      this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      this.inventory.lowStockItems(),
      this.prisma.productionTicket.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.order.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          totalMinor: true,
          currency: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      revenue: {
        last30DaysMinor: revenueLast30._sum.totalMinor ?? 0,
        allTimeMinor: revenueAllTime._sum.totalMinor ?? 0,
        currency: 'EUR',
      },
      orders: {
        total: ordersTotal,
        last30Days: ordersLast30,
        byStatus: Object.fromEntries(ordersByStatus.map((row) => [row.status, row._count._all])),
      },
      inventory: {
        lowStockCount: lowStockItems.length,
      },
      production: {
        byStatus: Object.fromEntries(
          productionByStatus.map((row) => [row.status, row._count._all]),
        ),
      },
      recentOrders: recentOrders.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        totalMinor: order.totalMinor,
        currency: order.currency,
        createdAt: order.createdAt.toISOString(),
      })),
    };
  }
}
