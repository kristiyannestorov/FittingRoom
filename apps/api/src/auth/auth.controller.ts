import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  loginSchema,
  refreshSchema,
  registerSchema,
  type LoginInput,
  type RefreshInput,
  type RegisterInput,
} from '@zed/contracts';
import { AuthService, type RequestContext } from './auth.service';
import { zodBody } from '../common/zod-validation.pipe';
import { Public } from '../common/public.decorator';
import { CurrentUser } from '../common/current-user.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body(zodBody(registerSchema)) dto: RegisterInput, @Req() req: Request) {
    return this.auth.register(dto, contextFrom(req));
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  login(@Body(zodBody(loginSchema)) dto: LoginInput, @Req() req: Request) {
    return this.auth.login(dto, contextFrom(req));
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body(zodBody(refreshSchema)) dto: RefreshInput, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, contextFrom(req));
  }

  @Public()
  @HttpCode(204)
  @Post('logout')
  async logout(@Body(zodBody(refreshSchema)) dto: RefreshInput): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  me(@CurrentUser('id') userId: string) {
    return this.auth.me(userId);
  }
}

function contextFrom(req: Request): RequestContext {
  return {
    userAgent: req.get('user-agent') ?? undefined,
    ipAddress: req.ip,
  };
}
