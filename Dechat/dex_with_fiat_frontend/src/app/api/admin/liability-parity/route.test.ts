import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockRequireAdminAuth = vi.fn();
const mockEnforceAdminIpAllowlist = vi.fn();
const mockCollectSources = vi.fn();

vi.mock('@/app/api/admin/_utils/requireAdminAuth', () => ({
  requireAdminAuth: (request: unknown) => mockRequireAdminAuth(request),
}));

vi.mock('@/lib/security', () => ({
  enforceAdminIpAllowlist: (request: unknown) =>
    mockEnforceAdminIpAllowlist(request),
}));

vi.mock('@/lib/payout/liabilityParitySources', () => ({
  collectLiabilityParitySources: (options: unknown) => mockCollectSources(options),
}));

const { GET, POST } = await import('./route');

const sources = {
  liabilities: [
    {
      receiptId: 'syn_receipt_1',
      asset: 'CSYNTHETICXLMTOKEN',
      amountMinor: '1000',
      status: 'active' as const,
    },
  ],
  reservations: [
    {
      payoutId: 'syn_payout_1',
      receiptId: 'syn_receipt_1',
      asset: 'CSYNTHETICXLMTOKEN',
      amountMinor: '900',
      status: 'reserved' as const,
    },
  ],
  assetAliases: { CSYNTHETICXLMTOKEN: 'XLM' },
  sourceTruncated: false,
};

function request(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(new Request(url, init));
}

describe('/api/admin/liability-parity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdminAuth.mockReturnValue(null);
    mockEnforceAdminIpAllowlist.mockReturnValue(null);
    mockCollectSources.mockResolvedValue(sources);
  });

  it('rejects unauthenticated GET requests before reading parity sources', async () => {
    mockRequireAdminAuth.mockReturnValue(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );

    const response = await GET(request('http://localhost/api/admin/liability-parity'));

    expect(response.status).toBe(401);
    expect(mockCollectSources).not.toHaveBeenCalled();
  });

  it('rejects IP-blocked requests before reading parity sources', async () => {
    mockEnforceAdminIpAllowlist.mockReturnValue(
      Response.json({ error: 'Forbidden' }, { status: 403 }),
    );

    const response = await GET(request('http://localhost/api/admin/liability-parity'));

    expect(response.status).toBe(403);
    expect(mockRequireAdminAuth).not.toHaveBeenCalled();
    expect(mockCollectSources).not.toHaveBeenCalled();
  });

  it('returns a read-only report with asset and receipt filters', async () => {
    const response = await GET(
      request(
        'http://localhost/api/admin/liability-parity?asset=XLM&receiptId=syn_receipt_1&pageSize=25&maxPages=2',
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockCollectSources).toHaveBeenCalledWith({
      pageSize: 25,
      maxPages: 2,
    });
    expect(body.readOnly).toBe(true);
    expect(body.correctionsApplied).toBe(0);
    expect(body.mismatches).toHaveLength(1);
    expect(body.mismatches[0]).toMatchObject({
      asset: 'XLM',
      receiptId: 'syn_receipt_1',
      type: 'AMOUNT_MISMATCH',
      deltaMinor: '100',
    });
  });

  it('rejects invalid pagination parameters', async () => {
    const response = await GET(
      request('http://localhost/api/admin/liability-parity?pageSize=0'),
    );

    expect(response.status).toBe(400);
    expect(mockCollectSources).not.toHaveBeenCalled();
  });

  it('compares a supplied snapshot without mutating it or calling ledger sources', async () => {
    const body = Object.freeze({
      liabilities: Object.freeze([
        Object.freeze({
          receiptId: 'syn_receipt_9',
          asset: 'XLM',
          amountMinor: '500',
          status: 'active',
        }),
      ]),
      reservations: Object.freeze([
        Object.freeze({
          payoutId: 'syn_payout_9',
          receiptId: 'syn_receipt_9',
          asset: 'XLM',
          amountMinor: '500',
          status: 'reserved',
        }),
      ]),
    });

    const response = await POST(
      request('http://localhost/api/admin/liability-parity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    const report = await response.json();

    expect(response.status).toBe(200);
    expect(report.ok).toBe(true);
    expect(report.readOnly).toBe(true);
    expect(report.correctionsApplied).toBe(0);
    expect(mockCollectSources).not.toHaveBeenCalled();
  });

  it('rejects malformed snapshot bodies', async () => {
    const missingArrays = await POST(
      request('http://localhost/api/admin/liability-parity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ liabilities: [] }),
      }),
    );
    const invalidJson = await POST(
      request('http://localhost/api/admin/liability-parity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      }),
    );

    expect(missingArrays.status).toBe(400);
    expect(invalidJson.status).toBe(400);
    expect(mockCollectSources).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated POST requests', async () => {
    mockRequireAdminAuth.mockReturnValue(
      Response.json({ error: 'Unauthorized' }, { status: 401 }),
    );

    const response = await POST(
      request('http://localhost/api/admin/liability-parity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ liabilities: [], reservations: [] }),
      }),
    );

    expect(response.status).toBe(401);
  });
});
