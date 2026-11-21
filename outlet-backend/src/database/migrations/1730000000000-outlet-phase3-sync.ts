import { type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Phase 3 sync schema (PRD §6.2, §8.5–§8.8): the delivery-attempt ledger,
 * the outlet-local audit log backing the privileged emergency-grace
 * override, and the grace-override column on the menu sync checkpoint.
 */
export class OutletPhase3Sync1730000000000 implements MigrationInterface {
  name = 'OutletPhase3Sync1730000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE sync_attempt_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        outbox_event_id uuid NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
        status_code integer,
        duration_ms integer NOT NULL CHECK (duration_ms >= 0),
        error_code text,
        attempt_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_sync_attempt_logs_event ON sync_attempt_logs (outbox_event_id, attempt_at DESC)',
    );

    await queryRunner.query(`
      CREATE TABLE outlet_audit_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_type text NOT NULL CHECK (actor_type IN ('USER', 'SYSTEM')),
        actor_id uuid REFERENCES outlet_users(id),
        action text NOT NULL,
        entity_id uuid,
        metadata jsonb NOT NULL DEFAULT '{}',
        occurred_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_outlet_audit_logs_occurred ON outlet_audit_logs (occurred_at DESC)',
    );

    await queryRunner.query('ALTER TABLE menu_sync_state ADD COLUMN grace_overridden_until timestamptz');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE menu_sync_state DROP COLUMN IF EXISTS grace_overridden_until');
    await queryRunner.query('DROP TABLE IF EXISTS outlet_audit_logs');
    await queryRunner.query('DROP TABLE IF EXISTS sync_attempt_logs');
  }
}
