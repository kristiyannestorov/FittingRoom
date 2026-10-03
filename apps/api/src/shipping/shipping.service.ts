import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Shipment } from '@prisma/client';
import {
  TERMINAL_SHIPMENT_STATUSES,
  type AddressInput,
  type Currency,
  type DeliveryMode,
  type ShipmentStatus,
  type ShippingOptionView,
  type ShippingProviderKey,
} from '@zed/contracts';
import type { Env } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService, StorageKeys } from '../storage/storage.service';
import { QueueService } from '../queue/queue.service';
import { JOB, QUEUE } from '../queue/queue.constants';
import { OrdersService } from '../orders/orders.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ShippingProviderRegistry } from './shipping-provider.registry';
import type { TrackingEvent, TrackingResult } from './shipping-provider.interface';

const POLL_SCHEDULE_MINUTES = [15, 30, 60, 120, 240, 480, 720];

const MAX_POLL_ATTEMPTS = 60;

@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
    private readonly registry: ShippingProviderRegistry,
    private readonly orders: OrdersService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async quote(
    address: AddressInput,
    deliveryMode: DeliveryMode,
    weightGrams: number,
    declaredValueMinor: number,
    currency: Currency,
    only?: ShippingProviderKey,
  ): Promise<ShippingOptionView[]> {
    const providers = only ? [this.registry.get(only)] : this.registry.all();

    const results = await Promise.allSettled(
      providers.map((provider) =>
        provider.quote({
          destination: address,
          deliveryMode,
          parcel: { weightGrams },
          declaredValueMinor,
          currency,
        }),
      ),
    );

    const rates = results.flatMap((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      this.logger.warn(
        `${providers[index].key} quote failed: ${(result.reason as Error).message}`,
      );
      return [];
    });

    if (rates.length === 0) {
      throw new BadRequestException(
        'No courier could price a delivery to that address. Please check the city and post code.',
      );
    }

    const freeThreshold = this.config.get('FREE_SHIPPING_THRESHOLD_MINOR', { infer: true });
    const qualifiesForFree = freeThreshold > 0 && declaredValueMinor >= freeThreshold;

    return rates
      .map((rate) => ({
        provider: rate.provider,
        serviceCode: rate.serviceCode,
        serviceName: qualifiesForFree ? `${rate.serviceName} (free)` : rate.serviceName,
        priceMinor: qualifiesForFree ? 0 : rate.priceMinor,
        currency: rate.currency,
        estimatedDeliveryDays: rate.estimatedDeliveryDays,
        deliveryMode: rate.deliveryMode,
      }))
      .sort((a, b) => a.priceMinor - b.priceMinor);
  }

  async createShipmentForOrder(orderId: string): Promise<Shipment> {
    const existing = await this.prisma.shipment.findUnique({ where: { orderId } });
    if (existing?.trackingNumber) {
      this.logger.debug(`Order ${orderId} already has shipment ${existing.trackingNumber}`);
      return existing;
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { product: { select: { weightGrams: true } } } } },
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);

    const provider = this.registry.get(order.shippingProvider);
    const address = order.shippingAddress as unknown as AddressInput;

    const weightGrams = order.items.reduce(
      (sum, item) => sum + item.product.weightGrams * item.quantity,
      200,
    );

    const shipment =
      existing ??
      (await this.prisma.shipment.create({
        data: {
          orderId,
          provider: order.shippingProvider,
          status: 'PENDING',
          weightGrams,
          currency: order.currency,
        },
      }));

    const created = await provider.createShipment({
      orderNumber: order.orderNumber,
      destination: address,
      deliveryMode: order.deliveryMode,
      serviceCode: order.serviceCode,
      parcel: { weightGrams },
      declaredValueMinor: order.totalMinor,
      currency: order.currency,
      contentDescription: order.items
        .map((item) => `${item.productName} ${item.size}`)
        .join(', '),
    });

    let labelKey: string | null = null;
    try {
      const pdf = created.labelPdf
        ? { pdf: created.labelPdf, contentType: 'application/pdf' }
        : created.labelUrl
          ? await downloadPdf(created.labelUrl)
          : await provider.fetchLabel(created.externalId);

      labelKey = StorageKeys.shippingLabel(shipment.id);
      await this.storage.put({
        key: labelKey,
        body: pdf.pdf,
        contentType: pdf.contentType,
      });
    } catch (error) {
      this.logger.error(
        `Stored shipment ${created.trackingNumber} but could not archive its label: ${(error as Error).message}`,
      );
    }

    const updated = await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        externalId: created.externalId,
        trackingNumber: created.trackingNumber,
        labelKey,
        status: 'LABEL_CREATED',
        priceMinor: created.priceMinor,
        currency: created.currency ?? order.currency,
        estimatedDeliveryDate: created.estimatedDeliveryDate,
        nextPollAt: new Date(Date.now() + POLL_SCHEDULE_MINUTES[0] * 60_000),
        events: {
          create: {
            status: 'LABEL_CREATED',
            description: `Label created with ${provider.key}`,
            rawStatus: 'LABEL_CREATED',
            occurredAt: new Date(),
          },
        },
      },
    });

    await this.orders.transition(
      orderId,
      'PACKED',
      'system',
      `Shipment ${created.trackingNumber} created`,
    );

    await this.schedulePoll(updated);
    this.logger.log(`Created ${provider.key} shipment ${created.trackingNumber} for ${order.orderNumber}`);

    return updated;
  }

  async pollShipment(shipmentId: string): Promise<void> {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment?.trackingNumber) return;

    if (TERMINAL_SHIPMENT_STATUSES.includes(shipment.status)) {
      this.logger.debug(`Shipment ${shipment.trackingNumber} is ${shipment.status}; polling stopped`);
      return;
    }

    if (shipment.pollAttempts >= MAX_POLL_ATTEMPTS) {
      this.logger.warn(
        `Giving up on ${shipment.trackingNumber} after ${shipment.pollAttempts} polls`,
      );
      await this.prisma.shipment.update({
        where: { id: shipmentId },
        data: { nextPollAt: null },
      });
      return;
    }

    const provider = this.registry.get(shipment.provider);
    const result = await provider.track(shipment.trackingNumber);

    await this.applyTracking(shipmentId, result.status, result.events, result.deliveredAt);

    const refreshed = await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: { pollAttempts: { increment: 1 } },
    });
    await this.schedulePoll(refreshed);
  }

  async applyTracking(
    shipmentId: string,
    status: ShipmentStatus,
    events: TrackingEvent[],
    deliveredAt: Date | null,
  ): Promise<void> {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) return;

    for (const event of events) {
      await this.prisma.shipmentEvent.upsert({
        where: {
          shipmentId_rawStatus_occurredAt: {
            shipmentId,
            rawStatus: event.rawStatus,
            occurredAt: event.occurredAt,
          },
        },
        create: {
          shipmentId,
          status: event.status,
          rawStatus: event.rawStatus,
          description: event.description,
          location: event.location,
          occurredAt: event.occurredAt,
        },
        update: {},
      });
    }

    if (shipment.status === status) return;

    await this.prisma.shipment.update({
      where: { id: shipmentId },
      data: {
        status,
        deliveredAt: deliveredAt ?? (status === 'DELIVERED' ? new Date() : null),
        ...(TERMINAL_SHIPMENT_STATUSES.includes(status) ? { nextPollAt: null } : {}),
      },
    });

    await this.propagateToOrder(shipment.orderId, status);
  }

  private async propagateToOrder(orderId: string, status: ShipmentStatus): Promise<void> {
    if (status === 'PICKED_UP' || status === 'IN_TRANSIT' || status === 'OUT_FOR_DELIVERY') {
      const moved = await this.orders
        .transition(orderId, 'SHIPPED', 'webhook:courier', `Courier reports ${status}`)
        .catch((error) => {
          this.logger.warn(`Could not mark ${orderId} shipped: ${(error as Error).message}`);
          return null;
        });
      if (moved) await this.notifications.queueOrderEmail(orderId, 'order-shipped');
      return;
    }

    if (status === 'DELIVERED') {
      const moved = await this.orders
        .transition(orderId, 'DELIVERED', 'webhook:courier', 'Courier reports delivery')
        .catch((error) => {
          this.logger.warn(`Could not mark ${orderId} delivered: ${(error as Error).message}`);
          return null;
        });
      if (moved) await this.notifications.queueOrderEmail(orderId, 'order-delivered');
    }
  }

  private async schedulePoll(shipment: Shipment): Promise<void> {
    if (TERMINAL_SHIPMENT_STATUSES.includes(shipment.status)) return;
    if (shipment.pollAttempts >= MAX_POLL_ATTEMPTS) return;

    const minutes =
      POLL_SCHEDULE_MINUTES[Math.min(shipment.pollAttempts, POLL_SCHEDULE_MINUTES.length - 1)];

    await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: { nextPollAt: new Date(Date.now() + minutes * 60_000) },
    });

    await this.queue.enqueueDelayed(
      QUEUE.SHIPPING,
      JOB.POLL_SHIPMENT,
      { shipmentId: shipment.id },
      minutes * 60_000,
      { jobId: `poll:${shipment.id}:${shipment.pollAttempts}` },
    );
  }

  async processCourierEvent(
    providerKey: ShippingProviderKey,
    payload: unknown,
  ): Promise<void> {
    const provider = this.registry.get(providerKey);
    const parsed = provider.parseWebhook(payload);
    if (!parsed) {
      this.logger.debug(`${providerKey} webhook carried no status change`);
      return;
    }

    const shipment = await this.prisma.shipment.findFirst({
      where: { trackingNumber: parsed.trackingNumber, provider: providerKey },
    });
    if (!shipment) {
      this.logger.warn(`${providerKey} webhook for unknown tracking ${parsed.trackingNumber}`);
      return;
    }

    const latest = parsed.events.at(-1);
    await this.applyTracking(
      shipment.id,
      latest?.status ?? shipment.status,
      parsed.events,
      latest?.status === 'DELIVERED' ? latest.occurredAt : null,
    );
  }

  async refreshOffices(providerKey: ShippingProviderKey): Promise<number> {
    const provider = this.registry.get(providerKey);
    const offices = await provider.listOffices();

    for (const office of offices) {
      if (!office.externalId) continue;
      await this.prisma.courierOffice.upsert({
        where: {
          provider_externalId: { provider: providerKey, externalId: office.externalId },
        },
        create: {
          provider: providerKey,
          externalId: office.externalId,
          name: office.name,
          city: office.city,
          postCode: office.postCode,
          address: office.address,
          latitude: office.latitude,
          longitude: office.longitude,
        },
        update: {
          name: office.name,
          city: office.city,
          postCode: office.postCode,
          address: office.address,
          latitude: office.latitude,
          longitude: office.longitude,
          isActive: true,
          refreshedAt: new Date(),
        },
      });
    }

    this.logger.log(`Refreshed ${offices.length} ${providerKey} offices`);
    return offices.length;
  }

  async listCachedOffices(providerKey: ShippingProviderKey, city?: string) {
    return this.prisma.courierOffice.findMany({
      where: {
        provider: providerKey,
        isActive: true,
        ...(city ? { city: { equals: city, mode: 'insensitive' } } : {}),
      },
      orderBy: [{ city: 'asc' }, { name: 'asc' }],
      take: 500,
    });
  }

  async trackByNumber(trackingNumber: string): Promise<TrackingResult | null> {
    const shipment = await this.prisma.shipment.findFirst({
      where: { trackingNumber },
      include: { events: { orderBy: { occurredAt: 'asc' } } },
    });
    if (!shipment) return null;

    return {
      trackingNumber,
      status: shipment.status,
      deliveredAt: shipment.deliveredAt,
      estimatedDeliveryDate: shipment.estimatedDeliveryDate,
      events: shipment.events.map((event) => ({
        status: event.status,
        rawStatus: event.rawStatus ?? '',
        description: event.description,
        location: event.location,
        occurredAt: event.occurredAt,
      })),
    };
  }
}

async function downloadPdf(url: string): Promise<{ pdf: Buffer; contentType: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Label download failed (${response.status})`);
  return {
    pdf: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? 'application/pdf',
  };
}
