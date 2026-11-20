import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'x-request-id' as const;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export function newRequestId(): string {
  return randomUUID();
}

/** Accept a client-supplied request ID only when it is a safe token. */
export function sanitizeRequestId(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const value = header.trim();
  return REQUEST_ID_PATTERN.test(value) ? value : undefined;
}
