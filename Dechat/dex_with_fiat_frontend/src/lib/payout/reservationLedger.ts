import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type PayoutReservationAction =
  'reserved' | 'provider_linked' | 'settled' | 'released' | 'under_review';

export interface PayoutReservationEntry {
  sequenceNumber: number;
  payoutId: string;
  contractReceiptId: string;
  action: PayoutReservationAction;
  amountMinor: string;
  currency: string;
  providerTransferReference?: string;
  timestamp: string;
  previousHash: string;
  hash: string;
}

export interface PayoutReservation {
  payoutId: string;
  contractReceiptId: string;
  amountMinor: string;
  currency: string;
  providerTransferReference?: string;
  status: 'reserved' | 'settled' | 'released' | 'under_review';
  entries: readonly PayoutReservationEntry[];
}

export class PayoutReservationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayoutReservationConflictError';
  }
}

export class PayoutReservationLedger {
  private entries: PayoutReservationEntry[] = [];
  private storageFilePath: string | null = null;
  private lastHash = '0'.repeat(64);

  constructor(storageDir?: string) {
    const dir = storageDir || process.env.PAYOUT_DATA_DIR;
    if (dir) this.initStorage(dir);
  }

  public initStorage(storageDir: string): void {
    fs.mkdirSync(storageDir, { recursive: true });
    this.storageFilePath = path.join(storageDir, 'payout_reservations.jsonl');
    this.loadFromFile();
  }

  private loadFromFile(): void {
    if (!this.storageFilePath || !fs.existsSync(this.storageFilePath)) return;
    const lines = fs
      .readFileSync(this.storageFilePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    this.entries = lines.map(
      (line) => JSON.parse(line) as PayoutReservationEntry,
    );
    this.lastHash = this.entries.at(-1)?.hash ?? '0'.repeat(64);
    if (!this.verifyIntegrity().valid) {
      throw new Error('Payout reservation ledger integrity check failed');
    }
  }

  private append(
    input: Omit<
      PayoutReservationEntry,
      'sequenceNumber' | 'previousHash' | 'hash'
    >,
  ): PayoutReservationEntry {
    const sequenceNumber = this.entries.length + 1;
    const previousHash = this.lastHash;
    const record = {
      ...input,
      sequenceNumber,
      previousHash,
    };
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(record))
      .digest('hex');
    const entry = Object.freeze({ ...record, hash });

    if (this.storageFilePath) {
      fs.appendFileSync(
        this.storageFilePath,
        `${JSON.stringify(entry)}\n`,
        'utf8',
      );
    }
    this.entries.push(entry);
    this.lastHash = hash;
    return entry;
  }

  public reserve(input: {
    payoutId: string;
    contractReceiptId: string;
    amountMinor: bigint | number | string;
    currency: string;
    timestamp?: string;
  }): PayoutReservation {
    const amountMinor = BigInt(input.amountMinor);
    const currency = input.currency.trim().toUpperCase();
    if (!input.payoutId || !input.contractReceiptId || !currency) {
      throw new Error('Payout, receipt, and currency identifiers are required');
    }
    if (amountMinor <= 0n) {
      throw new Error('Reserved amount must be a positive integer');
    }

    const receiptOwner = this.entries.find(
      (entry) =>
        entry.action === 'reserved' &&
        entry.contractReceiptId === input.contractReceiptId &&
        entry.payoutId !== input.payoutId,
    );
    if (receiptOwner) {
      throw new PayoutReservationConflictError(
        'Contract receipt is already reserved for another payout',
      );
    }

    const existing = this.getReservation(input.payoutId);
    if (existing) {
      if (
        existing.contractReceiptId !== input.contractReceiptId ||
        existing.amountMinor !== amountMinor.toString() ||
        existing.currency !== currency
      ) {
        throw new PayoutReservationConflictError(
          'Payout reservation already exists with different receipt or amount',
        );
      }
      return existing;
    }

    this.append({
      payoutId: input.payoutId,
      contractReceiptId: input.contractReceiptId,
      action: 'reserved',
      amountMinor: amountMinor.toString(),
      currency,
      timestamp: input.timestamp || new Date().toISOString(),
    });
    return this.getReservation(input.payoutId)!;
  }

