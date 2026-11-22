import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { NextRequest } from 'next/server';
import { payoutRetryQueue } from '@/lib/payout/retryQueue';
import { payoutAuditLedger } from '@/lib/payout/auditLedger';
import {
  createFxQuoteRecord,
  signFxQuote,
} from '@/lib/payout/fxQuoteProvenance';

vi.mock('@/lib/telemetry', () => ({
  telemetry: {
    extractTraceFromHeaders: () => ({ traceId: 'trace', spanId: 'parent' }),
    createSpan: () => ({ spanId: 'span' }),
    addLog: vi.fn(),
    finishSpan: vi.fn(),
  },
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
}));

vi.mock('@/lib/rateLimit', () => ({
  applyRateLimit: vi.fn(() => null),
  getClientIp: vi.fn(() => '127.0.0.1'),
  ROUTE_COST_BUCKETS: {
    '/api/initiate-transfer': { maxRequests: 10, windowMs: 60_000 },
  },
}));

vi.mock('@/lib/transferStore', () => ({
  setTransferStatus: vi.fn(),
  getTransferStatus: vi.fn(() => undefined),
}));

const mockInitiateTransfer = vi
  .fn()
  .mockResolvedValue({ reference: 'ref-123' });

vi.mock('@/lib/payout/providers/registry', () => ({
  getPayoutProvider: () => ({
    initiateTransfer: mockInitiateTransfer,
  }),
}));

const { POST } = await import('./route');

const FX_QUOTE_SECRET = 'test-secret-for-fx-quote-signing-123456';

function makeQuote(amount = '1', expiresAt = Date.now() + 120_000) {
  const quotedAt = expiresAt - 120_000;
  const quote = createFxQuoteRecord({
    quoteId: '01234567-89ab-4cde-8fab-0123456789ab',
    provider: 'coingecko',
    providerRequestId: '11234567-89ab-4cde-8fab-0123456789ab',
    providerResponseId: 'provider-response-1',
    source: 'live',
    asset: 'XLM',
    amount,
    currency: 'NGN',
    exchangeRate: '1',
    quotedAt,
    expiresAt,
    precisionDecimals: 2,
    stale: false,
  });
  return { quote, quoteToken: signFxQuote(quote, FX_QUOTE_SECRET) };
}

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(
    new Request('http://localhost/api/initiate-transfer', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        'X-Idempotency-Key': 'test-idempotency-key',
        ...headers,
      },
    }),
  );
}

