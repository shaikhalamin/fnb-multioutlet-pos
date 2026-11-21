import { describe, expect, it, vi } from 'vitest';
import { OutboxRepository, type SaleCompletedDraft } from './outbox.repository.js';
import { sha256OfCanonicalJson } from './canonical-json.js';

/** Draft matching the PRD §8.4 example: 2 burgers + 1 pizza = 3900. */
function makeDraft(overrides: Partial<SaleCompletedDraft> = {}): SaleCompletedDraft {
  return {
    outletId: '11111111-1111-4111-8111-111111111111',
    occurredAt: new Date('2026-11-20T04:02:03Z'),
    saleId: '0a44e56a-628e-492a-81e0-83f4a4d68f76',
    receiptNo: 'A-000001',
    catalogRevision: '1',
    currencyCode: 'USD',
    soldAt: new Date('2026-11-20T04:02:03Z'),
    totalMinor: '3900',
    items: [
      {
        saleItemId: '64750166-32a4-46f8-9285-f536f5b03213',
        menuItemId: '9708835e-2e21-465a-87e9-5f8d56cd44ab',
        nameSnapshot: 'Chicken Burger',
        skuSnapshot: 'BURGER-01',
        quantity: 2,
        unitPriceMinor: '1200',
        subtotalMinor: '2400',
      },
      {
        saleItemId: 'b7d5d798-daa0-4c52-a675-6d58a9b69f6b',
        menuItemId: 'c7647ce1-69c2-4ff2-8bc4-f3b96f7edca4',
        nameSnapshot: 'Pizza',
        skuSnapshot: 'PIZZA-01',
        quantity: 1,
        unitPriceMinor: '1500',
        subtotalMinor: '1500',
      },
    ],
    ...overrides,
  };
}

/** Manager stub capturing the outbox insert; sequence counter fixed at 108. */
function makeManager() {
  const inserted: Array<Record<string, unknown>> = [];
  const manager = {
    inserted,
    getRepository: (entity: unknown) => {
      const name = (entity as { name?: string }).name;
      if (name === 'OutboxCounterEntity' || name === 'outbox_counters') {
        return {
          createQueryBuilder: () => ({
            setLock: vi.fn(function (this: unknown) { return this; }),
            where: vi.fn(function (this: unknown) { return this; }),
            getOne: vi.fn(async () => ({ outletId: 'o', nextSequence: '108' })),
          }),
          update: vi.fn(async () => undefined),
        };
      }
      return {
        create: vi.fn((row: Record<string, unknown>) => row),
        insert: vi.fn(async (row: Record<string, unknown>) => {
          inserted.push(row);
        }),
      };
    },
  } as never;
  return manager;
}

describe('OutboxRepository.insertSaleCompletedEvent', () => {
  it('writes one PENDING row whose id equals payload.eventId with the contiguous sequence', async () => {
    const repo = new OutboxRepository(null as never);
    const manager = makeManager();

    const row = (await repo.insertSaleCompletedEvent(manager, makeDraft())) as unknown as Record<string, unknown>;

    expect(manager.inserted).toHaveLength(1);
    const insertedRow = manager.inserted[0];
    expect(row).toBe(insertedRow as never);
    expect(insertedRow.status).toBe('PENDING');
    expect(insertedRow.sequenceNo).toBe('108'); // allocated value; counter moves to 109
    expect(insertedRow.attempts).toBe(0);
    const payload = insertedRow.payload as { eventId: string; eventType: string; schemaVersion: number; sequenceNo: string; data: { saleId: string; totalMinor: string; status: string } };
    expect(payload.eventId).toBe(insertedRow.id);
    expect(payload.eventType).toBe('sale.completed');
    expect(payload.schemaVersion).toBe(1);
    expect(payload.sequenceNo).toBe('108');
    expect(payload.data.saleId).toBe('0a44e56a-628e-492a-81e0-83f4a4d68f76');
    expect(payload.data.totalMinor).toBe('3900');
    expect(payload.data.status).toBe('COMPLETED');
  });

  it('hashes the canonical payload so an identical event reproduces the digest', async () => {
    const repo = new OutboxRepository(null as never);
    const manager = makeManager();

    await repo.insertSaleCompletedEvent(manager, makeDraft());

    const insertedRow = manager.inserted[0];
    const payload = insertedRow.payload;
    expect(insertedRow.payloadSha256).toBe(sha256OfCanonicalJson(payload));
    expect(String(insertedRow.payloadSha256)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a draft where quantity × unitPrice ≠ subtotal (PRD §8.4 invariant)', async () => {
    const repo = new OutboxRepository(null as never);
    const draft = makeDraft();
    draft.items = [
      { ...draft.items[0], quantity: 2, unitPriceMinor: '1200', subtotalMinor: '999' },
    ];
    draft.totalMinor = '999';

    await expect(repo.insertSaleCompletedEvent(makeManager(), draft)).rejects.toThrow(
      /quantity × unitPrice ≠ subtotal/,
    );
  });

  it('rejects a draft where Σ subtotal ≠ total (PRD §8.4 invariant)', async () => {
    const repo = new OutboxRepository(null as never);
    const draft = makeDraft({ totalMinor: '9999' });

    await expect(repo.insertSaleCompletedEvent(makeManager(), draft)).rejects.toThrow(
      /Σ subtotal ≠ total/,
    );
  });
});
