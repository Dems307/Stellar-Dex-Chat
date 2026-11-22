import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { sanitizeProviderError } from '@/lib/payout/timeoutBudget';
import { telemetry } from '@/lib/telemetry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { setTransferStatus } from '@/lib/transferStore';
import { initiateTransferSchema } from '@/lib/apiSchemas';
import { payoutAuditLedger } from '@/lib/payout/auditLedger';
import {
  payoutReservationLedger,
  PayoutReservationConflictError,
} from '@/lib/payout/reservationLedger';
import { ProviderIdempotencyReconciliationRequiredError } from '@/lib/payout/providerIdempotency';
import { payoutRetryQueue } from '@/lib/payout/retryQueue';
import { enforcePayoutRouteSecurity } from '@/lib/payout/security';
import {
  createPayoutErrorResponse,
  extractOrGenerateCorrelationId,
  logStructuredError,
  validationError,
} from '@/lib/payout/errors';
import { validatePayoutAmount } from '@/lib/payout/minorUnits';
import {
  verifyFxQuote,
  type FxQuoteTransferValues,
} from '@/lib/payout/fxQuoteProvenance';
import type { InitiatedTransfer } from '@/lib/payout/providers/types';
import { handlePayoutApiError } from '@/lib/payout/circuitBreaker';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT = ROUTE_COST_BUCKETS['/api/initiate-transfer'];
const idempotencyCache = new Map<
  string,
  { result: unknown; timestamp: number; requestFingerprint: string }
>();

function hashPayoutRequest(payload: {
  source: string;
  reason?: string;
  amountMinor: bigint;
  currency: string;
  recipient: string;
  contractReceiptId?: string;
}): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        ...payload,
        amountMinor: payload.amountMinor.toString(),
      }),
    )
    .digest('hex');
}

export async function OPTIONS(request: NextRequest) {
  return (
    enforcePayoutRouteSecurity(request) ||
    new NextResponse(null, { status: 204 })
  );
}

