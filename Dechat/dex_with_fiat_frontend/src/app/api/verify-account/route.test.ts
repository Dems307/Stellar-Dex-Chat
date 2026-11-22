import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  ProviderOutageError,
  resetCircuitBreakers,
} from '@/lib/payout/circuitBreaker';
import { createWalletSessionToken } from '@/lib/payout/auth';

vi.mock('server-only', () => ({}));

const applyRateLimitMock = vi.fn(() => null);

vi.mock('@/lib/rateLimit', () => ({
  applyRateLimit: () => applyRateLimitMock(),
  getClientIp: () => '127.0.0.1',
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

const mockVerifyAccount = vi.fn().mockResolvedValue({
  account_number: '0123456789',
  account_name: 'Jane Doe',
  bank_id: 58,
});

vi.mock('@/lib/payout/providers/registry', () => ({
  getPayoutProvider: () => ({
    name: 'paystack',
    verifyAccount: mockVerifyAccount,
  }),
}));

const { POST } = await import('./route');
const WALLET_SESSION = createWalletSessionToken(
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
).sessionToken;

function makeRequest(body: unknown, extraHeaders: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/api/verify-account', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      'sec-fetch-site': 'same-origin',
      'x-wallet-session': WALLET_SESSION,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/verify-account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCircuitBreakers();
    applyRateLimitMock.mockReturnValue(null);
    mockVerifyAccount.mockResolvedValue({
      account_number: '0123456789',
      account_name: 'Jane Doe',
      bank_id: 58,
    });
  });

  it('verifies account, binds authorization, and omits full bank identifiers', async () => {
    const res = await POST(
      makeRequest({ accountNumber: '0123456789', bankCode: '058' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.account_name).toBe('Jane Doe');
    expect(body.data.accountNumberMasked).toBe('******6789');
    expect(body.data.verificationToken).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('0123456789');
    expect(body.data.bankCode).toBeUndefined();
  });

  it('requires an authenticated wallet before calling the provider', async () => {
    const res = await POST(
      makeRequest(
        { accountNumber: '0123456789', bankCode: '058' },
        { 'x-wallet-session': '' },
      ),
    );
    expect(res.status).toBe(401);
    expect(mockVerifyAccount).not.toHaveBeenCalled();
  });

  it('returns 503 when provider outage occurs', async () => {
    mockVerifyAccount.mockRejectedValue(
      new ProviderOutageError('Paystack service unavailable', 'OPEN', 30),
    );

    const res = await POST(
      makeRequest({ accountNumber: '0123456789', bankCode: '058' }),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('PROVIDER_OUTAGE');
  });

  it('returns 400 when account resolution fails permanently (rejection)', async () => {
    const rejectionError = {
      isAxiosError: true,
      response: {
        status: 422,
        data: { message: 'Could not resolve 0123456789 at bank 058' },
      },
    };
    mockVerifyAccount.mockRejectedValue(rejectionError);

    const res = await POST(
      makeRequest({ accountNumber: '0000000000', bankCode: '058' }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('PAYOUT_REJECTED');
    expect(body.message).toBe(
      'Account verification failed. Check the details and try again.',
    );
    expect(JSON.stringify(body)).not.toContain('0123456789');
    expect(JSON.stringify(body)).not.toContain('058');
  });

  it('rejects cross-site hostile origin requests with 403', async () => {
    const hostileReq = makeRequest(
      { accountNumber: '0123456789', bankCode: '058' },
      {
        origin: 'https://attacker.com',
        'sec-fetch-site': 'cross-site',
      },
    );

    const res = await POST(hostileReq);
    expect(res.status).toBe(403);
  });
});
