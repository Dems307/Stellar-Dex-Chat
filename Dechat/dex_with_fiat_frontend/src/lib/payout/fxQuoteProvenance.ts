import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * FX Quote Provenance and Payout Amount Breakdowns
 * Addresses Issue #102: Make quote, fee, and rounding decisions explainable after settlement.
 */

export const FX_QUOTE_TTL_MS = 120_000;
export const FX_QUOTE_ROUNDING_POLICY = 'HALF_UP_TO_MINOR_UNIT' as const;

export interface FxQuoteRecord {
  quoteId: string;
  provider: string;
  providerRequestId: string;
  providerResponseId: string | null;
  source: string;
  pair: string;
  tokenAmountDecimal: string;
  currency: string;
  exchangeRateDecimal: string;
  fiatAmountMinorUnits: string;
  roundingPolicy: typeof FX_QUOTE_ROUNDING_POLICY;
  quotedAt: number;
  expiresAt: number;
  precisionDecimals: number;
  stale: boolean;
}

export interface FxQuoteTransferValues {
  amountMinorUnits: string;
  providerAmountMinorUnits: string;
  currency: string;
  providerReference: string;
  providerTransferId: string | null;
  providerTransferCode: string | null;
}

export interface AmountBreakdown {
  currency: string;
  grossMinorUnits: bigint;
  bridgeFeeMinorUnits: bigint;
  providerFeeMinorUnits: bigint;
  netMinorUnits: bigint;
}

export interface PayoutProvenanceSnapshot {
  snapshotId: string;
  quote: FxQuoteRecord;
  breakdown: AmountBreakdown;
  createdOn: number;
}

export interface CreateFxQuoteInput {
  quoteId: string;
  provider: string;
  providerRequestId: string;
  providerResponseId: string | null;
  source: string;
  asset: string;
  amount: string;
  currency: string;
  exchangeRate: string;
  quotedAt: number;
  expiresAt: number;
  precisionDecimals: number;
  stale: boolean;
}

