import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createQueueRegistry, QUEUE_REGISTRY, QueueService } from './queue.service';

@Global()
@Module({
  providers: [
    {
      provide: QUEUE_REGISTRY,
      inject: [ConfigService],
      useFactory: createQueueRegistry,
    },
    QueueService,
  ],
  exports: [QueueService],
})
export class QueueModule {}
