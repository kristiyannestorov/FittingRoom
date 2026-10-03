import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ClothingSize } from '@prisma/client';
import type { Env } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { JOB, QUEUE } from '../queue/queue.constants';
import { NotificationsService } from '../notifications/notifications.service';

export interface StockLine {
  productId: string;
  variantId: string;
  size: ClothingSize;
  quantity: number;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  static buildSku(productSlug: string, variantId: string, size: ClothingSize): string {
    return `${productSlug}-${variantId.slice(0, 8)}-${size}`.toUpperCase();
  }

  async reserve(
    lines: StockLine[],
    orderId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;

    for (const line of lines) {
      const item = await client.inventoryItem.findUnique({
        where: {
          productId_variantId_size: {
            productId: line.productId,
            variantId: line.variantId,
            size: line.size,
          },
        },
        include: { product: { select: { fulfillmentType: true, name: true } } },
      });

      if (!item) {
        throw new BadRequestException(
          `No stock record for product ${line.productId} in size ${line.size}`,
        );
      }

      if (item.product.fulfillmentType === 'MADE_TO_ORDER') continue;

      const updated = await client.inventoryItem.updateMany({
        where: { id: item.id, quantityAvailable: { gte: line.quantity } },
        data: {
          quantityAvailable: { decrement: line.quantity },
          quantityReserved: { increment: line.quantity },
        },
      });

      if (updated.count === 0) {
        throw new BadRequestException(
          `${item.product.name} in size ${line.size} is out of stock`,
        );
      }

      await client.inventoryMovement.create({
        data: {
          inventoryItemId: item.id,
          delta: -line.quantity,
          reason: 'RESERVED_FOR_ORDER',
          orderId,
        },
      });
    }
  }

  async commit(lines: StockLine[], orderId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;

    for (const line of lines) {
      const item = await client.inventoryItem.findUnique({
        where: {
          productId_variantId_size: {
            productId: line.productId,
            variantId: line.variantId,
            size: line.size,
          },
        },
        include: { product: { select: { fulfillmentType: true } } },
      });
      if (!item || item.product.fulfillmentType === 'MADE_TO_ORDER') continue;

      const amount = Math.min(line.quantity, item.quantityReserved);
      if (amount === 0) continue;

      await client.inventoryItem.update({
        where: { id: item.id },
        data: { quantityReserved: { decrement: amount } },
      });

      await client.inventoryMovement.create({
        data: {
          inventoryItemId: item.id,
          delta: 0,
          reason: 'RESERVATION_COMMITTED',
          orderId,
        },
      });

      await this.queue.enqueue(QUEUE.INVENTORY, JOB.CHECK_LOW_STOCK, {
        inventoryItemId: item.id,
      });
    }
  }

  async release(lines: StockLine[], orderId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const client = tx ?? this.prisma;

    for (const line of lines) {
      const item = await client.inventoryItem.findUnique({
        where: {
          productId_variantId_size: {
            productId: line.productId,
            variantId: line.variantId,
            size: line.size,
          },
        },
        include: { product: { select: { fulfillmentType: true } } },
      });
      if (!item || item.product.fulfillmentType === 'MADE_TO_ORDER') continue;

      const amount = Math.min(line.quantity, item.quantityReserved);
      if (amount === 0) continue;

      await client.inventoryItem.update({
        where: { id: item.id },
        data: {
          quantityAvailable: { increment: amount },
          quantityReserved: { decrement: amount },
        },
      });

      await client.inventoryMovement.create({
        data: {
          inventoryItemId: item.id,
          delta: amount,
          reason: 'RESERVATION_RELEASED',
          orderId,
        },
      });
    }
  }

  async adjust(
    sku: string,
    delta: number,
    reason: string,
    actorUserId: string,
  ): Promise<{ sku: string; quantityAvailable: number }> {
    const item = await this.prisma.inventoryItem.findUnique({ where: { sku } });
    if (!item) throw new BadRequestException(`Unknown SKU ${sku}`);

    if (item.quantityAvailable + delta < 0) {
      throw new BadRequestException(
        `Adjustment would take ${sku} to ${item.quantityAvailable + delta}`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.inventoryItem.update({
        where: { id: item.id },
        data: {
          quantityAvailable: { increment: delta },
          ...(delta > 0 ? { lowStockNotifiedAt: null } : {}),
        },
      });
      await tx.inventoryMovement.create({
        data: { inventoryItemId: item.id, delta, reason, actorUserId },
      });
      return next;
    });

    await this.queue.enqueue(QUEUE.INVENTORY, JOB.CHECK_LOW_STOCK, {
      inventoryItemId: item.id,
    });

    return { sku: updated.sku, quantityAvailable: updated.quantityAvailable };
  }

  async availableSizes(productId: string, variantId: string): Promise<ClothingSize[]> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { fulfillmentType: true, availableSizes: true },
    });
    if (!product) return [];
    if (product.fulfillmentType === 'MADE_TO_ORDER') return product.availableSizes;

    const rows = await this.prisma.inventoryItem.findMany({
      where: { productId, variantId, quantityAvailable: { gt: 0 } },
      select: { size: true },
    });
    return rows.map((row) => row.size);
  }

  async lowStockItems() {
    return this.prisma.$queryRaw<
      { id: string; sku: string; quantityAvailable: number; reorderThreshold: number }[]
    >`
      SELECT i.id, i.sku, i."quantityAvailable", i."reorderThreshold"
      FROM inventory i
      JOIN products p ON p.id = i."productId"
      WHERE p."fulfillmentType" = 'STOCKED'
        AND i."quantityAvailable" <= i."reorderThreshold"
      ORDER BY i."quantityAvailable" ASC
    `;
  }

  async checkLowStock(inventoryItemId: string): Promise<void> {
    const item = await this.prisma.inventoryItem.findUnique({ where: { id: inventoryItemId } });
    if (!item) return;
    if (item.quantityAvailable > item.reorderThreshold) return;
    if (item.lowStockNotifiedAt) return;

    await this.prisma.inventoryItem.update({
      where: { id: item.id },
      data: { lowStockNotifiedAt: new Date() },
    });

    await this.notifications.queueLowStockAlert(
      this.config.get('ADMIN_ALERT_EMAIL', { infer: true }),
      item.sku,
      item.quantityAvailable,
      item.reorderThreshold,
    );
  }
}