const FxQuoteRecordSchema = z
  .object({
    quoteId: z.string().uuid(),
    provider: z.string().min(1).max(64),
    providerRequestId: z.string().uuid(),
    providerResponseId: z.union([z.string().max(256), z.null()]).default(null),
    source: z.string().min(1).max(64),
    pair: z.string().regex(/^[A-Z0-9]+\/[A-Z]{3}$/),
    tokenAmountDecimal: z.string().regex(/^\d+(?:\.\d{1,7})?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    exchangeRateDecimal: z.string().regex(/^\d+(?:\.\d{1,18})?$/),
    fiatAmountMinorUnits: z.string().regex(/^\d+$/),
    roundingPolicy: z.literal(FX_QUOTE_ROUNDING_POLICY),
    quotedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    precisionDecimals: z.number().int().min(0).max(3),
    stale: z.boolean(),
  })
  .strict();

function parsePositiveDecimal(value: string): {
  coefficient: bigint;
  scale: number;
} {
  const normalized = normalizeDecimal(value);
  if (!/^\d+(?:\.\d+)?$/.test(normalized) || normalized.length > 64) {
    throw new Error('FX quote contains an invalid decimal value');
  }

  const [whole, fraction = ''] = normalized.split('.');
  const coefficient = BigInt(`${whole}${fraction}`);
  if (coefficient <= 0n) {
    throw new Error('FX quote decimal values must be positive');
  }

  return { coefficient, scale: fraction.length };
}

function normalizeDecimal(value: string): string {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match) {
    throw new Error('FX quote contains an invalid decimal value');
  }

  const integer = match[1];
  const fraction = match[2] ?? '';
  const exponent = Number(match[3] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 32) {
    throw new Error('FX quote decimal exponent is out of range');
  }

  const digits = `${integer}${fraction}`;
  const decimalIndex = integer.length + exponent;
  const expanded =
    decimalIndex <= 0
      ? `0.${'0'.repeat(-decimalIndex)}${digits}`
      : decimalIndex >= digits.length
        ? `${digits}${'0'.repeat(decimalIndex - digits.length)}`
        : `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  const [wholePart, fractionPart] = expanded.split('.');
  const normalizedWhole = wholePart.replace(/^0+(?=\d)/, '');
  const normalizedFraction = fractionPart?.replace(/0+$/, '');
  const normalized = normalizedFraction
    ? `${normalizedWhole}.${normalizedFraction}`
    : normalizedWhole;

  if (normalized.length > 64) {
    throw new Error('FX quote decimal value is out of range');
  }
  return normalized;
}

export function calculateFxAmountMinorUnits(
  tokenAmountDecimal: string,
  exchangeRateDecimal: string,
  precisionDecimals: number,
): string {
  if (
    !Number.isInteger(precisionDecimals) ||
    precisionDecimals < 0 ||
    precisionDecimals > 3
  ) {
    throw new Error('FX quote currency precision is invalid');
  }

  const amount = parsePositiveDecimal(tokenAmountDecimal);
  const rate = parsePositiveDecimal(exchangeRateDecimal);
  const denominator = 10n ** BigInt(amount.scale + rate.scale);
  const scaledNumerator =
    amount.coefficient * rate.coefficient * 10n ** BigInt(precisionDecimals);

  return ((scaledNumerator * 2n + denominator) / (denominator * 2n)).toString();
}

export function createFxQuoteRecord(input: CreateFxQuoteInput): FxQuoteRecord {
  const currency = input.currency.toUpperCase();
  const asset = input.asset.toUpperCase();
  const tokenAmountDecimal = normalizeDecimal(input.amount);
  const exchangeRateDecimal = normalizeDecimal(input.exchangeRate);
  const quote: FxQuoteRecord = {
    quoteId: input.quoteId,
    provider: input.provider,
    providerRequestId: input.providerRequestId,
    providerResponseId: input.providerResponseId,
    source: input.source,
    pair: `${asset}/${currency}`,
    tokenAmountDecimal,
    currency,
    exchangeRateDecimal,
    fiatAmountMinorUnits: calculateFxAmountMinorUnits(
      tokenAmountDecimal,
      exchangeRateDecimal,
      input.precisionDecimals,
    ),
    roundingPolicy: FX_QUOTE_ROUNDING_POLICY,
    quotedAt: input.quotedAt,
    expiresAt: input.expiresAt,
    precisionDecimals: input.precisionDecimals,
    stale: input.stale,
  };

  return FxQuoteRecordSchema.parse(quote);
}

function getFxQuoteSecret(secret?: string): string {
  const configuredSecret = secret ?? process.env.PAYOUT_FX_QUOTE_SECRET;
  if (!configuredSecret && process.env.NODE_ENV === 'production') {
    throw new Error('PAYOUT_FX_QUOTE_SECRET must be configured in production');
  }

  const value =
    configuredSecret ?? 'local-fx-quote-signing-secret-not-for-production';
  if (value.length < 32) {
    throw new Error('PAYOUT_FX_QUOTE_SECRET must be at least 32 characters');
  }
  return value;
}

export function signFxQuote(quote: FxQuoteRecord, secret?: string): string {
  const payload = Buffer.from(
    JSON.stringify(FxQuoteRecordSchema.parse(quote)),
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', getFxQuoteSecret(secret))
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

export type FxQuoteVerification =
  | { valid: true; quote: FxQuoteRecord }
  | { valid: false; reason: 'invalid' | 'expired' };

export function verifyFxQuote(
  token: string,
  secret?: string,
  now = Date.now(),
): FxQuoteVerification {
  const [payload, receivedSignature, extra] = token.split('.');
  if (!payload || !receivedSignature || extra !== undefined) {
    return { valid: false, reason: 'invalid' };
  }

  try {
    const expectedSignature = crypto
      .createHmac('sha256', getFxQuoteSecret(secret))
      .update(payload)
      .digest();
    const actualSignature = Buffer.from(receivedSignature, 'base64url');
    if (
      actualSignature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(actualSignature, expectedSignature)
    ) {
      return { valid: false, reason: 'invalid' };
    }

    const parsedPayload: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    const result = FxQuoteRecordSchema.safeParse(parsedPayload);
    if (
      !result.success ||
      result.data.expiresAt <= result.data.quotedAt ||
      result.data.expiresAt - result.data.quotedAt > FX_QUOTE_TTL_MS ||
      calculateFxAmountMinorUnits(
        result.data.tokenAmountDecimal,
        result.data.exchangeRateDecimal,
        result.data.precisionDecimals,
      ) !== result.data.fiatAmountMinorUnits
    ) {
      return { valid: false, reason: 'invalid' };
    }
    if (now >= result.data.expiresAt) {
      return { valid: false, reason: 'expired' };
    }

    return { valid: true, quote: result.data };
  } catch {
    return { valid: false, reason: 'invalid' };
  }
}

/**
 * Validates quote expiry and calculates exact integer minor unit breakdown.
 */
export function calculatePayoutBreakdown(
  grossAmount: number,
  currency: string,
  quote: FxQuoteRecord,
  feePercentage: number = 0.015, // 1.5% fee
): { isValid: boolean; snapshot?: PayoutProvenanceSnapshot; error?: string } {
  const now = Date.now();
  if (now > quote.expiresAt) {
    return {
      isValid: false,
      error: 'FX Quote has expired. Please refresh quotes before proceeding.',
    };
  }

  // Integer arithmetic in minor units (e.g. kobo for NGN or cents for USD: 2 decimals)
  const multiplier = BigInt(10 ** quote.precisionDecimals);
  const grossMinor = BigInt(Math.round(grossAmount * 100));
  const bridgeFeeMinor =
    (grossMinor * BigInt(Math.round(feePercentage * 1000))) / BigInt(1000);
  const providerFeeMinor = BigInt(5000); // Flat provider fee in minor units (50.00)
  const netMinor = grossMinor - bridgeFeeMinor - providerFeeMinor;

  if (netMinor <= BigInt(0)) {
    return {
      isValid: false,
      error: 'Gross payout amount is too small to cover fees.',
    };
  }

  const breakdown: AmountBreakdown = {
    currency,
    grossMinorUnits: grossMinor,
    bridgeFeeMinorUnits: bridgeFeeMinor,
    providerFeeMinorUnits: providerFeeMinor,
    netMinorUnits: netMinor,
  };

  const snapshot: PayoutProvenanceSnapshot = {
    snapshotId: `snap_${quote.quoteId}_${now}`,
    quote,
    breakdown,
    createdOn: now,
  };

  return { isValid: true, snapshot };
}
