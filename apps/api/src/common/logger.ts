import pino, { type Logger } from 'pino';

export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["stripe-signature"]',
  'req.body.password',
  'req.body.refreshToken',
  'req.body.address.phone',
  'req.body.address.email',
  '*.passwordHash',
  '*.password',
  '*.secret',
  '*.clientSecret',
  '*.accessToken',
  '*.refreshToken',
];

export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    transport: pretty
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
      : undefined,
  });
}
