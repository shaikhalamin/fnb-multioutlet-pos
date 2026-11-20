import { buildCliDataSource } from './data-source.js';

/**
 * Migration CLI (`run` | `revert` | `show`) used by `scripts/migrate.sh`,
 * `pnpm migration:*` and the Compose migrate jobs. In the production image
 * this file runs compiled (`node dist/database/migrate.js`); locally it runs
 * through tsx. Migrations are a single controlled release job — never run
 * concurrently on every API replica (PRD §14.2).
 */
const USAGE = 'usage: migrate.ts <run|revert|show>';
const log = (payload: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(payload)}\n`);

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'run';
  const dataSource = buildCliDataSource();

  try {
    await dataSource.initialize();

    if (command === 'run') {
      const applied = await dataSource.runMigrations();
      log({ msg: 'migrations_applied', count: applied.length, migrations: applied.map((m) => m.name) });
    } else if (command === 'revert') {
      await dataSource.undoLastMigration();
      log({ msg: 'migration_reverted' });
    } else if (command === 'show') {
      const migrations = await dataSource.showMigrations();
      log({ msg: 'migrations_status', migrations });
    } else {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 1;
      return;
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: 'hq-backend',
      msg: 'migration_failed',
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
