import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { payoutAuditLedger } from '@/lib/payout/auditLedger';
import { verifyFxQuote } from '@/lib/payout/fxQuoteProvenance';

const { getTokenPriceMock, applyRateLimitMock } = vi.hoisted(() => ({
  getTokenPriceMock: vi.fn(),
  applyRateLimitMock: vi.fn(() => null),
}));

vi.mock('@/lib/cryptoPriceService', () => ({
  getTokenPriceWithStatus: getTokenPriceMock,
  QUOTE_LOCK_DURATION_MS: 120_000,
}));

vi.mock('@/lib/payout/security', () => ({
  enforcePayoutRouteSecurity: () => null,
}));

vi.mock('@/lib/rateLimit', () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
  getClientIp: () => '127.0.0.1',
}));

const { POST } = await import('./route');

const FX_QUOTE_SECRET = 'test-secret-for-fx-quote-signing-123456';

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost:3000/api/fx-quote', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/fx-quote', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PAYOUT_FX_QUOTE_SECRET', FX_QUOTE_SECRET);
    payoutAuditLedger._resetForTest();
    applyRateLimitMock.mockReturnValue(null);
    getTokenPriceMock.mockResolvedValue({
      price: 150.005,
      stale: false,
      source: 'live',
      providerResponseId: 'cg-response-123',
    });
  });

  it('issues and persists a signed quote with exact rate and half-up amount', async () => {
    const response = await POST(
      makeRequest({
        tokenSymbol: 'XLM',
        tokenAmount: 10,
        currency: 'ngn',
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.exchangeRateDecimal).toBe('150.005');
    expect(body.data.fiatAmountMinorUnits).toBe('150005');
    expect(body.data.ngnAmount).toBe(1500.05);
    expect(body.data.roundingPolicy).toBe('HALF_UP_TO_MINOR_UNIT');
    expect(body.data.providerResponseId).toBe('cg-response-123');

    const verified = verifyFxQuote(body.data.quoteToken, FX_QUOTE_SECRET);
    expect(verified).toMatchObject({
      valid: true,
      quote: {
        quoteId: body.data.quoteId,
        tokenAmountDecimal: '10',
        fiatAmountMinorUnits: '150005',
      },
    });
    expect(
      payoutAuditLedger.getEntries({ action: 'fx_quote_created' }).entries[0]
        ?.metadata.quote,
    ).toMatchObject({
      quoteId: body.data.quoteId,
      providerResponseId: 'cg-response-123',
      roundingPolicy: 'HALF_UP_TO_MINOR_UNIT',
    });
  });

  it('rejects invalid quote inputs without calling the price provider', async () => {
    const response = await POST(
      makeRequest({
        tokenSymbol: 'XLM',
        tokenAmount: 0,
        currency: 'ngn',
      }),
    );

    expect(response.status).toBe(400);
    expect(getTokenPriceMock).not.toHaveBeenCalled();
  });

  it('rejects amounts that round below one minor unit', async () => {
    const response = await POST(
      makeRequest({
        tokenSymbol: 'XLM',
        tokenAmount: 0.000001,
        currency: 'ngn',
      }),
    );

    expect(response.status).toBe(400);
    expect(getTokenPriceMock).toHaveBeenCalledOnce();
    expect(
      payoutAuditLedger.getEntries({ action: 'fx_quote_created' }).entries,
    ).toHaveLength(0);
  });

  it('rejects a rounded quote above the payout maximum', async () => {
    const response = await POST(
      makeRequest({
        tokenSymbol: 'XLM',
        tokenAmount: 1_000_000,
        currency: 'ngn',
      }),
    );

    expect(response.status).toBe(400);
    expect(
      payoutAuditLedger.getEntries({ action: 'fx_quote_created' }).entries,
    ).toHaveLength(0);
  });
});
