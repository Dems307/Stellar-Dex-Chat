import { NextRequest, NextResponse } from 'next/server';
import {
  API_VERSION,
  API_VERSION_HEADER,
  SUPPORTED_API_VERSIONS,
  createPayoutErrorResponse,
  extractOrGenerateCorrelationId,
} from './errors';

export const PAYOUT_API_VERSION = API_VERSION;
export const SUPPORTED_PAYOUT_API_VERSIONS = SUPPORTED_API_VERSIONS;
export const PAYOUT_API_VERSION_HEADER = API_VERSION_HEADER;

export interface PayoutApiVersionResult {
  version: typeof API_VERSION;
  requested?: string;
  supported: boolean;
}

function normalizeVersion(value: string): string {
  const trimmed = value.trim();
  if (/^(?:v)?1(?:\.0)?$/i.test(trimmed)) return 'v1';
  return trimmed.toLowerCase();
}

export function resolvePayoutApiVersion(
  headers: Headers,
): PayoutApiVersionResult {
  const explicit =
    headers.get(API_VERSION_HEADER) ||
    headers.get('api-version') ||
    headers.get('x-schema-version');

  let acceptVersion: string | null = null;
  const accept = headers.get('accept');
  if (accept) {
    const match = accept.match(
      /application\/(?:vnd\.stellar-dex-chat\.payout\.|stellar-dex-chat\.payout-)?v([0-9]+(?:\.[0-9]+)?)(?:\+json)?/i,
    );
    if (match) acceptVersion = `v${match[1]}`;
  }

  const requested = explicit || acceptVersion;
  if (!requested) return { version: API_VERSION, supported: true };

  const normalized = normalizeVersion(requested);
  if (normalized !== API_VERSION) {
    return { version: API_VERSION, requested, supported: false };
  }
  return { version: API_VERSION, requested, supported: true };
}

export function negotiatePayoutApiVersion(
  request: Pick<NextRequest, 'headers'>,
): PayoutApiVersionResult {
  return resolvePayoutApiVersion(request.headers);
}

export function unsupportedPayoutApiVersionResponse(
  request: NextRequest,
  result: PayoutApiVersionResult,
): NextResponse {
  const correlationId = extractOrGenerateCorrelationId(request.headers);
  return createPayoutErrorResponse({
    status: 406,
    code: 'UNSUPPORTED_API_VERSION',
    userMessage: `Unsupported payout API schema version: ${result.requested}. Supported versions: ${SUPPORTED_API_VERSIONS.join(', ')}.`,
    category: 'validation',
    retryable: false,
    correlationId,
    details: [
      {
        field: 'apiVersion',
        message: `Use ${API_VERSION_HEADER}: ${API_VERSION} or omit the header for the current compatibility schema.`,
        code: 'UNSUPPORTED_API_VERSION',
      },
    ],
  });
}

export function enforcePayoutApiVersion(
  request: NextRequest,
): NextResponse | null {
  const result = negotiatePayoutApiVersion(request);
  return result.supported
    ? null
    : unsupportedPayoutApiVersionResponse(request, result);
}

export function applyPayoutApiHeaders(
  response: NextResponse,
  correlationId?: string,
): NextResponse {
  response.headers.set(API_VERSION_HEADER, API_VERSION);
  if (correlationId) response.headers.set('X-Correlation-Id', correlationId);
  response.headers.set(
    'Vary',
    [response.headers.get('Vary'), 'Accept, X-API-Version']
      .filter(Boolean)
      .join(', '),
  );
  return response;
}

export function payoutSuccessResponse(
  data: unknown,
  options: {
    status?: number;
    correlationId?: string;
    extra?: Record<string, unknown>;
  } = {},
): NextResponse {
  const response = NextResponse.json(
    {
      version: API_VERSION,
      success: true,
      data,
      ...options.extra,
    },
    { status: options.status ?? 200 },
  );
  return applyPayoutApiHeaders(response, options.correlationId);
}
