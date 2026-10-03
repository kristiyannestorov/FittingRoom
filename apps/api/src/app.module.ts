import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { validateEnv, type Env } from './config/configuration';
import { createLogger } from './common/logger';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { JwtAuthGuard, RolesGuard } from './common/guards';

import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';
import { QueueModule } from './queue/queue.module';

import { AuthModule } from './auth/auth.module';
import { CartModule } from './cart/cart.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { ShippingModule } from './shipping/shipping.module';
import { AssetsModule } from './assets/assets.module';
import { InventoryModule } from './inventory/inventory.module';
import { NotificationsModule } from './notifications/notifications.module';
import { FulfillmentModule } from './fulfillment/fulfillment.module';
import { AdminModule } from './admin/admin.module';
import { GarmentGenerationModule } from './garment-generation/garment-generation.module';
import { DiscountsModule } from './discounts/discounts.module';
import { AnalyticsModule } from './analytics/analytics.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (raw) => validateEnv(raw),
    }),

    PrismaModule,
    RedisModule,
    StorageModule,
    QueueModule,

    AuthModule,
    CartModule,
    OrdersModule,
    PaymentsModule,
    ShippingModule,
    AssetsModule,
    InventoryModule,
    NotificationsModule,
    FulfillmentModule,
    AdminModule,
    GarmentGenerationModule,
    DiscountsModule,
    AnalyticsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    {
      provide: APP_FILTER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new AllExceptionsFilter(
          createLogger(config.get('LOG_LEVEL', { infer: true }), config.get('NODE_ENV', { infer: true }) === 'development'),
        ),
    },
  ],
})
export class AppModule {}
