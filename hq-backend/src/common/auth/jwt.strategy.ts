import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AuthenticatedUser } from './authenticated-user.js';
import type { Env } from '../../config/env.schema.js';
// Value import (not `import type`): the class is an injection token.
import { AuthUserRepository } from '../../modules/auth/auth-user.repository.js';

/** Claims carried by the short-lived HQ access token (PRD §9.1). */
export type AccessTokenPayload = {
  sub: string;
  jti: string;
  roleCodes?: unknown;
};

/**
 * Passport strategy behind the global `AuthGuard('jwt')` (PRD FR-09, §9.3):
 * verifies the bearer JWT (HS256 with `JWT_ACCESS_SECRET`, strict
 * `iss`/`aud`/`exp`) and then reloads the user's status, roles and effective
 * permissions from PostgreSQL, so a disabled account or a role change takes
 * effect on the very next request — claims alone never authorize anything.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService<Env, true>,
    private readonly authUsers: AuthUserRepository,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Resolved per request (callback-style), not at construction: the
      // worker entrypoint shares this module graph but is provisioned without
      // JWT secrets (PRD §14.1) — it never serves HTTP, so the strategy is
      // never used. The api entrypoint's env schema guarantees the secret.
      secretOrKeyProvider: (
        _request: unknown,
        _rawJwtToken: string | Buffer,
        done: (err: unknown, secretOrKey?: string) => void,
      ) => {
        done(null, config.get('JWT_ACCESS_SECRET', { infer: true }));
      },
      issuer: config.get('HQ_JWT_ISSUER', { infer: true }),
      audience: config.get('HQ_JWT_AUDIENCE', { infer: true }),
      algorithms: ['HS256'],
    });
  }

  /** What passport attaches to `request.user` for guarded routes. */
  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    const user = await this.authUsers.findActiveUserWithPermissions(payload.sub);
    // Deleted or disabled accounts lose access immediately (PRD §9.1).
    if (!user) throw new UnauthorizedException();
    return user;
  }
}
