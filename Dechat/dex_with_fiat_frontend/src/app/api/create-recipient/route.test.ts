import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { clearBeneficiaryStore } from '@/lib/payout/beneficiaryStore';
import {
  resetCircuitBreakers,
  ProviderOutageError,
} from '@/lib/payout/circuitBreaker';
import { createWalletSessionToken } from '@/lib/payout/auth';
import {
  issueBeneficiaryVerification,
} from '@/lib/payout/beneficiaryVerification';

vi.mock('server-only', () => ({}));

const applyRateLimitMock = vi.fn<(...args: unknown[]) => null>(() => null);

vi.mock('@/lib/rateLimit', () => ({
  applyRateLimit: (
    ...args: Parameters<typeof import('@/lib/rateLimit').applyRateLimit>
  ) => applyRateLimitMock(...args),
  getClientIp: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/telemetry', () => ({
  telemetry: {
    extractTraceFromHeaders: () => ({ traceId: 'trace', spanId: 'parent' }),
    createSpan: () => ({ spanId: 'span' }),
    addLog: vi.fn(),
    finishSpan: vi.fn(),
    setTraceHeaders: vi.fn(),
  },
}));

const createRecipientMock = vi.fn().mockResolvedValue({
  recipient_code: 'RCP_test',
  name: 'Ada Lovelace',
});

vi.mock('@/lib/payout/providers/registry', () => ({
  getPayoutProvider: () => ({
    name: 'paystack',
    createRecipient: createRecipientMock,
  }),
}));

const { POST } = await import('./route');
const WALLET_ADDRESS_A =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const WALLET_ADDRESS_B =
  'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF';
const WALLET_SESSION_A =
  createWalletSessionToken(WALLET_ADDRESS_A).sessionToken;
const WALLET_SESSION_B =
  createWalletSessionToken(WALLET_ADDRESS_B).sessionToken;

const VALID_BODY = {
  type: 'nuban',
  name: 'Ada Lovelace',
  account_number: '0123456789',
  bank_code: '058',
  currency: 'NGN',
};

function makeRequest(
  body: unknown,
  raw = false,
  extraHeaders: Record<string, string> = {},
) {
  return new NextRequest(
    new Request('http://localhost:3000/api/create-recipient', {
      method: 'POST',
      body: raw ? (body as string) : JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
        'sec-fetch-site': 'same-origin',
        'x-wallet-session': WALLET_SESSION_A,
        ...extraHeaders,
      },
    }),
  );
}

