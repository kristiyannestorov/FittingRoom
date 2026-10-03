import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { OrdersService } from './orders.service';
import { CurrentUser } from '../common/current-user.decorator';

@ApiTags('orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.orders.listForUser(userId);
  }

  @Get(':orderId')
  get(@CurrentUser('id') userId: string, @Param('orderId') orderId: string) {
    return this.orders.getForUser(userId, orderId);
  }
}
