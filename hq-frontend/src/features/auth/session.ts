import { useSyncExternalStore } from 'react'
import type { SessionUser } from '#/lib/permissions'

export type { SessionUser } from '#/lib/permissions'

export type Session = {
  accessToken: string | null
  user: SessionUser | null
}

/**
 * In-memory session store (PRD §9.1, AGENTS.md §4.3): the access token never
 * touches localStorage; the refresh token lives only in the backend's
 * HttpOnly cookie. Survives navigation, not reloads — a reload re-bootstraps
 * via `POST /auth/refresh`.
 */
const listeners = new Set<() => void>()
let session: Session = { accessToken: null, user: null }

function emit(): void {
  for (const listener of listeners) listener()
}

export const sessionStore = {
  get(): Session {
    return session
  },
  set(next: Pick<Session, 'accessToken'> & { user: SessionUser | null }): void {
    session = next
    emit()
  },
  clear(): void {
    session = { accessToken: null, user: null }
    emit()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

/** React hook: the live session snapshot. */
export function useSession(): Session {
  return useSyncExternalStore(
    sessionStore.subscribe,
    sessionStore.get,
    sessionStore.get,
  )
}
