import { defineConfig } from 'kubb/config';
import { pluginAxios } from '@kubb/plugin-axios';
import { pluginTs } from '@kubb/plugin-ts';
import { pluginZod } from '@kubb/plugin-zod';

/**
 * Kubb machine-client generation (PRD §11: "typed machine client … request
 * interceptor adding the outlet key"): the typed Axios client and Zod
 * schemas for the HQ sync API are generated from HQ's exported OpenAPI
 * document — never hand-maintained. Only `sync`-tagged operations are
 * generated: the machine client never sees human routes (§7.4). The key is
 * injected at runtime from server-side env, never baked into this output.
 *
 * Regenerate with `pnpm generate:api` after copying a fresh contract into
 * `src/contracts/hq.openapi.json`. Generated output is build output: do not
 * hand-edit.
 */
const SYNC_ONLY = [{ type: 'tag', pattern: 'sync' }] as const;

export default defineConfig({
  input: './src/contracts/hq.openapi.json',
  output: {
    path: './src/modules/sync/clients/generated',
    clean: true,
  },
  plugins: [
    pluginTs({
      include: [...SYNC_ONLY],
      output: { path: 'types', banner: '/* Backend-only machine client (PRD §11); never ship to a browser bundle. */' },
    }),
    pluginZod({
      include: [...SYNC_ONLY],
      output: { path: 'schemas' },
    }),
    pluginAxios({
      include: [...SYNC_ONLY],
      output: { path: 'clients' },
      // The ApiSuccess envelope is stripped by this client's response step
      // (HQ's `data` field is re-parsed with the generated Zod schemas);
      // generated functions resolve the bare payloads.
      returnType: 'data',
      // Overridden per call by HqSyncClient with the configured HQ base URL.
      baseURL: '',
      paramsSerializer: { indexes: null },
    }),
  ],
});
