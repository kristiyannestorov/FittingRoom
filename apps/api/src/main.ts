import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { AppModule } from './app.module';
import type { Env } from './config/configuration';
import { QueueService } from './queue/queue.service';
import { ALL_QUEUES, JOB, QUEUE } from './queue/queue.constants';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });

  const config = app.get(ConfigService<Env, true>);

  app.use(helmet());
  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }),
    credentials: true,
  });
  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');

  if (config.get('ADMIN_QUEUE_DASHBOARD_ENABLED', { infer: true })) {
    const queueService = app.get(QueueService);
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/api/admin/queues');
    createBullBoard({
      queues: ALL_QUEUES.map((name) => new BullMQAdapter(queueService.getQueue(name))),
      serverAdapter,
    });
    app.use('/api/admin/queues', serverAdapter.getRouter());
  }

  await scheduleRecurringJobs(app.get(QueueService));

  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  console.log(`API listening on :${port}`);
}

async function scheduleRecurringJobs(queue: QueueService): Promise<void> {
  await queue.schedule(QUEUE.SHIPPING, JOB.REFRESH_COURIER_OFFICES, { provider: 'ECONT' }, '0 3 * * *');
  await queue.schedule(QUEUE.SHIPPING, JOB.REFRESH_COURIER_OFFICES, { provider: 'SPEEDY' }, '15 3 * * *');
}

bootstrap().catch((error) => {
  console.error('API failed to start:', error);
  process.exit(1);
});
