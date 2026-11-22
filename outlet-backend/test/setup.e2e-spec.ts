import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from 'supertest/types.js';
import { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../src/config/database.config.js';

/**
 * The DataSource DI token. Defined locally (same literal as
 * `database.module.ts`) because statically importing that module would
 * transitively evaluate `ConfigModule.forRoot()` — freezing `DATABASE_URL`
 * before this spec points it at the scratch database in `beforeAll`.
 */
const DATA_SOURCE = 'DATA_SOURCE';

/**
 * First-run provisioning flow (PRD §8.7 bootstrap, §9.2 secure provisioning
 * channel) against a THROWAWAY real PostgreSQL database: the setup wizard's
 * two steps, live HQ validation via a stub HQ, permanent sealing, admin
 * login on the provisioned identity, and the authenticated rotation route —
 * exactly the demo path from the HQ console to a paired terminal.
 */
const hasDependencies = Boolean(process.env.DATABASE_URL && !process.env.DATABASE_URL?.includes('vitest'));
const describeWithDeps = hasDependencies ? describe : describe.skip;

const OUTLET_ID = randomUUID();
const OUTLET_CODE = 'S';
const ADMIN_EMAIL = 'admin@setup-e2e.local';
const ADMIN_PASSWORD = 'Admin123!';
const KEY_1 = { keyId: 'ok_dev_stubkey0001', keySecret: 'stub-secret-one-0123456789' };
const KEY_2 = { keyId: 'ok_dev_stubkey0002', keySecret: 'stub-secret-two-0123456789' };

/** Stub HQ: answers GET /api/v1/sync/v1/checkpoint for the two known keys. */
async function startStubHq(): Promise<{ server: Server; url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(String(req.headers.authorization ?? ''));
    const authorized =
      req.url?.includes('/sync/v1/checkpoint') &&
      (req.headers.authorization === `OutletKey ${KEY_1.keyId}.${KEY_1.keySecret}` ||
        req.headers.authorization === `OutletKey ${KEY_2.keyId}.${KEY_2.keySecret}`);
    if (!authorized) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'key rejected', requestId: 'stub' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        data: { outletId: OUTLET_ID, highestContiguousSequence: '0', missingRanges: [] },
        meta: { requestId: 'stub', timestamp: new Date().toISOString() },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${port}/api/v1`, requests };
}

describeWithDeps('Terminal setup wizard (e2e, throwaway database)', () => {
  let app: INestApplication<App>;
  let hq: Awaited<ReturnType<typeof startStubHq>>;
  let scratchName: string;
  let adminUri: DataSource | null = null;
  let query: DataSource['query'];

  beforeAll(async () => {
    // 1. Scratch database on the e2e PostgreSQL server, migrated from zero —
    //    an UNPROVISIONED terminal, exactly what the wizard is for.
    const base = new URL(process.env.DATABASE_URL as string);
    scratchName = `fnb_setup_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const adminUrl = new URL(base);
    adminUrl.pathname = '/postgres';
    adminUri = new DataSource({ type: 'postgres', url: adminUrl.href });
    await adminUri.initialize();
    await adminUri.query(`CREATE DATABASE ${scratchName}`);
    const scratchUrl = new URL(base);
    scratchUrl.pathname = `/${scratchName}`;
    const scratch = new DataSource(buildDataSourceOptions(scratchUrl.href));
    await scratch.initialize();
    await scratch.runMigrations();
    await scratch.destroy();

    // 2. Boot the real module graph against the scratch database.
    process.env.DATABASE_URL = scratchUrl.href;
    const { AppModule } = await import('../src/app.module.js');
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    query = app.get<DataSource>(DATA_SOURCE).query.bind(app.get<DataSource>(DATA_SOURCE)) as DataSource['query'];

    hq = await startStubHq();
  });

  afterAll(async () => {
    await app?.close();
    // Server#close() is void-typed without a callback; await the event loop's
    // completion via a resolved promise instead.
    hq?.server.close();
    if (adminUri) {
      try {
        await adminUri.query(`DROP DATABASE IF EXISTS ${scratchName}`);
      } finally {
        await adminUri.destroy();
      }
    }
  });

  it('reports an unprovisioned terminal', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/setup/status').expect(200);
    expect(response.body.data).toMatchObject({ identity: false, hqConnection: false, provisioned: false });
  });

  it('refuses pairing before identity exists (step order)', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/setup/hq-connection')
      .send({ hqApiBaseUrl: hq.url, ...KEY_1 })
      .expect(409);
  });

  it('step 1: provisions identity, admin, counters and checkpoint in one shot', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/setup/identity')
      .send({ outletId: OUTLET_ID, outletCode: OUTLET_CODE, adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASSWORD })
      .expect(201);
    expect(response.body.data).toMatchObject({ outletId: OUTLET_ID, outletCode: OUTLET_CODE, adminEmail: ADMIN_EMAIL });

    const [identity] = await query('SELECT outlet_id, outlet_code FROM outlet_identity');
    expect(identity).toEqual({ outlet_id: OUTLET_ID, outlet_code: OUTLET_CODE });
    const [counter] = await query('SELECT prefix FROM receipt_counters WHERE outlet_id = $1', [OUTLET_ID]);
    expect(counter.prefix).toBe(OUTLET_CODE);
    const [syncState] = await query('SELECT last_applied_revision FROM menu_sync_state WHERE outlet_id = $1', [OUTLET_ID]);
    expect(syncState.last_applied_revision).toBe('0');
    const [adminRole] = await query(
      `SELECT r.code FROM outlet_users u
         JOIN outlet_user_roles ur ON ur.user_id = u.id
         JOIN outlet_roles r ON r.id = ur.role_id
        WHERE lower(u.email) = $1`,
      [ADMIN_EMAIL],
    );
    expect(adminRole.code).toBe('OUTLET_MANAGER');
    // sync.manage was granted with the manager role (rotation path).
    const [perm] = await query(
      `SELECT count(*)::int AS n FROM outlet_role_permissions rp
         JOIN outlet_permissions p ON p.id = rp.permission_id
         JOIN outlet_roles r ON r.id = rp.role_id
        WHERE r.code = 'OUTLET_MANAGER' AND p.code = 'sync.manage'`,
    );
    expect(perm.n).toBe(1);
  });

  it('seals identity permanently', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/setup/identity')
      .send({ outletId: randomUUID(), outletCode: 'X', adminEmail: 'x@x.local', adminPassword: 'Password1!' })
      .expect(403);
  });

  it('step 2: rejects a bad key live and saves nothing', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/setup/hq-connection')
      .send({ hqApiBaseUrl: hq.url, keyId: KEY_1.keyId, keySecret: 'wrong-secret' })
      .expect(401);
    const rows = await query('SELECT count(*)::int AS n FROM hq_connection');
    expect(rows[0].n).toBe(0);
  });

  it('step 2: rejects an unreachable HQ URL and saves nothing', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/setup/hq-connection')
      .send({ hqApiBaseUrl: 'http://127.0.0.1:9/api/v1', ...KEY_1 })
      .expect(503);
    const rows = await query('SELECT count(*)::int AS n FROM hq_connection');
    expect(rows[0].n).toBe(0);
  });

  it('step 2: pairs after live HQ validation and seals permanently', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/setup/hq-connection')
      .send({ hqApiBaseUrl: hq.url, ...KEY_1 })
      .expect(201);
    expect(response.body.data).toMatchObject({ outletId: OUTLET_ID, keyId: KEY_1.keyId, highestContiguousSequence: '0' });
    // The raw secret exists in the outlet's own DB — and nowhere in the response.
    expect(JSON.stringify(response.body)).not.toContain(KEY_1.keySecret);
    const [row] = await query('SELECT key_id, key_secret, hq_base_url FROM hq_connection');
    expect(row).toEqual({ key_id: KEY_1.keyId, key_secret: KEY_1.keySecret, hq_base_url: hq.url });

    // The stub saw the machine credential exactly where the real HQ would.
    expect(hq.requests.at(-1)).toBe(`OutletKey ${KEY_1.keyId}.${KEY_1.keySecret}`);

    const status = await request(app.getHttpServer()).get('/api/v1/setup/status').expect(200);
    expect(status.body.data).toMatchObject({ identity: true, hqConnection: true, provisioned: true, outletCode: OUTLET_CODE });

    await request(app.getHttpServer())
      .post('/api/v1/setup/hq-connection')
      .send({ hqApiBaseUrl: hq.url, ...KEY_2 })
      .expect(403);
  });

  it('the created admin signs in on the provisioned identity (token outletId pinned)', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);
    expect(response.body.data.user).toMatchObject({ email: ADMIN_EMAIL, outletId: OUTLET_ID });
    expect(response.body.data.user.permissions).toContain('sync.manage');
  });

  it('sync status exposes the pairing (keyId only) and rotates via the authenticated route', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);
    const bearer = login.body.data.accessToken as string;

    const status = await request(app.getHttpServer())
      .get('/api/v1/sync/status')
      .set('authorization', `Bearer ${bearer}`)
      .expect(200);
    expect(status.body.data.hqConnection).toMatchObject({ keyId: KEY_1.keyId, hqApiBaseUrl: hq.url });
    expect(JSON.stringify(status.body)).not.toContain(KEY_1.keySecret);

    const rotated = await request(app.getHttpServer())
      .put('/api/v1/sync/hq-connection')
      .set('authorization', `Bearer ${bearer}`)
      .send({ hqApiBaseUrl: hq.url, ...KEY_2 })
      .expect(200);
    expect(rotated.body.data).toMatchObject({ keyId: KEY_2.keyId });
    expect(JSON.stringify(rotated.body)).not.toContain(KEY_2.keySecret);
    const [row] = await query('SELECT key_id FROM hq_connection');
    expect(row.key_id).toBe(KEY_2.keyId);

    // The rotation was audited — with the keyId, never the secret.
    const [audit] = await query(
      `SELECT metadata FROM outlet_audit_logs WHERE action = 'sync.hq_connection_updated' ORDER BY occurred_at DESC LIMIT 1`,
    );
    expect(audit.metadata.keyId).toBe(KEY_2.keyId);
    expect(JSON.stringify(audit.metadata)).not.toContain(KEY_2.keySecret);
  });

  it('refuses the rotation route unauthenticated', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/sync/hq-connection')
      .send({ hqApiBaseUrl: hq.url, ...KEY_1 })
      .expect(401);
  });
});
