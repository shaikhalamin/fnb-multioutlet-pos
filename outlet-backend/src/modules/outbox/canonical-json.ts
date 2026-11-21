import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialization for payload hashing (PRD §8.5: DUPLICATE is
 * defined by "the same canonical payload hash"): object keys sorted
 * recursively, no insignificant whitespace, stable array order. Two payloads
 * that serialize identically here are byte-identical for hashing purposes.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonStringify(entry)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`).join(',')}}`;
}

/** SHA-256 hex digest over the canonical JSON form (payload_sha256). */
export function sha256OfCanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(value)).digest('hex');
}
