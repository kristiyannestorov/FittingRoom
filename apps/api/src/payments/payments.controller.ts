import { Body, Controller, HttpCode, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { checkoutSchema, type CheckoutInput } from '@zed/contracts';
import { PaymentsService } from './payments.service';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { zodBody } from '../common/zod-validation.pipe';
import { CurrentUser } from '../common/current-user.decorator';
import { Public } from '../common/public.decorator';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly registry: PaymentProviderRegistry,
  ) {}

  @Public()
  @Post('providers')
  @HttpCode(200)
  providers() {
    return { providers: this.registry.available(), default: this.registry.default().key };
  }

  @HttpCode(200)
  @Post('checkout')
  checkout(
    @CurrentUser('id') userId: string,
    @Body(zodBody(checkoutSchema)) dto: CheckoutInput,
  ) {
    return this.payments.createCheckout(userId, dto);
  }

  @HttpCode(200)
  @Post('reconcile')
  reconcile(@CurrentUser('id') userId: string, @Query('order') orderNumber: string) {
    return this.payments.reconcile(userId, orderNumber);
  }
}
