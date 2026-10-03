import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { NotificationsService } from '../notifications/notifications.service';
import { Roles } from '../common/roles.decorator';

@ApiTags('admin/emails')
@Roles('ADMIN')
@Controller('admin/emails')
export class AdminEmailsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @Query('status') status?: 'sent' | 'failed' | 'pending',
    @Query('template') template?: string,
    @Query('page') page = '1',
    @Query('perPage') perPage = '30',
  ) {
    return this.notifications.listAll(status, template, Number(page) || 1, Number(perPage) || 30);
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const email = await this.notifications.getById(id);
    if (!email) throw new NotFoundException('Email not found');
    return email;
  }
}
