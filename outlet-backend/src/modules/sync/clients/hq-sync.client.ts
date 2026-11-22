import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { z } from 'zod';
// Value import (not `import type`): the class is an injection token.
import { HqCredentialsProvider } from '../../identity/hq-credentials.provider.js';
import {
  client as generatedClient,
  isResponseError,
  type ClientConfig,
  type ClientInstance,
  type Transport,
} from './generated/.kubb/client.js';
import { menuPullControllerGetChanges } from './generated/clients/menuPullControllerGetChanges.js';
import { menuPullControllerGetSnapshot } from './generated/clients/menuPullControllerGetSnapshot.js';
import { syncEventsControllerPushBatch } from './generated/clients/syncEventsControllerPushBatch.js';
import { syncStatusControllerGetCheckpoint } from './generated/clients/syncStatusControllerGetCheckpoint.js';
import { syncStatusControllerHeartbeat } from './generated/clients/syncStatusControllerHeartbeat.js';
import { menuPullControllerGetChangesStatus200Schema } from './generated/schemas/menuPullControllerGetChangesSchema.js';
import { menuPullControllerGetSnapshotStatus200Schema } from './generated/schemas/menuPullControllerGetSnapshotSchema.js';
import { syncEventsControllerPushBatchStatus200Schema } from './generated/schemas/syncEventsControllerPushBatchSchema.js';
import { syncStatusControllerGetCheckpointStatus200Schema } from './generated/schemas/syncStatusControllerGetCheckpointSchema.js';
import { syncStatusControllerHeartbeatStatus200Schema } from './generated/schemas/syncStatusControllerHeartbeatSchema.js';
import type { CatalogChangesResponse } from './generated/types/CatalogChangesResponse.js';
import type { EventBatchResponse } from './generated/types/EventBatchResponse.js';
import type { HeartbeatRequest } from './generated/types/HeartbeatRequest.js';
import type { HeartbeatResponse } from './generated/types/HeartbeatResponse.js';
import type { MenuSnapshotResponse } from './generated/types/MenuSnapshotResponse.js';
import type { SyncCheckpointResponse } from './generated/types/SyncCheckpointResponse.js';
import type { SyncEventV1 } from './generated/types/SyncEventV1.js';

/** Request timeout for every HQ call (PRD §7.4: short timeouts). */
const HQ_TIMEOUT_MS = 10_000;

/** Test-only transport override; never registered in production DI. */
export const HQ_SYNC_TRANSPORT = Symbol('HQ_SYNC_TRANSPORT');

/**
 * Sanitized HQ sync failure: never carries the axios config (which would
 * embed the Authorization secret) — only status, stable codes and the
 * server-rendered ApiError body, all safe to log (PRD §9.2, §15).
 */
export class HqSyncError extends Error {
  constructor(
    message: string,
    /** HTTP status, or null for transport-level failures. */
    readonly status: number | null,
    /** HQ ApiError code or a transport marker (`HQ_UNREACHABLE`, `CONTRACT_MISMATCH`). */
    readonly code: string,
    /** Parsed `Retry-After` seconds, when HQ sent one. */
    readonly retryAfterSeconds: number | null,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HqSyncError';
  }
}

/** Strips the `ApiSuccess` envelope once: HQ's `data` field is the payload. */
export function unwrapEnvelope(body: unknown): unknown {
  if (body !== null && typeof body === 'object' && 'data' in body) {
    return (body as { data: unknown }).data;
  }
  return body;
}

/**
 * Typed HQ machine client (PRD §7.4, §11): wraps the Kubb-generated sync
 * client. Credentials come from the DB-backed `HqCredentialsProvider` (the
 * `hq_connection` singleton written by the setup wizard / rotation surface)
 * — never from a browser bundle, query string, or log. Every HQ call
 * re-reads the provider first, so pairing and rotation take effect without
 * a restart; a 401 triggers exactly one credential re-read + retry (PRD
 * §9.2 rotation: switch worker secret, then keep going). Every response is
 * parsed with the generated Zod schemas before use (§8.3 "validate response
 * with the versioned contract").
 */
@Injectable()
export class HqSyncClient {
  private readonly client: ClientInstance;

  constructor(
    private readonly credentials: HqCredentialsProvider,
    /** Test hook: replaces the axios transport with a fake returning `Response`s. */
    @Optional()
    @Inject(HQ_SYNC_TRANSPORT)
    transportOverride?: Transport,
  ) {
    const clientConfig: ClientConfig = transportOverride
      ? { transport: transportOverride }
      : { options: { timeout: HQ_TIMEOUT_MS } };
    this.client = generatedClient.createClient(clientConfig);

    // Machine credential: the token value for the spec's `outlet-key` apiKey
    // scheme (Authorization header), resolved from the provider per request.
    // The secret exists only here (§9.2).
    this.client.setConfig({
      auth: (scheme) => {
        const current = this.credentials.get();
        return scheme.type === 'apiKey' &&
          scheme.name === 'Authorization' &&
          current &&
          current.keyId &&
          current.keySecret
          ? `OutletKey ${current.keyId}.${current.keySecret}`
          : undefined;
      },
    });

    // X-Request-Id on every call (PRD §7). The base URL is applied from the
    // provider in `execute()` (it is rotatable), not here.
    this.client.interceptors.request.use((request) => {
      request.headers['x-request-id'] = randomUUID();
      return request;
    });

    // Envelope strip: generated functions then resolve the bare payloads.
    this.client.interceptors.response.use((response) => {
      if (response.status >= 200 && response.status < 300) {
        response.data = unwrapEnvelope(response.data);
      }
      return response;
    });
  }

