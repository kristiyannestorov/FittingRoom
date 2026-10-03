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


const ECONT_SERVICES = {
  DOOR: { code: 'ECONT_DOOR', name: 'Econt: to address', days: 1 },
  OFFICE: { code: 'ECONT_OFFICE', name: 'Econt: to office', days: 1 },
} as const;

const ECONT_STATUS_MAP: Record<string, ShipmentStatus> = {
  registered: 'LABEL_CREATED',
  accepted: 'PICKED_UP',
  'in progress': 'IN_TRANSIT',
  transferred: 'IN_TRANSIT',
  'in delivery': 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  returned: 'RETURNED',
  rejected: 'RETURNED',
  canceled: 'CANCELLED',
  cancelled: 'CANCELLED',
  problem: 'EXCEPTION',
  lost: 'EXCEPTION',
};

interface EcontLabelResponse {
  label?: {
    shipmentNumber?: string;
    pdfURL?: string;
    loadingNumber?: string;
    expectedDeliveryDate?: string;
    totalPrice?: number;
    currency?: string;
  };
  totalPrice?: number;
  currency?: string;
  expectedDeliveryDate?: string;
  courierServicePrice?: number;
  error?: { type?: string; message?: string; fields?: unknown };
}

@Injectable()
export class EcontShippingProvider implements ShippingProvider {
  readonly key: ShippingProviderKey = 'ECONT';

  private readonly logger = new Logger(EcontShippingProvider.name);
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly sender: SenderProfile;

  constructor(config: ConfigService<Env, true>) {
    this.baseUrl = config.get('ECONT_BASE_URL', { infer: true }).replace(/\/+$/, '');
    const user = config.get('ECONT_USERNAME', { infer: true });
    const pass = config.get('ECONT_PASSWORD', { infer: true });
    this.authHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    this.sender = senderFrom(config);
  }

  async quote(request: ShippingQuoteRequest): Promise<ShippingRate[]> {
    const service =
      request.deliveryMode === 'OFFICE' ? ECONT_SERVICES.OFFICE : ECONT_SERVICES.DOOR;

    const response = await this.post<EcontLabelResponse>(
      '/Shipments/LabelService.createLabel.json',
      {
        label: this.buildLabel(request, request.deliveryMode, 'Apparel'),
        mode: 'calculate',
      },
    );

    const priceMajor = response.label?.totalPrice ?? response.totalPrice;
    if (priceMajor === undefined) {
      throw new BadRequestException(
        response.error?.message ?? 'Econt returned no price for this destination',
      );
    }

    const currency = normaliseCurrency(response.label?.currency ?? response.currency) ?? request.currency;

    return [
      {
        provider: this.key,
        serviceCode: service.code,
        serviceName: service.name,
        priceMinor: Math.round(priceMajor * 100),
        currency,
        estimatedDeliveryDays: service.days,
        deliveryMode: request.deliveryMode,
      },
    ];
  }

  async createShipment(request: CreateShipmentRequest): Promise<CreatedShipment> {
    const response = await this.post<EcontLabelResponse>(
      '/Shipments/LabelService.createLabel.json',
      {
        label: this.buildLabel(request, request.deliveryMode, request.contentDescription),
        mode: 'create',
      },
    );

    const shipmentNumber = response.label?.shipmentNumber;
    if (!shipmentNumber) {
      throw new BadRequestException(
        response.error?.message ?? 'Econt did not return a shipment number',
      );
    }

    const priceMajor = response.label?.totalPrice ?? response.totalPrice ?? null;
    const expected = response.label?.expectedDeliveryDate ?? response.expectedDeliveryDate;

    return {
      externalId: shipmentNumber,
      trackingNumber: shipmentNumber,
      priceMinor: priceMajor === null ? null : Math.round(priceMajor * 100),
      currency: normaliseCurrency(response.label?.currency ?? response.currency),
      estimatedDeliveryDate: expected ? new Date(expected) : null,
      labelUrl: response.label?.pdfURL ?? null,
      labelPdf: null,
    };
  }

