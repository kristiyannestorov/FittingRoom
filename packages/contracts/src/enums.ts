export const USER_ROLES = ['CUSTOMER', 'ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const PAYMENT_PROVIDERS = ['STRIPE', 'PAYPAL'] as const;
export type PaymentProviderKey = (typeof PAYMENT_PROVIDERS)[number];

export const SHIPPING_PROVIDERS = ['ECONT', 'SPEEDY'] as const;
export type ShippingProviderKey = (typeof SHIPPING_PROVIDERS)[number];

export const FULFILLMENT_TYPES = ['STOCKED', 'MADE_TO_ORDER'] as const;
export type FulfillmentType = (typeof FULFILLMENT_TYPES)[number];

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'PAID',
  'IN_PRODUCTION',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'REFUNDED',
  'PAYMENT_FAILED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ['PAID', 'PAYMENT_FAILED', 'CANCELLED'],
  PAYMENT_FAILED: ['PENDING_PAYMENT', 'PAID', 'CANCELLED'],
  PAID: ['IN_PRODUCTION', 'PACKED', 'CANCELLED', 'REFUNDED'],
  IN_PRODUCTION: ['PACKED', 'CANCELLED', 'REFUNDED'],
  PACKED: ['SHIPPED', 'CANCELLED', 'REFUNDED'],
  SHIPPED: ['DELIVERED', 'REFUNDED'],
  DELIVERED: ['REFUNDED'],
  CANCELLED: [],
  REFUNDED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return ORDER_TRANSITIONS[status].length === 0;
}

export const SHIPMENT_STATUSES = [
  'PENDING',
  'LABEL_CREATED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'RETURNED',
  'CANCELLED',
  'EXCEPTION',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const TERMINAL_SHIPMENT_STATUSES: readonly ShipmentStatus[] = [
  'DELIVERED',
  'RETURNED',
  'CANCELLED',
];

export const PRODUCTION_TICKET_STATUSES = [
  'QUEUED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export type ProductionTicketStatus = (typeof PRODUCTION_TICKET_STATUSES)[number];

export const DELIVERY_MODES = ['ADDRESS', 'OFFICE'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const GENDERS = ['FEMALE', 'MALE'] as const;
export type Gender = (typeof GENDERS)[number];

export const GARMENT_GENERATION_PROVIDERS = [
  'MANUAL',
  'LOCAL_BAKE',
] as const;
export type GarmentGenerationProviderKey = (typeof GARMENT_GENERATION_PROVIDERS)[number];

export const GENERATION_STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];
