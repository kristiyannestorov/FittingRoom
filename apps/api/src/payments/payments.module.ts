import { Module } from '@nestjs/common';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { PAYMENT_PROVIDERS_TOKEN } from './payment-provider.interface';
import { StripePaymentProvider } from './providers/stripe.provider';
import { PayPalPaymentProvider } from './providers/paypal.provider';
import { CartModule } from '../cart/cart.module';
import { OrdersModule } from '../orders/orders.module';
import { ShippingModule } from '../shipping/shipping.module';

@Module({
  imports: [CartModule, OrdersModule, ShippingModule],
  controllers: [PaymentsController, PaymentWebhookController],
  providers: [
    StripePaymentProvider,
    PayPalPaymentProvider,
    {
      provide: PAYMENT_PROVIDERS_TOKEN,
      inject: [StripePaymentProvider, PayPalPaymentProvider],
      useFactory: (stripe: StripePaymentProvider, paypal: PayPalPaymentProvider) => [
        stripe,
        paypal,
      ],
    },
    PaymentProviderRegistry,
    PaymentsService,
  ],
  exports: [PaymentsService, PaymentProviderRegistry],
})
export class PaymentsModule {}
