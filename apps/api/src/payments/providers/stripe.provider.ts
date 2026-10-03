import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Currency, PaymentProviderKey } from '@zed/contracts';
import type { Env } from '../../config/configuration';
import type {
  CreateCheckoutInput,
  CreateCheckoutResult,
  PaymentProvider,
  RefundResult,
  VerifiedPaymentEvent,
  WebhookRequest,
} from '../payment-provider.interface';

@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  readonly key: PaymentProviderKey = 'STRIPE';

  private readonly logger = new Logger(StripePaymentProvider.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(config: ConfigService<Env, true>) {
    this.stripe = new Stripe(config.get('STRIPE_SECRET_KEY', { infer: true }), {
      apiVersion: '2025-02-24.acacia',
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
    this.webhookSecret = config.get('STRIPE_WEBHOOK_SECRET', { infer: true });
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = input.items.map((item) => ({
      quantity: item.quantity,
      price_data: {
        currency: input.currency.toLowerCase(),
        unit_amount: item.unitPriceMinor,
        product_data: {
          name: item.name,
          ...(item.description ? { description: item.description } : {}),
          ...(item.imageUrl ? { images: [item.imageUrl] } : {}),
        },
      },
    }));

    if (input.shippingMinor > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: input.currency.toLowerCase(),
          unit_amount: input.shippingMinor,
          product_data: { name: 'Shipping' },
        },
      });
    }

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: lineItems,
        customer_email: input.customerEmail,
        client_reference_id: input.orderId,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: input.metadata,
        payment_intent_data: { metadata: input.metadata },
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      },
      { idempotencyKey: `checkout:${input.idempotencyKey}` },
    );

    return {
      providerReference: session.id,
      redirectUrl: session.url,
      clientSecret: null,
    };
  }

  async verifyWebhook(request: WebhookRequest): Promise<VerifiedPaymentEvent> {
    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string') {
      throw new BadRequestException('Missing stripe-signature header');
    }

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(
        request.rawBody,
        signature,
        this.webhookSecret,
      );
    } catch (error) {
      this.logger.warn(`Rejected Stripe webhook: ${(error as Error).message}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    return this.normalise(event);
  }

  async confirmPayment(providerReference: string): Promise<VerifiedPaymentEvent> {
    const session = await this.stripe.checkout.sessions.retrieve(providerReference);
    const paid = session.payment_status === 'paid';
    return {
      externalId: `confirm:${session.id}:${session.payment_status}`,
      eventType: 'checkout.session.confirm',
      kind: paid ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_PENDING',
      providerReference: session.id,
      orderId: session.metadata?.orderId ?? session.client_reference_id ?? null,
      amountMinor: session.amount_total,
      currency: toCurrency(session.currency),
      raw: session,
    };
  }

  async refund(
    providerReference: string,
    amountMinor: number,
    _currency: Currency,
  ): Promise<RefundResult> {
    const session = await this.stripe.checkout.sessions.retrieve(providerReference);
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;

    if (!paymentIntentId) {
      throw new BadRequestException(`Session ${providerReference} has no payment to refund`);
    }

    const refund = await this.stripe.refunds.create(
      { payment_intent: paymentIntentId, amount: amountMinor },
      { idempotencyKey: `refund:${providerReference}:${amountMinor}` },
    );

    return { providerRefundId: refund.id, amountMinor: refund.amount };
  }

  private normalise(event: Stripe.Event): VerifiedPaymentEvent {
    const base = {
      externalId: event.id,
      eventType: event.type,
      raw: event as unknown,
    };

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session;
        return {
          ...base,
          kind: session.payment_status === 'paid' ? 'PAYMENT_SUCCEEDED' : 'PAYMENT_PENDING',
          providerReference: session.id,
          orderId: session.metadata?.orderId ?? session.client_reference_id ?? null,
          amountMinor: session.amount_total,
          currency: toCurrency(session.currency),
        };
      }

      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed': {
        const session = event.data.object as Stripe.Checkout.Session;
        return {
          ...base,
          kind: 'PAYMENT_FAILED',
          providerReference: session.id,
          orderId: session.metadata?.orderId ?? session.client_reference_id ?? null,
          amountMinor: session.amount_total,
          currency: toCurrency(session.currency),
        };
      }

      case 'payment_intent.payment_failed': {
        const intent = event.data.object as Stripe.PaymentIntent;
        return {
          ...base,
          kind: 'PAYMENT_FAILED',
          providerReference: intent.id,
          orderId: intent.metadata?.orderId ?? null,
          amountMinor: intent.amount,
          currency: toCurrency(intent.currency),
        };
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        return {
          ...base,
          kind: 'REFUNDED',
          providerReference:
            typeof charge.payment_intent === 'string' ? charge.payment_intent : null,
          orderId: charge.metadata?.orderId ?? null,
          amountMinor: charge.amount_refunded,
          currency: toCurrency(charge.currency),
        };
      }

      case 'charge.dispute.created': {
        const dispute = event.data.object as Stripe.Dispute;
        return {
          ...base,
          kind: 'CHARGEBACK',
          providerReference:
            typeof dispute.payment_intent === 'string' ? dispute.payment_intent : null,
          orderId: dispute.metadata?.orderId ?? null,
          amountMinor: dispute.amount,
          currency: toCurrency(dispute.currency),
        };
      }

      default:
        return {
          ...base,
          kind: 'IGNORED',
          providerReference: null,
          orderId: null,
          amountMinor: null,
          currency: null,
        };
    }
  }
}

function toCurrency(value: string | null | undefined): Currency | null {
  if (!value) return null;
  const upper = value.toUpperCase();
  return upper === 'EUR' ? upper : null;
}
