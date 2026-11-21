import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Env } from '../../config/env.schema.js';

/**
 * Access and refresh tokens are signed with two independent HS256 secrets
 * (PRD §9.1), so each kind gets its own pre-configured `JwtService` instance
 * — call sites can never sign one with the other's secret. Issuer/audience
 * are pinned here and re-verified on every verify call.
 */
export const ACCESS_JWT_SERVICE = 'ACCESS_JWT_SERVICE' as const;
export const REFRESH_JWT_SERVICE = 'REFRESH_JWT_SERVICE' as const;

export const accessJwtProvider: Provider = {
  provide: ACCESS_JWT_SERVICE,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new JwtService({
      secret: config.get('OUTLET_JWT_ACCESS_SECRET', { infer: true }),
      signOptions: {
        algorithm: 'HS256',
        issuer: config.get('OUTLET_JWT_ISSUER', { infer: true }),
        audience: config.get('OUTLET_JWT_AUDIENCE', { infer: true }),
        expiresIn: config.get('ACCESS_TOKEN_TTL', { infer: true }),
      },
      verifyOptions: {
        algorithms: ['HS256'],
        issuer: config.get('OUTLET_JWT_ISSUER', { infer: true }),
        audience: config.get('OUTLET_JWT_AUDIENCE', { infer: true }),
      },
    }),
};

export const refreshJwtProvider: Provider = {
  provide: REFRESH_JWT_SERVICE,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new JwtService({
      secret: config.get('OUTLET_JWT_REFRESH_SECRET', { infer: true }),
      signOptions: {
        algorithm: 'HS256',
        issuer: config.get('OUTLET_JWT_ISSUER', { infer: true }),
        audience: config.get('OUTLET_JWT_AUDIENCE', { infer: true }),
        expiresIn: config.get('REFRESH_TOKEN_TTL', { infer: true }),
      },
      verifyOptions: {
        algorithms: ['HS256'],
        issuer: config.get('OUTLET_JWT_ISSUER', { infer: true }),
        audience: config.get('OUTLET_JWT_AUDIENCE', { infer: true }),
      },
    }),
};
