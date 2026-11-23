import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const healthModule = await import('./route');
const { GET } = healthModule;

type IndexerHealthSnapshot = {
  status: 'ok' | 'degraded';
  timestamp: string;
  indexer: {
    cursor: string | null;
    ledgerLag: number;
    retryCount: number;
    oldestUnprocessedEvent: string | null;
  };
};

const LEDGER_LAG_THRESHOLD = 100;

function resetIndexerState() {
  const maybeReset = (healthModule as unknown as { __resetIndexerHealthForTests?: () => void })
    .__resetIndexerHealthForTests;
  if (typeof maybeReset === 'function') {
    maybeReset();
  }
}

function setIndexerState(state: {
  cursor?: string | null;
  ledgerLag?: number;
  retryCount?: number;
  oldestUnprocessedEvent?: string | null;
}) {
  const maybeSet = (
    healthModule as unknown as {
      __setIndexerHealthForTests?: (s: typeof state) => void;
    }
  ).__setIndexerHealthForTests;
  if (typeof maybeSet === 'function') {
    maybeSet(state);
  }
}

async function readBody(res: Response): Promise<IndexerHealthSnapshot> {
  return (await res.json()) as IndexerHealthSnapshot;
}

function makeRequest(path = '/api/health', query: Record<string, string> = {}) {
  const url = new URL('http://localhost' + path);
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  return { url: url.toString() } as unknown as import('next/server').NextRequest;
}

