import { type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Phase 1 core schema (PRD §6.1): company/outlet topology, HQ users and RBAC,
 * refresh sessions, master menu catalog, outlet assignments, per-outlet
 * catalog revisions/changes, outlet API keys, and the audit log.
 * CHECK/UNIQUE constraints mirror the SQL-level protections in PRD §6.
 */
export class HqPhase1Core1710000000000 implements MigrationInterface {
  name = 'HqPhase1Core1710000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE companies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        currency_code text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE outlets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id),
        code text NOT NULL,
        name text NOT NULL,
        timezone text NOT NULL,
        status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_outlets_company_code UNIQUE (company_id, code)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE hq_users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id),
        email text NOT NULL,
        password_hash text NOT NULL,
        status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_hq_users_email ON hq_users (company_id, lower(email))',
    );

    await queryRunner.query(`
      CREATE TABLE hq_permissions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code text NOT NULL UNIQUE,
        description text NOT NULL DEFAULT ''
      )
    `);

    await queryRunner.query(`
      CREATE TABLE hq_roles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id),
        code text NOT NULL,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_hq_roles_company_code UNIQUE (company_id, code)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE hq_user_roles (
        user_id uuid NOT NULL REFERENCES hq_users(id) ON DELETE CASCADE,
        role_id uuid NOT NULL REFERENCES hq_roles(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, role_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE hq_role_permissions (
        role_id uuid NOT NULL REFERENCES hq_roles(id) ON DELETE CASCADE,
        permission_id uuid NOT NULL REFERENCES hq_permissions(id) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE hq_refresh_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES hq_users(id) ON DELETE CASCADE,
        family_id uuid NOT NULL,
        jti uuid NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        rotated_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_hq_refresh_sessions_user ON hq_refresh_sessions (user_id)');
    await queryRunner.query(
      'CREATE INDEX idx_hq_refresh_sessions_family ON hq_refresh_sessions (family_id)',
    );

    await queryRunner.query(`
      CREATE TABLE menu_categories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id),
        name text NOT NULL,
        sort_order integer NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_menu_categories_company_name UNIQUE (company_id, name)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE master_menu_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id),
        category_id uuid NOT NULL REFERENCES menu_categories(id),
        sku text NOT NULL,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        default_price_minor bigint NOT NULL CHECK (default_price_minor >= 0),
        currency_code text NOT NULL,
        status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_master_menu_items_company_sku UNIQUE (company_id, sku)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_master_menu_items_status ON master_menu_items (company_id, status, category_id)',
    );

    await queryRunner.query(`
      CREATE TABLE outlet_menu_assignments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        outlet_id uuid NOT NULL REFERENCES outlets(id),
        menu_item_id uuid NOT NULL REFERENCES master_menu_items(id),
        price_override_minor bigint CHECK (price_override_minor IS NULL OR price_override_minor >= 0),
        active boolean NOT NULL DEFAULT true,
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_outlet_menu_assignments UNIQUE (outlet_id, menu_item_id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_outlet_menu_assignments_outlet_active ON outlet_menu_assignments (outlet_id, active)',
    );

    await queryRunner.query(`
      CREATE TABLE outlet_catalog_revisions (
        outlet_id uuid PRIMARY KEY REFERENCES outlets(id),
        current_revision bigint NOT NULL DEFAULT 0
      )
    `);

    await queryRunner.query(`
      CREATE TABLE outlet_catalog_changes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        outlet_id uuid NOT NULL REFERENCES outlets(id),
        revision bigint NOT NULL,
        action text NOT NULL CHECK (action IN ('UPSERT', 'REMOVE')),
        payload jsonb NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_outlet_catalog_changes_revision UNIQUE (outlet_id, revision)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_catalog_changes_cursor ON outlet_catalog_changes (outlet_id, revision)',
    );

    await queryRunner.query(`
      CREATE TABLE outlet_api_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        key_id text NOT NULL UNIQUE,
        outlet_id uuid NOT NULL REFERENCES outlets(id),
        secret_hash text NOT NULL,
        scopes text[] NOT NULL,
        status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
        expires_at timestamptz,
        last_used_at timestamptz,
        rotated_from_id uuid REFERENCES outlet_api_keys(id),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_outlet_api_keys_outlet ON outlet_api_keys (outlet_id)');

    await queryRunner.query(`
      CREATE TABLE audit_logs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_type text NOT NULL CHECK (actor_type IN ('USER', 'OUTLET_KEY', 'SYSTEM')),
        actor_id uuid,
        action text NOT NULL,
        entity_type text,
        entity_id uuid,
        metadata jsonb NOT NULL DEFAULT '{}',
        occurred_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_audit_logs_occurred ON audit_logs (occurred_at DESC)');
    await queryRunner.query('CREATE INDEX idx_audit_logs_entity ON audit_logs (entity_type, entity_id)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS audit_logs');
    await queryRunner.query('DROP TABLE IF EXISTS outlet_api_keys');
    await queryRunner.query('DROP TABLE IF EXISTS outlet_catalog_changes');
    await queryRunner.query('DROP TABLE IF EXISTS outlet_catalog_revisions');
    await queryRunner.query('DROP TABLE IF EXISTS outlet_menu_assignments');
    await queryRunner.query('DROP TABLE IF EXISTS master_menu_items');
    await queryRunner.query('DROP TABLE IF EXISTS menu_categories');
    await queryRunner.query('DROP TABLE IF EXISTS hq_refresh_sessions');
    await queryRunner.query('DROP TABLE IF EXISTS hq_role_permissions');
    await queryRunner.query('DROP TABLE IF EXISTS hq_user_roles');
    await queryRunner.query('DROP TABLE IF EXISTS hq_roles');
    await queryRunner.query('DROP TABLE IF EXISTS hq_permissions');
    await queryRunner.query('DROP TABLE IF EXISTS hq_users');
    await queryRunner.query('DROP TABLE IF EXISTS outlets');
    await queryRunner.query('DROP TABLE IF EXISTS companies');
  }
}
