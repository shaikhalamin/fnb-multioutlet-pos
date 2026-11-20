/**
 * Export the machine-readable OpenAPI document (PRD §7, §11).
 *
 * Boots the compiled module graph with OPENAPI_EXPORT=true (no DB/Redis I/O),
 * builds the document and writes `openapi/openapi.json`. Rerun it on any
 * endpoint change so the committed contract never goes stale.
 *
 * Usage: node scripts/export-openapi.mjs   (after `pnpm build`)
 */
process.env.OPENAPI_EXPORT = 'true';

// The module graph validates its environment at boot; document export never
// performs I/O (OPENAPI_EXPORT skips DB connect), so inert placeholders are
// enough for deterministic runs on any machine.
process.env.DATABASE_URL ??= 'postgresql://openapi-export:unused@localhost:5432/unused';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.HQ_JWT_ISSUER ??= 'openapi-export';
process.env.HQ_JWT_AUDIENCE ??= 'openapi-export';
process.env.HQ_JWT_PRIVATE_KEY ??= 'openapi-export';
process.env.HQ_JWT_PUBLIC_KEY ??= 'openapi-export';
process.env.OUTLET_KEY_PEPPER ??= 'openapi-export';

try {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../dist/app.module.js');
  const { buildOpenApiDocument } = await import('../dist/openapi/document.js');
  const { mkdirSync, writeFileSync } = await import('node:fs');

  // Keep error logs enabled: with `logger: false` an init failure inside the
  // Nest ExceptionsZone exits silently (process.exit(1), no output).
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  const document = buildOpenApiDocument(app);
  await app.close();

  const outPath = new URL('../openapi/openapi.json', import.meta.url);
  mkdirSync(new URL('../openapi/', import.meta.url), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);

  process.stdout.write(`OpenAPI document written to ${outPath.pathname}\n`);
} catch (error) {
  const { writeSync } = await import('node:fs');
  // Synchronous write: process.exit() would truncate an async stderr pipe.
  writeSync(2, `openapi export failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
}
