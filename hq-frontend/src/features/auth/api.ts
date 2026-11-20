import { authControllerLogin } from '#/api/generated/clients/authControllerLogin'
import { authControllerLogout } from '#/api/generated/clients/authControllerLogout'
import { refreshSessionNow } from '#/api/axios'
import { parseSessionUser } from '#/schemas/auth'
import { sessionStore } from './session'

export { refreshSessionNow }

/**
 * Imperative session actions used by the login form and the header. The
 * refresh token travels only in the backend's HttpOnly cookie (PRD §9.1).
 */
export async function login(email: string, password: string): Promise<void> {
  const result = await authControllerLogin({ body: { email, password } })
  sessionStore.set({
    accessToken: result.accessToken,
    user: parseSessionUser(result.user),
  })
}

export async function logout(): Promise<void> {
  try {
    await authControllerLogout()
  } finally {
    sessionStore.clear()
  }
}
