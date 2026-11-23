import { describe, expect, it } from 'vitest';
import {
  buildLiabilityParityReport,
  EscrowLiabilityInput,
  PayoutReservationInput,
} from './liabilityParity';

const XLM_TOKEN = 'CSYNTHETICXLMTOKEN0000000000000000000000000000000000000000';
const USDC_TOKEN = 'CSYNTHETICUSDCTOKEN000000000000000000000000000000000000000';

const aliases = {
  [XLM_TOKEN]: 'XLM',
  [USDC_TOKEN]: 'USDC',
};

function liability(
  receiptId: string,
  asset: string,
  amountMinor: string | number | bigint,
): EscrowLiabilityInput {
  return { receiptId, asset, amountMinor, status: 'active' };
}

function reservation(
  payoutId: string,
  receiptId: string,
  asset: string,
  amountMinor: string | number | bigint,
): PayoutReservationInput {
  return { payoutId, receiptId, asset, amountMinor, status: 'reserved' };
}

describe('buildLiabilityParityReport', () => {
  it('reports parity when on-chain liabilities and reservations agree by asset and receipt', () => {
    const report = buildLiabilityParityReport({
      liabilities: [
        liability('syn_receipt_1', XLM_TOKEN, '1000'),
        liability('syn_receipt_2', USDC_TOKEN, 500n),
      ],
      reservations: [
        reservation('syn_payout_1', 'syn_receipt_1', XLM_TOKEN, 1000n),
        reservation('syn_payout_2', 'syn_receipt_2', USDC_TOKEN, '500'),
      ],
      assetAliases: aliases,
    });

    expect(report.ok).toBe(true);
    expect(report.readOnly).toBe(true);
    expect(report.correctionsApplied).toBe(0);
    expect(report.totals).toMatchObject({
      assets: 2,
      receipts: 2,
      matchedReceipts: 2,
      mismatchedReceipts: 0,
      invalidRecords: 0,
      onChainMinor: '1500',
      reservedMinor: '1500',
      deltaMinor: '0',
    });
    expect(report.byAsset.map((asset) => [asset.asset, asset.deltaMinor])).toEqual([
      ['USDC', '0'],
      ['XLM', '0'],
    ]);
    expect(report.mismatches).toEqual([]);
  });

  it('reports amount mismatches by asset and receipt with a signed delta', () => {
    const report = buildLiabilityParityReport({
      liabilities: [
        liability('syn_receipt_1', XLM_TOKEN, '1000'),
        liability('syn_receipt_2', USDC_TOKEN, '700'),
      ],
      reservations: [
        reservation('syn_payout_1', 'syn_receipt_1', XLM_TOKEN, '900'),
        reservation('syn_payout_2', 'syn_receipt_2', USDC_TOKEN, '700'),
      ],
      assetAliases: aliases,
    });

    expect(report.ok).toBe(false);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]).toMatchObject({
      asset: 'XLM',
      receiptId: 'syn_receipt_1',
      type: 'AMOUNT_MISMATCH',
      onChainMinor: '1000',
      reservedMinor: '900',
      deltaMinor: '100',
    });
    expect(report.byAsset.find((asset) => asset.asset === 'XLM')).toMatchObject({
      deltaMinor: '100',
      matched: false,
    });
    expect(report.byReceipt.find((receipt) => receipt.asset === 'USDC')?.matched).toBe(
      true,
    );
  });

  it('reports missing reservations, missing liabilities, and duplicate reservations', () => {
    const report = buildLiabilityParityReport({
      liabilities: [
        liability('syn_receipt_1', XLM_TOKEN, '1000'),
        liability('syn_receipt_3', XLM_TOKEN, '250'),
      ],
      reservations: [
        reservation('syn_payout_3', 'syn_receipt_3', XLM_TOKEN, '250'),
        reservation('syn_payout_4', 'syn_receipt_3', XLM_TOKEN, '250'),
        reservation('syn_payout_5', 'syn_receipt_5', XLM_TOKEN, '400'),
      ],
      assetAliases: aliases,
    });

    expect(report.mismatches.map((mismatch) => mismatch.type)).toEqual([
      'MISSING_RESERVATION',
      'AMOUNT_MISMATCH',
      'DUPLICATE_RESERVATION',
      'MISSING_LIABILITY',
    ]);
    expect(report.totals.mismatchedReceipts).toBe(3);
  });

  it('excludes settled, released, and terminal records from outstanding parity', () => {
    const report = buildLiabilityParityReport({
      liabilities: [
        { ...liability('syn_receipt_1', XLM_TOKEN, '1000'), status: 'migrated' },
        { ...liability('syn_receipt_2', XLM_TOKEN, '500'), status: 'released' },
      ],
      reservations: [
        reservation('syn_payout_1', 'syn_receipt_1', XLM_TOKEN, '1000'),
        {
          ...reservation('syn_payout_2', 'syn_receipt_2', XLM_TOKEN, '500'),
          status: 'settled',
        },
        {
          ...reservation('syn_payout_3', 'syn_receipt_3', XLM_TOKEN, '300'),
          status: 'released',
        },
      ],
      assetAliases: aliases,
    });

    expect(report.ok).toBe(true);
    expect(report.totals.receipts).toBe(1);
    expect(report.totals.onChainMinor).toBe('1000');
    expect(report.totals.reservedMinor).toBe('1000');
  });

  it('records invalid records without throwing or changing valid totals', () => {
    const report = buildLiabilityParityReport({
      liabilities: [
        liability('syn_receipt_1', XLM_TOKEN, '1000'),
        { receiptId: 'syn_receipt_2', asset: XLM_TOKEN, amountMinor: '-1' },
        { receiptId: 'syn_receipt_3', asset: XLM_TOKEN, amountMinor: '1.5' },
        { receiptId: '', asset: XLM_TOKEN, amountMinor: '10' },
      ],
      reservations: [reservation('syn_payout_1', 'syn_receipt_1', XLM_TOKEN, '1000')],
      assetAliases: aliases,
    });

    expect(report.ok).toBe(false);
    expect(report.totals.invalidRecords).toBe(3);
    expect(report.totals.onChainMinor).toBe('1000');
    expect(report.mismatches.every((item) => item.type === 'INVALID_RECORD')).toBe(
      true,
    );
  });

  it('supports asset and receipt filters', () => {
    const input = {
      liabilities: [
        liability('syn_receipt_1', XLM_TOKEN, '1000'),
        liability('syn_receipt_2', USDC_TOKEN, '700'),
      ],
      reservations: [
        reservation('syn_payout_1', 'syn_receipt_1', XLM_TOKEN, '900'),
        reservation('syn_payout_2', 'syn_receipt_2', USDC_TOKEN, '700'),
      ],
      assetAliases: aliases,
    };

    const xlmReport = buildLiabilityParityReport({
      ...input,
      filters: { asset: 'xlm' },
    });
    expect(xlmReport.totals.receipts).toBe(1);
    expect(xlmReport.mismatches[0]?.asset).toBe('XLM');

    const receiptReport = buildLiabilityParityReport({
      ...input,
      filters: { receiptId: 'syn_receipt_2' },
    });
    expect(receiptReport.ok).toBe(true);
    expect(receiptReport.totals.receipts).toBe(1);
  });

  it('reports truncated sources so an incomplete report is never treated as parity', () => {
    const report = buildLiabilityParityReport({
      liabilities: [liability('syn_receipt_1', XLM_TOKEN, '1000')],
      reservations: [reservation('syn_payout_1', 'syn_receipt_1', XLM_TOKEN, '1000')],
      assetAliases: aliases,
      sourceTruncated: true,
    });

    expect(report.ok).toBe(false);
    expect(report.mismatches[0]).toMatchObject({ type: 'SOURCE_TRUNCATED' });
  });

  it('normalizes hex receipt identifiers and does not mutate supplied inputs', () => {
    const receiptId = 'A'.repeat(64);
    const liabilities = [liability(receiptId, XLM_TOKEN, '1000')];
    const reservations = [
      reservation('syn_payout_1', receiptId.toLowerCase(), XLM_TOKEN, '1000'),
    ];
    const snapshot = { liabilities, reservations, assetAliases: aliases };
    const before = JSON.stringify(snapshot, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );

    const report = buildLiabilityParityReport(snapshot);

    expect(report.ok).toBe(true);
    expect(report.byReceipt[0]?.receiptId).toBe(receiptId.toLowerCase());
    expect(
      JSON.stringify(snapshot, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).toBe(before);
  });
});
