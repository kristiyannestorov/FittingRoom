import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CheckoutInput, CheckoutSessionView } from '@zed/contracts';
import type { Env } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { CartService } from '../cart/cart.service';
import { OrdersService } from '../orders/orders.service';
import { ShippingService } from '../shipping/shipping.service';
import { QueueService } from '../queue/queue.service';
import { JOB, QUEUE } from '../queue/queue.constants';
import { PaymentProviderRegistry } from './payment-provider.registry';
import type { VerifiedPaymentEvent } from './payment-provider.interface';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly cart: CartService,
    private readonly orders: OrdersService,
    private readonly shipping: ShippingService,
    private readonly queue: QueueService,
    private readonly registry: PaymentProviderRegistry,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async createCheckout(userId: string, dto: CheckoutInput): Promise<CheckoutSessionView> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const { lines, subtotalMinor, currency } = await this.cart.toOrderLines(userId);

    if (currency !== dto.currency) {
      throw new BadRequestException(`Cart is priced in ${currency}, not ${dto.currency}`);
    }

    const summary = await this.cart.getShippingSummary(userId);
    const options = await this.shipping.quote(
      dto.address,
      dto.deliveryMode,
      summary.weightGrams,
      subtotalMinor,
      currency,
      dto.shippingProvider,
    );

    const selected = options.find((option) => option.serviceCode === dto.serviceCode);
    if (!selected) {
      throw new BadRequestException(
        'That delivery option is no longer available. Please choose again.',
      );
    }

    const order = await this.orders.createPendingOrder({
      userId,
      idempotencyKey: dto.idempotencyKey,
      lines,
      subtotalMinor,
      discountCode: dto.discountCode,
      shippingMinor: selected.priceMinor,
      currency,
      paymentProvider: dto.paymentProvider,
      shippingProvider: dto.shippingProvider,
      deliveryMode: dto.deliveryMode,
      serviceCode: dto.serviceCode,
      address: dto.address,
    });

    if (order.paymentRef) {
      this.logger.log(`Reusing payment session for order ${order.orderNumber}`);
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        provider: order.paymentProvider,
        redirectUrl: null,
        clientSecret: null,
        providerReference: order.paymentRef,
        totalMinor: order.totalMinor,
        currency: order.currency,
      };
    }

    const provider = this.registry.get(dto.paymentProvider);
    const thumbnails = await this.storage.resolveUrls(lines.map((line) => line.thumbnailKey));

    const session = await provider.createCheckout({
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountMinor: order.totalMinor,
      currency,
      customerEmail: user.email,
      shippingMinor: order.shippingMinor,
      items: lines.map((line, index) => ({
        name: line.productName,
        description: [line.variantName, `Size ${line.size}`].filter(Boolean).join(' · '),
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        imageUrl: thumbnails[index]?.startsWith('http') ? thumbnails[index] : undefined,
      })),
      successUrl: `${this.webUrl()}/checkout/success?order=${order.orderNumber}`,
      cancelUrl: `${this.webUrl()}/checkout/cancelled?order=${order.orderNumber}`,
      metadata: { orderId: order.id, orderNumber: order.orderNumber },
      idempotencyKey: dto.idempotencyKey,
    });

    await this.prisma.order.update({
      where: { id: order.id },
      data: { paymentRef: session.providerReference },
    });

    this.logger.log(
      `Opened ${provider.key} session ${session.providerReference} for ${order.orderNumber}`,
    );

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      provider: provider.key,
      redirectUrl: session.redirectUrl,
      clientSecret: session.clientSecret,
      providerReference: session.providerReference,
      totalMinor: order.totalMinor,
      currency: order.currency,
    };
  }

  async recordAndQueue(event: VerifiedPaymentEvent, providerKey: string): Promise<void> {
    const orderId = await this.resolveOrderId(event);

    let paymentEventId: string;
    try {
      const created = await this.prisma.paymentEvent.create({
        data: {
          orderId,
          provider: providerKey as never,
          eventType: event.eventType,
          kind: event.kind,
          externalId: event.externalId,
          rawPayload: event.raw as never,
        },
      });
      paymentEventId = created.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.logger.debug(`Ignoring redelivered ${providerKey} event ${event.externalId}`);
        return;
      }
      throw error;
    }

    if (event.kind === 'IGNORED') {
      await this.prisma.paymentEvent.update({
        where: { id: paymentEventId },
        data: { processedAt: new Date() },
      });
      return;
    }

    await this.queue.enqueueOnce(
      QUEUE.PAYMENTS,
      JOB.PROCESS_PAYMENT_EVENT,
      `payment-event:${paymentEventId}`,
      { paymentEventId },
    );
  }

  async processPaymentEvent(paymentEventId: string): Promise<void> {
    const record = await this.prisma.paymentEvent.findUnique({ where: { id: paymentEventId } });
    if (!record) return;
    if (record.processedAt) {
      this.logger.debug(`Payment event ${paymentEventId} already processed`);
      return;
    }

    const provider = this.registry.get(record.provider);
    const kind = record.kind;
    const orderId = record.orderId;

    if (!orderId) {
      await this.markProcessed(paymentEventId, 'No order could be resolved for this event');
      this.logger.warn(`Payment event ${record.externalId} matched no order`);
      return;
    }

    try {
      switch (kind) {
        case 'PAYMENT_SUCCEEDED':
          await this.orders.confirmPaidOrder(
            orderId,
            record.externalId,
            `webhook:${record.provider.toLowerCase()}`,
          );
          break;

        case 'PAYMENT_PENDING': {
          const order = await this.prisma.order.findUnique({ where: { id: orderId } });
          if (!order?.paymentRef) break;

          const confirmed = await provider.confirmPayment(order.paymentRef);
          if (confirmed.kind === 'PAYMENT_SUCCEEDED') {
            await this.orders.confirmPaidOrder(
              orderId,
              order.paymentRef,
              `webhook:${record.provider.toLowerCase()}`,
            );
          } else {
            this.logger.log(`Order ${order.orderNumber} still pending at ${provider.key}`);
          }
          break;
        }

        case 'PAYMENT_FAILED':
          await this.orders.failOrder(
            orderId,
            `Payment failed at ${provider.key}`,
            `webhook:${record.provider.toLowerCase()}`,
          );
          break;

        case 'REFUNDED':
          await this.orders.transition(
            orderId,
            'REFUNDED',
            `webhook:${record.provider.toLowerCase()}`,
            'Refund confirmed by provider',
          );
          break;

        case 'CHARGEBACK':
          this.logger.error(`Chargeback opened on order ${orderId} (${record.externalId})`);
          break;

        default:
          break;
      }

      await this.markProcessed(paymentEventId);
    } catch (error) {
      await this.prisma.paymentEvent.update({
        where: { id: paymentEventId },
        data: { processingError: (error as Error).message.slice(0, 500) },
      });
      throw error;
    }
  }

  async reconcile(userId: string, orderNumber: string): Promise<{ status: string }> {
    const order = await this.prisma.order.findFirst({
      where: { orderNumber, userId },
    });
    if (!order) throw new BadRequestException('Order not found');
    if (order.status !== 'PENDING_PAYMENT') return { status: order.status };
    if (!order.paymentRef) return { status: order.status };

    const provider = this.registry.get(order.paymentProvider);
    const confirmed = await provider.confirmPayment(order.paymentRef);

    if (confirmed.kind === 'PAYMENT_SUCCEEDED') {
      await this.orders.confirmPaidOrder(order.id, order.paymentRef, 'reconcile:success-page');
      return { status: 'PAID' };
    }

    return { status: order.status };
  }

  private async resolveOrderId(event: VerifiedPaymentEvent): Promise<string | null> {
    if (event.orderId) {
      const byId = await this.prisma.order.findUnique({
        where: { id: event.orderId },
        select: { id: true },
      });
      if (byId) return byId.id;
    }

    if (event.providerReference) {
      const byRef = await this.prisma.order.findFirst({
        where: { paymentRef: event.providerReference },
        select: { id: true },
      });
      if (byRef) return byRef.id;
    }

    return null;
  }

  private async markProcessed(paymentEventId: string, error?: string): Promise<void> {
    await this.prisma.paymentEvent.update({
      where: { id: paymentEventId },
      data: { processedAt: new Date(), processingError: error ?? null },
    });
  }

  private webUrl(): string {
    return this.config.get('WEB_PUBLIC_URL', { infer: true }).replace(/\/+$/, '');
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === 'P2002';
}
