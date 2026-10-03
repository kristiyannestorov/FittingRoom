import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomUUID } from 'node:crypto';
import type {
  AuthResponse,
  AuthTokens,
  LoginInput,
  RegisterInput,
  UserView,
} from '@zed/contracts';
import type { Env } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import type { User } from '@prisma/client';

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
};

interface AccessTokenClaims {
  sub: string;
  email: string;
  role: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async register(input: RegisterInput, context: RequestContext): Promise<AuthResponse> {
    const email = normaliseEmail(input.email);
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException('An account with that email already exists');
    }

    const user = await this.prisma.user.create({
      data: {
        email,
        fullName: input.fullName.trim(),
        passwordHash: await argon2.hash(input.password, ARGON2_OPTIONS),
      },
    });

    this.logger.log(`Registered user ${user.id}`);
    return { user: toUserView(user), tokens: await this.issueTokens(user, context) };
  }

  async login(input: LoginInput, context: RequestContext): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({
      where: { email: normaliseEmail(input.email) },
    });

    const hash = user?.passwordHash ?? (await getDummyHash());
    const valid = await argon2.verify(hash, input.password).catch(() => false);

    if (!user || !valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (argon2.needsRehash(user.passwordHash, ARGON2_OPTIONS)) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await argon2.hash(input.password, ARGON2_OPTIONS) },
      });
    }

    return { user: toUserView(user), tokens: await this.issueTokens(user, context) };
  }

  async refresh(refreshToken: string, context: RequestContext): Promise<AuthResponse> {
    const tokenHash = hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) throw new UnauthorizedException('Invalid refresh token');

    if (stored.revokedAt || stored.expiresAt < new Date()) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(
        `Refresh token reuse detected for user ${stored.userId}; revoked family ${stored.familyId}`,
      );
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return {
      user: toUserView(stored.user),
      tokens: await this.issueTokens(stored.user, context, stored.familyId),
    };
  }

  async logout(refreshToken: string): Promise<void> {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (!stored) return;
    await this.prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string): Promise<UserView> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return toUserView(user);
  }

  private async issueTokens(
    user: User,
    context: RequestContext,
    familyId: string = randomUUID(),
  ): Promise<AuthTokens> {
    const claims: AccessTokenClaims = { sub: user.id, email: user.email, role: user.role };

    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      expiresIn: this.config.get('JWT_ACCESS_TTL', { infer: true }),
    });

    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, fid: familyId, jti: randomUUID() },
      {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
        expiresIn: this.config.get('JWT_REFRESH_TTL', { infer: true }),
      },
    );

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        familyId,
        expiresAt: new Date(Date.now() + parseDuration(this.config.get('JWT_REFRESH_TTL', { infer: true }))),
        userAgent: context.userAgent?.slice(0, 300),
        ipAddress: context.ipAddress,
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresInSeconds: Math.floor(
        parseDuration(this.config.get('JWT_ACCESS_TTL', { infer: true })) / 1000,
      ),
    };
  }
}

export interface RequestContext {
  userAgent?: string;
  ipAddress?: string;
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function toUserView(user: User): UserView {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
  };
}

export function parseDuration(value: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) throw new Error(`Cannot parse duration: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * multipliers[unit];
}

let dummyHashPromise: Promise<string> | undefined;

function getDummyHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash(randomUUID(), ARGON2_OPTIONS);
  return dummyHashPromise;
}
