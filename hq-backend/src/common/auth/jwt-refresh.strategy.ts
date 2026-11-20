import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { REFRESH_COOKIE_NAME } from '../../modules/auth/refresh-cookie.js';
import type { Env } from '../../config/env.schema.js';

/** Identity the refresh strategy attaches to `request.user`. */
export type RefreshTokenIdentity = {
  userId: string;
  jti: string;
};

type CookieRequest = { cookies?: Record<string, unknown> };

/** Reads the rotating refresh JWT from the HttpOnly `hq_rt` cookie. */
function extractRefreshTokenFromCookie(request: CookieRequest): string | null {
  const token = request?.cookies?.[REFRESH_COOKIE_NAME];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Cookie-based Passport strategy guarding `POST /auth/refresh` (PRD §9.1):
 * verifies the refresh JWT (HS256 with the *separate* `JWT_REFRESH_SECRET`,
 * strict `iss`/`aud`/`exp`) straight from the HttpOnly cookie. Only the
 * signature and claims are checked here — rotation, expiry state and
 * family-revocation-on-reuse remain service-level rules keyed on `jti`.
 */
@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(config: ConfigService<Env, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([extractRefreshTokenFromCookie]),
      ignoreExpiration: false,
      // Resolved per request (callback-style) — see the note in
      // `jwt.strategy.ts` about the worker entrypoint running this module
      // graph without JWT secrets.
      secretOrKeyProvider: (
        _request: unknown,
        _rawJwtToken: string | Buffer,
        done: (err: unknown, secretOrKey?: string) => void,
      ) => {
        done(null, config.get('JWT_REFRESH_SECRET', { infer: true }));
      },
      issuer: config.get('HQ_JWT_ISSUER', { infer: true }),
      audience: config.get('HQ_JWT_AUDIENCE', { infer: true }),
      algorithms: ['HS256'],
    });
  }

  /** What passport attaches to `request.user` for the refresh route. */
  async validate(payload: { sub?: unknown; jti?: unknown }): Promise<RefreshTokenIdentity> {
    if (typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
      throw new Error('malformed refresh claims');
    }
    return { userId: payload.sub, jti: payload.jti };
  }
}