  async fetchLabel(externalId: string): Promise<{ pdf: Buffer; contentType: string }> {
    const response = await this.post<{
      shipmentStatuses?: { status?: { pdfURL?: string } }[];
    }>('/Shipments/ShipmentService.getShipmentStatuses.json', {
      shipmentNumbers: [externalId],
      full: true,
    });

    const url = response.shipmentStatuses?.[0]?.status?.pdfURL;
    if (!url) throw new BadRequestException(`No label PDF available for ${externalId}`);

    const pdf = await fetch(url, {
      headers: { Authorization: this.authHeader },
      signal: AbortSignal.timeout(30_000),
    });
    if (!pdf.ok) throw new BadRequestException(`Econt label download failed (${pdf.status})`);

    return {
      pdf: Buffer.from(await pdf.arrayBuffer()),
      contentType: pdf.headers.get('content-type') ?? 'application/pdf',
    };
  }

  async track(trackingNumber: string): Promise<TrackingResult> {
    const response = await this.post<{
      shipmentStatuses?: {
        status?: {
          shipmentNumber?: string;
          shipmentStatus?: string;
          deliveryTime?: string;
          expectedDeliveryDate?: string;
          trackingEvents?: {
            destinationType?: string;
            destinationDetails?: string;
            officeName?: string;
            time?: string;
          }[];
        };
      }[];
    }>('/Shipments/ShipmentService.getShipmentStatuses.json', {
      shipmentNumbers: [trackingNumber],
    });

    const status = response.shipmentStatuses?.[0]?.status;
    if (!status) {
      throw new BadRequestException(`Econt knows no shipment ${trackingNumber}`);
    }

    const events: TrackingEvent[] = (status.trackingEvents ?? []).map((event) => ({
      status: mapEcontStatus(event.destinationType ?? ''),
      rawStatus: event.destinationType ?? 'unknown',
      description: event.destinationDetails ?? event.officeName ?? 'Scan',
      location: event.officeName ?? null,
      occurredAt: event.time ? new Date(event.time) : new Date(),
    }));

    const current = mapEcontStatus(status.shipmentStatus ?? '');

    events.push({
      status: current,
      rawStatus: status.shipmentStatus ?? 'unknown',
      description: `Status: ${status.shipmentStatus ?? 'unknown'}`,
      location: null,
      occurredAt: status.deliveryTime ? new Date(status.deliveryTime) : new Date(),
    });

    return {
      trackingNumber,
      status: current,
      events,
      deliveredAt:
        current === 'DELIVERED' && status.deliveryTime ? new Date(status.deliveryTime) : null,
      estimatedDeliveryDate: status.expectedDeliveryDate
        ? new Date(status.expectedDeliveryDate)
        : null,
    };
  }

  async cancelShipment(externalId: string): Promise<void> {
    await this.post('/Shipments/ShipmentService.deleteShipments.json', {
      shipmentNumbers: [externalId],
    });
  }

  async listOffices(city?: string): Promise<CourierOffice[]> {
    const response = await this.post<{
      offices?: {
        code?: string;
        name?: string;
        address?: {
          city?: { name?: string; postCode?: string };
          fullAddress?: string;
          location?: { latitude?: number; longitude?: number };
        };
      }[];
    }>('/Nomenclatures/NomenclaturesService.getOffices.json', { countryCode: 'BGR' });

    const offices = (response.offices ?? []).map((office) => ({
      externalId: office.code ?? '',
      name: office.name ?? '',
      city: office.address?.city?.name ?? '',
      postCode: office.address?.city?.postCode ?? null,
      address: office.address?.fullAddress ?? '',
      latitude: office.address?.location?.latitude ?? null,
      longitude: office.address?.location?.longitude ?? null,
    }));

    return city
      ? offices.filter((o) => o.city.toLowerCase() === city.toLowerCase())
      : offices;
  }

