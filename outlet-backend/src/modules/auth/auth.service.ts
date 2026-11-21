import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import { ApiException } from '../../common/exceptions/api.exception.js';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import type { Env } from '../../config/env.schema.js';
import { AuthUserRepository } from './auth-user.repository.js';
import { ACCESS_JWT_SERVICE, REFRESH_JWT_SERVICE } from './auth.providers.js';
import { RefreshSessionRepository } from './refresh-session.repository.js';

/** Result of a successful login/refresh: JSON body + the cookie token. */
export type AuthSessionResult = {
  accessToken: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
  user: AuthenticatedUser;
  refreshToken: string;
};

const BCRYPT_ROUNDS = 12;
const GENERIC_UNAUTHENTICATED = 'Invalid email or password.';
// Real hash of an unguessable throwaway string, burned on the user-not-found
// path so response timing does not leak account existence.
const DUMMY_HASH = bcrypt.hashSync('fnb-timing-pad-do-not-use', BCRYPT_ROUNDS);

/**
 * Outlet human session lifecycle (PRD FR-09, §9.1): password login (rate
 * limited at the route level via `@nestjs/throttler`), rotating refresh JWTs
 * (server-side `jti` tracking, family revocation on reuse), and logout. The
 * refresh JWT never appears in any JSON response body — it travels only in
 * the HttpOnly `outlet_rt` cookie. Outlet tokens carry the `outletId` claim,
 * re-validated against this deployment on every request (PRD §3).
 */
@Injectable()
export class AuthService {
  private readonly refreshTokenTtlSeconds: number;
  private readonly accessTokenTtlSeconds: number;
  private readonly outletId: string;

  constructor(
    @Inject(ACCESS_JWT_SERVICE) private readonly accessJwt: JwtService,
    @Inject(REFRESH_JWT_SERVICE) private readonly refreshJwt: JwtService,
    private readonly authUsers: AuthUserRepository,
    private readonly refreshSessions: RefreshSessionRepository,
    config: ConfigService<Env, true>,
  ) {
    this.refreshTokenTtlSeconds = config.get('REFRESH_TOKEN_TTL', { infer: true });
    this.accessTokenTtlSeconds = config.get('ACCESS_TOKEN_TTL', { infer: true });
    this.outletId = config.get('OUTLET_ID', { infer: true });
  }

  async login(email: string, password: string): Promise<AuthSessionResult> {
    const user = await this.authUsers.findByEmail(email);
    const passwordMatches = user
      ? await bcrypt.compare(password, user.passwordHash)
      : await bcrypt.compare(password, DUMMY_HASH).then(() => false);

    if (!user || !passwordMatches) {
      throw new ApiException('UNAUTHENTICATED', GENERIC_UNAUTHENTICATED, 401);
    }
    if (user.status !== 'ACTIVE') {
      throw new ApiException('UNAUTHENTICATED', GENERIC_UNAUTHENTICATED, 401);
    }

    const identity = await this.authUsers.findActiveUserWithPermissions(user.id);
    if (!identity) {
      throw new ApiException('UNAUTHENTICATED', GENERIC_UNAUTHENTICATED, 401);
    }
    return this.issueSession(identity);
  }

  /** `jti` comes from the cookie-strategy-verified refresh JWT. */
  async refresh(jti: string): Promise<AuthSessionResult> {
    const invalid = (): ApiException =>
      new ApiException('UNAUTHENTICATED', 'Refresh token missing or invalid.', 401);

    const session = await this.refreshSessions.findByJti(jti);
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
      throw invalid();
    }

    // A rotated jti being re-presented is the reuse signature (PRD AT-18):
    // assume theft and revoke the entire session family. The CAS update makes
    // concurrent refreshes with the same token mutually exclusive.
    if (session.rotatedAt || !(await this.refreshSessions.markRotated(session.id))) {
      await this.refreshSessions.revokeFamily(session.familyId);
      throw invalid();
    }

    const identity = await this.authUsers.findActiveUserWithPermissions(session.userId);
    if (!identity) {
      await this.refreshSessions.revokeFamily(session.familyId);
      throw invalid();
    }

    return this.issueSession(identity, session.familyId);
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    // Signature/claims were checked on the way in via the cookie strategy;
    // here we only need the jti to find the session family. An unusable
    // cookie is a no-op logout.
    let jti: string | undefined;
    try {
      jti = (await this.refreshJwt.verifyAsync<{ sub: string; jti?: string }>(rawToken)).jti;
    } catch {
      return;
    }
    if (!jti) return;
    const session = await this.refreshSessions.findByJti(jti);
    if (!session) return;
    await this.refreshSessions.revokeFamily(session.familyId);
  }

  /**
   * Mints an access + refresh pair. The refresh JWT's `jti` is a fresh UUID
   * recorded server-side before the token is returned; the raw token travels
   * only in the cookie. On rotation the successor joins `familyId`.
   */
  private async issueSession(
    identity: AuthenticatedUser,
    familyId: string = randomUUID(),
  ): Promise<AuthSessionResult> {
    const jti = randomUUID();
    await this.refreshSessions.insert({
      userId: identity.id,
      familyId,
      jti,
      expiresAt: new Date(Date.now() + this.refreshTokenTtlSeconds * 1_000),
    });

    const [accessToken, refreshToken] = await Promise.all([
      this.accessJwt.signAsync(
        { roleCodes: identity.roleCodes, outletId: this.outletId },
        { subject: identity.id, jwtid: randomUUID() },
      ),
      this.refreshJwt.signAsync({}, { subject: identity.id, jwtid: jti }),
    ]);

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresInSeconds: this.accessTokenTtlSeconds,
      user: identity,
      refreshToken,
    };
  }
}
