import { NextRequest, NextResponse } from 'next/server';
import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { telemetry } from '@/lib/telemetry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { verifyAccountSchema } from '@/lib/apiSchemas';
import { enforcePayoutRouteSecurity } from '@/lib/payout/security';
import {
  getProviderCircuitBreaker,
  handlePayoutApiError,
} from '@/lib/payout/circuitBreaker';
import {
  extractOrGenerateCorrelationId,
  validationError,
  authorizationError,
} from '@/lib/payout/errors';
import { resolveCallerIdentity } from '@/lib/payout/auth';
import {
  getWalletIdentityScope,
  issueBeneficiaryVerification,
} from '@/lib/payout/beneficiaryVerification';

const RATE_LIMIT = { maxRequests: 10, windowMs: 60_000 };

export async function OPTIONS(request: NextRequest) {
  return (
    enforcePayoutRouteSecurity(request) ||
    new NextResponse(null, { status: 204 })
  );
}

export async function POST(request: NextRequest) {
  // Enforce payout API security
  const securityBlocked = enforcePayoutRouteSecurity(request);
  if (securityBlocked) return securityBlocked;
  const apiVersionBlocked = enforcePayoutApiVersion(request);
  if (apiVersionBlocked) return apiVersionBlocked;

  const ip = getClientIp(request);
  const correlationId = extractOrGenerateCorrelationId(request.headers);

  const limited = applyRateLimit(ip, '/api/verify-account', RATE_LIMIT);
  if (limited) return limited;

  const traceContext = telemetry.extractTraceFromHeaders(request.headers);
  const span = telemetry.createSpan(
    'verify-account',
    traceContext.spanId,
    traceContext.traceId,
  );

  try {
    const identity = await resolveCallerIdentity(request);
    const identityScope = getWalletIdentityScope(identity);
    if (!identityScope) {
      return authorizationError({
        status: 401,
        message:
          'A verified wallet session is required to verify payout details',
        correlationId,
      });
    }

    telemetry.addLog(span.spanId, 'info', 'Starting account verification', {
      endpoint: '/api/verify-account',
      correlationId,
    });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      telemetry.addLog(span.spanId, 'warn', 'Request body is not valid JSON', {
        endpoint: '/api/verify-account',
        correlationId,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Invalid JSON body',
      });

      return validationError({
        message: 'Request body must be valid JSON',
        correlationId,
        code: 'MALFORMED_REQUEST',
      });
    }

    // Validate with strict server-side Zod schema
    const validationResult = verifyAccountSchema.safeParse(body);

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

    const { accountNumber, bankCode } = validationResult.data;

    telemetry.addLog(span.spanId, 'info', 'Request validated', {
      hasAccountNumber: !!accountNumber,
      hasBankCode: !!bankCode,
      correlationId,
    });

    const provider = getPayoutProvider();
    const breaker = getProviderCircuitBreaker(
      provider.name,
      'account_verification',
    );

    const data = await breaker.execute(() =>
      provider.verifyAccount({ accountNumber, bankCode }),
    );
    const accountName =
      'accountName' in data && typeof data.accountName === 'string'
        ? data.accountName
        : 'account_name' in data && typeof data.account_name === 'string'
          ? data.account_name
          : '';
    if (!accountName) {
      throw new Error('Verification provider returned no account name');
    }

    const authorization = issueBeneficiaryVerification({
      accountNumber,
      bankCode,
      currency: 'NGN',
      identityScope,
      accountName,
    });

    telemetry.finishSpan(span.spanId, { success: true });

    const apiResponse = NextResponse.json({
      success: true,
      data: {
        account_name: accountName,
        accountNumberMasked: authorization.accountNumberMasked,
        verificationToken: authorization.verificationToken,
        verificationExpiresAt: authorization.expiresAt,
      },
    });
    apiResponse.headers.set('X-Correlation-Id', correlationId);
    telemetry.setTraceHeaders(apiResponse.headers, traceContext);
    return apiResponse;
  } catch (error: unknown) {
    telemetry.addLog(
      span.spanId,
      'error',
      'Unhandled error in account verification',
      {
        errorType: error instanceof Error ? error.name : 'UnknownError',
        correlationId,
      },
    );

    const errorDetails = handlePayoutApiError(
      error,
      'Account verification failed. Check the details and try again.',
    );
    const safeMessage =
      errorDetails.status >= 500
        ? 'Account verification is temporarily unavailable. Please try again.'
        : 'Account verification failed. Check the details and try again.';

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