  parseWebhook(payload: unknown): { trackingNumber: string; events: TrackingEvent[] } | null {
    const body = payload as {
      shipmentNumber?: string;
      shipmentStatus?: string;
      time?: string;
      details?: string;
    };
    if (!body?.shipmentNumber || !body.shipmentStatus) return null;

    return {
      trackingNumber: body.shipmentNumber,
      events: [
        {
          status: mapEcontStatus(body.shipmentStatus),
          rawStatus: body.shipmentStatus,
          description: body.details ?? `Status: ${body.shipmentStatus}`,
          location: null,
          occurredAt: body.time ? new Date(body.time) : new Date(),
        },
      ],
    };
  }


  private buildLabel(
    request: ShippingQuoteRequest | CreateShipmentRequest,
    deliveryMode: string,
    description: string,
  ): Record<string, unknown> {
    const destination = request.destination;

    const receiverAddress =
      deliveryMode === 'OFFICE'
        ? undefined
        : {
            city: {
              country: { code3: destination.countryCode === 'BG' ? 'BGR' : destination.countryCode },
              name: destination.city,
              postCode: destination.postCode,
            },
            street: destination.street ?? '',
            num: destination.streetNumber ?? '',
            other: [destination.floor && `fl. ${destination.floor}`, destination.apartment && `ap. ${destination.apartment}`]
              .filter(Boolean)
              .join(', '),
          };

    return {
      senderClient: {
        name: this.sender.name,
        phones: [this.sender.phone],
        email: this.sender.email,
      },
      senderAddress: {
        city: {
          country: { code3: 'BGR' },
          name: this.sender.city,
          postCode: this.sender.postCode,
        },
        street: this.sender.street,
        num: this.sender.streetNumber,
      },
      receiverClient: {
        name: destination.fullName,
        phones: [destination.phone],
        email: destination.email,
      },
      ...(receiverAddress ? { receiverAddress } : {}),
      ...(deliveryMode === 'OFFICE' && destination.officeId
        ? { receiverOfficeCode: destination.officeId }
        : {}),
      packCount: 1,
      shipmentType: 'PACK',
      weight: Number((request.parcel.weightGrams / 1000).toFixed(3)),
      shipmentDescription: description.slice(0, 100),
      holidayDeliveryDay: 'workday',
      paymentSenderMethod: 'cash',
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: this.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();
    if (!response.ok) {
      this.logger.warn(`Econt ${path} -> ${response.status}: ${text.slice(0, 300)}`);
      throw new BadRequestException(`Econt request failed (${response.status})`);
    }

    const parsed = text ? (JSON.parse(text) as T & { error?: { message?: string } }) : ({} as T);

    if ((parsed as { error?: { message?: string } }).error?.message) {
      const message = (parsed as { error?: { message?: string } }).error?.message;
      this.logger.warn(`Econt ${path} returned error: ${message}`);
      throw new BadRequestException(`Econt: ${message}`);
    }

    return parsed;
  }
}

export function mapEcontStatus(raw: string): ShipmentStatus {
  return ECONT_STATUS_MAP[raw.trim().toLowerCase()] ?? 'IN_TRANSIT';
}

interface SenderProfile {
  name: string;
  phone: string;
  email: string;
  city: string;
  postCode: string;
  street: string;
  streetNumber: string;
}

export function senderFrom(config: ConfigService<Env, true>): SenderProfile {
  return {
    name: config.get('SENDER_NAME', { infer: true }),
    phone: config.get('SENDER_PHONE', { infer: true }),
    email: config.get('SENDER_EMAIL', { infer: true }),
    city: config.get('SENDER_CITY', { infer: true }),
    postCode: config.get('SENDER_POST_CODE', { infer: true }),
    street: config.get('SENDER_STREET', { infer: true }),
    streetNumber: config.get('SENDER_STREET_NUM', { infer: true }),
  };
}

function normaliseCurrency(value: string | undefined | null): Currency | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  return upper === 'EUR' ? upper : null;
}