  public linkProviderTransfer(
    payoutId: string,
    providerTransferReference: string,
    timestamp?: string,
  ): PayoutReservation {
    const reservation = this.requireReservation(payoutId);
    if (!providerTransferReference) {
      throw new Error('Provider transfer reference is required');
    }
    if (reservation.providerTransferReference === providerTransferReference) {
      return reservation;
    }
    if (reservation.providerTransferReference) {
      throw new PayoutReservationConflictError(
        'Payout is already linked to a different provider transfer',
      );
    }
    const linkedElsewhere = this.entries.some(
      (entry) =>
        entry.action === 'provider_linked' &&
        entry.providerTransferReference === providerTransferReference &&
        entry.payoutId !== payoutId,
    );
    if (linkedElsewhere) {
      throw new PayoutReservationConflictError(
        'Provider transfer is already linked to another payout',
      );
    }

    this.append({
      payoutId,
      contractReceiptId: reservation.contractReceiptId,
      action: 'provider_linked',
      amountMinor: reservation.amountMinor,
      currency: reservation.currency,
      providerTransferReference,
      timestamp: timestamp || new Date().toISOString(),
    });
    return this.getReservation(payoutId)!;
  }

  public settle(payoutId: string, timestamp?: string): PayoutReservation {
    return this.transition(payoutId, 'settled', timestamp);
  }

  public release(payoutId: string, timestamp?: string): PayoutReservation {
    return this.transition(payoutId, 'released', timestamp);
  }

  public markUnderReview(
    payoutId: string,
    timestamp?: string,
  ): PayoutReservation {
    return this.transition(payoutId, 'under_review', timestamp);
  }

  private transition(
    payoutId: string,
    action: 'settled' | 'released' | 'under_review',
    timestamp?: string,
  ): PayoutReservation {
    const reservation = this.requireReservation(payoutId);
    if (reservation.status === action) return reservation;

    const hadSettled = reservation.entries.some(
      (entry) => entry.action === 'settled',
    );
    const hadReleased = reservation.entries.some(
      (entry) => entry.action === 'released',
    );
    const allowed =
      (action === 'settled' &&
        !hadSettled &&
        !hadReleased &&
        (reservation.status === 'reserved' ||
          reservation.status === 'under_review')) ||
      (action === 'released' &&
        !hadSettled &&
        !hadReleased &&
        (reservation.status === 'reserved' ||
          reservation.status === 'under_review')) ||
      (action === 'under_review' &&
        (reservation.status === 'reserved' || hadSettled));
    if (!allowed) {
      throw new PayoutReservationConflictError(
        `Cannot transition reservation from ${reservation.status} to ${action}`,
      );
    }

    const providerTransferReference =
      reservation.providerTransferReference ??
      reservation.entries.find((entry) => entry.providerTransferReference)
        ?.providerTransferReference;
    this.append({
      payoutId,
      contractReceiptId: reservation.contractReceiptId,
      action,
      amountMinor: reservation.amountMinor,
      currency: reservation.currency,
      providerTransferReference,
      timestamp: timestamp || new Date().toISOString(),
    });
    return this.getReservation(payoutId)!;
  }

  private requireReservation(payoutId: string): PayoutReservation {
    const reservation = this.getReservation(payoutId);
    if (!reservation) {
      throw new Error(`Payout reservation not found: ${payoutId}`);
    }
    return reservation;
  }

  public getReservation(payoutId: string): PayoutReservation | undefined {
    const entries = this.entries.filter((entry) => entry.payoutId === payoutId);
    const reserved = entries.find((entry) => entry.action === 'reserved');
    if (!reserved) return undefined;
    const latest = entries.at(-1)!;
    const providerTransferReference = [...entries]
      .reverse()
      .find(
        (entry) => entry.providerTransferReference,
      )?.providerTransferReference;
    return {
      payoutId,
      contractReceiptId: reserved.contractReceiptId,
      amountMinor: reserved.amountMinor,
      currency: reserved.currency,
      providerTransferReference,
      status: latest.action === 'provider_linked' ? 'reserved' : latest.action,
      entries,
    };
  }

  public getReservationByProviderReference(
    providerTransferReference: string,
  ): PayoutReservation | undefined {
    const linked = [...this.entries]
      .reverse()
      .find(
        (entry) =>
          entry.action === 'provider_linked' &&
          entry.providerTransferReference === providerTransferReference,
      );
    return linked ? this.getReservation(linked.payoutId) : undefined;
  }

  public getEntries(payoutId?: string): readonly PayoutReservationEntry[] {
    return payoutId
      ? this.entries.filter((entry) => entry.payoutId === payoutId)
      : [...this.entries];
  }

  public verifyIntegrity(): { valid: boolean; invalidEntries: number[] } {
    let previousHash = '0'.repeat(64);
    const invalidEntries: number[] = [];
    for (const entry of this.entries) {
      const { hash, ...record } = entry;
      const expectedHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(record))
        .digest('hex');
      if (entry.previousHash !== previousHash || hash !== expectedHash) {
        invalidEntries.push(entry.sequenceNumber);
      }
      previousHash = hash;
    }
    return { valid: invalidEntries.length === 0, invalidEntries };
  }
}

export const payoutReservationLedger = new PayoutReservationLedger();