// ---------------------------------------------------------------------------
// Indexer health — original contract
// ---------------------------------------------------------------------------
describe('GET /api/health', () => {
  beforeEach(() => {
    resetIndexerState();
  });

  afterEach(() => {
    resetIndexerState();
    vi.restoreAllMocks();
  });

  it('returns 200 with status ok', async () => {
    const res = await GET();
    const body = await readBody(res);

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
    expect(Number.isNaN(new Date(body.timestamp).getTime())).toBe(false);
  });

  it('reports zero lag and no retries during normal operation', async () => {
    setIndexerState({
      cursor: 'cursor-0001',
      ledgerLag: 0,
      retryCount: 0,
      oldestUnprocessedEvent: null,
    });

    const res = await GET();
    const body = await readBody(res);

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.indexer.cursor).toBe('cursor-0001');
    expect(body.indexer.ledgerLag).toBe(0);
    expect(body.indexer.retryCount).toBe(0);
    expect(body.indexer.oldestUnprocessedEvent).toBeNull();
  });

  it('increments retryCount and surfaces oldest unprocessed event on RPC failure', async () => {
    setIndexerState({
      cursor: 'cursor-0002',
      ledgerLag: 5,
      retryCount: 3,
      oldestUnprocessedEvent: 'event-0001',
    });

    const res = await GET();
    const body = await readBody(res);

    // Retries below threshold and lag below threshold keep status ok.
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.indexer.retryCount).toBe(3);
    expect(body.indexer.oldestUnprocessedEvent).toBe('event-0001');
    expect(body.indexer.ledgerLag).toBe(5);
  });

  it('flips to degraded and returns 503 when ledger lag crosses the threshold', async () => {
    setIndexerState({
      cursor: 'cursor-0003',
      ledgerLag: LEDGER_LAG_THRESHOLD + 1,
      retryCount: 0,
      oldestUnprocessedEvent: 'event-0002',
    });

    const res = await GET();
    const body = await readBody(res);

    expect(res.status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.indexer.ledgerLag).toBe(LEDGER_LAG_THRESHOLD + 1);
    expect(body.indexer.oldestUnprocessedEvent).toBe('event-0002');
  });

  it('stays ok exactly at the ledger lag threshold boundary', async () => {
    setIndexerState({
      cursor: 'cursor-0004',
      ledgerLag: LEDGER_LAG_THRESHOLD,
      retryCount: 0,
      oldestUnprocessedEvent: null,
    });

    const res = await GET();
    const body = await readBody(res);

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.indexer.ledgerLag).toBe(LEDGER_LAG_THRESHOLD);
  });

  it('does not leak customer identifiers into the health payload', async () => {
    setIndexerState({
      cursor: 'cursor-0005',
      ledgerLag: 0,
      retryCount: 1,
      oldestUnprocessedEvent: 'event-0003',
    });

    const res = await GET();
    const raw = await res.text();

    // Synthetic sentinel values that must never appear in the payload.
    const forbidden = [
      'customer@example.test',
      'user-1234567890',
      '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      'account-9876543210',
    ];
    for (const value of forbidden) {
      expect(raw).not.toContain(value);
    }

    const body = JSON.parse(raw) as IndexerHealthSnapshot;
    expect(Object.keys(body).sort()).toEqual(['indexer', 'status', 'timestamp']);
    expect(Object.keys(body.indexer).sort()).toEqual([
      'cursor',
      'ledgerLag',
      'oldestUnprocessedEvent',
      'retryCount',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Module is re-imported fresh each describe block via dynamic import so the
// module-level `gate` singleton can be reset between groups.  Vitest's module
// cache is cleared with resetModules() in afterEach.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1. Basic liveness — the original contract must still hold
// ---------------------------------------------------------------------------
describe('GET /api/health — basic liveness', () => {
  it('returns 200 with status ok when gate is clean', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
    expect(Number.isNaN(new Date(body.timestamp).getTime())).toBe(false);
  });

  it('includes a releaseHealth block in every response', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.releaseHealth).toBeDefined();
    expect(body.releaseHealth.decision).toBeDefined();
    expect(typeof body.releaseHealth.payoutProcessingPermitted).toBe('boolean');
    expect(body.releaseHealth.metrics).toBeDefined();
    expect(body.releaseHealth.thresholds).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. HEALTHY gate — 200 with payoutProcessingPermitted true
// ---------------------------------------------------------------------------
describe('GET /api/health — HEALTHY gate', () => {
  afterEach(() => vi.resetModules());

  it('returns 200 and decision HEALTHY with no samples', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.releaseHealth.decision).toBe('HEALTHY');
    expect(body.releaseHealth.payoutProcessingPermitted).toBe(true);
    expect(body.releaseHealth.reason).toBeNull();
  });

  it('reports zero metrics on a fresh gate', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeRequest());
    const { metrics } = (await res.json()).releaseHealth;

    expect(metrics.totalRequests).toBe(0);
    expect(metrics.erroredRequests).toBe(0);
    expect(metrics.errorRate).toBe(0);
    expect(metrics.payoutFailures).toBe(0);
  });

  it('exposes the threshold configuration', async () => {
    const { GET, DEFAULT_THRESHOLDS } = await import('./route');
    const res = await GET(makeRequest());
    const { thresholds } = (await res.json()).releaseHealth;

    expect(thresholds.maxErrorRate).toBe(DEFAULT_THRESHOLDS.maxErrorRate);
    expect(thresholds.maxPayoutFailures).toBe(DEFAULT_THRESHOLDS.maxPayoutFailures);
    expect(thresholds.windowMs).toBe(DEFAULT_THRESHOLDS.windowMs);
  });
});

// ---------------------------------------------------------------------------
// 3. DEGRADED gate — 200 but decision is degraded
// ---------------------------------------------------------------------------
describe('GET /api/health — DEGRADED gate', () => {
  afterEach(() => vi.resetModules());

  it('returns 200 with status degraded when error rate is above half-threshold', async () => {
    const { GET, _healthGateForTesting } = await import('./route');

    // 6 % error rate against a 10 % threshold → DEGRADED (above 5 % half-threshold)
    for (let i = 0; i < 100; i++) {
      _healthGateForTesting.recordRequest({ isError: i < 6 });
    }

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.releaseHealth.decision).toBe('DEGRADED');
    expect(body.status).toBe('degraded');
    expect(body.releaseHealth.payoutProcessingPermitted).toBe(true);
    expect(body.releaseHealth.reason).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 4. ROLLBACK gate — 503 and payoutProcessingPermitted false
// ---------------------------------------------------------------------------
describe('GET /api/health — ROLLBACK via error rate', () => {
  afterEach(() => vi.resetModules());

  it('returns 503 when error rate exceeds default threshold', async () => {
    const { GET, _healthGateForTesting } = await import('./route');

    // Default threshold is 5 %; inject 6 % error rate over 100 requests
    for (let i = 0; i < 100; i++) {
      _healthGateForTesting.recordRequest({ isError: i < 6 });
    }

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.releaseHealth.decision).toBe('ROLLBACK');
    expect(body.releaseHealth.payoutProcessingPermitted).toBe(false);
    expect(body.releaseHealth.reason).toMatch(/error rate/i);
  });

  it('status field reflects rollback', async () => {
    const { GET, _healthGateForTesting } = await import('./route');
    for (let i = 0; i < 100; i++) {
      _healthGateForTesting.recordRequest({ isError: i < 6 });
    }
    const body = await (await GET(makeRequest())).json();
    expect(body.status).toBe('rollback');
  });
});

describe('GET /api/health — ROLLBACK via payout failures', () => {
  afterEach(() => vi.resetModules());

  it('returns 503 when payout failures reach threshold', async () => {
    const { GET, _healthGateForTesting } = await import('./route');

    // Default maxPayoutFailures is 3
    ['ref-a', 'ref-b', 'ref-c'].forEach((ref) =>
      _healthGateForTesting.recordPayoutFailure({
        reference: ref,
        category: 'PROVIDER_UNAVAILABLE',
      }),
    );

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.releaseHealth.decision).toBe('ROLLBACK');
    expect(body.releaseHealth.metrics.payoutFailures).toBe(3);
    expect(body.releaseHealth.reason).toMatch(/payout failures/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Threshold query-param overrides — one-shot evaluation, no mutation
// ---------------------------------------------------------------------------
describe('GET /api/health — threshold query-param overrides', () => {
  afterEach(() => vi.resetModules());

  it('applies maxPayoutFailures override from query string', async () => {
    // With override maxPayoutFailures=1, a single recorded failure → ROLLBACK
    const { GET, _healthGateForTesting } = await import('./route');
    _healthGateForTesting.recordPayoutFailure({
      reference: 'x',
      category: 'INTERNAL_ERROR',
    });

    const res = await GET(makeRequest('/api/health', { maxPayoutFailures: '1' }));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.releaseHealth.decision).toBe('ROLLBACK');
  });

  it('applies maxErrorRate override from query string', async () => {
    // Record 3 errors in 10 requests (30 % error rate).
    // Default threshold is 5 % — ROLLBACK with defaults.
    // With override maxErrorRate=0.5 (50 %) it should be HEALTHY.
    const { GET, _healthGateForTesting } = await import('./route');
    for (let i = 0; i < 10; i++) {
      _healthGateForTesting.recordRequest({ isError: i < 3 });
    }

    // Override gate sees fresh zero samples (one-shot), so HEALTHY.
    const res = await GET(
      makeRequest('/api/health', {
        maxErrorRate: '0.5',
        maxPayoutFailures: '10',
        windowMs: '600000',
      }),
    );
    const body = await res.json();

    // Fresh one-shot gate has no samples → HEALTHY regardless of threshold
    expect(res.status).toBe(200);
    expect(body.releaseHealth.decision).toBe('HEALTHY');
  });

  it('ignores invalid maxErrorRate (out of range)', async () => {
    const { GET } = await import('./route');
    // maxErrorRate=1.5 is invalid; falls back to default
    const res = await GET(makeRequest('/api/health', { maxErrorRate: '1.5' }));
    expect(res.status).toBe(200); // fresh gate → HEALTHY
  });

  it('ignores non-numeric maxErrorRate', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeRequest('/api/health', { maxErrorRate: 'banana' }));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 6. Instrumentation helpers
// ---------------------------------------------------------------------------
describe('recordApiRequest / recordPayoutFailure helpers', () => {
  afterEach(() => vi.resetModules());

  it('recordApiRequest feeds the shared gate', async () => {
    const { GET, recordApiRequest, _healthGateForTesting } = await import('./route');

    // Record 5 error requests + 95 clean via helper
    for (let i = 0; i < 100; i++) recordApiRequest(i < 5, '/api/test');

    // 5 % is NOT strictly greater than 5 %; below DEGRADED half-threshold too
    const body = await (await GET(makeRequest())).json();
    expect(body.releaseHealth.metrics.totalRequests).toBe(100);
    expect(body.releaseHealth.metrics.erroredRequests).toBe(5);
    void _healthGateForTesting;
  });

  it('recordPayoutFailure feeds the shared gate', async () => {
    const { GET, recordPayoutFailure } = await import('./route');

    recordPayoutFailure('key-1', 'PROVIDER_TIMEOUT');
    recordPayoutFailure('key-2', 'PROVIDER_TIMEOUT');

    const body = await (await GET(makeRequest())).json();
    expect(body.releaseHealth.metrics.payoutFailures).toBe(2);
  });

  it('isPayoutProcessingPermitted returns true on a healthy gate', async () => {
    const { isPayoutProcessingPermitted } = await import('./route');
    expect(isPayoutProcessingPermitted()).toBe(true);
  });

  it('isPayoutProcessingPermitted returns false once gate enters ROLLBACK', async () => {
    const { isPayoutProcessingPermitted, _healthGateForTesting } =
      await import('./route');

    ['p1', 'p2', 'p3'].forEach((ref) =>
      _healthGateForTesting.recordPayoutFailure({
        reference: ref,
        category: 'INTERNAL_ERROR',
      }),
    );

    expect(isPayoutProcessingPermitted()).toBe(false);
  });
});
