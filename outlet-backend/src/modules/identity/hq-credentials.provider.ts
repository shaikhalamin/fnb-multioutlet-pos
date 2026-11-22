import { Injectable } from '@nestjs/common';
import { IdentityRepository } from './identity.repository.js';

/** The HQ machine credentials the sync worker authenticates with. */
export type HqCredentials = {
  hqApiBaseUrl: string;
  keyId: string;
  /** Raw secret — lives only server-side; never logged, never serialized. */
  keySecret: string;
};

/**
 * DB-backed HQ credential source (PRD §9.2, §14.1): the worker reads the
 * `hq_connection` singleton — credentials saved (or rotated) through the
 * setup wizard / sync surface, with no restart and no environment variable.
 * `refresh()` re-reads the row; `get()` returns the last known value for
 * the synchronous axios auth callback.
 */
@Injectable()
export class HqCredentialsProvider {
  private current: HqCredentials | null = null;

  constructor(private readonly repository: IdentityRepository) {}

  /** Fresh read of the singleton row; returns null while unpaired. */
  async refresh(): Promise<HqCredentials | null> {
    const row = await this.repository.findConnection();
    this.current = row
      ? { hqApiBaseUrl: row.hqBaseUrl, keyId: row.keyId, keySecret: row.keySecret }
      : null;
    return this.current;
  }

  /** Last refreshed credentials (null before the first refresh or when unpaired). */
  get(): HqCredentials | null {
    return this.current;
  }

  /** True when the two credential sets differ (rotation detection). */
  static credentialsChanged(before: HqCredentials | null, after: HqCredentials | null): boolean {
    if (before === null || after === null) return after !== null;
    return (
      before.keyId !== after.keyId ||
      before.keySecret !== after.keySecret ||
      before.hqApiBaseUrl !== after.hqApiBaseUrl
    );
  }
}
