import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuditLogService, { retryWithBackoff } from './auditLog';

describe('auditLog retry helpers', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries a failed operation and succeeds with exponential backoff', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('storage fail'))
      .mockResolvedValueOnce('ok');

    const promise = retryWithBackoff(operation, { retries: 2, minDelayMs: 50, factor: 2 });

    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('persists an audit entry to localStorage when recordAction is called', async () => {
    const entry = AuditLogService.recordAction(
      'admin1',
      'deposit',
      'Test deposit',
      { amount: 42 },
      'txhash',
      'success',
    );

    await Promise.resolve();

    const stored = JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: entry.id,
      adminAddress: 'admin1',
      actionType: 'deposit',
      actionDescription: 'Test deposit',
      txHash: 'txhash',
      status: 'success',
    });
  });
});

describe('auditLog redaction boundary', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const readStoredEntries = (): any[] =>
    JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');

  it('redacts sensitive fields in nested objects while preserving audit metadata', async () => {
    const entry = AuditLogService.recordAction(
      'admin1',
      'deposit',
      'Test deposit',
      {
        amount: 42,
        bank: {
          accountNumber: '0000000000',
          routingNumber: '000000000',
          iban: 'DE00000000000000000000',
        },
        nested: {
          deeper: {
            password: 'fixture-password',
            walletToken: 'fixture-wallet-token',
          },
        },
      },
      'txhash',
      'success',
    );

    await Promise.resolve();

    const stored = readStoredEntries();
    expect(stored).toHaveLength(1);
    const persisted = stored[0];

    // Audit metadata is preserved.
    expect(persisted).toMatchObject({
      id: entry.id,
      adminAddress: 'admin1',
      actionType: 'deposit',
      actionDescription: 'Test deposit',
      txHash: 'txhash',
      status: 'success',
    });
    expect(persisted.timestamp).toBeDefined();

    // Sensitive values are redacted at every nesting level.
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain('0000000000');
    expect(serialized).not.toContain('000000000');
    expect(serialized).not.toContain('DE00000000000000000000');
    expect(serialized).not.toContain('fixture-password');
    expect(serialized).not.toContain('fixture-wallet-token');

    // Non-sensitive values remain intact.
    expect(persisted.details?.amount ?? persisted.metadata?.amount).toBe(42);
  });

  it('redacts mixed-case sensitive keys', async () => {
    AuditLogService.recordAction(
      'admin1',
      'withdrawal',
      'Mixed case keys',
      {
        Password: 'fixture-password',
        API_KEY: 'fixture-api-key',
        SessionToken: 'fixture-session-token',
        BankAccountNumber: '0000000000',
        amount: 7,
      },
      'txhash',
      'success',
    );

    await Promise.resolve();

    const serialized = JSON.stringify(readStoredEntries());
    expect(serialized).not.toContain('fixture-password');
    expect(serialized).not.toContain('fixture-api-key');
    expect(serialized).not.toContain('fixture-session-token');
    expect(serialized).not.toContain('0000000000');
    expect(serialized).toContain('7');
  });

  it('redacts encoded sensitive values (base64 and URL-encoded)', async () => {
    const base64Secret = btoa('fixture-password');
    const urlEncodedSecret = encodeURIComponent('fixture-wallet-token');

    AuditLogService.recordAction(
      'admin1',
      'deposit',
      'Encoded values',
      {
        encodedPassword: base64Secret,
        encodedToken: urlEncodedSecret,
        amount: 11,
      },
      'txhash',
      'success',
    );

    await Promise.resolve();

    const serialized = JSON.stringify(readStoredEntries());
    expect(serialized).not.toContain(base64Secret);
    expect(serialized).not.toContain(urlEncodedSecret);
    expect(serialized).not.toContain('fixture-password');
    expect(serialized).not.toContain('fixture-wallet-token');
    expect(serialized).toContain('11');
  });

  it('redacts provider payloads and prompt content', async () => {
    AuditLogService.recordAction(
      'admin1',
      'deposit',
      'Provider payload',
      {
        providerPayload: { raw: 'fixture-provider-raw-payload' },
        prompt: 'fixture-prompt-content',
        amount: 3,
      },
      'txhash',
      'success',
    );

    await Promise.resolve();

    const serialized = JSON.stringify(readStoredEntries());
    expect(serialized).not.toContain('fixture-provider-raw-payload');
    expect(serialized).not.toContain('fixture-prompt-content');
    expect(serialized).toContain('3');
  });
});

