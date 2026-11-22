import { describe, expect, it } from 'vitest';
import {
  calculateFxAmountMinorUnits,
  createFxQuoteRecord,
  signFxQuote,
  verifyFxQuote,
} from './fxQuoteProvenance';

const SECRET = 'unit-test-fx-quote-secret-with-more-than-32-chars';

function makeQuote(expiresAt = 121_000) {
  return createFxQuoteRecord({
    quoteId: '01234567-89ab-4cde-8fab-0123456789ab',
    provider: 'coingecko',
    providerRequestId: '11234567-89ab-4cde-8fab-0123456789ab',
    providerResponseId: 'provider-response-1',
    source: 'live',
    asset: 'XLM',
    amount: '1',
    currency: 'NGN',
    exchangeRate: '150.005',
    quotedAt: 1_000,
    expiresAt,
    precisionDecimals: 2,
    stale: false,
  });
}

describe('FX quote provenance', () => {
  it('uses integer arithmetic and half-up rounding at the minor-unit boundary', () => {
    expect(calculateFxAmountMinorUnits('1', '1.005', 2)).toBe('101');
    expect(calculateFxAmountMinorUnits('1', '1.0049', 2)).toBe('100');
    expect(calculateFxAmountMinorUnits('1e-7', '1500', 2)).toBe('0');
  });

  it('verifies signed immutable quote data and rejects tampering', () => {
    const quote = makeQuote();
    const token = signFxQuote(quote, SECRET);

    expect(verifyFxQuote(token, SECRET, 120_999)).toEqual({
      valid: true,
      quote,
    });

    const [payload, signature] = token.split('.');
    const alteredSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    expect(
      verifyFxQuote(`${payload}.${alteredSignature}`, SECRET, 120_999),
    ).toEqual({ valid: false, reason: 'invalid' });
  });

  it('rejects quotes at their expiry boundary', () => {
    const token = signFxQuote(makeQuote(121_000), SECRET);

    expect(verifyFxQuote(token, SECRET, 121_000)).toEqual({
      valid: false,
      reason: 'expired',
    });
  });
});
