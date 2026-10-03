import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ORDER_STATUSES, type OrderStatus } from '@zed/contracts';
import { OrdersService } from '../orders/orders.service';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { zodBody } from '../common/zod-validation.pipe';

const transitionSchema = z.object({
  status: z.enum(ORDER_STATUSES),
  note: z.string().max(500).optional(),
});

@ApiTags('admin/orders')
@Roles('ADMIN')
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('page') page = '1',
    @Query('perPage') perPage = '30',
  ) {
    return this.orders.listAll(
      status as OrderStatus | undefined,
      Number(page) || 1,
      Number(perPage) || 30,
    );
  }

  @Get(':orderId')
  get(@Param('orderId') orderId: string) {
    return this.orders.getForAdmin(orderId);
  }

  @Patch(':orderId/status')
  setStatus(
    @Param('orderId') orderId: string,
    @Body(zodBody(transitionSchema)) dto: z.infer<typeof transitionSchema>,
    @CurrentUser('id') adminId: string,
  ) {
    return this.orders.adminTransition(orderId, dto.status, adminId, dto.note);
  }
}
