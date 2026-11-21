import { type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Phase 2 core schema (PRD §6.2): outlet identity, local users/RBAC, refresh
 * sessions, catalog cache + sync checkpoint, inventory balances/movements,
 * receipt counter, sales + immutable lines + idempotency keys, and the
 * transactional outbox. `sync_attempt_logs` lands with the Phase-3 sync
 * migration (it audits delivery attempts, which do not exist yet).
 * CHECK/UNIQUE constraints mirror the SQL-level protections in PRD §6.2.
 */
export class OutletPhase2Core1720000000000 implements MigrationInterface {
  name = 'OutletPhase2Core1720000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE outlet_identity (
        outlet_id uuid PRIMARY KEY,
        outlet_code text NOT NULL,
        company_id uuid NOT NULL,
        timezone text NOT NULL,
        currency_code text NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE outlet_users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL,
        password_hash text NOT NULL,
        status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE UNIQUE INDEX uq_outlet_users_email ON outlet_users (lower(email))');

    await queryRunner.query(`
      CREATE TABLE outlet_permissions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code text NOT NULL UNIQUE,
        description text NOT NULL DEFAULT ''
      )
    `);

    await queryRunner.query(`
      CREATE TABLE outlet_roles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code text NOT NULL UNIQUE,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE outlet_user_roles (
        user_id uuid NOT NULL REFERENCES outlet_users(id) ON DELETE CASCADE,
        role_id uuid NOT NULL REFERENCES outlet_roles(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, role_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE outlet_role_permissions (
        role_id uuid NOT NULL REFERENCES outlet_roles(id) ON DELETE CASCADE,
        permission_id uuid NOT NULL REFERENCES outlet_permissions(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE outlet_refresh_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES outlet_users(id) ON DELETE CASCADE,
        family_id uuid NOT NULL,
        jti uuid NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        rotated_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_outlet_refresh_sessions_user ON outlet_refresh_sessions (user_id)');
    await queryRunner.query('CREATE INDEX idx_outlet_refresh_sessions_family ON outlet_refresh_sessions (family_id)');

    await queryRunner.query(`
      CREATE TABLE catalog_items (
        menu_item_id uuid PRIMARY KEY,
        assignment_id uuid NOT NULL,
        sku text NOT NULL,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        category text NOT NULL DEFAULT '',
        effective_price_minor bigint NOT NULL CHECK (effective_price_minor >= 0),
        currency_code text NOT NULL,
        active boolean NOT NULL DEFAULT true,
        hq_item_version integer NOT NULL DEFAULT 1,
        applied_revision bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_catalog_items_active ON catalog_items (active)');

    await queryRunner.query(`
      CREATE TABLE menu_sync_state (
        outlet_id uuid PRIMARY KEY,
        last_applied_revision bigint NOT NULL DEFAULT 0,
        last_sync_at timestamptz NOT NULL DEFAULT now(),
        snapshot_id uuid
      )
    `);

    await queryRunner.query(`
      CREATE TABLE inventory_balances (
        menu_item_id uuid PRIMARY KEY REFERENCES catalog_items(menu_item_id),
        quantity_on_hand bigint NOT NULL,
        version integer NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT inventory_nonnegative CHECK (quantity_on_hand >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE receipt_counters (
        outlet_id uuid PRIMARY KEY,
        next_number bigint NOT NULL DEFAULT 1 CHECK (next_number > 0),
        prefix text NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE sales (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        outlet_id uuid NOT NULL REFERENCES outlet_identity(outlet_id),
        receipt_number bigint NOT NULL,
        receipt_no text NOT NULL,
        total_minor bigint NOT NULL CHECK (total_minor >= 0),
        currency_code text NOT NULL,
        status text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED')),
        catalog_revision bigint NOT NULL,
        sold_at timestamptz NOT NULL,
        created_by uuid NOT NULL REFERENCES outlet_users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_sales_receipt_number UNIQUE (outlet_id, receipt_number),
        CONSTRAINT uq_sales_receipt_no UNIQUE (outlet_id, receipt_no)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_sales_sold_at ON sales (sold_at DESC)');

    // stock_movements references sales(id) (source_sale_id), so it lands
    // after the sales table.
    await queryRunner.query(`
      CREATE TABLE stock_movements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        menu_item_id uuid NOT NULL REFERENCES catalog_items(menu_item_id),
        delta_quantity bigint NOT NULL,
        reason text NOT NULL CHECK (reason IN ('SALE', 'RESTOCK', 'WRITE_OFF', 'RECOUNT')),
        source_sale_id uuid REFERENCES sales(id),
        actor_id uuid REFERENCES outlet_users(id),
        request_id text,
        occurred_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_stock_movements_item_time ON stock_movements (menu_item_id, occurred_at DESC)',
    );

    // sale_items must exist before stock_movements can reference sales(id);
    // created here (after sales) with the PRD §6.2 line-level CHECKs.
    await queryRunner.query(`
      CREATE TABLE sale_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        sale_id uuid NOT NULL REFERENCES sales(id),
        menu_item_id uuid NOT NULL REFERENCES catalog_items(menu_item_id),
        name_snapshot text NOT NULL,
        sku_snapshot text NOT NULL,
        quantity integer NOT NULL,
        unit_price_minor bigint NOT NULL,
        subtotal_minor bigint NOT NULL,
        catalog_revision bigint NOT NULL,
        CONSTRAINT uq_sale_items_item UNIQUE (sale_id, menu_item_id),
        CONSTRAINT positive_line_quantity CHECK (quantity > 0),
        CONSTRAINT nonnegative_line_price CHECK (unit_price_minor >= 0),
        CONSTRAINT nonnegative_line_subtotal CHECK (subtotal_minor >= 0)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_sale_items_sale ON sale_items (sale_id)');

    await queryRunner.query(`
      CREATE TABLE sale_idempotency_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        outlet_id uuid NOT NULL,
        key text NOT NULL,
        request_sha256 text NOT NULL,
        sale_id uuid NOT NULL REFERENCES sales(id),
        response_json jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        CONSTRAINT uq_sale_idempotency_keys UNIQUE (outlet_id, key)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_sale_idempotency_keys_sale ON sale_idempotency_keys (sale_id)');

    await queryRunner.query(`
      CREATE TABLE outbox_counters (
        outlet_id uuid PRIMARY KEY,
        next_sequence bigint NOT NULL DEFAULT 1
      )
    `);

    await queryRunner.query(`
      CREATE TABLE outbox_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        outlet_id uuid NOT NULL REFERENCES outlet_identity(outlet_id),
        sequence_no bigint NOT NULL,
        event_type text NOT NULL,
        schema_version integer NOT NULL,
        payload jsonb NOT NULL,
        payload_sha256 text NOT NULL,
        status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RETRY', 'DELIVERED', 'QUARANTINED')),
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        lease_until timestamptz,
        published_at timestamptz,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_outlet_event_seq UNIQUE (outlet_id, sequence_no)
      )
    `);
    await queryRunner.query(
      "CREATE INDEX idx_outbox_due ON outbox_events (status, next_attempt_at) WHERE status IN ('PENDING', 'RETRY')",
    );
    // Sync status of a sale resolves through the outbox payload (PRD §8.7):
    // no sync_status column on sales — the concepts stay separate.
    await queryRunner.query(
      "CREATE INDEX idx_outbox_sale_id ON outbox_events ((payload->'data'->>'saleId'))",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS outbox_events');
    await queryRunner.query('DROP TABLE IF EXISTS outbox_counters');
    await queryRunner.query('DROP TABLE IF EXISTS sale_idempotency_keys');
    await queryRunner.query('DROP TABLE IF EXISTS sale_items');
    await queryRunner.query('DROP TABLE IF EXISTS stock_movements');
    await queryRunner.query('DROP TABLE IF EXISTS sales');
    await queryRunner.query('DROP TABLE IF EXISTS receipt_counters');
    await queryRunner.query('DROP TABLE IF EXISTS inventory_balances');
    await queryRunner.query('DROP TABLE IF EXISTS menu_sync_state');
    await queryRunner.query('DROP TABLE IF EXISTS catalog_items');
    await queryRunner.query('DROP TABLE IF EXISTS outlet_refresh_sessions');
    await queryRunner.query('DROP TABLE IF EXISTS outlet_role_permissions');
    await queryRunner.query('DROP TABLE IF EXISTS outlet_user_roles');
    await queryRunner.query('DROP TABLE IF EXISTS outlet_roles');
    await queryRunner.query('DROP TABLE IF EXISTS outlet_permissions');
    await queryRunner.query('DROP TABLE IF EXISTS outlet_users');
    await queryRunner.query('DROP TABLE IF EXISTS outlet_identity');
  }
}
