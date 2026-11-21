import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import type { Env } from '../../../config/env.schema.js';
import { DATA_SOURCE } from '../../../database/database.module.js';
import { MenuSyncStateEntity } from '../../../database/entities/menu-sync-state.entity.js';
import { JsonLogger } from '../../../common/logging/logger.service.js';
// Value import (not `import type`): the class is an injection token.
import { HqSyncClient } from '../clients/hq-sync.client.js';
import { MenuApplyRepository } from '../repositories/menu-apply.repository.js';

/**
 * Menu pull + atomic apply (PRD §8.3, FR-03): fetches revisioned deltas for
 * this outlet, verifies the reply's outlet identity against server-side
 * identity config, and applies the whole batch in ONE local transaction
 * before advancing the checkpoint. Any HTTP failure leaves the checkpoint
 * untouched (AT-13); gaps route to a full-snapshot rebuild (AT-14).
 */
@Injectable()
export class MenuPullService {
  private readonly logger = new JsonLogger('MenuPull');
  private readonly outletId: string;

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: DataSource,
    private readonly hq: HqSyncClient,
    private readonly apply: MenuApplyRepository,
    config: ConfigService<Env, true>,
  ) {
    this.outletId = config.get('OUTLET_ID', { infer: true });
  }

  async pullAndApply(): Promise<{ applied: number; nextRevision: string; snapshotApplied: boolean }> {
    const syncState = await this.dataSource
      .getRepository(MenuSyncStateEntity)
      .findOne({ where: { outletId: this.outletId } });
    const lastRevision = syncState?.lastAppliedRevision ?? '0';

    const changes = await this.hq.getMenuChanges(lastRevision, 500);

    // §8.3: verify the outlet ID — a reply for any other outlet is never applied.
    if (changes.outletId !== this.outletId) {
      throw new Error(
        `HQ menu reply outlet ${changes.outletId} does not match local identity; refusing to apply`,
      );
    }

    // Redelivered pages are pure no-ops: revisions at or below the local
    // checkpoint never re-apply (§8.3). Contiguity is then required of EVERY
    // consecutive pair in the remaining (new) entries — the first revision
    // must follow the checkpoint and no internal gap may exist. A gap routes
    // to the snapshot protocol instead of guessing (AT-14).
    const applicable = changes.changes.filter((change) => BigInt(change.revision) > BigInt(lastRevision));
    const first = applicable[0];
    const contiguous =
      first === undefined ||
      (BigInt(first.revision) === BigInt(lastRevision) + 1n &&
        applicable.every(
          (change, index) => index === 0 || BigInt(change.revision) === BigInt(applicable[index - 1].revision) + 1n,
        ));
    if (changes.snapshotRequired || !contiguous) {
      this.logger.warn('menu_pull_gap_detected', {
        lastAppliedRevision: lastRevision,
        snapshotRequired: changes.snapshotRequired,
        firstRevision: first?.revision ?? null,
      });
      const revision = await this.applySnapshot();
      return { applied: 0, nextRevision: revision, snapshotApplied: true };
    }

    const applied = await this.dataSource.transaction(async (manager) =>
      this.apply.applyChanges(
        manager,
        this.outletId,
        lastRevision,
        changes.changes,
        changes.nextRevision,
        new Date(),
      ),
    );
    return { applied, nextRevision: changes.nextRevision, snapshotApplied: false };
  }

  /**
   * Single-response snapshot rebuild (§8.3 scope decision): one consistent
   * HQ view replaces the catalog atomically — upserts, tombstones for
   * absent items, checkpoint pinned to `snapshotRevision`.
   */
  async applySnapshot(): Promise<string> {
    const snapshot = await this.hq.getMenuSnapshot();
    await this.dataSource.transaction(async (manager) =>
      this.apply.applySnapshot(manager, this.outletId, snapshot, new Date()),
    );
    this.logger.log('menu_snapshot_applied', {
      snapshotId: snapshot.snapshotId,
      snapshotRevision: snapshot.snapshotRevision,
      itemCount: snapshot.items.length,
    });
    return snapshot.snapshotRevision;
  }
}
