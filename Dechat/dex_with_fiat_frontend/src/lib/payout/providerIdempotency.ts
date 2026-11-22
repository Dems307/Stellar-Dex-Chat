import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type ProviderAttemptStatus =
  | 'pending'
  | 'uncertain'
  | 'completed'
  | 'reconciled_absent'
  | 'reconciled_found';

export interface ProviderIdempotencyAttempt {
  providerKey: string;
  requestFingerprint: string;
  expiresAt: number;
  preparedAt: number;
  status: ProviderAttemptStatus;
  responseReference?: string;
  reconciledAt?: number;
}

export interface ProviderIdempotencyRecord {
  provider: string;
  idempotencyKey: string;
  requestFingerprint: string;
  attempts: ProviderIdempotencyAttempt[];
}

export class ProviderRequestFingerprintMismatchError extends Error {
  constructor() {
    super('Provider idempotency key was reused with a different request');
    this.name = 'ProviderRequestFingerprintMismatchError';
  }
}

export class ProviderIdempotencyReconciliationRequiredError extends Error {
  constructor() {
    super(
      'Provider idempotency window expired; reconcile transfer status before retrying',
    );
    this.name = 'ProviderIdempotencyReconciliationRequiredError';
  }
}

export class ProviderIdempotencyRegistry {
  private records = new Map<string, ProviderIdempotencyRecord>();
  private storageFilePath: string | null = null;

  constructor(storageDir?: string) {
    const dir = storageDir || process.env.PAYOUT_DATA_DIR;
    if (dir) this.initStorage(dir);
  }

  public initStorage(storageDir: string): void {
    fs.mkdirSync(storageDir, { recursive: true });
    this.storageFilePath = path.join(storageDir, 'provider_idempotency.json');
    if (!fs.existsSync(this.storageFilePath)) return;
    const parsed = JSON.parse(
      fs.readFileSync(this.storageFilePath, 'utf8'),
    ) as ProviderIdempotencyRecord[];
    this.records = new Map(
      parsed.map((record) => [
        this.getRecordKey(record.provider, record.idempotencyKey),
        record,
      ]),
    );
  }

  private getRecordKey(provider: string, key: string): string {
    return `${provider}:${key}`;
  }

  private persist(): void {
    if (!this.storageFilePath) return;
    const temporaryPath = `${this.storageFilePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(
      temporaryPath,
      JSON.stringify([...this.records.values()]),
      'utf8',
    );
    fs.renameSync(temporaryPath, this.storageFilePath);
  }

  public prepare(input: {
    provider: string;
    idempotencyKey: string;
    requestFingerprint: string;
    windowMs: number;
    now?: number;
  }):
    | { mode: 'execute'; attempt: ProviderIdempotencyAttempt }
    | {
        mode: 'replay';
        attempt: ProviderIdempotencyAttempt;
        responseReference: string;
      } {
    if (!input.provider || !input.idempotencyKey || !input.requestFingerprint) {
      throw new Error(
        'Provider, idempotency key, and fingerprint are required',
      );
    }
    if (!Number.isFinite(input.windowMs) || input.windowMs <= 0) {
      throw new Error('Provider idempotency window must be positive');
    }

    const recordKey = this.getRecordKey(input.provider, input.idempotencyKey);
    const existing = this.records.get(recordKey);
    if (existing && existing.requestFingerprint !== input.requestFingerprint) {
      throw new ProviderRequestFingerprintMismatchError();
    }

    const now = input.now ?? Date.now();
    const latest = existing?.attempts.at(-1);
    if (
      latest?.status === 'completed' ||
      latest?.status === 'reconciled_found'
    ) {
      if (!latest.responseReference) {
        throw new Error('Completed provider attempt has no response reference');
      }
      return {
        mode: 'replay',
        attempt: latest,
        responseReference: latest.responseReference,
      };
    }

    if (latest && now >= latest.expiresAt) {
      if (latest.status !== 'reconciled_absent') {
        throw new ProviderIdempotencyReconciliationRequiredError();
      }
    }

    const attempt: ProviderIdempotencyAttempt =
      latest && now < latest.expiresAt
        ? latest
        : {
            providerKey: crypto.randomUUID(),
            requestFingerprint: input.requestFingerprint,
            expiresAt: now + input.windowMs,
            preparedAt: now,
            status: 'pending',
          };
    const record: ProviderIdempotencyRecord = existing
      ? { ...existing, attempts: [...existing.attempts] }
      : {
          provider: input.provider,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          attempts: [],
        };
    if (attempt !== latest) record.attempts.push(attempt);
    this.records.set(recordKey, record);
    this.persist();
    return { mode: 'execute', attempt };
  }

  public markUncertain(
    provider: string,
    idempotencyKey: string,
    now = Date.now(),
  ): void {
    const attempt = this.requireLatest(provider, idempotencyKey);
    if (
      attempt.status === 'completed' ||
      attempt.status === 'reconciled_found'
    ) {
      return;
    }
    attempt.status = 'uncertain';
    attempt.preparedAt = Math.min(attempt.preparedAt, now);
    this.persist();
  }

  public complete(
    provider: string,
    idempotencyKey: string,
    responseReference: string,
  ): void {
    if (!responseReference) {
      throw new Error('Provider response reference is required');
    }
    const attempt = this.requireLatest(provider, idempotencyKey);
    attempt.status = 'completed';
    attempt.responseReference = responseReference;
    this.persist();
  }

  public reconcile(
    provider: string,
    idempotencyKey: string,
    result:
      { status: 'found'; responseReference: string } | { status: 'absent' },
    now = Date.now(),
  ): void {
    const attempt = this.requireLatest(provider, idempotencyKey);
    if (result.status === 'found') {
      if (!result.responseReference) {
        throw new Error('Reconciled provider response reference is required');
      }
      attempt.status = 'reconciled_found';
      attempt.responseReference = result.responseReference;
    } else {
      attempt.status = 'reconciled_absent';
      delete attempt.responseReference;
    }
    attempt.reconciledAt = now;
    this.persist();
  }

  public get(
    provider: string,
    idempotencyKey: string,
  ): ProviderIdempotencyRecord | undefined {
    const record = this.records.get(
      this.getRecordKey(provider, idempotencyKey),
    );
    return record ? structuredClone(record) : undefined;
  }

  private requireLatest(
    provider: string,
    idempotencyKey: string,
  ): ProviderIdempotencyAttempt {
    const record = this.records.get(
      this.getRecordKey(provider, idempotencyKey),
    );
    const attempt = record?.attempts.at(-1);
    if (!attempt) {
      throw new Error('Provider idempotency attempt not found');
    }
    return attempt;
  }
}

export const providerIdempotencyRegistry = new ProviderIdempotencyRegistry();
