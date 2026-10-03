import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Currency, ShipmentStatus, ShippingProviderKey } from '@zed/contracts';
import type { Env } from '../../config/configuration';
import type {
  CourierOffice,
  CreateShipmentRequest,
  CreatedShipment,
  ShippingProvider,
  ShippingQuoteRequest,
  ShippingRate,
  TrackingEvent,
  TrackingResult,
} from '../shipping-provider.interface';

const BULGARIA_COUNTRY_ID = 100;

const SPEEDY_OPERATION_MAP: Record<string, ShipmentStatus> = {
  '1': 'PICKED_UP',
  '2': 'IN_TRANSIT',
  '3': 'IN_TRANSIT',
  '10': 'OUT_FOR_DELIVERY',
  '11': 'DELIVERED',
  '12': 'RETURNED',
  '13': 'EXCEPTION',
  PICKUP: 'PICKED_UP',
  TRANSIT: 'IN_TRANSIT',
  DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  RETURNED: 'RETURNED',
  CANCELLED: 'CANCELLED',
};

interface SpeedyCalculation {
  serviceId: number;
  serviceName?: string;
  price?: { amount?: number; total?: number; currency?: string; vat?: number };
  deliveryDeadline?: string;
  error?: { message?: string };
}

@Injectable()
export class SpeedyShippingProvider implements ShippingProvider {
  readonly key: ShippingProviderKey = 'SPEEDY';

  private readonly logger = new Logger(SpeedyShippingProvider.name);
  private readonly baseUrl: string;
  private readonly userName: string;
  private readonly password: string;
  private readonly defaultServiceId: number;

  private readonly siteCache = new Map<string, number>();

