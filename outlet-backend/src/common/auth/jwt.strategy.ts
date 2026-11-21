import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { AuthenticatedUser } from './authenticated-user.js';
import type { Env } from '../../config/env.schema.js';
// Value import (not `import type`): the class is an injection token.
import { AuthUserRepository } from '../../modules/auth/auth-user.repository.js';

/** Claims carried by the short-lived outlet access token (PRD §9.1). */
export type AccessTokenPayload = {
  sub: string;
  jti: string;
  outletId?: unknown;
  roleCodes?: unknown;
};

/**
 * Passport strategy behind the global `AuthGuard('jwt')` (PRD FR-09, §9.3):
 * verifies the bearer JWT (HS256 with `OUTLET_JWT_ACCESS_SECRET`, strict
 * `iss`/`aud`/`exp`), re-loads the user's status and effective permissions
 * from the outlet database (claims alone never authorize anything), and
 * asserts the token's `outletId` claim equals this deployment's provisioned
 * `OUTLET_ID` — a token minted for any other outlet is dead here (PRD §3).
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private readonly outletId: string;

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
        done(null, config.get('OUTLET_JWT_ACCESS_SECRET', { infer: true }));
      },
      issuer: config.get('OUTLET_JWT_ISSUER', { infer: true }),
      audience: config.get('OUTLET_JWT_AUDIENCE', { infer: true }),
      algorithms: ['HS256'],
    });
    this.outletId = config.get('OUTLET_ID', { infer: true });
  }

  /** What passport attaches to `request.user` for guarded routes. */
  async validate(payload: AccessTokenPayload): Promise<AuthenticatedUser> {
    // Outlet identity is server-side configuration (PRD §3, §15): a valid
    // signature for a different outlet must not authorize anything here.
    if (payload.outletId !== this.outletId) throw new UnauthorizedException();
    const user = await this.authUsers.findActiveUserWithPermissions(payload.sub);
    // Deleted or disabled accounts lose access immediately (PRD §9.1).
    if (!user) throw new UnauthorizedException();
    return user;
  }
}
