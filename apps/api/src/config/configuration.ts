import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

const csv = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PUBLIC_URL: z.string().url(),
  WEB_PUBLIC_URL: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: csv.default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional().default('zed-assets'),
  S3_ACCESS_KEY_ID: z.string().optional().default('test'),
  S3_SECRET_ACCESS_KEY: z.string().optional().default('test'),
  S3_FORCE_PATH_STYLE: bool.default('true'),
  S3_PUBLIC_BASE_URL: z.string().url().optional(),

  DEFAULT_PAYMENT_PROVIDER: z.enum(['stripe', 'paypal']).default('stripe'),
  STRIPE_SECRET_KEY: z.string().min(1).default('sk_test_dev'),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).default('whsec_dev'),
  PAYPAL_CLIENT_ID: z.string().min(1).default('dev-client'),
  PAYPAL_CLIENT_SECRET: z.string().min(1).default('dev-secret'),
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_WEBHOOK_ID: z.string().min(1).default('dev-webhook'),

  ECONT_BASE_URL: z.string().url().default('https://demo.econt.com/ee/services'),
  ECONT_USERNAME: z.string().min(1).default('dev-user'),
  ECONT_PASSWORD: z.string().min(1).default('dev-pass'),
  ECONT_SHIPPING_WEBHOOK_SECRET: z.string().min(1).default('dev-secret'),
  SPEEDY_BASE_URL: z.string().url().default('https://api.speedy.bg/v1'),
  SPEEDY_USERNAME: z.string().min(1).default('dev-user'),
  SPEEDY_PASSWORD: z.string().min(1).default('dev-pass'),
  SPEEDY_SERVICE_ID: z.coerce.number().int().positive().default(505),
  SPEEDY_SHIPPING_WEBHOOK_SECRET: z.string().min(1).default('dev-secret'),

  SENDER_NAME: z.string().min(1).default('ProjectZed OOD'),
  SENDER_PHONE: z.string().min(1).default('+359888000000'),
  SENDER_EMAIL: z.string().email().default('fulfillment@projectzed.bg'),
  SENDER_COUNTRY: z.string().length(2).default('BG'),
  SENDER_CITY: z.string().min(1).default('Plovdiv'),
  SENDER_POST_CODE: z.string().min(1).default('4000'),
  SENDER_STREET: z.string().min(1).default('bul. Bulgaria'),
  SENDER_STREET_NUM: z.string().min(1).default('1'),

  DEFAULT_CURRENCY: z.enum(['EUR']).default('EUR'),
  FREE_SHIPPING_THRESHOLD_MINOR: z.coerce.number().int().nonnegative().default(0),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  SMTP_SECURE: bool.default('false'),
  MAIL_FROM: z.string().min(1),
  ADMIN_ALERT_EMAIL: z.string().email(),

  ADMIN_QUEUE_DASHBOARD_ENABLED: bool.default('false'),

  DEFAULT_GARMENT_GENERATION_PROVIDER: z.enum(['manual', 'local_bake']).default('manual'),
  GARMENT_MAX_GLB_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  GARMENT_MAX_TRIANGLES: z.coerce.number().int().positive().default(150_000),
  GARMENT_MAX_SOURCE_IMAGES: z.coerce.number().int().positive().default(6),
  GARMENT_MAX_SOURCE_IMAGE_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),

  GARMENT3D_SERVICE_URL: z.string().url().default('http://127.0.0.1:8100'),
  GARMENT3D_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(20 * 60_000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  return parsed.data;
}
