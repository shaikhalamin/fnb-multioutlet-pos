import { describe, expect, it, vi } from 'vitest';
import { formatReceiptNo } from './receipt-counter.repository.js';

describe('formatReceiptNo (PRD §6.2, §8.4)', () => {
  it('zero-pads to 6 digits with the outlet-code prefix', () => {
    expect(formatReceiptNo('A', 1)).toBe('A-000001');
    expect(formatReceiptNo('A', '42')).toBe('A-000042');
    expect(formatReceiptNo('B', 123456)).toBe('B-123456');
  });

  it('grows beyond 6 digits without truncation', () => {
    expect(formatReceiptNo('A', 1234567)).toBe('A-1234567');
  });

  it('matches the sync-event v1 receipt pattern', () => {
    expect(formatReceiptNo('A', 1)).toMatch(/^[A-Za-z0-9_-]+-[0-9]{1,19}$/);
  });

  it('rejects non-positive or unsafe numbers', () => {
    expect(() => formatReceiptNo('A', 0)).toThrow();
    expect(() => formatReceiptNo('A', -1)).toThrow();
    expect(() => formatReceiptNo('A', Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});

describe('ReceiptCounterRepository.allocate (mocked row lock)', () => {
  it('locks FOR UPDATE, increments, and returns the pre-increment number', async () => {
    const update = vi.fn(async () => undefined);
    const manager = {
      getRepository: () => ({
        createQueryBuilder: () => ({
          setLock: vi.fn(function (this: unknown) { return this; }),
          where: vi.fn(function (this: unknown) { return this; }),
          getOne: vi.fn(async () => ({ outletId: 'o-1', nextNumber: '7', prefix: 'A' })),
        }),
        update,
      }),
    } as never;
    const { ReceiptCounterRepository } = await import('./receipt-counter.repository.js');
    const repo = new ReceiptCounterRepository();

    const allocation = await repo.allocate(manager, 'o-1');

    expect(allocation).toEqual({ receiptNumber: '7', receiptNo: 'A-000007' });
    expect(update).toHaveBeenCalledWith({ outletId: 'o-1' }, { nextNumber: '8' });
  });
});
