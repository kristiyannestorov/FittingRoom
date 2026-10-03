import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { adjustInventorySchema, type AdjustInventoryInput } from '@zed/contracts';
import { InventoryService } from '../inventory/inventory.service';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { zodBody } from '../common/zod-validation.pipe';

@ApiTags('admin/inventory')
@Roles('ADMIN')
@Controller('admin/inventory')
export class AdminInventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('low-stock')
  lowStock() {
    return this.inventory.lowStockItems();
  }

  @Post('adjust')
  adjust(
    @Body(zodBody(adjustInventorySchema)) dto: AdjustInventoryInput,
    @CurrentUser('id') adminId: string,
  ) {
    return this.inventory.adjust(dto.sku, dto.delta, dto.reason, adminId);
  }
}
