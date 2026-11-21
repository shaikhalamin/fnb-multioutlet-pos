import type { ClientConfig } from './core.js'
import { serializeHeaders } from './serializers/headers.js'
import { serializePath } from './serializers/path.js'
import { serializeQuery } from './serializers/query.js'

/**
 * The config `client.ts` starts with: what this spec needs from the runtime.
 */
export const defaultConfig: ClientConfig = { serializer: { query: serializeQuery, path: serializePath, header: serializeHeaders } }
