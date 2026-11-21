import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Post-generation codemod for the Kubb machine client: Kubb emits
 * extensionless relative imports, but this backend compiles with NodeNext
 * module resolution, which requires explicit `.js` specifiers (repo-wide
 * import style). Deterministic — running it twice is a no-op. Generated
 * files are still build output; this script runs inside `pnpm generate:api`
 * only.
 */
const GENERATED_DIR = new URL('../src/modules/sync/clients/generated', import.meta.url).pathname;

const RELATIVE_IMPORT = /(\bfrom\s+')(\.\.?\/[^']+)(?=')/g;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.name.endsWith('.ts')) {
      yield path;
    }
  }
}

let touched = 0;
for await (const path of walk(GENERATED_DIR)) {
  const source = await readFile(path, 'utf8');
  const patched = source.replace(RELATIVE_IMPORT, (match, prefix, specifier) =>
    specifier.endsWith('.js') ? match : `${prefix}${specifier}.js`,
  );
  if (patched !== source) {
    await writeFile(path, patched, 'utf8');
    touched += 1;
  }
}
process.stdout.write(`fix-generated-imports: ${touched} file(s) patched\n`);
