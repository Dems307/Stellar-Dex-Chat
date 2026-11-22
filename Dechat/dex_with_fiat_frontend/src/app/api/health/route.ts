import { NextRequest, NextResponse } from 'next/server';
import { getProviderCircuitBreakerHealth } from '@/lib/payout/circuitBreaker';
import {
  ReleaseHealthGate,
  DEFAULT_THRESHOLDS,
  type HealthGateThresholds,
  type ReleaseHealthDecision,
} from '@/lib/payout/releaseHealthGate';

export const runtime = 'edge';

/**
 * Bounded indexer health snapshot.
 *
 * Only aggregate, non-identifying values are exposed here: ledger cursors,
 * lag, retry counts and the age of the oldest unprocessed event. Wallet
 * addresses, transaction hashes and any other customer identifiers must
 * never be added to this payload.
 */
export interface IndexerHealthSnapshot {
  cursorLedger: number | null;
  cursorEventIndex: number | null;
  ledgerLag: number | null;
  retryCount: number;
  oldestUnprocessedEventLedger: number | null;
  oldestUnprocessedEventAgeSeconds: number | null;
}

export type IndexerHealthStatus = 'ok' | 'degraded';

/** Ledger lag (in ledgers) above which the indexer is considered degraded. */
export const LEDGER_LAG_DEGRADED_THRESHOLD = 100;
/** Ledger lag (in ledgers) above which the indexer is considered critical. */
export const LEDGER_LAG_CRITICAL_THRESHOLD = 500;
/** Retry count above which the indexer is considered degraded. */
export const RETRY_COUNT_DEGRADED_THRESHOLD = 5;
/** Retry count above which the indexer is considered critical. */
export const RETRY_COUNT_CRITICAL_THRESHOLD = 20;
/** Age (seconds) of the oldest unprocessed event above which the indexer is degraded. */
export const OLDEST_EVENT_AGE_DEGRADED_THRESHOLD_SECONDS = 300;
/** Age (seconds) of the oldest unprocessed event above which the indexer is critical. */
export const OLDEST_EVENT_AGE_CRITICAL_THRESHOLD_SECONDS = 900;

const EMPTY_SNAPSHOT: IndexerHealthSnapshot = {
  cursorLedger: null,
  cursorEventIndex: null,
  ledgerLag: null,
  retryCount: 0,
  oldestUnprocessedEventLedger: null,
  oldestUnprocessedEventAgeSeconds: null,
};

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Normalizes an arbitrary health source into the bounded snapshot shape,
 * dropping any unexpected or identifying fields.
 */
export function normalizeIndexerHealth(
  source: Partial<IndexerHealthSnapshot> | null | undefined,
): IndexerHealthSnapshot {
  if (!source) {
    return { ...EMPTY_SNAPSHOT };
  }

  return {
    cursorLedger: toFiniteNumber(source.cursorLedger),
    cursorEventIndex: toFiniteNumber(source.cursorEventIndex),
    ledgerLag: toFiniteNumber(source.ledgerLag),
    retryCount: toFiniteNumber(source.retryCount) ?? 0,
    oldestUnprocessedEventLedger: toFiniteNumber(source.oldestUnprocessedEventLedger),
    oldestUnprocessedEventAgeSeconds: toFiniteNumber(source.oldestUnprocessedEventAgeSeconds),
  };
}

/**
 * Loads the current indexer health snapshot.
 *
 * The indexer publishes its snapshot to a shared health provider; when that
 * provider is unavailable we fall back to an empty snapshot so the health
 * route still responds with bounded data.
 */
export async function loadIndexerHealth(): Promise<IndexerHealthSnapshot> {
  try {
    const provider = (globalThis as { __indexerHealthProvider?: () => unknown })
      .__indexerHealthProvider;

    if (typeof provider !== 'function') {
      return { ...EMPTY_SNAPSHOT };
    }

    const snapshot = await provider();
    return normalizeIndexerHealth(snapshot as Partial<IndexerHealthSnapshot> | null);
  } catch {
    return { ...EMPTY_SNAPSHOT };
  }
}

/**
 * Classifies the snapshot against the alert thresholds.
 *
 * Returns 'degraded' when any metric crosses its degraded threshold and
 * whether the snapshot is critical (used to decide the HTTP status code).
 */
export function evaluateIndexerHealth(snapshot: IndexerHealthSnapshot): {
  status: IndexerHealthStatus;
  critical: boolean;
} {
  const ledgerLag = snapshot.ledgerLag ?? 0;
  const retryCount = snapshot.retryCount ?? 0;
  const oldestEventAge = snapshot.oldestUnprocessedEventAgeSeconds ?? 0;

  const critical =
    ledgerLag > LEDGER_LAG_CRITICAL_THRESHOLD ||
    retryCount > RETRY_COUNT_CRITICAL_THRESHOLD ||
    oldestEventAge > OLDEST_EVENT_AGE_CRITICAL_THRESHOLD_SECONDS;

  const degraded =
    critical ||
    ledgerLag > LEDGER_LAG_DEGRADED_THRESHOLD ||
    retryCount > RETRY_COUNT_DEGRADED_THRESHOLD ||
    oldestEventAge > OLDEST_EVENT_AGE_DEGRADED_THRESHOLD_SECONDS;

  return {
    status: degraded ? 'degraded' : 'ok',
    critical,
  };
}

