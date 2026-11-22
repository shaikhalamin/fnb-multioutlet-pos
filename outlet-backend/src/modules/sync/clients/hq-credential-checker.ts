import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  client as generatedClient,
  isResponseError,
  type Transport,
} from './generated/.kubb/client.js';
import { syncStatusControllerGetCheckpoint } from './generated/clients/syncStatusControllerGetCheckpoint.js';
import { syncStatusControllerGetCheckpointStatus200Schema } from './generated/schemas/syncStatusControllerGetCheckpointSchema.js';
import { unwrapEnvelope } from './hq-sync.client.js';

/** Same short HQ timeout as the resident sync client (PRD §7.4). */
const HQ_TIMEOUT_MS = 10_000;

/** Candidate HQ machine credentials as entered in the pairing form. */
export type HqCredentialCandidate = {
  hqApiBaseUrl: string;
  keyId: string;
  keySecret: string;
};

export type HqCredentialCheck =
  | { ok: true; outletId: string; highestContiguousSequence: string }
  | { ok: false; kind: 'REJECTED' | 'UNAVAILABLE' | 'UNREACHABLE' | 'CONTRACT_MISMATCH' };

/**
 * One-shot validation of candidate HQ credentials (PRD §9.2 secure
 * provisioning channel, §8.7 bootstrap): builds an ephemeral generated
 * client around the candidate `OutletKey keyId.secret` and asks HQ for the
 * lightweight checkpoint. HQ derives `outletId` exclusively from the key
 * record (§7.4), so a successful reply both proves the key is active and
 * reveals which outlet it belongs to — the caller refuses a key minted for
 * a different outlet. The secret exists only inside this call; it is never
 * logged and never returned.
 */
@Injectable()
export class HqCredentialChecker {
  /** Test hook: replaces the axios transport with a fake returning `Response`s. */
  async check(
    candidate: HqCredentialCandidate,
    transportOverride?: Transport,
  ): Promise<HqCredentialCheck> {
    const client = generatedClient.createClient(
      transportOverride
        ? { transport: transportOverride }
        : { baseURL: candidate.hqApiBaseUrl, options: { timeout: HQ_TIMEOUT_MS } },
    );
    client.setConfig({
      auth: (scheme) =>
        scheme.type === 'apiKey' && scheme.name === 'Authorization'
          ? `OutletKey ${candidate.keyId}.${candidate.keySecret}`
          : undefined,
    });
    client.interceptors.request.use((request) => {
      request.headers['x-request-id'] = randomUUID();
      return request;
    });
    client.interceptors.response.use((response) => {
      if (response.status >= 200 && response.status < 300) {
        response.data = unwrapEnvelope(response.data);
      }
      return response;
    });

    try {
      const payload = await syncStatusControllerGetCheckpoint({ client });
      const parsed = syncStatusControllerGetCheckpointStatus200Schema.safeParse(payload);
      if (!parsed.success) {
        return { ok: false, kind: 'CONTRACT_MISMATCH' };
      }
      return {
        ok: true,
        outletId: parsed.data.outletId,
        highestContiguousSequence: parsed.data.highestContiguousSequence,
      };
    } catch (error) {
      if (isResponseError(error)) {
        // 401 = HQ refused the key (unknown/expired/revoked); other statuses
        // mean the URL reached SOMETHING, but not a healthy HQ sync API.
        return error.status === 401
          ? { ok: false, kind: 'REJECTED' }
          : { ok: false, kind: 'UNAVAILABLE' };
      }
      return { ok: false, kind: 'UNREACHABLE' };
    }
  }
}
