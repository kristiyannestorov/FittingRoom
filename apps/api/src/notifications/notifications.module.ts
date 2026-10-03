import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { MailerService } from './mailer.service';

@Module({
  providers: [NotificationsService, MailerService],
  exports: [NotificationsService, MailerService],
})
export class NotificationsModule {}
