import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, type JobsOptions } from 'bullmq';
import type { Env } from '../config/configuration';
import {
  ALL_QUEUES,
  bullConnectionOptions,
  jobOptionsFor,
  type JobPayloadMap,
  type QueueName,
} from './queue.constants';

export const QUEUE_REGISTRY = 'QUEUE_REGISTRY';

@Injectable()
export class QueueService implements OnApplicationShutdown {
  constructor(
    @Inject(QUEUE_REGISTRY) private readonly queues: Map<QueueName, Queue>,
  ) {}

  getQueue(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Queue "${name}" is not registered`);
    return queue;
  }

  async enqueue<Q extends QueueName, J extends keyof JobPayloadMap[Q] & string>(
    queueName: Q,
    jobName: J,
    payload: JobPayloadMap[Q][J],
    options?: JobsOptions,
  ): Promise<string> {
    const job = await this.getQueue(queueName).add(jobName, payload, {
      ...jobOptionsFor(queueName),
      ...options,
    });
    return job.id as string;
  }

  async enqueueOnce<Q extends QueueName, J extends keyof JobPayloadMap[Q] & string>(
    queueName: Q,
    jobName: J,
    jobId: string,
    payload: JobPayloadMap[Q][J],
    options?: JobsOptions,
  ): Promise<string> {
    return this.enqueue(queueName, jobName, payload, { ...options, jobId });
  }

  async enqueueDelayed<Q extends QueueName, J extends keyof JobPayloadMap[Q] & string>(
    queueName: Q,
    jobName: J,
    payload: JobPayloadMap[Q][J],
    delayMs: number,
    options?: JobsOptions,
  ): Promise<string> {
    return this.enqueue(queueName, jobName, payload, { ...options, delay: delayMs });
  }

  async schedule<Q extends QueueName, J extends keyof JobPayloadMap[Q] & string>(
    queueName: Q,
    jobName: J,
    payload: JobPayloadMap[Q][J],
    cron: string,
  ): Promise<void> {
    await this.getQueue(queueName).add(jobName, payload, {
      ...jobOptionsFor(queueName),
      repeat: { pattern: cron },
      jobId: `repeat:${jobName}`,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

export function createQueueRegistry(config: ConfigService<Env, true>): Map<QueueName, Queue> {
  const connection = bullConnectionOptions(config.get('REDIS_URL', { infer: true }));
  return new Map(
    ALL_QUEUES.map((name) => [name, new Queue(name, { connection })] as const),
  );
}
