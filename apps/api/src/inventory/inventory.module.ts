import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
