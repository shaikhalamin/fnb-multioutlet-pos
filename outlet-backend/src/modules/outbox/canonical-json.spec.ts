import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify, sha256OfCanonicalJson } from './canonical-json.js';

describe('canonicalJsonStringify', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJsonStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('is key-order-insensitive: same content ⇒ same string', () => {
    const a = { totalMinor: '3900', receiptNo: 'A-000001', items: [{ qty: 2, sku: 'BURGER-01' }] };
    const b = { items: [{ sku: 'BURGER-01', qty: 2 }], receiptNo: 'A-000001', totalMinor: '3900' };
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it('preserves array order (order is semantic)', () => {
    expect(canonicalJsonStringify([2, 1])).toBe('[2,1]');
    expect(canonicalJsonStringify([2, 1])).not.toBe(canonicalJsonStringify([1, 2]));
  });

  it('drops undefined values and handles primitives/null', () => {
    expect(canonicalJsonStringify({ a: undefined, b: null, c: 'x' })).toBe('{"b":null,"c":"x"}');
    expect(canonicalJsonStringify(null)).toBe('null');
    expect(canonicalJsonStringify(42)).toBe('42');
  });
});

describe('sha256OfCanonicalJson', () => {
  it('hashes the canonical form: property order does not change the digest', () => {
    const a = sha256OfCanonicalJson({ total: '10', id: 'x' });
    const b = sha256OfCanonicalJson({ id: 'x', total: '10' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different digests for different content', () => {
    expect(sha256OfCanonicalJson({ total: '10' })).not.toBe(sha256OfCanonicalJson({ total: '11' }));
  });
});
