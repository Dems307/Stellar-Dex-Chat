import { describe, expect, it } from 'vitest';
import {
  PayoutReservationConflictError,
  PayoutReservationLedger,
} from './reservationLedger';

describe('PayoutReservationLedger', () => {
  it('links one reservation to its receipt, provider transfer, and settlement exactly once', () => {
    const ledger = new PayoutReservationLedger();
    const reservation = ledger.reserve({
      payoutId: 'payout-1',
      contractReceiptId: 'receipt-1',
      amountMinor: 12500n,
      currency: 'ngn',
    });
    ledger.linkProviderTransfer('payout-1', 'provider-1');
    ledger.settle('payout-1');
    ledger.settle('payout-1');

    expect(ledger.getReservation('payout-1')).toMatchObject({
      contractReceiptId: 'receipt-1',
      amountMinor: '12500',
      currency: 'NGN',
      providerTransferReference: 'provider-1',
      status: 'settled',
    });
    expect(
      ledger
        .getEntries('payout-1')
        .filter((entry) => entry.action === 'settled'),
    ).toHaveLength(1);
    expect(ledger.verifyIntegrity().valid).toBe(true);
    expect(reservation.entries).toHaveLength(1);
  });

  it('prevents a contract receipt from being reserved for two payouts', () => {
    const ledger = new PayoutReservationLedger();
    ledger.reserve({
      payoutId: 'payout-1',
      contractReceiptId: 'receipt-1',
      amountMinor: 12500,
      currency: 'NGN',
    });

    expect(() =>
      ledger.reserve({
        payoutId: 'payout-2',
        contractReceiptId: 'receipt-1',
        amountMinor: 12500,
        currency: 'NGN',
      }),
    ).toThrow(PayoutReservationConflictError);
  });

  it('does not allow both settlement and release or duplicate provider links', () => {
    const ledger = new PayoutReservationLedger();
    ledger.reserve({
      payoutId: 'payout-1',
      contractReceiptId: 'receipt-1',
      amountMinor: 12500,
      currency: 'NGN',
    });
    ledger.linkProviderTransfer('payout-1', 'provider-1');

    expect(() => ledger.linkProviderTransfer('payout-1', 'provider-2')).toThrow(
      PayoutReservationConflictError,
    );
    ledger.release('payout-1');
    expect(() => ledger.settle('payout-1')).toThrow(
      PayoutReservationConflictError,
    );
  });

  it('persists immutable reservation links across restarts', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'payout-ledger-'));
    try {
      const ledger = new PayoutReservationLedger(directory);
      ledger.reserve({
        payoutId: 'payout-2',
        contractReceiptId: 'receipt-2',
        amountMinor: 500n,
        currency: 'NGN',
      });
      ledger.linkProviderTransfer('payout-2', 'provider-2');

      const restarted = new PayoutReservationLedger(directory);
      expect(
        restarted.getReservation('payout-2')?.providerTransferReference,
      ).toBe('provider-2');
      expect(restarted.verifyIntegrity().valid).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
