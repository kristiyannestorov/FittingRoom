import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { JOB, QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';


export type EmailTemplate =
  | 'order-confirmed'
  | 'payment-failed'
  | 'order-in-production'
  | 'order-shipped'
  | 'order-delivered'
  | 'order-cancelled'
  | 'low-stock-alert';

const SUBJECTS: Record<EmailTemplate, (ctx: Record<string, unknown>) => string> = {
  'order-confirmed': (c) => `Order ${c.orderNumber} confirmed`,
  'payment-failed': (c) => `We could not process payment for order ${c.orderNumber}`,
  'order-in-production': (c) => `Order ${c.orderNumber} is being made`,
  'order-shipped': (c) => `Order ${c.orderNumber} is on its way`,
  'order-delivered': (c) => `Order ${c.orderNumber} has been delivered`,
  'order-cancelled': (c) => `Order ${c.orderNumber} was cancelled`,
  'low-stock-alert': (c) => `Low stock: ${c.sku}`,
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly storage: StorageService,
  ) {}

  async enqueueEmail(
    toEmail: string,
    template: EmailTemplate,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const email = await this.prisma.outboundEmail.create({
      data: {
        toEmail,
        template,
        subject: SUBJECTS[template](payload),
        payload: payload as never,
      },
    });

    await this.queue.enqueue(QUEUE.NOTIFICATIONS, JOB.SEND_EMAIL, {
      outboundEmailId: email.id,
    });

    this.logger.debug(`Queued ${template} to ${toEmail}`);
    return email.id;
  }

  async queueOrderEmail(orderId: string, template: EmailTemplate): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, items: true, shipment: true },
    });

    if (!order) {
      this.logger.warn(`Cannot send ${template}: order ${orderId} not found`);
      return;
    }

    await this.enqueueEmail(order.user.email, template, {
      orderNumber: order.orderNumber,
      fullName: order.user.fullName,
      status: order.status,
      currency: order.currency,
      subtotalMinor: order.subtotalMinor,
      shippingMinor: order.shippingMinor,
      totalMinor: order.totalMinor,
      trackingNumber: order.shipment?.trackingNumber ?? null,
      trackingProvider: order.shipment?.provider ?? null,
      estimatedDeliveryDate: order.shipment?.estimatedDeliveryDate?.toISOString() ?? null,
      items: await Promise.all(
        order.items.map(async (item) => ({
          name: item.productName,
          variant: item.variantName,
          size: item.size,
          quantity: item.quantity,
          unitPriceMinor: item.unitPriceMinor,
          thumbnailUrl: await this.storage.resolveUrl(item.thumbnailKey),
        })),
      ),
    });
  }

  async queueLowStockAlert(
    adminEmail: string,
    sku: string,
    quantityAvailable: number,
    threshold: number,
  ): Promise<void> {
    await this.enqueueEmail(adminEmail, 'low-stock-alert', { sku, quantityAvailable, threshold });
  }

  async listAll(status?: 'sent' | 'failed' | 'pending', template?: string, page = 1, perPage = 30) {
    const where = {
      ...(template ? { template } : {}),
      ...(status === 'sent'
        ? { sentAt: { not: null } }
        : status === 'failed'
          ? { failedAt: { not: null } }
          : status === 'pending'
            ? { sentAt: null, failedAt: null }
            : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.outboundEmail.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.outboundEmail.count({ where }),
    ]);

    return {
      items,
      page,
      perPage,
      total,
      totalPages: Math.max(1, Math.ceil(total / perPage)),
    };
  }

  async getById(id: string) {
    return this.prisma.outboundEmail.findUnique({ where: { id } });
  }
}