describe('POST /api/create-recipient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBeneficiaryStore();
    resetCircuitBreakers();
    applyRateLimitMock.mockReturnValue(null);
    createRecipientMock.mockResolvedValue({
      recipient_code: 'RCP_test',
      name: 'Ada Lovelace',
    });
  });

  function verifiedRequest(
    body: typeof VALID_BODY = VALID_BODY,
    walletAddress = WALLET_ADDRESS_A,
    session = WALLET_SESSION_A,
  ) {
    const identityScope = `wallet:${walletAddress.toUpperCase()}`;
    const { verificationToken } = issueBeneficiaryVerification({
      accountNumber: body.account_number,
      bankCode: body.bank_code,
      currency: body.currency,
      identityScope,
      accountName: body.name,
    });
    return makeRequest(
      { ...body, verificationToken },
      false,
      { 'x-wallet-session': session },
    );
  }

  it('creates a recipient for a valid body', async () => {
    const res = await POST(verifiedRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.recipient_code).toBe('RCP_test');
    expect(JSON.stringify(body)).not.toContain(VALID_BODY.account_number);
    expect(body.data.account_number).toBeUndefined();
    expect(body.data.bank_code).toBeUndefined();
    expect(createRecipientMock).toHaveBeenCalledWith(
      expect.objectContaining({ bank_code: '058', currency: 'NGN' }),
    );
  });

  it('reuses existing beneficiary reference on identical subsequent submissions', async () => {
    const res1 = await POST(verifiedRequest());
    const body1 = await res1.json();
    expect(body1.success).toBe(true);
    expect(body1.data.recipient_code).toBe('RCP_test');
    expect(createRecipientMock).toHaveBeenCalledTimes(1);

    // Second call with same account
    const res2 = await POST(verifiedRequest());
    const body2 = await res2.json();
    expect(body2.success).toBe(true);
    expect(body2.data.recipient_code).toBe('RCP_test');
    expect(body2.data.reused).toBe(true);
    // Remote provider was not called again
    expect(createRecipientMock).toHaveBeenCalledTimes(1);
  });

  it('requires current verification and rejects changed details before provider call', async () => {
    const { verificationToken } = issueBeneficiaryVerification({
      accountNumber: VALID_BODY.account_number,
      bankCode: VALID_BODY.bank_code,
      currency: VALID_BODY.currency,
      identityScope: `wallet:${WALLET_ADDRESS_A}`,
      accountName: VALID_BODY.name,
    });
    const res = await POST(
      makeRequest(
        { ...VALID_BODY, account_number: '9876543210', verificationToken },
      ),
    );
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe('BENEFICIARY_DETAILS_CHANGED');
    expect(JSON.stringify(body)).not.toContain('9876543210');
    expect(createRecipientMock).not.toHaveBeenCalled();
  });

  it('does not allow another wallet to use the verification authorization', async () => {
    const request = verifiedRequest(
      VALID_BODY,
      WALLET_ADDRESS_A,
      WALLET_SESSION_B,
    );
    const res = await POST(request);
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error.code).toBe('BENEFICIARY_VERIFICATION_REQUIRED');
    expect(createRecipientMock).not.toHaveBeenCalled();
  });

  it('requires verification before recipient creation', async () => {
    const res = await POST(makeRequest(VALID_BODY));
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error.code).toBe('BENEFICIARY_VERIFICATION_REQUIRED');
    expect(createRecipientMock).not.toHaveBeenCalled();
  });

  it('returns 400 with a machine-readable error shape for invalid input', async () => {
    const res = await POST(
      makeRequest({ ...VALID_BODY, name: '', account_number: '' }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.message).toBe('Validation failed');
    expect(Array.isArray(body.errors)).toBe(true);
    const paths = body.errors.flatMap((e: { path: string[] }) => e.path);
    expect(paths).toContain('name');
    expect(paths).toContain('account_number');
    expect(createRecipientMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed JSON body', async () => {
    const res = await POST(makeRequest('not json{{{', true));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.message).toMatch(/invalid json/i);
    expect(createRecipientMock).not.toHaveBeenCalled();
  });

  it('returns 429 when the shared rate limiter rejects the request', async () => {
    applyRateLimitMock.mockReturnValueOnce(
      new Response(JSON.stringify({ success: false, retryAfter: 60 }), {
        status: 429,
      }) as never,
    );

    const res = await POST(makeRequest(VALID_BODY));

    expect(res.status).toBe(429);
    expect(createRecipientMock).not.toHaveBeenCalled();
  });

  it('returns 503 when provider outage circuit breaker is tripped', async () => {
    createRecipientMock.mockRejectedValue(
      new ProviderOutageError('Provider unavailable', 'OPEN', 30),
    );

    const res = await POST(verifiedRequest());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.success).toBe(false);
    expect(body.error).toBe('PROVIDER_OUTAGE');
  });

  it('does not echo bank identifiers from provider rejection responses', async () => {
    createRecipientMock.mockRejectedValueOnce({
      response: {
        status: 422,
        data: { message: 'Invalid account 0123456789 at bank 058' },
      },
    });

    const res = await POST(verifiedRequest());
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(JSON.stringify(body)).not.toContain('0123456789');
    expect(JSON.stringify(body)).not.toContain('058');
  });

  it('rejects cross-site hostile origins with 403', async () => {
    const hostileReq = makeRequest(VALID_BODY, false, {
      origin: 'https://evil-site.com',
      'sec-fetch-site': 'cross-site',
    });

    const res = await POST(hostileReq);
    expect(res.status).toBe(403);
  });
});
