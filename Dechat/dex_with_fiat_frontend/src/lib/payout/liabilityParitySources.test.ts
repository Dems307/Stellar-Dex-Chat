import { describe, expect, it, vi } from 'vitest';
import {
  collectLiabilityParitySources,
  reservationsFromLedgerEntries,
} from './liabilityParitySources';
import { PayoutReservationEntry } from './reservationLedger';

function reservationEntry(
  overrides: Partial<PayoutReservationEntry> = {},
): PayoutReservationEntry {
  return {
    sequenceNumber: 1,
    payoutId: 'syn_payout_1',
    contractReceiptId: 'syn_receipt_1',
    action: 'reserved',
    amountMinor: '1000',
    currency: 'xlm',
    timestamp: '2026-01-01T00:00:00.000Z',
    previousHash: '0'.repeat(64),
    hash: '1'.repeat(64),
    ...overrides,
  };
}

describe('reservationsFromLedgerEntries', () => {
  it('maps the latest reservation state to a parity snapshot', () => {
    const entries = [
      reservationEntry(),
      reservationEntry({
        sequenceNumber: 2,
        action: 'provider_linked',
        providerTransferReference: 'syn_provider_1',
        previousHash: '1'.repeat(64),
        hash: '2'.repeat(64),
      }),
      reservationEntry({
        sequenceNumber: 3,
        payoutId: 'syn_payout_2',
        contractReceiptId: 'syn_receipt_2',
        action: 'reserved',
        amountMinor: '500',
        previousHash: '2'.repeat(64),
        hash: '3'.repeat(64),
      }),
      reservationEntry({
        sequenceNumber: 4,
        payoutId: 'syn_payout_3',
        contractReceiptId: 'syn_receipt_3',
        action: 'reserved',
        previousHash: '3'.repeat(64),
        hash: '4'.repeat(64),
      }),
      reservationEntry({
        sequenceNumber: 5,
        payoutId: 'syn_payout_3',
        contractReceiptId: 'syn_receipt_3',
        action: 'settled',
        previousHash: '4'.repeat(64),
        hash: '5'.repeat(64),
      }),
    ];

    expect(reservationsFromLedgerEntries(entries)).toEqual([
      {
        payoutId: 'syn_payout_1',
        receiptId: 'syn_receipt_1',
        asset: 'xlm',
        amountMinor: '1000',
        status: 'reserved',
      },
      {
        payoutId: 'syn_payout_2',
        receiptId: 'syn_receipt_2',
        asset: 'xlm',
        amountMinor: '500',
        status: 'reserved',
      },
      {
        payoutId: 'syn_payout_3',
        receiptId: 'syn_receipt_3',
        asset: 'xlm',
        amountMinor: '1000',
        status: 'settled',
      },
    ]);
  });
});

describe('collectLiabilityParitySources', () => {
  it('pages all contract receipts and includes the configured XLM token alias', async () => {
    const getReceiptAuditViews = vi
      .fn()
      .mockResolvedValueOnce({
        records: [
          {
            version: 1,
            receiptId: 'a'.repeat(64),
            token: 'CSYNTHETICXLMTOKEN',
            amount: 1000n,
            status: 'active',
          },
        ],
        nextCursor: 1,
      })
      .mockResolvedValueOnce({
        records: [
          {
            version: 1,
            receiptId: 'b'.repeat(64),
            token: 'CSYNTHETICXLMTOKEN',
            amount: 500n,
            status: 'migrated',
          },
        ],
        nextCursor: null,
      });

    const sources = await collectLiabilityParitySources({
      pageSize: 1,
      maxPages: 5,
      client: { getReceiptAuditViews },
      ledger: {
        getEntries: () => [reservationEntry()],
      },
    });

    expect(getReceiptAuditViews).toHaveBeenCalledTimes(2);
    expect(getReceiptAuditViews).toHaveBeenNthCalledWith(1, 0, 1);
    expect(getReceiptAuditViews).toHaveBeenNthCalledWith(2, 1, 1);
    expect(sources.liabilities).toHaveLength(2);
    expect(sources.reservations).toHaveLength(1);
    expect(sources.sourceTruncated).toBe(false);
    expect(
      Object.values(sources.assetAliases).map((alias) => alias.toUpperCase()),
    ).toContain('XLM');
  });

  it('marks a report as truncated when the page budget is exhausted', async () => {
    const getReceiptAuditViews = vi.fn().mockResolvedValue({
      records: [],
      nextCursor: 1,
    });

    const sources = await collectLiabilityParitySources({
      pageSize: 10,
      maxPages: 1,
      client: { getReceiptAuditViews },
      ledger: { getEntries: () => [] },
    });

    expect(sources.sourceTruncated).toBe(true);
    expect(getReceiptAuditViews).toHaveBeenCalledTimes(1);
  });
});
