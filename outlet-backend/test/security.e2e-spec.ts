import request from 'supertest';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module.js';
import { configureE2eApp, loginAs, SEEDED_USERS, type E2eApp } from './helpers.js';

/**
 * Phase-4 forged-token matrix (PRD §9.1, AT-17): the outlet API rejects
 * access tokens whose signature, issuer, audience, expiry or subject is not
 * exactly right — the issuer/audience pinning is also what makes an HQ-issued
 * JWT useless here (independent secrets + issuer, §9.1).
 *
 * The two §9.3 persona denials named in Phase 4 (cashier → inventory
 * adjustments, clerk → sales) are already covered in sales.e2e-spec.ts.
 */
const hasDependencies = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeWithDeps = hasDependencies ? describe : describe.skip;

type JwtClaims = { sub: string; jti: string; outletId: string; roleCodes: string[]; iss: string; aud: string };

/** Decodes a JWT's payload (no verification — fixture introspection only). */
function decodePayload(token: string): JwtClaims {
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as JwtClaims;
  return payload;
}

describeWithDeps('Outlet token security (e2e)', () => {
  let app: E2eApp;
  let realToken: string;
  let claims: JwtClaims;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    configureE2eApp(app);
    await app.init();

    realToken = await loginAs(app, SEEDED_USERS.manager.email, SEEDED_USERS.manager.password);
    claims = decodePayload(realToken);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  /** Signs an access-token-shaped JWT with the given (possibly wrong) params. */
  const forge = (overrides: { secret?: string; issuer?: string; audience?: string; expiresIn?: string | number }) =>
    new JwtService({
      secret: overrides.secret ?? process.env.OUTLET_JWT_ACCESS_SECRET,
      signOptions: {
        algorithm: 'HS256',
        issuer: overrides.issuer ?? claims.iss,
        audience: overrides.audience ?? claims.aud,
        ...(overrides.expiresIn ? { expiresIn: overrides.expiresIn } : {}),
      },
    }).signAsync(
      { roleCodes: claims.roleCodes, outletId: claims.outletId },
      { subject: claims.sub, jwtid: randomUUID() },
    );

  const expectUnauthenticated = async (token: string) => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/menu')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  };

  it('control: a correctly minted token reaches the menu', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/menu')
      .set('Authorization', `Bearer ${realToken}`)
      .expect(200)
      .expect((res) => expect(Array.isArray(res.body.data)).toBe(true));
  });

  it('401s tokens signed with the wrong secret', async () => {
    await expectUnauthenticated(await forge({ secret: 'x'.repeat(48) }));
  });

  it('401s tokens with the wrong issuer — including HQ-issued tokens (§9.1 isolation)', async () => {
    await expectUnauthenticated(await forge({ issuer: 'fnb-hq' }));
    await expectUnauthenticated(await forge({ issuer: 'https://evil.example' }));
  });

  it('401s tokens with the wrong audience', async () => {
    await expectUnauthenticated(await forge({ audience: 'fnb-hq-api' }));
    await expectUnauthenticated(await forge({ audience: 'https://evil.example' }));
  });

  it('401s expired tokens', async () => {
    await expectUnauthenticated(await forge({ expiresIn: -60 }));
  });

  it('401s a validly signed token for an unknown subject', async () => {
    const unknown = await new JwtService({
      secret: process.env.OUTLET_JWT_ACCESS_SECRET,
      signOptions: { algorithm: 'HS256', issuer: claims.iss, audience: claims.aud },
    }).signAsync(
      { roleCodes: claims.roleCodes, outletId: claims.outletId },
      { subject: randomUUID(), jwtid: randomUUID() },
    );
    await expectUnauthenticated(unknown);
  });
});
