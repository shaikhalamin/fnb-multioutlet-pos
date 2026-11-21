import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import autocannon from 'autocannon';

/**
 * Sale-load harness (PRD §16, Phase 4 O1): drives dynamic-body concurrent
 * sales against a running outlet API (compose `outlet-a-api` by default) and
 * asserts the local-sale p95 target.
 *
 * Correctness rules that make the numbers real:
 * - every request mints a FRESH `Idempotency-Key` + `X-Request-Id` and a
 *   varied item/quantity mix via autocannon's per-request `setupRequest` —
 *   replayed bodies would return cached idempotent 201s and fake the results;
 * - stock is pre-restocked through the audited `POST /inventory/adjustments`
 *   path (`reason: "RESTOCK"`, request ids prefixed `perf-`) so balances
 *   never bind during a run;
 * - credentials are read from flags/env and never printed.
 *
 * The API's global throttle (100/min/IP by default) must be raised for the
 * run, e.g. `OUTLET_A_THROTTLE_LIMIT=1000000 docker compose up -d outlet-a-api`.
 */

type MenuItem = { menuItemId: string; availableQuantity: number };

const args = parseArgs({
  allowPositionals: false,
  options: {
    url: { type: 'string', default: process.env.PERF_BASE_URL ?? 'http://127.0.0.1:5000/api/v1' },
    email: { type: 'string', default: process.env.PERF_EMAIL ?? 'manager@outlet-a.local' },
    password: { type: 'string', default: process.env.PERF_PASSWORD ?? 'Manager123!' },
    duration: { type: 'string', default: '30' },
    connections: { type: 'string', default: '10' },
    rate: { type: 'string' }, // optional overall requests/second cap
    'p95-threshold': { type: 'string', default: '500' },
    'max-quantity': { type: 'string', default: '5' },
    'restock-target': { type: 'string', default: '5000' },
  },
}).values;

const baseUrl = args.url.replace(/\/$/, '');
const durationSeconds = Number(args.duration);
const connections = Number(args.connections);
const overallRate = args.rate === undefined ? undefined : Number(args.rate);
const p95ThresholdMs = Number(args['p95-threshold']);
const maxQuantity = Number(args['max-quantity']);
const restockTarget = Number(args['restock-target']);

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    fail(`--${name} must be a positive number (got: ${value})`);
  }
}
assertPositive('duration', durationSeconds);
assertPositive('connections', connections);
if (overallRate !== undefined) assertPositive('rate', overallRate);
assertPositive('p95-threshold', p95ThresholdMs);
assertPositive('max-quantity', maxQuantity);
assertPositive('restock-target', restockTarget);

function fail(message: string): never {
  process.stderr.write(`sale-load: ${message}\n`);
  process.exit(1);
}

let accessToken: string | null = null;

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': `perf-${randomUUID()}`,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
}

