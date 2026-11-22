import { describe, expect, it } from 'vitest';
import { decodeReceiptAuditPage, decodeReceiptAuditView } from '../encoding';

describe('receipt audit view decoding', () => {
  it('decodes named audit view fields and byte receipt identifiers', () => {
    const receiptId = Uint8Array.from({ length: 32 }, (_, index) => index);
    const view = decodeReceiptAuditView({
      version: 1,
      receipt_id: receiptId,
      token: 'CSYNTHETICXLMTOKEN',
      amount: 1000n,
      status: 2,
    });

    expect(view).toEqual({
      version: 1,
      receiptId: Array.from(receiptId)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
      token: 'CSYNTHETICXLMTOKEN',
      amount: 1000n,
      status: 'migrated',
    });
  });

  it('decodes tuple-shaped audit pages and tolerates missing cursors', () => {
    const page = decodeReceiptAuditPage({
      _0: [
        {
          _0: 1,
          _1: 'a'.repeat(64),
          _2: 'CSYNTHETICXLMTOKEN',
          _3: '250',
          _4: 'Active',
        },
      ],
      _1: undefined,
    });

    expect(page.nextCursor).toBeNull();
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({
      amount: 250n,
      status: 'active',
      receiptId: 'a'.repeat(64),
    });
  });

  it('returns an empty page for malformed responses', () => {
    expect(decodeReceiptAuditPage(null)).toEqual({
      records: [],
      nextCursor: null,
    });
    expect(decodeReceiptAuditView({ token: 'CSYNTHETICXLMTOKEN' })).toBeNull();
  });
});
