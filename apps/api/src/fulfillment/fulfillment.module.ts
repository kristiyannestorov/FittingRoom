import { Module } from '@nestjs/common';
import { ProductionService } from './production.service';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [OrdersModule],
  providers: [ProductionService],
  exports: [ProductionService],
})
export class FulfillmentModule {}
