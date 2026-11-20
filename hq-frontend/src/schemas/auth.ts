import { authUserResponseSchema } from '#/api/generated/schemas/authUserResponseSchema'
import type { SessionUser } from '#/lib/permissions'
import { toHqPermissions } from '#/lib/permissions'

/**
 * Runtime validation of the auth user coming back from `POST /auth/login` /
 * `POST /auth/refresh` (AGENTS §4.2): parse with the generated Zod schema,
 * then narrow `permissions` from raw strings to the known `HqPermission`
 * catalog. Throws on malformed payloads — callers treat that as a failed
 * login/refresh rather than storing an unvalidated session.
 */
export function parseSessionUser(raw: unknown): SessionUser {
  const user = authUserResponseSchema.parse(raw)
  return {
    id: user.id,
    email: user.email,
    roleCodes: [...user.roleCodes],
    permissions: toHqPermissions(user.permissions),
  }
}
