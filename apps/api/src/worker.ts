import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Worker, type Job } from 'bullmq';
import { AppModule } from './app.module';
import type { Env } from './config/configuration';
import {
  QUEUE,
  QUEUE_CONCURRENCY,
  bullConnectionOptions,
  type JobPayloadMap,
} from './queue/queue.constants';

import { PaymentsService } from './payments/payments.service';
import { OrdersService } from './orders/orders.service';
import { ShippingService } from './shipping/shipping.service';
import { MailerService } from './notifications/mailer.service';
import { InventoryService } from './inventory/inventory.service';
import { GarmentGenerationService } from './garment-generation/garment-generation.service';
import { TryOnService } from './assets/try-on.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  const config = app.get(ConfigService<Env, true>);
  const connection = bullConnectionOptions(config.get('REDIS_URL', { infer: true }));

  const payments = app.get(PaymentsService);
  const orders = app.get(OrdersService);
  const shipping = app.get(ShippingService);
  const mailer = app.get(MailerService);
  const inventory = app.get(InventoryService);
  const garmentGeneration = app.get(GarmentGenerationService);
  const tryOn = app.get(TryOnService);

  const workers = [
    new Worker(
      QUEUE.PAYMENTS,
      async (job: Job<JobPayloadMap['payments']['process-payment-event']>) => {
        await payments.processPaymentEvent(job.data.paymentEventId);
      },
      { connection, concurrency: QUEUE_CONCURRENCY[QUEUE.PAYMENTS] },
    ),

    new Worker(
      QUEUE.ORDERS,
      async (job: Job<JobPayloadMap['orders']['cancel-unpaid-order']>) => {
        await orders.cancelIfUnpaid(job.data.orderId);
      },
      { connection, concurrency: QUEUE_CONCURRENCY[QUEUE.ORDERS] },
    ),

    new Worker(
      QUEUE.SHIPPING,
      async (job) => {
        switch (job.name) {
          case 'create-shipment':
            return shipping.createShipmentForOrder(
              (job as Job<JobPayloadMap['shipping']['create-shipment']>).data.orderId,
            );
          case 'poll-shipment':
            return shipping.pollShipment(
              (job as Job<JobPayloadMap['shipping']['poll-shipment']>).data.shipmentId,
            );
          case 'process-courier-event': {
            const data = (job as Job<JobPayloadMap['shipping']['process-courier-event']>).data;
            return shipping.processCourierEvent(data.provider, data.rawPayload);
          }
          case 'refresh-courier-offices':
            return shipping.refreshOffices(
              (job as Job<JobPayloadMap['shipping']['refresh-courier-offices']>).data.provider,
            );
          default:
            throw new Error(`Unhandled shipping job: ${job.name}`);
        }
      },
      { connection, concurrency: QUEUE_CONCURRENCY[QUEUE.SHIPPING] },
    ),

    new Worker(
      QUEUE.NOTIFICATIONS,
      async (job: Job<JobPayloadMap['notifications']['send-email']>) => {
        await mailer.deliver(job.data.outboundEmailId);
      },
      { connection, concurrency: QUEUE_CONCURRENCY[QUEUE.NOTIFICATIONS] },
    ),

    new Worker(
      QUEUE.INVENTORY,
      async (job: Job<JobPayloadMap['inventory']['check-low-stock']>) => {
        await inventory.checkLowStock(job.data.inventoryItemId);
      },
      { connection, concurrency: QUEUE_CONCURRENCY[QUEUE.INVENTORY] },
    ),

    new Worker(
      QUEUE.GARMENT_GENERATION,
      async (job: Job<JobPayloadMap['garment-generation']['generate-garment']>) => {
        await garmentGeneration.processJob(job.data.garmentId);
      },
      {
        connection,
        concurrency: QUEUE_CONCURRENCY[QUEUE.GARMENT_GENERATION],
        lockDuration: 60 * 60 * 1000,
      },
    ),

    new Worker(
      QUEUE.TRY_ON,
      async (job: Job<JobPayloadMap['try-on']['run-try-on']>) => {
        await tryOn.process(job.data.tryOnId);
      },
      {
        connection,
        concurrency: QUEUE_CONCURRENCY[QUEUE.TRY_ON],
        lockDuration: 60 * 60 * 1000,
      },
    ),
  ];

  for (const worker of workers) {
    worker.on('failed', (job, error) => {
      console.error(`[${worker.name}] job ${job?.id} (${job?.name}) failed:`, error.message);
    });
  }

  console.log(`Worker process started, listening on queues: ${workers.map((w) => w.name).join(', ')}`);

  const shutdown = async (): Promise<void> => {
    await Promise.all(workers.map((w) => w.close()));
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

bootstrap().catch((error) => {
  console.error('Worker failed to start:', error);
  process.exit(1);
});
