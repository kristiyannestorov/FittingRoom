import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { claimDiscountSchema, type ClaimDiscountInput } from '@zed/contracts';
import { DiscountsService } from './discounts.service';
import { zodBody } from '../common/zod-validation.pipe';
import { Public } from '../common/public.decorator';

@ApiTags('discounts')
@Controller('discounts')
export class DiscountsController {
  constructor(private readonly discounts: DiscountsService) {}

  @Public()
  @HttpCode(200)
  @Post('claim')
  claim(@Body(zodBody(claimDiscountSchema)) dto: ClaimDiscountInput) {
    return this.discounts.claim(dto.productType);
  }
}
