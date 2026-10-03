import type {
  AddressInput,
  Currency,
  DeliveryMode,
  ShipmentStatus,
  ShippingProviderKey,
} from '@zed/contracts';

export interface ParcelDimensions {
  weightGrams: number;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
}

export interface ShippingQuoteRequest {
  destination: AddressInput;
  deliveryMode: DeliveryMode;
  parcel: ParcelDimensions;
  declaredValueMinor: number;
  currency: Currency;
}

export interface ShippingRate {
  provider: ShippingProviderKey;
  serviceCode: string;
  serviceName: string;
  priceMinor: number;
  currency: Currency;
  estimatedDeliveryDays: number | null;
  deliveryMode: DeliveryMode;
}

export interface CreateShipmentRequest {
  orderNumber: string;
  destination: AddressInput;
  deliveryMode: DeliveryMode;
  serviceCode: string;
  parcel: ParcelDimensions;
  declaredValueMinor: number;
  currency: Currency;
  contentDescription: string;
}

export interface CreatedShipment {
  externalId: string;
  trackingNumber: string;
  priceMinor: number | null;
  currency: Currency | null;
  estimatedDeliveryDate: Date | null;
  labelUrl: string | null;
  labelPdf: Buffer | null;
}

export interface TrackingEvent {
  status: ShipmentStatus;
  rawStatus: string;
  description: string;
  location: string | null;
  occurredAt: Date;
}

export interface TrackingResult {
  trackingNumber: string;
  status: ShipmentStatus;
  events: TrackingEvent[];
  deliveredAt: Date | null;
  estimatedDeliveryDate: Date | null;
}

export interface CourierOffice {
  externalId: string;
  name: string;
  city: string;
  postCode: string | null;
  address: string;
  latitude: number | null;
  longitude: number | null;
}

export interface ShippingProvider {
  readonly key: ShippingProviderKey;

  quote(request: ShippingQuoteRequest): Promise<ShippingRate[]>;

  createShipment(request: CreateShipmentRequest): Promise<CreatedShipment>;

  fetchLabel(externalId: string): Promise<{ pdf: Buffer; contentType: string }>;

  track(trackingNumber: string): Promise<TrackingResult>;

  cancelShipment(externalId: string): Promise<void>;

  listOffices(city?: string): Promise<CourierOffice[]>;

  parseWebhook(payload: unknown): { trackingNumber: string; events: TrackingEvent[] } | null;
}

export const SHIPPING_PROVIDERS_TOKEN = 'SHIPPING_PROVIDERS';
