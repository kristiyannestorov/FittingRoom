import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  fromDecimalString,
  toDecimalString,
  type Currency,
  type PaymentProviderKey,
} from '@zed/contracts';
import type { Env } from '../../config/configuration';
import type {
  CreateCheckoutInput,
  CreateCheckoutResult,
  PaymentProvider,
  RefundResult,
  VerifiedPaymentEvent,
  WebhookRequest,
} from '../payment-provider.interface';

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
const LIVE_BASE = 'https://api-m.paypal.com';

const MAX_ITEM_NAME = 127;
const MAX_DESCRIPTION = 127;

interface PayPalTokenResponse {
  access_token: string;
  expires_in: number;
}

interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

interface PayPalOrderResponse {
  id: string;
  status: string;
  links?: PayPalLink[];
  purchase_units?: {
    reference_id?: string;
    custom_id?: string;
    amount?: { currency_code: string; value: string };
    payments?: {
      captures?: { id: string; status: string; amount: { currency_code: string; value: string } }[];
    };
  }[];
}

@Injectable()
export class PayPalPaymentProvider implements PaymentProvider {
  readonly key: PaymentProviderKey = 'PAYPAL';

  private readonly logger = new Logger(PayPalPaymentProvider.name);
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly webhookId: string;

  private cachedToken?: { value: string; expiresAt: number };

