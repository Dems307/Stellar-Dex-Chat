import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import {
  enforcePayoutApiVersion,
  payoutSuccessResponse,
  resolvePayoutApiVersion,
} from './schemaEvolution';

describe('payout API schema evolution', () => {
  it('defaults missing version headers to v1 for older clients', () => {
    expect(resolvePayoutApiVersion(new Headers()).supported).toBe(true);
  });

  it('accepts v1 aliases and rejects unsupported versions with a stable code', async () => {
    expect(
      resolvePayoutApiVersion(new Headers({ 'X-API-Version': '1' }))
        .supported,
    ).toBe(true);
    expect(
      resolvePayoutApiVersion(new Headers({ 'X-API-Version': 'v2' }))
        .supported,
    ).toBe(false);

    const request = new NextRequest(
      'http://localhost/api/initiate-transfer',
      {
        method: 'POST',
        headers: { 'X-API-Version': 'v2' },
      },
    );
    const response = enforcePayoutApiVersion(request);
    expect(response?.status).toBe(406);
    const body = await response?.json();
    expect(body.error.code).toBe('UNSUPPORTED_API_VERSION');
  });

  it('adds a versioned success envelope and API headers', async () => {
    const response = payoutSuccessResponse(
      { reference: 'payout-ref' },
      { correlationId: 'cid-test' },
    );
    expect(response.headers.get('X-API-Version')).toBe('v1');
    expect(response.headers.get('X-Correlation-Id')).toBe('cid-test');
    expect(await response.json()).toEqual({
      version: 'v1',
      success: true,
      data: { reference: 'payout-ref' },
    });
  });
});
