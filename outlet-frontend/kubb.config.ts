import { defineConfig } from 'kubb/config'
import { pluginAxios } from '@kubb/plugin-axios'
import { pluginReactQuery } from '@kubb/plugin-react-query'
import { pluginTs } from '@kubb/plugin-ts'
import { pluginZod } from '@kubb/plugin-zod'

/**
 * Kubb generation pipeline (PRD §11, AGENTS.md §4.1): the typed Axios client,
 * Zod schemas and TanStack Query hooks are generated from the outlet
 * backend's exported OpenAPI contract — never hand-maintained. Regenerate
 * with `pnpm generate:api` after copying a fresh contract into
 * `src/api/contracts/outlet.openapi.json`. Generated output
 * (`src/api/generated/`) is build output: do not hand-edit.
 */
export default defineConfig({
  input: './src/api/contracts/outlet.openapi.json',
  output: {
    path: './src/api/generated',
    // Generated code imports the app's axios wiring (envelope unwrap, auth
    // header, refresh-on-401) from one shared module.
    clean: true,
  },
  plugins: [
    pluginTs({
      output: { path: 'types' },
    }),
    pluginZod({
      output: { path: 'schemas' },
    }),
    pluginAxios({
      output: { path: 'clients' },
      // The ApiSuccess envelope is unwrapped by the shared axios layer; the
      // generated functions resolve the bare DTO payloads directly.
      returnType: 'data',
      baseURL: '/api/v1',
    }),
    pluginReactQuery({
      output: { path: 'queries' },
    }),
  ],
})
