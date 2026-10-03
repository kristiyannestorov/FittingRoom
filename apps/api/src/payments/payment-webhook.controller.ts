import {
  BadRequestException,
  Controller,
  HttpCode,
  Logger,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import type { PaymentProviderKey } from '@zed/contracts';
import { PaymentsService } from './payments.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { Public } from '../common/public.decorator';

@ApiExcludeController()
@Controller('webhooks/payments')
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);

  constructor(
    private readonly payments: PaymentsService,
    private readonly registry: PaymentProviderRegistry,
  ) {}

  @Public()
  @HttpCode(202)
  @Post(':provider')
  async receive(
    @Param('provider') providerParam: string,
    @Req() request: RawBodyRequest,
  ): Promise<{ received: true }> {
    const key = providerParam.toUpperCase() as PaymentProviderKey;
    const provider = this.registry.get(key);

    if (!request.rawBody) {
      throw new BadRequestException('Raw request body unavailable');
    }

    const event = await provider.verifyWebhook({
      rawBody: request.rawBody,
      headers: request.headers as Record<string, string | string[] | undefined>,
    });

    await this.payments.recordAndQueue(event, key);

    this.logger.debug(`Accepted ${key} event ${event.eventType} (${event.externalId})`);
    return { received: true };
  }
}

export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}
