import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  getTokenPriceWithStatus,
  QUOTE_LOCK_DURATION_MS,
} from '@/lib/cryptoPriceService';
import {
  fxQuoteRequestSchema,
  MAX_TRANSFER_AMOUNT_NGN,
} from '@/lib/apiSchemas';
import { payoutAuditLedger } from '@/lib/payout/auditLedger';
import {
  createFxQuoteRecord,
  signFxQuote,
} from '@/lib/payout/fxQuoteProvenance';
import { enforcePayoutRouteSecurity } from '@/lib/payout/security';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import {
  createPayoutErrorResponse,
  extractOrGenerateCorrelationId,
  logStructuredError,
  validationError,
} from '@/lib/payout/errors';

const RATE_LIMIT = { maxRequests: 10, windowMs: 60_000 };

export async function OPTIONS(request: NextRequest) {
  return (
    enforcePayoutRouteSecurity(request) ||
    new NextResponse(null, { status: 204 })
  );
}

export async function POST(request: NextRequest) {
  const securityBlocked = enforcePayoutRouteSecurity(request);
  if (securityBlocked) return securityBlocked;

  const correlationId = extractOrGenerateCorrelationId(request.headers);
  const limited = applyRateLimit(
    getClientIp(request),
    '/api/fx-quote',
    RATE_LIMIT,
  );
  if (limited) return limited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError({
      message: 'Invalid JSON in request body.',
      correlationId,
      code: 'MALFORMED_REQUEST',
    });
  }

  const validation = fxQuoteRequestSchema.safeParse(body);
  if (!validation.success) {
    return validationError({
      message: 'Invalid FX quote request.',
      correlationId,
      issues: validation.error.issues,
    });
  }

  const { tokenSymbol, tokenAmount, currency } = validation.data;
  const providerRequestId = randomUUID();

  try {
    const price = await getTokenPriceWithStatus(tokenSymbol, currency);
    if (!Number.isFinite(price.price) || price.price <= 0) {
      return createPayoutErrorResponse({
        status: 503,
        code: 'FX_QUOTE_UNAVAILABLE',
        userMessage: 'A current FX quote is unavailable. Please try again.',
        category: 'provider',
        retryable: true,
        correlationId,
      });
    }

    const quotedAt = Date.now();
    const quote = createFxQuoteRecord({
      quoteId: randomUUID(),
      provider: 'coingecko',
      providerRequestId,
      providerResponseId: price.providerResponseId,
      source: price.source,
      asset: tokenSymbol,
      amount: String(tokenAmount),
      currency,
      exchangeRate: String(price.price),
      quotedAt,
      expiresAt: quotedAt + QUOTE_LOCK_DURATION_MS,
      precisionDecimals: 2,
      stale: price.stale,
    });
    const fiatAmountMinorUnits = BigInt(quote.fiatAmountMinorUnits);
    if (
      fiatAmountMinorUnits <= 0n ||
      fiatAmountMinorUnits >
        BigInt(MAX_TRANSFER_AMOUNT_NGN) * 10n ** BigInt(quote.precisionDecimals)
    ) {
      return createPayoutErrorResponse({
        status: 400,
        code: 'INVALID_INPUT',
        userMessage: 'The quoted payout amount is outside supported limits.',
        category: 'validation',
        retryable: false,
        correlationId,
      });
    }

    const quoteToken = signFxQuote(quote);
    const ngnAmount =
      Number(quote.fiatAmountMinorUnits) / 10 ** quote.precisionDecimals;

    payoutAuditLedger.recordEvent({
      payoutId: quote.quoteId,
      action: 'fx_quote_created',
      actor: 'system:fx_quote',
      requestCorrelationId: correlationId,
      providerReference: quote.providerResponseId ?? quote.providerRequestId,
      metadata: { quote },
      timestamp: new Date(quotedAt).toISOString(),
    });

    return NextResponse.json({
      success: true,
      data: {
        ...quote,
        quoteToken,
        ngnAmount,
        lockedAt: quotedAt,
      },
    });
  } catch (error: unknown) {
    logStructuredError('fx-quote', error, { correlationId });
    return createPayoutErrorResponse({
      status: 503,
      code: 'FX_QUOTE_UNAVAILABLE',
      userMessage: 'A current FX quote is unavailable. Please try again.',
      category: 'provider',
      retryable: true,
      correlationId,
    });
  }
}
