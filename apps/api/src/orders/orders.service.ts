import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Order, type OrderStatus } from '@prisma/client';
import { customAlphabet } from 'nanoid';
import {
  canTransition,
  type AddressInput,
  type OrderView,
  type ProductType,
} from '@zed/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { InventoryService, type StockLine } from '../inventory/inventory.service';
import { QueueService } from '../queue/queue.service';
import { JOB, QUEUE } from '../queue/queue.constants';
import { NotificationsService } from '../notifications/notifications.service';
import { CartService } from '../cart/cart.service';
import { DiscountsService } from '../discounts/discounts.service';


const orderSuffix = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

export interface CreateOrderLine {
  productId: string;
  variantId: string;
  productType: ProductType;
  size: string;
  quantity: number;
  unitPriceMinor: number;
  productName: string;
  productSlug: string;
  variantName: string | null;
  sku: string;
  thumbnailKey: string | null;
}

export interface CreatePendingOrderInput {
  userId: string;
  idempotencyKey: string;
  lines: CreateOrderLine[];
  subtotalMinor: number;
  discountCode?: string;
  shippingMinor: number;
  currency: 'EUR';
  paymentProvider: 'STRIPE' | 'PAYPAL';
  shippingProvider: 'ECONT' | 'SPEEDY';
  deliveryMode: 'ADDRESS' | 'OFFICE';
  serviceCode: string;
  address: AddressInput;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly inventory: InventoryService,
    private readonly queue: QueueService,
    private readonly notifications: NotificationsService,
    private readonly cart: CartService,
    private readonly discounts: DiscountsService,
  ) {}

  async createPendingOrder(input: CreatePendingOrderInput): Promise<Order> {
    const existing = await this.prisma.order.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      if (existing.userId !== input.userId) {
        throw new ConflictException('Idempotency key already used');
      }
      this.logger.log(`Reusing order ${existing.orderNumber} for replayed checkout`);
      return existing;
    }

    const priced = input.discountCode
      ? await this.discounts.priceDiscount(input.discountCode, input.lines)
      : null;
    const discountMinor = priced?.discountMinor ?? 0;
    const totalMinor = input.subtotalMinor - discountMinor + input.shippingMinor;

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          orderNumber: `ZED-${orderSuffix()}`,
          userId: input.userId,
          status: 'PENDING_PAYMENT',
          currency: input.currency,
          subtotalMinor: input.subtotalMinor,
          discountMinor,
          discountCode: input.discountCode,
          shippingMinor: input.shippingMinor,
          totalMinor,
          paymentProvider: input.paymentProvider,
          shippingProvider: input.shippingProvider,
          deliveryMode: input.deliveryMode,
          serviceCode: input.serviceCode,
          idempotencyKey: input.idempotencyKey,
          shippingAddress: input.address as unknown as Prisma.InputJsonValue,
          items: {
            create: input.lines.map((line) => ({
              productId: line.productId,
              variantId: line.variantId,
              productName: line.productName,
              productSlug: line.productSlug,
              variantName: line.variantName,
              size: line.size as never,
              quantity: line.quantity,
              unitPriceMinor: line.unitPriceMinor,
              sku: line.sku,
              thumbnailKey: line.thumbnailKey,
            })),
          },
          statusEvents: {
            create: {
              status: 'PENDING_PAYMENT',
              source: 'system',
              note: 'Checkout started',
            },
          },
        },
      });

      await this.inventory.reserve(toStockLines(input.lines), created.id, tx);

      if (priced) {
        await this.discounts.markUsed(priced.discountId, input.userId, tx);
      }

      return created;
    });

    await this.queue.enqueueDelayed(
      QUEUE.ORDERS,
      JOB.CANCEL_UNPAID_ORDER,
      { orderId: order.id },
      35 * 60 * 1000,
    );

    this.logger.log(`Created pending order ${order.orderNumber}`);
    return order;
  }

  async transition(
    orderId: string,
    to: OrderStatus,
    source: string,
    note?: string,
    metadata?: Prisma.InputJsonValue,
    tx?: Prisma.TransactionClient,
  ): Promise<Order | null> {
    const client = tx ?? this.prisma;
    const order = await client.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);

    if (order.status === to) {
      this.logger.debug(`Order ${order.orderNumber} already ${to}; no-op`);
      return null;
    }

    if (!canTransition(order.status, to)) {
      throw new BadRequestException(
        `Cannot move order ${order.orderNumber} from ${order.status} to ${to}`,
      );
    }

    const updated = await client.order.update({
      where: { id: orderId },
      data: {
        status: to,
        ...(to === 'PAID' ? { placedAt: new Date() } : {}),
        ...(to === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
        statusEvents: { create: { status: to, source, note, metadata } },
      },
    });

    this.logger.log(`Order ${updated.orderNumber}: ${order.status} -> ${to} (${source})`);
    return updated;
  }

  async confirmPaidOrder(orderId: string, paymentRef: string, source: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { product: { select: { fulfillmentType: true } } } } },
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);

    if (order.status === 'CANCELLED' || order.status === 'REFUNDED') {
      this.logger.error(
        `Payment ${paymentRef} confirmed for ${order.status} order ${order.orderNumber}`,
      );
      return;
    }

    const transitioned = await this.prisma.$transaction(async (tx) => {
      const result = await this.transition(
        orderId,
        'PAID',
        source,
        `Payment confirmed (${paymentRef})`,
        { paymentRef },
        tx,
      );
      if (!result) return null;

      await tx.order.update({ where: { id: orderId }, data: { paymentRef } });
      await this.inventory.commit(toStockLines(order.items), orderId, tx);

      const madeToOrder = order.items.filter(
        (item) => item.product.fulfillmentType === 'MADE_TO_ORDER',
      );
      for (const item of madeToOrder) {
        await tx.productionTicket.upsert({
          where: { orderItemId: item.id },
          create: {
            orderItemId: item.id,
            status: 'QUEUED',
            notes: `${item.productName} / ${item.variantName ?? 'default'} / ${item.size}`,
          },
          update: {},
        });
      }

      return { result, hasProduction: madeToOrder.length > 0 };
    });

    if (!transitioned) {
      this.logger.debug(`Order ${order.orderNumber} was already confirmed`);
      return;
    }

    if (transitioned.hasProduction) {
      await this.transition(
        orderId,
        'IN_PRODUCTION',
        'system',
        'Made-to-order items queued for production',
      );
    } else {
      await this.queue.enqueueOnce(
        QUEUE.SHIPPING,
        JOB.CREATE_SHIPMENT,
        `shipment:${orderId}`,
        { orderId },
      );
    }

    await this.cart.clear(order.userId);

    await this.notifications.queueOrderEmail(orderId, 'order-confirmed');
  }

  async releaseForShipment(orderId: string): Promise<void> {
    await this.queue.enqueueOnce(
      QUEUE.SHIPPING,
      JOB.CREATE_SHIPMENT,
      `shipment:${orderId}`,
      { orderId },
    );
  }

  async failOrder(orderId: string, reason: string, source: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) return;
    if (order.status !== 'PENDING_PAYMENT' && order.status !== 'PAYMENT_FAILED') return;

    await this.prisma.$transaction(async (tx) => {
      await this.transition(orderId, 'PAYMENT_FAILED', source, reason, undefined, tx);
      await this.inventory.release(toStockLines(order.items), orderId, tx);
    });

    await this.notifications.queueOrderEmail(orderId, 'payment-failed');
  }

  async cancelIfUnpaid(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) return;
    if (order.status !== 'PENDING_PAYMENT' && order.status !== 'PAYMENT_FAILED') return;

    await this.prisma.$transaction(async (tx) => {
      await this.transition(
        orderId,
        'CANCELLED',
        'system',
        'Checkout expired without payment',
        undefined,
        tx,
      );
      await this.inventory.release(toStockLines(order.items), orderId, tx);
    });

    this.logger.log(`Cancelled unpaid order ${order.orderNumber}`);
  }


  async listForUser(userId: string): Promise<OrderView[]> {
    const orders = await this.prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: ORDER_INCLUDE,
    });
    return Promise.all(orders.map((order) => this.toView(order)));
  }

  async getForUser(userId: string, orderId: string): Promise<OrderView> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Order not found');
    return this.toView(order);
  }

  async listAll(status?: OrderStatus, page = 1, perPage = 30) {
    const where = status ? { status } : {};
    const [orders, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: ORDER_INCLUDE,
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.order.count({ where }),
    ]);
    return {
      items: await Promise.all(orders.map((order) => this.toView(order))),
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    };
  }

  async getForAdmin(orderId: string): Promise<OrderView> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Order not found');
    return this.toView(order);
  }

  async adminTransition(orderId: string, to: OrderStatus, actorUserId: string, note?: string) {
    await this.transition(orderId, to, `admin:${actorUserId}`, note);
    return this.getForAdmin(orderId);
  }

  async toView(order: OrderWithRelations): Promise<OrderView> {
    const thumbnails = await this.storage.resolveUrls(
      order.items.map((item) => item.thumbnailKey),
    );
    const labelUrl = await this.storage.resolveUrl(order.shipment?.labelKey);

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      currency: order.currency,
      subtotalMinor: order.subtotalMinor,
      discountMinor: order.discountMinor,
      discountCode: order.discountCode,
      shippingMinor: order.shippingMinor,
      totalMinor: order.totalMinor,
      paymentProvider: order.paymentProvider,
      createdAt: order.createdAt.toISOString(),
      items: order.items.map((item, index) => ({
        id: item.id,
        productId: item.productId,
        productName: item.productName,
        productSlug: item.productSlug,
        variantName: item.variantName,
        size: item.size,
        quantity: item.quantity,
        unitPriceMinor: item.unitPriceMinor,
        thumbnailUrl: thumbnails[index],
      })),
      shipment: order.shipment
        ? {
            id: order.shipment.id,
            provider: order.shipment.provider,
            trackingNumber: order.shipment.trackingNumber,
            labelUrl,
            status: order.shipment.status,
            estimatedDeliveryDate:
              order.shipment.estimatedDeliveryDate?.toISOString() ?? null,
            events: order.shipment.events.map((event) => ({
              status: event.status,
              description: event.description,
              occurredAt: event.occurredAt.toISOString(),
            })),
          }
        : null,
      statusHistory: order.statusEvents.map((event) => ({
        status: event.status,
        note: event.note,
        source: event.source,
        createdAt: event.createdAt.toISOString(),
      })),
      shippingAddress: order.shippingAddress as unknown as AddressInput,
    };
  }

}

export const ORDER_INCLUDE = {
  items: true,
  statusEvents: { orderBy: { createdAt: 'asc' } },
  shipment: { include: { events: { orderBy: { occurredAt: 'asc' } } } },
} satisfies Prisma.OrderInclude;

export type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

function toStockLines(
  items: { productId: string; variantId: string; size: string; quantity: number }[],
): StockLine[] {
  return items.map((item) => ({
    productId: item.productId,
    variantId: item.variantId,
    size: item.size as never,
    quantity: item.quantity,
  }));
}