export async function POST(request: NextRequest) {
  const securityBlocked = enforcePayoutRouteSecurity(request);
  if (securityBlocked) return securityBlocked;
  const apiVersionBlocked = enforcePayoutApiVersion(request);
  if (apiVersionBlocked) return apiVersionBlocked;
  if (!request.headers.get('X-Idempotency-Key')) {
    return validationError({
      message: 'X-Idempotency-Key header is required',
      correlationId: extractOrGenerateCorrelationId(request.headers),
      code: 'VALIDATION_ERROR',
    });
  }

  const correlationId = extractOrGenerateCorrelationId(request.headers);
  const headerIdempotencyKey = request.headers.get('X-Idempotency-Key');
  if (!headerIdempotencyKey) {
    return validationError({
      message: 'X-Idempotency-Key header is required',
      correlationId,
    });
  }

  const ip = getClientIp(request);
  const limited = applyRateLimit(ip, '/api/initiate-transfer', RATE_LIMIT, {
    correlationId,
  });
  if (limited) return limited;

  const traceContext = telemetry.extractTraceFromHeaders(request.headers);
  const span = telemetry.createSpan(
    'initiate-transfer',
    traceContext.spanId,
    traceContext.traceId,
  );
  const idempotencyKey = headerIdempotencyKey;

  try {
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

    const bodyRecord =
      body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const headerIdempotencyKey = request.headers.get('X-Idempotency-Key');
    idempotencyKey =
      headerIdempotencyKey ||
      (typeof bodyRecord.reference === 'string' ? bodyRecord.reference : '');
    if (!idempotencyKey) {
      return validationError({
        message: 'X-Idempotency-Key header is required.',
        correlationId,
        code: 'INVALID_INPUT',
      });
    }

    const validationResult = initiateTransferSchema.safeParse(body);
    if (!validationResult.success) {
      return validationError({
        message: 'Validation failed',
        correlationId,
        issues: validationResult.error.issues.map((issue) => ({
          path: issue.path.filter(
            (segment): segment is string | number =>
              typeof segment !== 'symbol',
          ),
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    const {
      source,
      reason,
      amount,
      recipient,
      currency,
      quoteId,
      quoteToken,
      clientSessionId: bodyClientSessionId,
    } = validationResult.data;
    const clientSessionId =
      request.headers.get('x-client-session-id') || bodyClientSessionId;

    if (!quoteId || !quoteToken) {
      return createPayoutErrorResponse({
        status: 428,
        code: 'FX_QUOTE_REQUIRED',
        userMessage: 'A valid FX quote is required to initiate this payout.',
        category: 'validation',
        retryable: false,
        correlationId,
      });
    }

    const payoutCurrency = (currency || 'NGN').toUpperCase();
    const validatedAmount = validatePayoutAmount(amount, payoutCurrency);
    const requestFingerprint = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          source,
          reason: reason ?? null,
          amountMinorUnits: validatedAmount.amountMinor.toString(),
          currency: payoutCurrency,
          recipient,
          quoteId,
          quoteToken,
        }),
      )
      .digest('hex');
    const cached = idempotencyCache.get(idempotencyKey);
    if (cached && Date.now() - cached.timestamp < IDEMPOTENCY_TTL_MS) {
      if (cached.requestFingerprint !== requestFingerprint) {
        return createPayoutErrorResponse({
          status: 409,
          code: 'IDEMPOTENCY_CONFLICT',
          userMessage:
            'This idempotency key was already used with different payout details.',
          category: 'validation',
          retryable: false,
          correlationId,
        });
      }
      return NextResponse.json({ success: true, data: cached.result });
    }

    const verifiedQuote = verifyFxQuote(quoteToken);
    if (!verifiedQuote.valid) {
      const expired = verifiedQuote.reason === 'expired';
      return createPayoutErrorResponse({
        status: expired ? 410 : 409,
        code: expired ? 'FX_QUOTE_EXPIRED' : 'FX_QUOTE_MISMATCH',
        userMessage: expired
          ? 'The FX quote has expired. Request a new quote before continuing.'
          : 'The FX quote is invalid. Request a new quote before continuing.',
        category: expired ? 'validation' : 'authorization',
        retryable: false,
        correlationId,
      });
    }

    const quote = verifiedQuote.quote;
    if (
      quote.quoteId !== quoteId ||
      quote.currency !== payoutCurrency ||
      quote.precisionDecimals !== validatedAmount.exponent ||
      quote.fiatAmountMinorUnits !== validatedAmount.amountMinor.toString()
    ) {
      return createPayoutErrorResponse({
        status: 409,
        code: 'FX_QUOTE_MISMATCH',
        userMessage:
          'The payout amount or currency does not match the FX quote.',
        category: 'validation',
        retryable: false,
        correlationId,
      });
    }
    if (cached) idempotencyCache.delete(idempotencyKey);

    telemetry.addLog(span.spanId, 'info', 'Request validated', {
      hasSource: !!source,
      hasAmount: !!amount,
      hasRecipient: !!recipient,
      currency: payoutCurrency,
      amountMinorUnits: validatedAmount.amountMinor.toString(),
      quoteId: quote.quoteId,
      idempotencyKey,
    });

    if (Date.now() >= quote.expiresAt) {
      return createPayoutErrorResponse({
        status: 410,
        code: 'FX_QUOTE_EXPIRED',
        userMessage: 'The FX quote expired before payout submission.',
        category: 'validation',
        retryable: false,
        correlationId,
      });
    }

    const initialTransferValues: FxQuoteTransferValues = {
      amountMinorUnits: validatedAmount.amountMinor.toString(),
      providerAmountMinorUnits: validatedAmount.amountMinor.toString(),
      currency: payoutCurrency,
      providerReference: idempotencyKey,
      providerTransferId: null,
      providerTransferCode: null,
    };

    // Record immutable audit event for payout initiation (Issue #38)
    payoutAuditLedger.recordEvent({
      payoutId: idempotencyKey,
      action: 'payout_initiated',
      actor: clientSessionId ? `client:${clientSessionId}` : 'client:user',
      requestCorrelationId: traceContext.traceId,
      providerReference: idempotencyKey,
      metadata: {
        source,
        reason,
        fxQuote: quote,
        finalTransferValues: initialTransferValues,
        recipient,
      },
    });

    const provider = getPayoutProvider();
    try {
      if (Date.now() >= quote.expiresAt) {
        return createPayoutErrorResponse({
          status: 410,
          code: 'FX_QUOTE_EXPIRED',
          userMessage: 'The FX quote expired before payout submission.',
          category: 'validation',
          retryable: false,
          correlationId,
        });
      }

      const data: InitiatedTransfer = await provider.initiateTransfer({
        source,
        reason,
        amount: validatedAmount.canonicalDecimal,
        recipient,
        reference: idempotencyKey,
        idempotencyKey,
        currency,
        credentialVersion,
      });

      const transferReference =
        typeof data.reference === 'string' && data.reference
          ? data.reference
          : idempotencyKey;
      const providerReference =
        typeof data.providerReference === 'string' && data.providerReference
          ? data.providerReference
          : transferReference;
      const providerAmountMinorUnits =
        typeof data.amountMinor === 'bigint'
          ? data.amountMinor.toString()
          : typeof data.amountMinor === 'number' &&
              Number.isSafeInteger(data.amountMinor)
            ? String(data.amountMinor)
            : typeof data.amount === 'number' &&
                Number.isSafeInteger(data.amount)
              ? String(data.amount)
              : validatedAmount.amountMinor.toString();
      const finalTransferValues: FxQuoteTransferValues = {
        amountMinorUnits: validatedAmount.amountMinor.toString(),
        providerAmountMinorUnits,
        currency: payoutCurrency,
        providerReference,
        providerTransferId:
          data.id === undefined || data.id === null ? null : String(data.id),
        providerTransferCode: data.transfer_code ?? data.transferCode ?? null,
      };

      if (transferReference) {
        setTransferStatus({
          reference: transferReference,
          status: 'pending',
          amount: Number(validatedAmount.canonicalDecimal),
          amountMinor: validatedAmount.amountMinor,
          currency: payoutCurrency,
          fxQuote: quote,
          finalTransferValues,
          updatedAt: new Date().toISOString(),
          clientSessionId,
        });
      }

      payoutAuditLedger.recordEvent({
        payoutId: idempotencyKey,
        action: 'payout_provider_accepted',
        actor: `provider:${provider.name}`,
        requestCorrelationId: traceContext.traceId,
        providerReference,
        metadata: {
          fxQuote: quote,
          finalTransferValues,
          providerStatus: data.status ?? null,
        },
      });

      idempotencyCache.set(idempotencyKey, {
        result: data,
        payloadHash,
        timestamp: Date.now(),
        requestFingerprint,
      });

      return payoutSuccessResponse(data, { correlationId });
    } catch (providerError: unknown) {
      const now = Date.now();
      const errorMessage =
        providerError instanceof Error
          ? providerError.message
          : 'Unknown provider error';

      if (contractReceiptId) {
        payoutReservationLedger.markUnderReview(idempotencyKey);
      }

      const retryJob = payoutRetryQueue.enqueueJob({
        payoutId: idempotencyKey,
        idempotencyKey,
        payload: {
          source,
          amount: Number(validatedAmount.canonicalDecimal),
          recipient,
          reason,
          fxQuote: quote,
          amountMinorUnits: validatedAmount.amountMinor.toString(),
        },
        error: errorMessage,
        correlationId: traceContext.traceId,
      });

      setTransferStatus({
        reference: idempotencyKey,
        status: 'pending',
        amount: Number(validatedAmount.canonicalDecimal),
        amountMinor: validatedAmount.amountMinor,
        currency: payoutCurrency,
        fxQuote: quote,
        finalTransferValues: initialTransferValues,
        updatedAt: new Date(now).toISOString(),
        updatedAtMs: now,
        clientSessionId,
        failureReason: `Transfer outcome requires reconciliation: ${errorMessage}`,
      });

      return NextResponse.json(
        {
          reference: idempotencyKey,
          jobId: retryJob.id,
          message: 'Transfer queued for retry due to provider uncertainty',
        },
        {
          status: 202,
          correlationId,
          extra: {
            status: 'queued_for_retry',
            reference: idempotencyKey,
            jobId: retryJob.id,
            message: 'Transfer queued for retry due to provider failure',
          },
        },
      );
    }
  } catch (error: unknown) {
    logStructuredError('initiate-transfer', error, {
      endpoint: '/api/initiate-transfer',
      correlationId,
      ip,
    });
    Sentry.captureException(error, {
      tags: {
        endpoint: '/api/initiate-transfer',
        operation: 'transfer_initiation',
      },
      extra: { ip, correlationId, traceId: traceContext.traceId },
    });
    telemetry.addLog(span.spanId, 'error', 'Transfer initiation failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      idempotencyKey,
    });
    const errorDetails = handlePayoutApiError(
      error,
      'Failed to initiate transfer. Please try again.',
    );
    telemetry.finishSpan(span.spanId, {
      success: false,
      error: errorDetails.body.message,
    });
    return NextResponse.json(errorDetails.body, {
      status: errorDetails.status,
      headers: errorDetails.headers,
    });
  }
}
