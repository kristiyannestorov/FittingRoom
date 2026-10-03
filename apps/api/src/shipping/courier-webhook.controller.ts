import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Param,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { ShippingProviderKey } from '@zed/contracts';
import type { Env } from '../config/configuration';
import { QueueService } from '../queue/queue.service';
import { JOB, QUEUE } from '../queue/queue.constants';
import { Public } from '../common/public.decorator';

@ApiExcludeController()
@Controller('webhooks/courier')
export class CourierWebhookController {
  private readonly logger = new Logger(CourierWebhookController.name);

  constructor(
    private readonly queue: QueueService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Public()
  @HttpCode(202)
  @Post(':provider/:secret')
  async receive(
    @Param('provider') provider: string,
    @Param('secret') secret: string,
    @Body() payload: unknown,
  ): Promise<{ accepted: true }> {
    const key = provider.toUpperCase() as ShippingProviderKey;
    const expected =
      key === 'ECONT'
        ? this.config.get('ECONT_SHIPPING_WEBHOOK_SECRET', { infer: true })
        : key === 'SPEEDY'
          ? this.config.get('SPEEDY_SHIPPING_WEBHOOK_SECRET', { infer: true })
          : null;

    if (!expected || !constantTimeEquals(secret, expected)) {
      this.logger.warn(`Rejected courier webhook for provider "${provider}"`);
      throw new UnauthorizedException();
    }

    const trackingNumber = extractTrackingNumber(payload);
    if (!trackingNumber) {
      this.logger.warn(`${key} webhook had no tracking number`);
      return { accepted: true };
    }

    await this.queue.enqueue(QUEUE.SHIPPING, JOB.PROCESS_COURIER_EVENT, {
      provider: key,
      trackingNumber,
      rawPayload: payload,
    });

    return { accepted: true };
  }
}

function extractTrackingNumber(payload: unknown): string | null {
  const body = payload as {
    shipmentNumber?: string;
    parcelId?: string;
    id?: string;
  } | null;
  return body?.shipmentNumber ?? body?.parcelId ?? body?.id ?? null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