describe('auditLog indexer reorg and backfill entries', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('records an indexer reorg entry with the invalidated range and checkpoint', async () => {
    const entry = AuditLogService.recordAction(
      'indexer',
      'indexer_reorg',
      'Detected ledger fork; rebuilding projections',
      {
        fromLedger: 100,
        toLedger: 120,
        checkpointLedger: 99,
        checkpointHash: 'abc123',
        detectedAt: '2024-01-01T00:00:00.000Z',
      },
      undefined,
      'success',
    );

    await Promise.resolve();

    const stored = JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: entry.id,
      adminAddress: 'indexer',
      actionType: 'indexer_reorg',
      status: 'success',
    });
    expect(stored[0].details).toMatchObject({
      fromLedger: 100,
      toLedger: 120,
      checkpointLedger: 99,
      checkpointHash: 'abc123',
    });
  });

  it('records a backfill entry with persisted progress metadata', async () => {
    const entry = AuditLogService.recordAction(
      'indexer',
      'indexer_backfill',
      'Backfill job started',
      {
        jobId: 'job-1',
        fromLedger: 1,
        toLedger: 500,
        cursor: 250,
        status: 'running',
      },
      undefined,
      'success',
    );

    await Promise.resolve();

    const stored = JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: entry.id,
      adminAddress: 'indexer',
      actionType: 'indexer_backfill',
      status: 'success',
    });
    expect(stored[0].details).toMatchObject({
      jobId: 'job-1',
      fromLedger: 1,
      toLedger: 500,
      cursor: 250,
      status: 'running',
    });
  });

  it('preserves insertion ordering of reorg and backfill entries', async () => {
    AuditLogService.recordAction(
      'indexer',
      'indexer_backfill',
      'Backfill started',
      { jobId: 'job-1', cursor: 0 },
      undefined,
      'success',
    );
    AuditLogService.recordAction(
      'indexer',
      'indexer_reorg',
      'Reorg detected',
      { fromLedger: 10, toLedger: 12 },
      undefined,
      'success',
    );
    AuditLogService.recordAction(
      'indexer',
      'indexer_backfill',
      'Backfill resumed',
      { jobId: 'job-1', cursor: 12 },
      undefined,
      'success',
    );

    await Promise.resolve();

    const stored = JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');
    expect(stored).toHaveLength(3);
    expect(stored.map((e: { actionType: string }) => e.actionType)).toEqual([
      'indexer_backfill',
      'indexer_reorg',
      'indexer_backfill',
    ]);
    expect(stored.map((e: { actionDescription: string }) => e.actionDescription)).toEqual([
      'Backfill started',
      'Reorg detected',
      'Backfill resumed',
    ]);
  });

  it('does not mutate the details object passed to recordAction', async () => {
    const details = {
      jobId: 'job-immutable',
      fromLedger: 1,
      toLedger: 10,
      cursor: 5,
      status: 'running',
    };
    const snapshot = JSON.parse(JSON.stringify(details));

    AuditLogService.recordAction(
      'indexer',
      'indexer_backfill',
      'Backfill started',
      details,
      undefined,
      'success',
    );

    await Promise.resolve();

    expect(details).toEqual(snapshot);

    const stored = JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');
    expect(stored[0].details).toMatchObject(snapshot);
  });

  it('keeps previously stored entries immutable when new entries are appended', async () => {
    const first = AuditLogService.recordAction(
      'indexer',
      'indexer_reorg',
      'Reorg detected',
      { fromLedger: 10, toLedger: 12 },
      undefined,
      'success',
    );

    await Promise.resolve();

    const before = JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');
    const firstSnapshot = JSON.parse(JSON.stringify(before[0]));

    AuditLogService.recordAction(
      'indexer',
      'indexer_backfill',
      'Backfill started',
      { jobId: 'job-2', cursor: 12 },
      undefined,
      'success',
    );

    await Promise.resolve();

    const after = JSON.parse(localStorage.getItem('audit_log_entries') ?? '[]');
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(firstSnapshot);
    expect(after[0].id).toBe(first.id);
    expect(after[1].actionType).toBe('indexer_backfill');
  });
});
  });
});