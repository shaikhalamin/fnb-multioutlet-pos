import { type MigrationInterface, type QueryRunner } from 'typeorm';

/**
 * Phase 0 baseline migration: enable pgcrypto so later phases can use
 * server-side digest/uuid helpers (e.g. outlet key hashing, PRD §9.2).
 * Business schema (HQ users/outlets/menu, PRD §6.1) lands in Phase 1+.
 */
export class EnablePgcrypto1700000000000 implements MigrationInterface {
  name = 'EnablePgcrypto1700000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP EXTENSION IF EXISTS pgcrypto');
  }
}