  async getMenuChanges(afterRevision: string, limit: number): Promise<CatalogChangesResponse> {
    return this.call('GET /sync/v1/menu/changes', menuPullControllerGetChangesStatus200Schema, () =>
      menuPullControllerGetChanges({ client: this.client, query: { afterRevision, limit } }),
    );
  }

  async getMenuSnapshot(): Promise<MenuSnapshotResponse> {
    return this.call('GET /sync/v1/menu/snapshot', menuPullControllerGetSnapshotStatus200Schema, () =>
      menuPullControllerGetSnapshot({ client: this.client }),
    );
  }

  /**
   * Pushes one batch. `idempotencyKey` doubles as the `batchId` and the
   * `Idempotency-Key` header (§8.5): the caller mints ONE key per logical
   * batch attempt and keeps it stable across transport retries of the same
   * bytes.
   */
  async pushEventBatch(events: SyncEventV1[], idempotencyKey: string): Promise<EventBatchResponse> {
    return this.call('POST /sync/v1/events/batch', syncEventsControllerPushBatchStatus200Schema, () =>
      syncEventsControllerPushBatch({
        client: this.client,
        headers: { 'idempotency-key': idempotencyKey },
        body: { batchId: idempotencyKey, events },
      }),
    );
  }

  async getCheckpoint(): Promise<SyncCheckpointResponse> {
    return this.call('GET /sync/v1/checkpoint', syncStatusControllerGetCheckpointStatus200Schema, () =>
      syncStatusControllerGetCheckpoint({ client: this.client }),
    );
  }

  async sendHeartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    return this.call('POST /sync/v1/heartbeat', syncStatusControllerHeartbeatStatus200Schema, () =>
      syncStatusControllerHeartbeat({ client: this.client, body: request }),
    );
  }

  /**
   * Runs one generated call: refreshes credentials from the database (so
   * pairing/rotation land without a restart), converts failures into the
   * sanitized `HqSyncError` (retry guidance included), retries exactly once
   * on 401 when the credentials changed underneath us (rotation, PRD §9.2),
   * and validates the payload against the generated Zod schema (§8.3).
   */
  private async call<T>(
    label: string,
    schema: z.ZodType<T>,
    run: () => Promise<T>,
  ): Promise<T> {
    const payload = await this.execute(label, run);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      // A reply that breaks the versioned contract is treated as a
      // transport-level fault: retryable, never applied (§8.3).
      throw new HqSyncError(
        `HQ reply for ${label} failed contract validation`,
        null,
        'CONTRACT_MISMATCH',
        null,
        parsed.error.issues.slice(0, 5),
      );
    }
    return parsed.data;
  }

  /** Credential refresh + single 401-retry around one generated call. */
  private async execute<T>(label: string, run: () => Promise<T>): Promise<T> {
    const before = await this.credentials.refresh();
    if (!before) {
      // Unpaired terminal: surfaced as a retryable transport-level fault so
      // the worker idles (`awaiting_provisioning`) instead of crashing.
      throw new HqSyncError('HQ connection is not provisioned yet', null, 'HQ_NOT_PROVISIONED', null);
    }
    // The base URL is part of the stored connection (rotatable), so it is
    // re-applied from the freshly-read credentials before every call.
    this.client.setConfig({ baseURL: before.hqApiBaseUrl });
    try {
      return await run();
    } catch (error) {
      const first = this.toHqSyncError(label, error);
      if (first.status !== 401) throw first;
      // The key may have been rotated (HQ grace overlap) between our refresh
      // and HQ's reply — re-read once and retry only if something changed.
      const latest = await this.credentials.refresh();
      if (!HqCredentialsProvider.credentialsChanged(before, latest) || !latest) throw first;
      this.client.setConfig({ baseURL: latest.hqApiBaseUrl });
      try {
        return await run();
      } catch (retryError) {
        throw this.toHqSyncError(label, retryError);
      }
    }
  }

  private toHqSyncError(label: string, error: unknown): HqSyncError {
    if (isResponseError(error)) {
      const body = unwrapEnvelope(error.data) as { error?: { code?: string; message?: string } } | null;
      const apiError = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      // `Retry-After` guidance for 429/5xx backoff (§8.7).
      const retryAfter = error.headers?.get?.('retry-after');
      const retryAfterSeconds = retryAfter !== null && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) : null;
      return new HqSyncError(
        apiError?.message ?? `${label} failed with status ${error.status}`,
        error.status,
        apiError?.code ?? `HTTP_${error.status}`,
        retryAfterSeconds,
        apiError,
      );
    }
    // Network/timeout errors: sanitize — axios errors embed `config` with the
    // Authorization secret, which must never surface in logs (§9.2).
    const message = error instanceof Error ? error.message : String(error);
    return new HqSyncError(`${label} unreachable: ${message}`, null, 'HQ_UNREACHABLE', null);
  }
}
