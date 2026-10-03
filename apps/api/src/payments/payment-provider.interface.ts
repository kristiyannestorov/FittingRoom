import type { Currency, PaymentProviderKey } from '@zed/contracts';

export interface PaymentLineItem {
  name: string;
  description?: string;
  quantity: number;
  unitPriceMinor: number;
  imageUrl?: string;
}

export interface CreateCheckoutInput {
  orderId: string;
  orderNumber: string;
  amountMinor: number;
  currency: Currency;
  customerEmail: string;
  items: PaymentLineItem[];
  shippingMinor: number;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface CreateCheckoutResult {
  providerReference: string;
  redirectUrl: string | null;
  clientSecret: string | null;
}

export type PaymentEventKind =
  | 'PAYMENT_SUCCEEDED'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_PENDING'
  | 'REFUNDED'
  | 'CHARGEBACK'
  | 'IGNORED';

export interface VerifiedPaymentEvent {
  externalId: string;
  eventType: string;
  kind: PaymentEventKind;
  providerReference: string | null;
  orderId: string | null;
  amountMinor: number | null;
  currency: Currency | null;
  raw: unknown;
}

export interface RefundResult {
  providerRefundId: string;
  amountMinor: number;
}

export interface WebhookRequest {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

export interface PaymentProvider {
  readonly key: PaymentProviderKey;

  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;

  verifyWebhook(request: WebhookRequest): Promise<VerifiedPaymentEvent>;

  confirmPayment(providerReference: string): Promise<VerifiedPaymentEvent>;

  refund(providerReference: string, amountMinor: number, currency: Currency): Promise<RefundResult>;
}

export const PAYMENT_PROVIDERS_TOKEN = 'PAYMENT_PROVIDERS';
