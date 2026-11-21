import type { Response } from 'express';

export const REFRESH_COOKIE_NAME = 'outlet_rt';

/** Cookie is scoped to the auth routes only — nowhere else needs it. */
const COOKIE_PATH = '/api/v1/auth';

/**
 * The refresh token lives exclusively in an HttpOnly cookie; the login/refresh
 * JSON bodies never contain it (PRD §9.1, root AGENTS §4.3).
 */
export function setRefreshCookie(
  response: Response,
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
): void {
  response.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: COOKIE_PATH,
    maxAge: maxAgeSeconds * 1_000,
  });
}

export function clearRefreshCookie(response: Response, secure: boolean): void {
  response.clearCookie(REFRESH_COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure, path: COOKIE_PATH });
}