// ---------------------------------------------------------------------------
// Process-level gate singleton.
//
// In a standard Node.js / long-lived server process this accumulates samples
// across requests.  In edge/serverless deployments each invocation is
// isolated, so the CI health-gate workflow (release-health-gate.yml) is the
// authoritative cross-deployment check; this endpoint feeds that workflow.
// ---------------------------------------------------------------------------
const gate = new ReleaseHealthGate();

/**
 * Parse optional threshold overrides from query parameters.
 * Only values that are valid numbers in range are accepted; malformed
 * or out-of-range values fall back to the compiled-in defaults.
 */
function parseThresholdOverrides(
  searchParams: URLSearchParams,
): Partial<HealthGateThresholds> {
  const overrides: Partial<HealthGateThresholds> = {};

  const errorRate = Number(searchParams.get('maxErrorRate'));
  if (!Number.isNaN(errorRate) && errorRate > 0 && errorRate <= 1) {
    overrides.maxErrorRate = errorRate;
  }

  const payoutFailures = Number(searchParams.get('maxPayoutFailures'));
  if (
    Number.isInteger(payoutFailures) &&
    payoutFailures > 0
  ) {
    overrides.maxPayoutFailures = payoutFailures;
  }

  const windowMs = Number(searchParams.get('windowMs'));
  if (!Number.isNaN(windowMs) && windowMs > 0) {
    overrides.windowMs = windowMs;
  }

  return overrides;
}

/** Map gate decision to an HTTP status code. */
function decisionToStatus(decision: ReleaseHealthDecision): number {
  switch (decision) {
    case 'HEALTHY':
      return 200;
    case 'DEGRADED':
      return 200; // still serving; callers inspect the body for the warning
    case 'ROLLBACK':
      return 503;
  }
}

export async function GET(request: NextRequest) {
  try {
    const indexer = await loadIndexerHealth();
    const { status, critical } = evaluateIndexerHealth(indexer);

    const { searchParams } = new URL(request.url);
    const overrides = parseThresholdOverrides(searchParams);

    // If threshold overrides were supplied create a fresh one-shot gate so the
    // caller can probe what the decision would be under different thresholds
    // without affecting the shared singleton.
    const evaluatingGate =
      Object.keys(overrides).length > 0
        ? new ReleaseHealthGate(overrides)
        : gate;

    const metrics = evaluatingGate.evaluate();
    const gateStatus = decisionToStatus(metrics.decision);

    // The overall response is critical if either the indexer or the release
    // health gate reports a critical/rollback condition.
    const httpStatus = critical ? 503 : gateStatus;

    return NextResponse.json(
      {
        status,
        timestamp: new Date().toISOString(),
        indexer,
        providerCircuits: getProviderCircuitBreakerHealth(),
      },
      { status: httpStatus },
    );
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        timestamp: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'Health check failed',
      },
      { status: 503 },
    );
  }
}

// ---------------------------------------------------------------------------
// Thin instrumentation helpers — called by other route handlers to feed the
// singleton gate without importing it directly everywhere.
// ---------------------------------------------------------------------------

/**
 * Record the outcome of an API request into the shared health gate.
 * Call this from route middleware or individual handlers.
 *
 * @example
 * ```ts
 * import { recordApiRequest } from '@/app/api/health/route';
 * // Inside a route handler:
 * recordApiRequest(response.status >= 500, '/api/initiate-transfer');
 * ```
 */
export function recordApiRequest(isError: boolean, route?: string): void {
  gate.recordRequest({ isError, route });
}

/**
 * Record a payout processing failure into the shared health gate.
 * Pass only sanitised identifiers — no account numbers, amounts, or PII.
 *
 * @example
 * ```ts
 * import { recordPayoutFailure } from '@/app/api/health/route';
 * recordPayoutFailure(job.idempotencyKey, 'PROVIDER_UNAVAILABLE');
 * ```
 */
export function recordPayoutFailure(
  reference: string,
  category: string,
): void {
  gate.recordPayoutFailure({ reference, category });
}

/**
 * Evaluate the current health gate decision without exposing the full
 * metrics object.  Suitable for inline payout-processing guards.
 *
 * @returns `true` when payout processing is permitted.
 */
export function isPayoutProcessingPermitted(): boolean {
  return gate.evaluate().payoutProcessingPermitted;
}

// Exported for tests that need to inject samples into the module-level gate.
export { gate as _healthGateForTesting, DEFAULT_THRESHOLDS };
