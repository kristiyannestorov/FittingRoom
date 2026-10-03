import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { trackProductEventSchema, type TrackProductEventInput } from '@zed/contracts';
import { AnalyticsService } from './analytics.service';
import { zodBody } from '../common/zod-validation.pipe';
import { Public } from '../common/public.decorator';

@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Public()
  @HttpCode(204)
  @Post('product-event')
  async track(@Body(zodBody(trackProductEventSchema)) dto: TrackProductEventInput): Promise<void> {
    await this.analytics.track(dto);
  }
}