describe('POST /api/initiate-transfer (Issue #32)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PAYOUT_FX_QUOTE_SECRET', FX_QUOTE_SECRET);
    payoutRetryQueue._resetForTest();
    payoutAuditLedger._resetForTest();
    mockInitiateTransfer.mockResolvedValue({ reference: 'ref-123' });
  });

  it('returns 400 for malformed JSON body', async () => {
    const badReq = new NextRequest(
      new Request('http://localhost/api/initiate-transfer', {
        method: 'POST',
        body: 'not json{{{',
        headers: {
          'content-type': 'application/json',
          'x-idempotency-key': 'test-idempotency-key',
        },
      }),
    );

    const res = await POST(badReq);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.message).toContain('Invalid JSON');
  });

  it('returns 400 when X-Idempotency-Key header is missing', async () => {
    const noKeyReq = new NextRequest(
      new Request('http://localhost/api/initiate-transfer', {
        method: 'POST',
        body: JSON.stringify({
          source: 'wallet',
          reason: 'pay',
          amount: 10,
          recipient: 'G1',
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await POST(noKeyReq);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.message).toContain('X-Idempotency-Key');
  });

  it('returns 400 for validation failures', async () => {
    const req = makeRequest({
      source: '',
      reason: '',
      amount: 0,
      recipient: '',
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('returns 200 for valid request and records audit events', async () => {
    const { quote, quoteToken } = makeQuote();
    mockInitiateTransfer.mockResolvedValue({
      reference: 'ref-123',
      providerReference: 'provider-ref-123',
      id: 42,
      transfer_code: 'TRF_123',
      amountMinor: 100,
      currency: 'NGN',
    });
    const req = makeRequest(
      {
        source: 'wallet',
        reason: 'payment',
        amount: 1,
        currency: 'NGN',
        quoteId: quote.quoteId,
        quoteToken,
        recipient: 'GABC123',
      },
      { 'X-Idempotency-Key': 'key-valid-req' },
    );
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    const auditEvents = payoutAuditLedger.getEntries().entries;
    expect(auditEvents.some((e) => e.action === 'payout_initiated')).toBe(true);
    expect(
      auditEvents.some((e) => e.action === 'payout_provider_accepted'),
    ).toBe(true);
    expect(
      auditEvents.find((e) => e.action === 'payout_provider_accepted')?.metadata
        .finalTransferValues,
    ).toMatchObject({
      amountMinorUnits: '100',
      providerAmountMinorUnits: '100',
      providerReference: 'provider-ref-123',
      providerTransferId: '42',
      providerTransferCode: 'TRF_123',
    });
  });

  it('rejects missing, expired, and mismatched quote authorization before provider submission', async () => {
    const missingQuoteResponse = await POST(
      makeRequest({
        source: 'wallet',
        amount: 1,
        recipient: 'GABC123',
      }),
    );
    expect(missingQuoteResponse.status).toBe(428);

    const expired = makeQuote('1', Date.now() - 1);
    const expiredResponse = await POST(
      makeRequest({
        source: 'wallet',
        amount: 1,
        currency: 'NGN',
        quoteId: expired.quote.quoteId,
        quoteToken: expired.quoteToken,
        recipient: 'GABC123',
      }),
    );
    expect(expiredResponse.status).toBe(410);

    const { quote, quoteToken } = makeQuote();
    const mismatchResponse = await POST(
      makeRequest({
        source: 'wallet',
        amount: 2,
        currency: 'NGN',
        quoteId: quote.quoteId,
        quoteToken,
        recipient: 'GABC123',
      }),
    );
    expect(mismatchResponse.status).toBe(409);
    expect(mockInitiateTransfer).not.toHaveBeenCalled();
  });

  it('rejects a modified quote signature and prevents idempotency-key payload reuse', async () => {
    const { quote, quoteToken } = makeQuote();
    const [payload, signature] = quoteToken.split('.');
    const tampered = `${payload}.${signature.slice(1)}`;
    const tamperedResponse = await POST(
      makeRequest({
        source: 'wallet',
        amount: 1,
        currency: 'NGN',
        quoteId: quote.quoteId,
        quoteToken: tampered,
        recipient: 'GABC123',
      }),
    );
    expect(tamperedResponse.status).toBe(409);
    expect(mockInitiateTransfer).not.toHaveBeenCalled();

    const requestBody = {
      source: 'wallet',
      amount: 1,
      currency: 'NGN',
      quoteId: quote.quoteId,
      quoteToken,
      recipient: 'GABC123',
    };
    const first = await POST(
      makeRequest(requestBody, { 'X-Idempotency-Key': 'key-idempotency' }),
    );
    expect(first.status).toBe(200);
    const replay = await POST(
      makeRequest(requestBody, { 'X-Idempotency-Key': 'key-idempotency' }),
    );
    expect(replay.status).toBe(200);
    const conflict = await POST(
      makeRequest(
        { ...requestBody, recipient: 'GDEF456' },
        { 'X-Idempotency-Key': 'key-idempotency' },
      ),
    );
    expect(conflict.status).toBe(409);
    expect(mockInitiateTransfer).toHaveBeenCalledTimes(1);
  });

  it('links the reserved contract receipt to the accepted provider transfer', async () => {
    const payoutId = `payout-${Date.now()}`;
    const receiptId = `receipt-${Date.now()}`;
    const req = makeRequest(
      {
        source: 'wallet',
        reason: 'payment',
        amount: '100',
        recipient: 'GABC123',
        contractReceiptId: receiptId,
      },
      { 'X-Idempotency-Key': payoutId },
    );

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(payoutReservationLedger.getReservation(payoutId)).toMatchObject({
      contractReceiptId: receiptId,
      amountMinor: '10000',
      currency: 'NGN',
      providerTransferReference: 'ref-123',
      status: 'reserved',
    });
  });

  it('enqueues failed provider calls into durable retry queue without losing intent', async () => {
    mockInitiateTransfer.mockRejectedValueOnce(new Error('502 Bad Gateway'));
    const { quote, quoteToken } = makeQuote();

    const req = makeRequest(
      {
        source: 'wallet',
        reason: 'payment',
        amount: 1,
        currency: 'NGN',
        quoteId: quote.quoteId,
        quoteToken,
        recipient: 'GABC456',
      },
      { 'X-Idempotency-Key': 'key-transient-fail' },
    );

    const res = await POST(req);
    expect(res.status).toBe(202);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe('queued_for_retry');

    const jobs = payoutRetryQueue.getJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].idempotencyKey).toBe('key-transient-fail');
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].payload.fxQuote).toMatchObject({ quoteId: quote.quoteId });
    expect(jobs[0].payload.amountMinorUnits).toBe('100');
  });
});
