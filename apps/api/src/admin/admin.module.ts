import { Module } from '@nestjs/common';
import { AdminProductsController } from './admin-products.controller';
import { AdminInventoryController } from './admin-inventory.controller';
import { AdminOrdersController } from './admin-orders.controller';
import { AdminProductionController } from './admin-production.controller';
import { AdminStatsController } from './admin-stats.controller';
import { AdminStatsService } from './admin-stats.service';
import { AdminEmailsController } from './admin-emails.controller';
import { AssetsModule } from '../assets/assets.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OrdersModule } from '../orders/orders.module';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { GarmentGenerationModule } from '../garment-generation/garment-generation.module';
import { AdminProductBatchController } from './admin-product-batch.controller';
import { AdminProductBatchService } from './admin-product-batch.service';

@Module({
  imports: [
    AssetsModule,
    InventoryModule,
    OrdersModule,
    FulfillmentModule,
    NotificationsModule,
    AnalyticsModule,
    GarmentGenerationModule,
  ],
  controllers: [
    AdminProductBatchController,
    AdminProductsController,
    AdminInventoryController,
    AdminOrdersController,
    AdminProductionController,
    AdminStatsController,
    AdminEmailsController,
  ],
  providers: [AdminStatsService, AdminProductBatchService],
})
export class AdminModule {}