  constructor(config: ConfigService<Env, true>) {
    this.baseUrl = config.get('SPEEDY_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.userName = config.get('SPEEDY_USERNAME', { infer: true });
    this.password = config.get('SPEEDY_PASSWORD', { infer: true });
    this.defaultServiceId = config.get('SPEEDY_SERVICE_ID', { infer: true });
  }

  async quote(request: ShippingQuoteRequest): Promise<ShippingRate[]> {
    const response = await this.post<{ calculations?: SpeedyCalculation[] }>('/calculate', {
      recipient: await this.buildRecipient(request.destination, request.deliveryMode),
      service: {
        serviceIds: [this.defaultServiceId],
        autoAdjustPickupDate: true,
      },
      content: this.buildContent(request.parcel, 'Apparel'),
      payment: { courierServicePayer: 'SENDER' },
    });

    const calculations = (response.calculations ?? []).filter((c) => !c.error && c.price);
    if (calculations.length === 0) {
      const message = response.calculations?.[0]?.error?.message;
      throw new BadRequestException(message ?? 'Speedy returned no price for this destination');
    }

    return calculations.map((calculation) => {
      const majorUnits = calculation.price?.total ?? calculation.price?.amount ?? 0;
      return {
        provider: this.key,
        serviceCode: String(calculation.serviceId),
        serviceName: calculation.serviceName ?? `Speedy service ${calculation.serviceId}`,
        priceMinor: Math.round(majorUnits * 100),
        currency: normaliseCurrency(calculation.price?.currency) ?? request.currency,
        estimatedDeliveryDays: daysUntil(calculation.deliveryDeadline),
        deliveryMode: request.deliveryMode,
      };
    });
  }

  async createShipment(request: CreateShipmentRequest): Promise<CreatedShipment> {
    const response = await this.post<{
      id?: string;
      parcels?: { id?: string; seqNo?: number }[];
      price?: { total?: number; amount?: number; currency?: string };
      deliveryDeadline?: string;
    }>('/shipment', {
      recipient: await this.buildRecipient(request.destination, request.deliveryMode),
      service: {
        serviceId: Number(request.serviceCode) || this.defaultServiceId,
        autoAdjustPickupDate: true,
      },
      content: this.buildContent(request.parcel, request.contentDescription),
      payment: { courierServicePayer: 'SENDER' },
      ref1: request.orderNumber,
    });

    const shipmentId = response.id;
    const parcelId = response.parcels?.[0]?.id ?? shipmentId;
    if (!shipmentId || !parcelId) {
      throw new BadRequestException('Speedy did not return a shipment id');
    }

    const majorUnits = response.price?.total ?? response.price?.amount ?? null;

    return {
      externalId: shipmentId,
      trackingNumber: parcelId,
      priceMinor: majorUnits === null ? null : Math.round(majorUnits * 100),
      currency: normaliseCurrency(response.price?.currency),
      estimatedDeliveryDate: response.deliveryDeadline ? new Date(response.deliveryDeadline) : null,
      labelUrl: null,
      labelPdf: null,
    };
  }

  async fetchLabel(externalId: string): Promise<{ pdf: Buffer; contentType: string }> {
    const response = await fetch(`${this.baseUrl}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userName: this.userName,
        password: this.password,
        paperSize: 'A6',
        parcels: [{ parcel: { id: externalId } }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text();
      this.logger.warn(`Speedy /print -> ${response.status}: ${text.slice(0, 300)}`);
      throw new BadRequestException(`Speedy label print failed (${response.status})`);
    }

    return {
      pdf: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/pdf',
    };
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    const response = await this.post<{
      parcels?: {
        id?: string;
        operations?: {
          operationCode?: string | number;
          dateTime?: string;
          description?: string;
          placeName?: string;
        }[];
      }[];
    }>('/track', {
      parcels: [{ id: trackingNumber }],
      lastOperationOnly: false,
    });

    const parcel = response.parcels?.[0];
    if (!parcel) throw new BadRequestException(`Speedy knows no parcel ${trackingNumber}`);

    const events: TrackingEvent[] = (parcel.operations ?? []).map((operation) => ({
      status: mapSpeedyOperation(operation.operationCode),
      rawStatus: String(operation.operationCode ?? 'unknown'),
      description: operation.description ?? 'Scan',
      location: operation.placeName ?? null,
      occurredAt: operation.dateTime ? new Date(operation.dateTime) : new Date(),
    }));

    const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const latest = sorted.at(-1);
    const delivered = sorted.find((event) => event.status === 'DELIVERED');

    return {
      trackingNumber,
      status: latest?.status ?? 'PENDING',
      events: sorted,
      deliveredAt: delivered?.occurredAt ?? null,
      estimatedDeliveryDate: null,
    };
  }

  async cancelShipment(externalId: string): Promise<void> {
    await this.post(`/shipment/${externalId}/cancel`, { comment: 'Cancelled by merchant' });
  }

  async listOffices(city?: string): Promise<CourierOffice[]> {
    const siteId = city ? await this.resolveSiteId(city, undefined) : undefined;

    const response = await this.post<{
      offices?: {
        id?: number;
        name?: string;
        siteId?: number;
        address?: {
          siteName?: string;
          postCode?: string;
          fullAddressString?: string;
          x?: number;
          y?: number;
        };
      }[];
    }>('/location/office', {
      countryId: BULGARIA_COUNTRY_ID,
      ...(siteId ? { siteId } : {}),
    });

    return (response.offices ?? []).map((office) => ({
      externalId: String(office.id ?? ''),
      name: office.name ?? '',
      city: office.address?.siteName ?? city ?? '',
      postCode: office.address?.postCode ?? null,
      address: office.address?.fullAddressString ?? '',
      latitude: office.address?.y ?? null,
      longitude: office.address?.x ?? null,
    }));
  }

  parseWebhook(payload: unknown): { trackingNumber: string; events: TrackingEvent[] } | null {
    const body = payload as {
      parcelId?: string;
      id?: string;
      operationCode?: string | number;
      dateTime?: string;
      description?: string;
      placeName?: string;
    };
    const trackingNumber = body?.parcelId ?? body?.id;
    if (!trackingNumber || body.operationCode === undefined) return null;

    return {
      trackingNumber,
      events: [
        {
          status: mapSpeedyOperation(body.operationCode),
          rawStatus: String(body.operationCode),
          description: body.description ?? `Operation ${body.operationCode}`,
          location: body.placeName ?? null,
          occurredAt: body.dateTime ? new Date(body.dateTime) : new Date(),
        },
      ],
    };
  }

  private async buildRecipient(
    destination: { city: string; postCode: string; fullName: string; phone: string; email: string; street?: string; streetNumber?: string; officeId?: string },
    deliveryMode: string,
  ): Promise<Record<string, unknown>> {
    const base = {
      privatePerson: true,
      clientName: destination.fullName,
      phone1: { number: destination.phone },
      email: destination.email,
    };

    if (deliveryMode === 'OFFICE') {
      if (!destination.officeId) {
        throw new BadRequestException('An office must be selected for office delivery');
      }
      return { ...base, pickupOfficeId: Number(destination.officeId) };
    }

    return {
      ...base,
      address: {
        countryId: BULGARIA_COUNTRY_ID,
        siteId: await this.resolveSiteId(destination.city, destination.postCode),
        postCode: destination.postCode,
        streetName: destination.street ?? '',
        streetNo: destination.streetNumber ?? '',
      },
    };
  }

  private buildContent(
    parcel: { weightGrams: number; lengthCm?: number; widthCm?: number; heightCm?: number },
    description: string,
  ): Record<string, unknown> {
    return {
      parcelsCount: 1,
      totalWeight: Number((parcel.weightGrams / 1000).toFixed(3)),
      contents: description.slice(0, 100),
      package: 'BOX',
      ...(parcel.lengthCm && parcel.widthCm && parcel.heightCm
        ? {
            parcels: [
              {
                size: {
                  width: parcel.widthCm,
                  height: parcel.heightCm,
                  depth: parcel.lengthCm,
                },
                weight: Number((parcel.weightGrams / 1000).toFixed(3)),
              },
            ],
          }
        : {}),
    };
  }

  private async resolveSiteId(city: string, postCode: string | undefined): Promise<number> {
    const cacheKey = `${city.toLowerCase()}|${postCode ?? ''}`;
    const cached = this.siteCache.get(cacheKey);
    if (cached) return cached;

    const response = await this.post<{
      sites?: { id?: number; name?: string; postCode?: string }[];
    }>('/location/site', { countryId: BULGARIA_COUNTRY_ID, name: city });

    const sites = response.sites ?? [];
    const match =
      (postCode ? sites.find((site) => site.postCode === postCode) : undefined) ??
      sites.find((site) => site.name?.toLowerCase() === city.toLowerCase()) ??
      sites[0];

    if (!match?.id) {
      throw new BadRequestException(`Speedy does not recognise the settlement "${city}"`);
    }

    this.siteCache.set(cacheKey, match.id);
    return match.id;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userName: this.userName,
        password: this.password,
        language: 'EN',
        ...body,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();
    if (!response.ok) {
      this.logger.warn(`Speedy ${path} -> ${response.status}: ${text.slice(0, 300)}`);
      throw new BadRequestException(`Speedy request failed (${response.status})`);
    }

    const parsed = text ? (JSON.parse(text) as T & { error?: { message?: string } }) : ({} as T);

    if ((parsed as { error?: { message?: string } }).error?.message) {
      const message = (parsed as { error?: { message?: string } }).error?.message;
      throw new BadRequestException(`Speedy: ${message}`);
    }

    return parsed;
  }
}

export function mapSpeedyOperation(code: string | number | undefined): ShipmentStatus {
  if (code === undefined || code === null) return 'IN_TRANSIT';
  return SPEEDY_OPERATION_MAP[String(code).toUpperCase()] ?? 'IN_TRANSIT';
}

function normaliseCurrency(value: string | undefined | null): Currency | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  return upper === 'EUR' ? upper : null;
}

function daysUntil(deadline: string | undefined): number | null {
  if (!deadline) return null;
  const target = new Date(deadline).getTime();
  if (Number.isNaN(target)) return null;
  return Math.max(0, Math.ceil((target - Date.now()) / 86_400_000));
}
