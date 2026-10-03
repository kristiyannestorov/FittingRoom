import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  shippingQuoteSchema,
  type CourierOfficeView,
  type ShippingProviderKey,
  type ShippingQuoteInput,
} from '@zed/contracts';
import { ShippingService } from './shipping.service';
import { CartService } from '../cart/cart.service';
import { zodBody } from '../common/zod-validation.pipe';
import { CurrentUser } from '../common/current-user.decorator';
import { Public } from '../common/public.decorator';

@ApiTags('shipping')
@Controller('shipping')
export class ShippingController {
  constructor(
    private readonly shipping: ShippingService,
    private readonly cart: CartService,
  ) {}

  @HttpCode(200)
  @Post('quote')
  async quote(
    @CurrentUser('id') userId: string,
    @Body(zodBody(shippingQuoteSchema)) dto: ShippingQuoteInput,
  ) {
    const summary = await this.cart.getShippingSummary(userId);
    if (summary.itemCount === 0) {
      throw new BadRequestException('Cart is empty');
    }

    return this.shipping.quote(
      dto.address,
      dto.deliveryMode,
      summary.weightGrams,
      summary.subtotalMinor,
      summary.currency,
      dto.provider,
    );
  }

  @Public()
  @Get('offices')
  async offices(
    @Query('provider') provider: string,
    @Query('city') city?: string,
  ): Promise<CourierOfficeView[]> {
    const key = (provider ?? '').toUpperCase() as ShippingProviderKey;
    if (key !== 'ECONT' && key !== 'SPEEDY') {
      throw new BadRequestException('provider must be econt or speedy');
    }

    const offices = await this.shipping.listCachedOffices(key, city);
    return offices.map((office) => ({
      id: office.externalId,
      provider: office.provider,
      name: office.name,
      city: office.city,
      address: office.address,
      latitude: office.latitude,
      longitude: office.longitude,
    }));
  }

  @Public()
  @Get('track/:trackingNumber')
  async track(@Param('trackingNumber') trackingNumber: string) {
    const result = await this.shipping.trackByNumber(trackingNumber);
    if (!result) return { found: false, trackingNumber };
    return {
      found: true,
      trackingNumber: result.trackingNumber,
      status: result.status,
      deliveredAt: result.deliveredAt?.toISOString() ?? null,
      estimatedDeliveryDate: result.estimatedDeliveryDate?.toISOString() ?? null,
      events: result.events.map((event) => ({
        status: event.status,
        description: event.description,
        location: event.location,
        occurredAt: event.occurredAt.toISOString(),
      })),
    };
  }
}
