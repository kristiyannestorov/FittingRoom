import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PRODUCTION_TICKET_STATUSES } from '@zed/contracts';
import { ProductionService } from '../fulfillment/production.service';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { zodBody } from '../common/zod-validation.pipe';

const statusSchema = z.object({ status: z.enum(PRODUCTION_TICKET_STATUSES) });

@ApiTags('admin/production')
@Roles('ADMIN')
@Controller('admin/production-tickets')
export class AdminProductionController {
  constructor(private readonly production: ProductionService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.production.listQueue(status as never);
  }

  @Patch(':ticketId')
  setStatus(
    @Param('ticketId') ticketId: string,
    @Body(zodBody(statusSchema)) dto: z.infer<typeof statusSchema>,
    @CurrentUser('id') adminId: string,
  ) {
    return this.production.setStatus(ticketId, dto.status, adminId).then(() => ({ ok: true }));
  }
}
