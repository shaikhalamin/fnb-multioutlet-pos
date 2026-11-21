import { type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Phase 3 sync schema (PRD §6.1, §8.5–§8.7): the HQ inbox dedupe table, the
 * accepted-sale projections, and the per-outlet sync checkpoint. Constraints
 * mirror the SQL-level protections in the PRD §6 block (unique identities,
 * partial reporting index, inbox cursor indexes).
 */
export class HqPhase3Sync1730000000000 implements MigrationInterface {
  name = 'HqPhase3Sync1730000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE sync_inbox_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        outlet_id uuid NOT NULL REFERENCES outlets(id),
        event_id uuid NOT NULL,
        sequence_no bigint NOT NULL,
        event_type text NOT NULL,
        payload_sha256 text NOT NULL,
        schema_version integer NOT NULL,
        status text NOT NULL DEFAULT 'ACCEPTED' CHECK (status IN ('ACCEPTED')),
        received_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_hq_inbox_event ON sync_inbox_events (outlet_id, event_id)',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_hq_inbox_sequence ON sync_inbox_events (outlet_id, sequence_no)',
    );
    await queryRunner.query(
      'CREATE INDEX idx_hq_inbox_received ON sync_inbox_events (outlet_id, received_at DESC)',
    );

    await queryRunner.query(`
      CREATE TABLE hq_sales (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        outlet_id uuid NOT NULL REFERENCES outlets(id),
        source_sale_id uuid NOT NULL,
        receipt_no text NOT NULL,
        sold_at timestamptz NOT NULL,
        total_minor bigint NOT NULL CHECK (total_minor >= 0),
        currency_code text NOT NULL,
        status text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED')),
        ingested_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX uq_hq_sale_source ON hq_sales (outlet_id, source_sale_id)');
    await queryRunner.query('CREATE UNIQUE INDEX uq_hq_receipt ON hq_sales (outlet_id, receipt_no)');
    await queryRunner.query(
      "CREATE INDEX idx_hq_sales_reporting ON hq_sales (outlet_id, sold_at) WHERE status = 'COMPLETED'",
    );

    await queryRunner.query(`
      CREATE TABLE hq_sale_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        hq_sale_id uuid NOT NULL REFERENCES hq_sales(id) ON DELETE CASCADE,
        source_sale_item_id uuid NOT NULL,
        menu_item_id uuid NOT NULL,
        name_snapshot text NOT NULL,
        quantity integer NOT NULL CHECK (quantity > 0),
        unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
        subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
        CONSTRAINT uq_hq_sale_item_source UNIQUE (hq_sale_id, source_sale_item_id)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_hq_sale_items_item ON hq_sale_items (menu_item_id, hq_sale_id)');

    await queryRunner.query(`
      CREATE TABLE sync_outlet_checkpoints (
        outlet_id uuid PRIMARY KEY REFERENCES outlets(id),
        highest_contiguous_sequence bigint NOT NULL DEFAULT 0,
        last_event_at timestamptz,
        last_reported_backlog jsonb,
        last_menu_seen_revision bigint,
        last_heartbeat_at timestamptz
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS sync_outlet_checkpoints');
    await queryRunner.query('DROP TABLE IF EXISTS hq_sale_items');
    await queryRunner.query('DROP TABLE IF EXISTS hq_sales');
    await queryRunner.query('DROP TABLE IF EXISTS sync_inbox_events');
  }
}
