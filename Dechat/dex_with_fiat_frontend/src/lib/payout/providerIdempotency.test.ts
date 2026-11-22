import { describe, expect, it } from 'vitest';
import {
  ProviderIdempotencyReconciliationRequiredError,
  ProviderIdempotencyRegistry,
  ProviderRequestFingerprintMismatchError,
} from './providerIdempotency';

describe('ProviderIdempotencyRegistry', () => {
  it('reuses provider keys within their window and returns completed references', () => {
    const registry = new ProviderIdempotencyRegistry();
    const first = registry.prepare({
      provider: 'paystack',
      idempotencyKey: 'client-key',
      requestFingerprint: 'request-hash',
      windowMs: 100,
      now: 1000,
    });
    const retry = registry.prepare({
      provider: 'paystack',
      idempotencyKey: 'client-key',
      requestFingerprint: 'request-hash',
      windowMs: 100,
      now: 1050,
    });

    expect(first.mode).toBe('execute');
    expect(retry.mode).toBe('execute');
    if (first.mode !== 'execute' || retry.mode !== 'execute') {
      throw new Error('Expected executable provider attempts');
    }
    expect(retry.attempt.providerKey).toBe(first.attempt.providerKey);
    registry.complete('paystack', 'client-key', 'transfer-1');

    expect(
      registry.prepare({
        provider: 'paystack',
        idempotencyKey: 'client-key',
        requestFingerprint: 'request-hash',
        windowMs: 100,
        now: 1200,
      }),
    ).toMatchObject({ mode: 'replay', responseReference: 'transfer-1' });
  });

  it('rejects mismatched requests and expired attempts until reconciliation', () => {
    const registry = new ProviderIdempotencyRegistry();
    registry.prepare({
      provider: 'paystack',
      idempotencyKey: 'client-key',
      requestFingerprint: 'original',
      windowMs: 100,
      now: 1000,
    });

    expect(() =>
      registry.prepare({
        provider: 'paystack',
        idempotencyKey: 'client-key',
        requestFingerprint: 'changed',
        windowMs: 100,
        now: 1050,
      }),
    ).toThrow(ProviderRequestFingerprintMismatchError);
    expect(() =>
      registry.prepare({
        provider: 'paystack',
        idempotencyKey: 'client-key',
        requestFingerprint: 'original',
        windowMs: 100,
        now: 1100,
      }),
    ).toThrow(ProviderIdempotencyReconciliationRequiredError);
  });

  it('issues a fresh provider key only after status confirms no transfer exists', () => {
    const registry = new ProviderIdempotencyRegistry();
    const first = registry.prepare({
      provider: 'paystack',
      idempotencyKey: 'client-key',
      requestFingerprint: 'request-hash',
      windowMs: 100,
      now: 1000,
    });
    if (first.mode !== 'execute') throw new Error('Expected an attempt');

    registry.reconcile('paystack', 'client-key', { status: 'absent' }, 1200);
    const retry = registry.prepare({
      provider: 'paystack',
      idempotencyKey: 'client-key',
      requestFingerprint: 'request-hash',
      windowMs: 100,
      now: 1200,
    });
    if (retry.mode !== 'execute') throw new Error('Expected a new attempt');
    expect(retry.attempt.providerKey).not.toBe(first.attempt.providerKey);

    registry.reconcile(
      'paystack',
      'client-key',
      { status: 'found', responseReference: 'transfer-2' },
      1300,
    );
    expect(
      registry.prepare({
        provider: 'paystack',
        idempotencyKey: 'client-key',
        requestFingerprint: 'request-hash',
        windowMs: 100,
        now: 1400,
      }),
    ).toMatchObject({ mode: 'replay', responseReference: 'transfer-2' });
  });

  it('persists provider keys, fingerprints, expirations, and response references', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-idem-'));
    try {
      const registry = new ProviderIdempotencyRegistry(directory);
      registry.prepare({
        provider: 'paystack',
        idempotencyKey: 'client-key',
        requestFingerprint: 'request-hash',
        windowMs: 100,
        now: 1000,
      });
      registry.complete('paystack', 'client-key', 'transfer-1');

      const restarted = new ProviderIdempotencyRegistry(directory);
      expect(
        restarted.get('paystack', 'client-key')?.attempts[0],
      ).toMatchObject({
        requestFingerprint: 'request-hash',
        expiresAt: 1100,
        responseReference: 'transfer-1',
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