  constructor(config: ConfigService<Env, true>) {
    this.baseUrl = config.get('PAYPAL_ENV', { infer: true }) === 'live' ? LIVE_BASE : SANDBOX_BASE;
    this.clientId = config.get('PAYPAL_CLIENT_ID', { infer: true });
    this.clientSecret = config.get('PAYPAL_CLIENT_SECRET', { infer: true });
    this.webhookId = config.get('PAYPAL_WEBHOOK_ID', { infer: true });
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const currency = input.currency;
    const itemTotal = input.items.reduce(
      (sum, item) => sum + item.unitPriceMinor * item.quantity,
      0,
    );

    const order = await this.request<PayPalOrderResponse>('POST', '/v2/checkout/orders', {
      body: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: input.orderId,
            custom_id: input.orderId,
            invoice_id: input.orderNumber,
            description: truncate(`Order ${input.orderNumber}`, MAX_DESCRIPTION),
            amount: {
              currency_code: currency,
              value: toDecimalString({ amountMinor: input.amountMinor, currency }),
              breakdown: {
                item_total: {
                  currency_code: currency,
                  value: toDecimalString({ amountMinor: itemTotal, currency }),
                },
                shipping: {
                  currency_code: currency,
                  value: toDecimalString({ amountMinor: input.shippingMinor, currency }),
                },
              },
            },
            items: input.items.map((item) => ({
              name: truncate(item.name, MAX_ITEM_NAME),
              description: item.description
                ? truncate(item.description, MAX_DESCRIPTION)
                : undefined,
              quantity: String(item.quantity),
              unit_amount: {
                currency_code: currency,
                value: toDecimalString({ amountMinor: item.unitPriceMinor, currency }),
              },
            })),
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: input.successUrl,
              cancel_url: input.cancelUrl,
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
            },
          },
        },
      },
      idempotencyKey: `checkout:${input.idempotencyKey}`,
    });

    const approveUrl =
      order.links?.find((link) => link.rel === 'payer-action' || link.rel === 'approve')?.href ??
      null;

    if (!approveUrl) {
      throw new BadRequestException('PayPal did not return an approval link');
    }

    return { providerReference: order.id, redirectUrl: approveUrl, clientSecret: null };
  }

  async verifyWebhook(request: WebhookRequest): Promise<VerifiedPaymentEvent> {
    const header = (name: string): string => {
      const value = request.headers[name];
      const single = Array.isArray(value) ? value[0] : value;
      if (!single) throw new BadRequestException(`Missing ${name} header`);
      return single;
    };

    const body = JSON.parse(request.rawBody.toString('utf8'));
    const verification = await this.request<{ verification_status: string }>(
      'POST',
      '/v1/notifications/verify-webhook-signature',
      {
        body: {
          auth_algo: header('paypal-auth-algo'),
          cert_url: header('paypal-cert-url'),
          transmission_id: header('paypal-transmission-id'),
          transmission_sig: header('paypal-transmission-sig'),
          transmission_time: header('paypal-transmission-time'),
          webhook_id: this.webhookId,
          webhook_event: body,
        },
      },
    );

    if (verification.verification_status !== 'SUCCESS') {
      this.logger.warn(`Rejected PayPal webhook ${body?.id}: ${verification.verification_status}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    return this.normalise(body);
  }

  async confirmPayment(providerReference: string): Promise<VerifiedPaymentEvent> {
    let order: PayPalOrderResponse;
    try {
      order = await this.request<PayPalOrderResponse>(
        'POST',
        `/v2/checkout/orders/${providerReference}/capture`,
        { body: {}, idempotencyKey: `capture:${providerReference}` },
      );
    } catch (error) {
      if (error instanceof PayPalApiError && error.issue === 'ORDER_ALREADY_CAPTURED') {
        order = await this.request<PayPalOrderResponse>(
          'GET',
          `/v2/checkout/orders/${providerReference}`,
        );
      } else {
        throw error;
      }
    }

    const unit = order.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    const completed = order.status === 'COMPLETED' && capture?.status === 'COMPLETED';

    return {
      externalId: `confirm:${order.id}:${order.status}`,
      eventType: 'checkout.order.capture',
      kind: completed ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_PENDING',
      providerReference: order.id,
      orderId: unit?.custom_id ?? unit?.reference_id ?? null,
      ...amountFrom(capture?.amount ?? unit?.amount),
      raw: order,
    };
  }

  async refund(
    providerReference: string,
    amountMinor: number,
    currency: Currency,
  ): Promise<RefundResult> {
    const order = await this.request<PayPalOrderResponse>(
      'GET',
      `/v2/checkout/orders/${providerReference}`,
    );
    const captureId = order.purchase_units?.[0]?.payments?.captures?.[0]?.id;
    if (!captureId) {
      throw new BadRequestException(`PayPal order ${providerReference} has no capture to refund`);
    }

    const refund = await this.request<{ id: string; amount: { value: string; currency_code: string } }>(
      'POST',
      `/v2/payments/captures/${captureId}/refund`,
      {
        body: {
          amount: { value: toDecimalString({ amountMinor, currency }), currency_code: currency },
        },
        idempotencyKey: `refund:${captureId}:${amountMinor}`,
      },
    );

    return {
      providerRefundId: refund.id,
      amountMinor: fromDecimalString(refund.amount.value, currency).amountMinor,
    };
  }

  private normalise(event: {
    id: string;
    event_type: string;
    resource?: Record<string, unknown>;
  }): VerifiedPaymentEvent {
    const resource = (event.resource ?? {}) as {
      id?: string;
      custom_id?: string;
      status?: string;
      amount?: { currency_code: string; value: string };
      supplementary_data?: { related_ids?: { order_id?: string } };
      purchase_units?: { custom_id?: string; reference_id?: string }[];
    };

    const orderId =
      resource.custom_id ??
      resource.purchase_units?.[0]?.custom_id ??
      resource.purchase_units?.[0]?.reference_id ??
      null;

    const providerReference =
      resource.supplementary_data?.related_ids?.order_id ?? resource.id ?? null;

    const base = {
      externalId: event.id,
      eventType: event.event_type,
      providerReference,
      orderId,
      ...amountFrom(resource.amount),
      raw: event as unknown,
    };

    switch (event.event_type) {
      case 'PAYMENT.CAPTURE.COMPLETED':
        return { ...base, kind: 'PAYMENT_SUCCEEDED' };
      case 'CHECKOUT.ORDER.APPROVED':
        return { ...base, kind: 'PAYMENT_PENDING' };
      case 'PAYMENT.CAPTURE.DENIED':
      case 'PAYMENT.CAPTURE.DECLINED':
      case 'CHECKOUT.ORDER.VOIDED':
        return { ...base, kind: 'PAYMENT_FAILED' };
      case 'PAYMENT.CAPTURE.REFUNDED':
      case 'PAYMENT.CAPTURE.REVERSED':
        return { ...base, kind: 'REFUNDED' };
      case 'CUSTOMER.DISPUTE.CREATED':
        return { ...base, kind: 'CHARGEBACK' };
      default:
        return { ...base, kind: 'IGNORED' };
    }
  }

  private async accessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.value;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const response = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new PayPalApiError('Failed to obtain PayPal access token', response.status);
    }

    const token = (await response.json()) as PayPalTokenResponse;
    this.cachedToken = {
      value: token.access_token,
      expiresAt: Date.now() + (token.expires_in - 60) * 1000,
    };
    return token.access_token;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    if (options.idempotencyKey) headers['PayPal-Request-Id'] = options.idempotencyKey;

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();
    const parsed = text ? safeJson(text) : {};

    if (!response.ok) {
      const issue = (parsed as { details?: { issue?: string }[] })?.details?.[0]?.issue;
      this.logger.warn(`PayPal ${method} ${path} -> ${response.status} ${issue ?? text.slice(0, 200)}`);
      throw new PayPalApiError(
        `PayPal ${method} ${path} failed with ${response.status}`,
        response.status,
        issue,
      );
    }

    return parsed as T;
  }
}

export class PayPalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issue?: string,
  ) {
    super(message);
    this.name = 'PayPalApiError';
  }
}

function amountFrom(
  amount: { currency_code: string; value: string } | undefined,
): { amountMinor: number | null; currency: Currency | null } {
  if (!amount) return { amountMinor: null, currency: null };
  const code = amount.currency_code.toUpperCase();
  if (code !== 'EUR') return { amountMinor: null, currency: null };
  return { amountMinor: fromDecimalString(amount.value, code).amountMinor, currency: code };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
