import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/auth/public.decorator.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import type { RefreshTokenIdentity } from '../../common/auth/jwt-refresh.strategy.js';
import { JwtRefreshAuthGuard } from '../../common/auth/jwt-refresh.guard.js';
import type { Env } from '../../config/env.schema.js';
import { LoginRequest } from './dto/login.request.js';
import { AuthResponse, LogoutResponse } from './dto/auth.response.js';
import { AuthService } from './auth.service.js';
import { REFRESH_COOKIE_NAME, clearRefreshCookie, setRefreshCookie } from './refresh-cookie.js';

/**
 * HQ human auth routes (PRD §7.2). The rotating refresh JWT is set/cleared
 * as an HttpOnly cookie scoped to `/api/v1/auth` and never appears in JSON.
 */
@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  private readonly cookieSecure: boolean;
  private readonly refreshTokenTtlSeconds: number;

  constructor(
    private readonly authService: AuthService,
    config: ConfigService<Env, true>,
  ) {
    // Explicit override wins (the local dev cluster terminates HTTP inside
    // Compose); otherwise Secure cookies only in production (PRD §9.1).
    const override = config.get('REFRESH_COOKIE_SECURE', { infer: true });
    const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';
    this.cookieSecure = override !== undefined ? override : isProduction;
    this.refreshTokenTtlSeconds = config.get('REFRESH_TOKEN_TTL', { infer: true });
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  // Login brute-force budget (PRD §7.2 "Public with rate limit", §9.1):
  // 5 attempts/minute per client IP, on top of the global limiter.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Sign in with email + password (rate limited).' })
  @ApiResponse({ status: 200, type: AuthResponse })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED' })
  @ApiResponse({ status: 401, description: 'UNAUTHENTICATED' })
  @ApiResponse({ status: 429, description: 'RATE_LIMITED' })
  async login(
    @Body() body: LoginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    const session = await this.authService.login(body.email, body.password, clientIpOf(request));
    setRefreshCookie(response, session.refreshToken, this.refreshTokenTtlSeconds, this.cookieSecure);
    return toAuthResponse(session);
  }

  @Post('refresh')
  @Public() // No access token here — identity comes from the refresh cookie.
  @UseGuards(JwtRefreshAuthGuard)
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the refresh cookie and mint a new access token.' })
  @ApiResponse({ status: 200, type: AuthResponse })
  @ApiResponse({ status: 401, description: 'UNAUTHENTICATED' })
  async refresh(
    @Req() request: Request & { user?: RefreshTokenIdentity },
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponse> {
    const identity = request.user;
    if (!identity) {
      throw new Error('jwt-refresh guard did not attach request.user');
    }
    const session = await this.authService.refresh(identity.jti);
    setRefreshCookie(response, session.refreshToken, this.refreshTokenTtlSeconds, this.cookieSecure);
    return toAuthResponse(session);
  }

  @Post('logout')
  @HttpCode(200)
  @ApiSecurity('bearer-jwt')
  @ApiOperation({ summary: 'Revoke the current refresh session family.' })
  @ApiResponse({ status: 200, type: LogoutResponse })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LogoutResponse> {
    await this.authService.logout(
      request.cookies?.[REFRESH_COOKIE_NAME] as string | undefined,
      user.id,
    );
    clearRefreshCookie(response, this.cookieSecure);
    return { success: true };
  }
}

function clientIpOf(request: Request): string {
  return (request.ips?.[0] ?? request.ip ?? 'unknown').toString();
}

function toAuthResponse(session: {
  accessToken: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
  user: AuthenticatedUser;
}): AuthResponse {
  return {
    accessToken: session.accessToken,
    tokenType: session.tokenType,
    expiresInSeconds: session.expiresInSeconds,
    user: {
      id: session.user.id,
      email: session.user.email,
      roleCodes: session.user.roleCodes,
      permissions: session.user.permissions,
    },
  };
}
