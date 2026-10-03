import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { productStatsQuerySchema } from '@zed/contracts';
import { AdminStatsService } from './admin-stats.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { Roles } from '../common/roles.decorator';

@ApiTags('admin/stats')
@Roles('ADMIN')
@Controller('admin/stats')
export class AdminStatsController {
  constructor(
    private readonly stats: AdminStatsService,
    private readonly analytics: AnalyticsService,
  ) {}

  @Get()
  get() {
    return this.stats.getStats();
  }

  @Get('products')
  products(@Query() query: Record<string, string>) {
    const { days, limit } = productStatsQuerySchema.parse(query);
    return this.analytics.productStats(days, limit);
  }
}
