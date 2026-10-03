import { Module } from '@nestjs/common';
import { CourierWebhookController } from './courier-webhook.controller';
import { EcontShippingProvider } from './providers/econt.provider';
import { SpeedyShippingProvider } from './providers/speedy.provider';
import { ShippingController } from './shipping.controller';
import { ShippingProviderRegistry } from './shipping-provider.registry';
import { SHIPPING_PROVIDERS_TOKEN } from './shipping-provider.interface';
import { ShippingService } from './shipping.service';
import { OrdersModule } from '../orders/orders.module';
import { CartModule } from '../cart/cart.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [OrdersModule, CartModule, NotificationsModule],
  controllers: [ShippingController, CourierWebhookController],
  providers: [
    EcontShippingProvider,
    SpeedyShippingProvider,
    {
      provide: SHIPPING_PROVIDERS_TOKEN,
      inject: [EcontShippingProvider, SpeedyShippingProvider],
      useFactory: (econt: EcontShippingProvider, speedy: SpeedyShippingProvider) => [econt, speedy],
    },
    ShippingProviderRegistry,
    ShippingService,
  ],
  exports: [ShippingService, ShippingProviderRegistry],
})
export class ShippingModule {}
