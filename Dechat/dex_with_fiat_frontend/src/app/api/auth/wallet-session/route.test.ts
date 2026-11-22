import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { verifySignatureMock } = vi.hoisted(() => ({
  verifySignatureMock: vi.fn(),
}));

vi.mock('@/lib/stellarSignature', () => ({
  verifySignature: verifySignatureMock,
}));

const { POST } = await import('./route');

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost:3000/api/auth/wallet-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/wallet-session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns wallet and CSRF tokens after signature verification', async () => {
    verifySignatureMock.mockResolvedValue(true);
    const timestamp = Date.now();

    const response = await POST(
      makeRequest({
        address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        signature: 'valid-signature',
        timestamp,
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.address).toBe(
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    );
    expect(body.data.sessionToken).toBeTruthy();
    expect(body.data.csrfToken).toMatch(/^\d+\.[a-f0-9]{64}$/);
    expect(response.cookies.get('wallet_session')?.httpOnly).toBe(true);
    expect(verifySignatureMock).toHaveBeenCalledWith(
      `authenticate:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF:${timestamp}`,
      'valid-signature',
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    );
  });

  it('rejects invalid signatures without issuing a session', async () => {
    verifySignatureMock.mockResolvedValue(false);

    const response = await POST(
      makeRequest({
        address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
        signature: 'invalid-signature',
        timestamp: Date.now(),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.cookies.get('wallet_session')).toBeUndefined();
  });
});
