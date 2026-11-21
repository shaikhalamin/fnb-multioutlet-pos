import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { DATA_SOURCE } from '../../database/database.module.js';
import { SyncOutletCheckpointEntity } from '../../database/entities/sync-outlet-checkpoint.entity.js';

/**
 * Per-outlet contiguous-sequence checkpoint (PRD §6.1, §8.7): tracks the
 * highest **contiguous** accepted sequence — gaps never advance it — plus
 * heartbeat-reported backlog. All mutation runs inside the caller's ingest
 * transaction so the checkpoint and the inbox rows commit atomically.
 */
@Injectable()
export class SyncCheckpointRepository {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  async find(outletId: string): Promise<SyncOutletCheckpointEntity | null> {
    return this.dataSource.getRepository(SyncOutletCheckpointEntity).findOne({ where: { outletId } });
  }

  /**
   * Locks (creating if absent) the checkpoint row `FOR UPDATE` inside the
   * caller's transaction — concurrent per-event ingests serialize here, so
   * the contiguous walk below can never race.
   */
  async lockCheckpointRow(manager: EntityManager, outletId: string): Promise<SyncOutletCheckpointEntity> {
    await manager.query(
      'INSERT INTO sync_outlet_checkpoints (outlet_id) VALUES ($1) ON CONFLICT (outlet_id) DO NOTHING',
      [outletId],
    );
    const rows = await manager.query<Array<{ highest_contiguous_sequence: string }>>(
      'SELECT highest_contiguous_sequence FROM sync_outlet_checkpoints WHERE outlet_id = $1 FOR UPDATE',
      [outletId],
    );
    return {
      outletId,
      highestContiguousSequence: rows[0]?.highest_contiguous_sequence ?? '0',
      lastEventAt: null,
      lastReportedBacklog: null,
      lastMenuSeenRevision: null,
      lastHeartbeatAt: null,
    };
  }

  /**
   * Advances the highest contiguous sequence after a successful event insert:
   * walks accepted sequences upward from the current watermark until the
   * first gap (out-of-order events ingest fine; only filled gaps advance —
   * AT-21). Caller holds the checkpoint row lock.
   */
  async advanceContiguous(manager: EntityManager, outletId: string, now: Date): Promise<string> {
    const rows = await manager.query<Array<{ highest: string }>>(
      'SELECT highest_contiguous_sequence::text AS highest FROM sync_outlet_checkpoints WHERE outlet_id = $1',
      [outletId],
    );
    let expected = BigInt(rows[0]?.highest ?? '0') + 1n;
    const sequences = await manager.query<Array<{ seq: string }>>(
      'SELECT sequence_no::text AS seq FROM sync_inbox_events WHERE outlet_id = $1 AND sequence_no >= $2 ORDER BY sequence_no',
      [outletId, expected.toString()],
    );
    for (const row of sequences) {
      if (BigInt(row.seq) === expected) {
        expected += 1n;
      } else {
        break;
      }
    }
    const next = (expected - 1n).toString();
    await manager.query(
      'UPDATE sync_outlet_checkpoints SET highest_contiguous_sequence = $2, last_event_at = $3 WHERE outlet_id = $1',
      [outletId, next, now.toISOString()],
    );
    return next;
  }

  /**
   * Persists an outlet heartbeat (PRD §7.4): the reported backlog snapshot and
   * the menu revision the outlet last applied. Standalone write — never part
   * of an ingest transaction.
   */
  async upsertHeartbeat(
    outletId: string,
    backlog: Record<string, unknown>,
    lastMenuSeenRevision: string,
    now: Date,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO sync_outlet_checkpoints (outlet_id, last_reported_backlog, last_menu_seen_revision, last_heartbeat_at)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (outlet_id) DO UPDATE
       SET last_reported_backlog = $2::jsonb,
           last_menu_seen_revision = $3,
           last_heartbeat_at = $4`,
      [outletId, JSON.stringify(backlog), lastMenuSeenRevision, now.toISOString()],
    );
  }
}
