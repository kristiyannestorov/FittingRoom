import type { JobsOptions, QueueOptions } from 'bullmq';

export const QUEUE = {
  PAYMENTS: 'payments',
  ORDERS: 'orders',
  SHIPPING: 'shipping',
  NOTIFICATIONS: 'notifications',
  INVENTORY: 'inventory',
  GARMENT_GENERATION: 'garment-generation',
  TRY_ON: 'try-on',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const ALL_QUEUES: readonly QueueName[] = Object.values(QUEUE);

export const JOB = {
  PROCESS_PAYMENT_EVENT: 'process-payment-event',
  CANCEL_UNPAID_ORDER: 'cancel-unpaid-order',
  CREATE_SHIPMENT: 'create-shipment',
  POLL_SHIPMENT: 'poll-shipment',
  PROCESS_COURIER_EVENT: 'process-courier-event',
  REFRESH_COURIER_OFFICES: 'refresh-courier-offices',
  SEND_EMAIL: 'send-email',
  CHECK_LOW_STOCK: 'check-low-stock',
  GENERATE_GARMENT: 'generate-garment',
  RUN_TRY_ON: 'run-try-on',
} as const;

export interface ProcessPaymentEventJob {
  paymentEventId: string;
}

export interface CancelUnpaidOrderJob {
  orderId: string;
}

export interface CreateShipmentJob {
  orderId: string;
}

export interface PollShipmentJob {
  shipmentId: string;
}

export interface ProcessCourierEventJob {
  provider: 'ECONT' | 'SPEEDY';
  trackingNumber: string;
  rawPayload: unknown;
}

export interface RefreshCourierOfficesJob {
  provider: 'ECONT' | 'SPEEDY';
}

export interface SendEmailJob {
  outboundEmailId: string;
}

export interface CheckLowStockJob {
  inventoryItemId: string;
}

export interface GenerateGarmentJob {
  garmentId: string;
}

export interface RunTryOnJob {
  tryOnId: string;
}

export interface JobPayloadMap {
  [QUEUE.PAYMENTS]: {
    [JOB.PROCESS_PAYMENT_EVENT]: ProcessPaymentEventJob;
  };
  [QUEUE.ORDERS]: {
    [JOB.CANCEL_UNPAID_ORDER]: CancelUnpaidOrderJob;
  };
  [QUEUE.SHIPPING]: {
    [JOB.CREATE_SHIPMENT]: CreateShipmentJob;
    [JOB.POLL_SHIPMENT]: PollShipmentJob;
    [JOB.PROCESS_COURIER_EVENT]: ProcessCourierEventJob;
    [JOB.REFRESH_COURIER_OFFICES]: RefreshCourierOfficesJob;
  };
  [QUEUE.NOTIFICATIONS]: {
    [JOB.SEND_EMAIL]: SendEmailJob;
  };
  [QUEUE.INVENTORY]: {
    [JOB.CHECK_LOW_STOCK]: CheckLowStockJob;
  };
  [QUEUE.GARMENT_GENERATION]: {
    [JOB.GENERATE_GARMENT]: GenerateGarmentJob;
  };
  [QUEUE.TRY_ON]: {
    [JOB.RUN_TRY_ON]: RunTryOnJob;
  };
}

export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 8,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 14 * 24 * 3600 },
};

export const QUEUE_JOB_OPTIONS: Partial<Record<QueueName, JobsOptions>> = {
  [QUEUE.NOTIFICATIONS]: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 10,
    backoff: { type: 'exponential', delay: 30_000 },
  },
  [QUEUE.GARMENT_GENERATION]: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 1,
  },
  [QUEUE.TRY_ON]: {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  },
};

export function jobOptionsFor(queue: QueueName): JobsOptions {
  return QUEUE_JOB_OPTIONS[queue] ?? DEFAULT_JOB_OPTIONS;
}

export const QUEUE_CONCURRENCY: Record<QueueName, number> = {
  [QUEUE.PAYMENTS]: 10,
  [QUEUE.ORDERS]: 5,
  [QUEUE.SHIPPING]: 5,
  [QUEUE.NOTIFICATIONS]: 10,
  [QUEUE.INVENTORY]: 5,
  [QUEUE.GARMENT_GENERATION]: 1,
  [QUEUE.TRY_ON]: 1,
};

export function bullConnectionOptions(redisUrl: string): QueueOptions['connection'] {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}
