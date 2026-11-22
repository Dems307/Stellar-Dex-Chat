import { NextRequest, NextResponse } from 'next/server';
import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { telemetry } from '@/lib/telemetry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { createRecipientSchema } from '@/lib/apiSchemas';
import { enforcePayoutRouteSecurity } from '@/lib/payout/security';
import {
  getProviderCircuitBreaker,
  handlePayoutApiError,
} from '@/lib/payout/circuitBreaker';
import { getOrCreateBeneficiary } from '@/lib/payout/beneficiaryStore';
import {
  extractOrGenerateCorrelationId,
  validationError,
  createPayoutErrorResponse,
} from '@/lib/payout/errors';
import { resolveCallerIdentity } from '@/lib/payout/auth';
import {
  getWalletIdentityScope,
  validateBeneficiaryVerification,
} from '@/lib/payout/beneficiaryVerification';

const RATE_LIMIT = { maxRequests: 5, windowMs: 60_000 };

export async function OPTIONS(request: NextRequest) {
  return (
    enforcePayoutRouteSecurity(request) ||
    new NextResponse(null, { status: 204 })
  );
}

export async function POST(request: NextRequest) {
  // 1. Enforce payout API security: Origin, Sec-Fetch-Site, CSRF, and explicit CORS
  const securityBlocked = enforcePayoutRouteSecurity(request);
  if (securityBlocked) return securityBlocked;
  const apiVersionBlocked = enforcePayoutApiVersion(request);
  if (apiVersionBlocked) return apiVersionBlocked;

  const ip = getClientIp(request);
  const correlationId = extractOrGenerateCorrelationId(request.headers);

  const limited = applyRateLimit(ip, '/api/create-recipient', RATE_LIMIT);
  if (limited) return limited;

  const traceContext = telemetry.extractTraceFromHeaders(request.headers);
  const span = telemetry.createSpan(
    'create-recipient',
    traceContext.spanId,
    traceContext.traceId,
  );

  try {
    telemetry.addLog(span.spanId, 'info', 'Starting recipient creation', {
      endpoint: '/api/create-recipient',
      correlationId,
    });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      telemetry.addLog(span.spanId, 'warn', 'Malformed JSON body', {
        correlationId,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Invalid JSON body',
      });

      return validationError({
        message: 'Invalid JSON in request body.',
        correlationId,
        code: 'MALFORMED_REQUEST',
      });
    }

    // Validate with strict server-side Zod schema
    const validationResult = createRecipientSchema.safeParse(body);

    if (!validationResult.success) {
      telemetry.addLog(span.spanId, 'warn', 'Zod validation failed', {
        errors: validationResult.error.issues.map(({ path, code }) => ({
          path,
          code,
        })),
        correlationId,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Validation failed',
      });

      return validationError({
        message: 'Validation failed',
        correlationId,
        issues: validationResult.error.issues,
      });
    }

    const {
      type,
      name,
      account_number,
      bank_code,
      currency,
      verificationToken,
    } = validationResult.data;

    const identity = await resolveCallerIdentity(request);
    const userScope = getWalletIdentityScope(identity);
    if (!userScope) {
      return createPayoutErrorResponse({
        status: 401,
        code: 'UNAUTHORIZED',
        userMessage:
          'A verified wallet session is required to create a recipient',
        category: 'authorization',
        retryable: false,
        correlationId,
      });
    }

    const verification = validateBeneficiaryVerification(verificationToken, {
      accountNumber: account_number,
      bankCode: bank_code,
      currency,
      identityScope: userScope,
      accountName: name,
    });
    if (!verification.valid) {
      const expired = verification.reason === 'expired';
      const changed = verification.reason === 'details_changed';
      return createPayoutErrorResponse({
        status: changed ? 409 : 403,
        code: changed
          ? 'BENEFICIARY_DETAILS_CHANGED'
          : expired
            ? 'BENEFICIARY_VERIFICATION_EXPIRED'
            : 'BENEFICIARY_VERIFICATION_REQUIRED',
        userMessage: changed
          ? 'Beneficiary details changed. Verify the account again before creating a recipient.'
          : expired
            ? 'Beneficiary verification expired. Verify the account again.'
            : 'Verify the beneficiary details before creating a recipient.',
        category: changed ? 'validation' : 'authorization',
        retryable: false,
        correlationId,
      });
    }

    telemetry.addLog(span.spanId, 'info', 'Request validated', {
      hasType: !!type,
      hasName: !!name,
      currency,
      correlationId,
    });

    const provider = getPayoutProvider();
    const breaker = getProviderCircuitBreaker(
      provider.name,
      'recipient_creation',
    );

    // Race-safe beneficiary resolution with circuit breaker protection
    const beneficiaryResult = await getOrCreateBeneficiary(
      {
        name,
        accountNumber: account_number,
        bankCode: bank_code,
        currency,
        userScope,
        type,
      },
      () =>
        breaker.execute(() =>
          provider.createRecipient({
            type,
            name,
            account_number,
            bank_code,
            currency,
          }),
        ),
    );

    telemetry.finishSpan(span.spanId, { success: true });

    const apiResponse = payoutSuccessResponse(
      {
        recipient_code: beneficiaryResult.recipientCode,
        name: beneficiaryResult.name,
        reused: beneficiaryResult.reused,
        recovered: beneficiaryResult.recovered,
      },
      { correlationId },
    );

    telemetry.setTraceHeaders(apiResponse.headers, traceContext);
    return apiResponse;
  } catch (error: unknown) {
    telemetry.addLog(
      span.spanId,
      'error',
      'Unhandled error in recipient creation',
      {
        errorType: error instanceof Error ? error.name : 'UnknownError',
        correlationId,
      },
    );

    const errorDetails = handlePayoutApiError(
      error,
      'Failed to create recipient. Please try again.',
    );
    const safeMessage =
      errorDetails.status >= 500
        ? 'Recipient creation is temporarily unavailable. Please try again.'
        : 'Failed to create recipient. Check the beneficiary details and try again.';

    telemetry.finishSpan(span.spanId, {
      success: false,
      error: safeMessage,
    });

    return NextResponse.json(
      {
        ...errorDetails.body,
        message: safeMessage,
      },
      {
        status: errorDetails.status,
        headers: errorDetails.headers,
      },
    );
  }
}
