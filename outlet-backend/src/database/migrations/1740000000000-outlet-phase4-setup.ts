import { type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Phase 4 UI-provisioning schema: the `hq_connection` singleton storing the
 * HQ machine-key credentials saved from the outlet setup wizard (PRD §8.7
 * bootstrap, §9.2 secure provisioning channel), plus nullable informational
 * identity columns — a terminal provisioned from the wizard knows only its
 * HQ-issued outlet ID and code; currency is backfilled from the first menu
 * pull (snapshot/changes items carry `currencyCode`).
 */
export class OutletPhase4Setup1740000000000 implements MigrationInterface {
  name = 'OutletPhase4Setup1740000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE hq_connection (
        outlet_id uuid PRIMARY KEY REFERENCES outlet_identity(outlet_id),
        hq_base_url text NOT NULL,
        key_id text NOT NULL,
        key_secret text NOT NULL,
        last_validated_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('ALTER TABLE outlet_identity ALTER COLUMN company_id DROP NOT NULL');
    await queryRunner.query('ALTER TABLE outlet_identity ALTER COLUMN timezone DROP NOT NULL');
    await queryRunner.query('ALTER TABLE outlet_identity ALTER COLUMN currency_code DROP NOT NULL');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE outlet_identity ALTER COLUMN currency_code SET NOT NULL');
    await queryRunner.query('ALTER TABLE outlet_identity ALTER COLUMN timezone SET NOT NULL');
    await queryRunner.query('ALTER TABLE outlet_identity ALTER COLUMN company_id SET NOT NULL');
    await queryRunner.query('DROP TABLE IF EXISTS hq_connection');
  }
}
