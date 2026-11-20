import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const OUTLET_KEY_SCOPES = ['menu.pull', 'events.push', 'status.write'] as const;
export type OutletKeyScope = (typeof OUTLET_KEY_SCOPES)[number];

/** Non-secret, indexed key identifier (`ok_<env>_<random>`), PRD §9.2. */
export function generateOutletKeyId(environment: string): string {
  const prefix = environment === 'production' ? 'ok_live_' : 'ok_dev_';
  return `${prefix}${randomBytes(8).toString('hex')}`;
}

/** 256-bit cryptographically random secret, base64url (PRD §9.2). */
export function generateOutletKeySecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Keyed digest of the secret — the only stored form. The pepper never leaves
 * backend configuration (PRD §9.2, root AGENTS §1.6).
 */
export function hashOutletKeySecret(secret: string, pepper: string): string {
  return createHmac('sha256', pepper).update(secret, 'utf8').digest('hex');
}

/** Constant-time verification for the Phase 3 sync guard. */
export function outletKeySecretMatches(secret: string, storedHash: string, pepper: string): boolean {
  const computed = Buffer.from(hashOutletKeySecret(secret, pepper), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  return computed.length === stored.length && timingSafeEqual(computed, stored);
}