async function main(): Promise<void> {
  process.stdout.write(
    `sale-load: target=${baseUrl} duration=${durationSeconds}s connections=${connections}` +
      `${overallRate ? ` rate=${overallRate}/s` : ''} p95Target=${p95ThresholdMs}ms\n`,
  );

  // ---- Login (credentials never printed) --------------------------------
  const login = await api<{ data?: { accessToken?: string }; error?: { code: string } }>('/auth/login', {
    method: 'POST',
    body: { email: args.email, password: args.password },
  });
  if (login.status !== 200 || !login.body.data?.accessToken) {
    fail(`login failed (status ${login.status}, code ${login.body.error?.code ?? 'n/a'})`);
  }
  accessToken = login.body.data.accessToken;

  // ---- Catalog discovery + audited pre-restock ----------------------------
  const menu = await api<{ data?: MenuItem[] }>('/menu');
  if (menu.status !== 200 || !Array.isArray(menu.body.data) || menu.body.data.length === 0) {
    fail(`menu fetch failed (status ${menu.status}) — is the catalog synced?`);
  }
  const items = menu.body.data;
  for (const item of items) {
    while (item.availableQuantity < restockTarget) {
      const adjusted = await api<{ data?: { quantityOnHand?: number } }>('/inventory/adjustments', {
        method: 'POST',
        body: { menuItemId: item.menuItemId, deltaQuantity: 1000, reason: 'RESTOCK' },
      });
      if (adjusted.status !== 200) {
        fail(`restock failed for ${item.menuItemId} (status ${adjusted.status})`);
      }
      item.availableQuantity = adjusted.body.data?.quantityOnHand ?? item.availableQuantity;
    }
  }
  process.stdout.write(
    `sale-load: restocked ${items.length} item(s) to >= ${restockTarget} units via audited adjustments\n`,
  );

  // ---- Warmup: a few real sales through the exact path under test ---------
  for (let i = 0; i < connections; i += 1) {
    const item = items[i % items.length];
    const warmup = await api('/sales', {
      method: 'POST',
      idempotencyKey: `perf-warmup-${randomUUID()}`,
      body: { items: [{ menuItemId: item.menuItemId, quantity: 1 }] },
    });
    if (warmup.status !== 201) {
      fail(`warmup sale failed (status ${warmup.status})`);
    }
  }

  // ---- Load run ------------------------------------------------------------
  // Per-request state: fresh keys/ids and a rotating item mix so no two
  // request bodies share an idempotency key.
  let requestCounter = 0;
  const nextBody = (): string => {
    requestCounter += 1;
    const first = items[requestCounter % items.length];
    const lines = [{ menuItemId: first.menuItemId, quantity: 1 + (requestCounter % maxQuantity) }];
    if (items.length > 1 && requestCounter % 3 === 0) {
      const second = items[(requestCounter * 7) % items.length];
      if (second.menuItemId !== first.menuItemId) {
        lines.push({ menuItemId: second.menuItemId, quantity: 1 + (requestCounter % 2) });
      }
    }
    return JSON.stringify({ items: lines });
  };

  const responseTimes: number[] = [];
  const statusCounts = new Map<number, number>();
  const instance = autocannon({
    url: `${baseUrl}/sales`,
    connections,
    duration: durationSeconds,
    ...(overallRate ? { overallRate } : {}),
    ignoreCoordinatedOmission: overallRate === undefined,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    requests: [
      {
        method: 'POST',
        setupRequest: (request) => {
          request.headers = {
            ...request.headers,
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'Idempotency-Key': `perf-${randomUUID()}`,
            'X-Request-Id': randomUUID(),
          };
          request.body = nextBody();
          return request;
        },
      },
    ],
  });
  instance.on('response', (_clientIndex: number, statusCode: number, _bytes: number, responseTime: number) => {
    responseTimes.push(responseTime);
    statusCounts.set(statusCode, (statusCounts.get(statusCode) ?? 0) + 1);
  });

  const result = await instance;

  // ---- Report --------------------------------------------------------------
  const sorted = [...responseTimes].sort((a, b) => a - b);
  const percentile = (p: number): number =>
    sorted.length === 0 ? Number.POSITIVE_INFINITY : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const p50 = percentile(50);
  const p95 = percentile(95);
  const p99 = percentile(99);
  const non2xx = sorted.length === 0 ? result.non2xx : [...statusCounts.entries()].filter(([status]) => status >= 300).reduce((sum, [, count]) => sum + count, 0);
  const errorCount = result.errors + result.timeouts;

  process.stdout.write(
    [
      `sale-load results`,
      `  requests:    ${result.requests.total} (${result.requests.rate.toFixed(1)} req/s)`,
      `  p50 / p95 / p99: ${Math.round(p50)} ms / ${Math.round(p95)} ms / ${Math.round(p99)} ms`,
      `  errors:      ${errorCount}`,
      `  timeouts:    ${result.timeouts}`,
      `  non-2xx:     ${non2xx}`,
      `  statuses:    ${[...statusCounts.entries()].sort().map(([s, c]) => `${s}×${c}`).join(' ') || 'n/a'}`,
    ].join('\n') + '\n',
  );

  if (errorCount > 0) fail(`failing: ${errorCount} request error(s)/timeout(s)`);
  if (non2xx > 0) fail(`failing: ${non2xx} non-2xx response(s) — stock, throttle or contract issue`);
  if (p95 > p95ThresholdMs) {
    fail(`failing: p95 ${Math.round(p95)} ms exceeds the ${p95ThresholdMs} ms target (PRD §16)`);
  }
  process.stdout.write(`sale-load: PASS (p95 ${Math.round(p95)} ms <= ${p95ThresholdMs} ms)\n`);
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
