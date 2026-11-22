import {
  PayoutStatus,
  PayoutActor,
  PayoutTransitionRecord,
  validatePayoutTransition,
} from './payout/payoutLifecycle';
import type {
  FxQuoteRecord,
  FxQuoteTransferValues,
} from './payout/fxQuoteProvenance';

export {
  type PayoutStatus,
  type PayoutActor,
  type PayoutTransitionRecord,
  InvalidPayoutTransitionError,
} from './payout/payoutLifecycle';

type ReplayCacheEntry = {
  seenAt: number;
};

const DEFAULT_REPLAY_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REPLAY_MAX_SIZE = 1000;

const replayCache = new Map<string, ReplayCacheEntry>();

function pruneReplayCache(now = Date.now()) {
  for (const [key, entry] of replayCache.entries()) {
    if (now - entry.seenAt > DEFAULT_REPLAY_TTL_MS) {
      replayCache.delete(key);
    }
  }

  while (replayCache.size > DEFAULT_REPLAY_MAX_SIZE) {
    const oldestKey = replayCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    replayCache.delete(oldestKey);
  }
}

export function isReplayEvent(cacheKey: string): boolean {
  const now = Date.now();
  pruneReplayCache(now);

  if (replayCache.has(cacheKey)) {
    return true;
  }

  replayCache.set(cacheKey, { seenAt: now });
  return false;
}

export function replayCacheStats() {
  return {
    size: replayCache.size,
    ttlMs: DEFAULT_REPLAY_TTL_MS,
    maxSize: DEFAULT_REPLAY_MAX_SIZE,
  };
}

/**
 * In-memory store for transfer status and payout lifecycle tracking.
 */
export interface TransferStatusRecord {
  reference: string;
  status: PayoutStatus;
  amount: number;
  amountMinor?: bigint;
  currency?: string;
  fxQuote?: FxQuoteRecord;
  finalTransferValues?: FxQuoteTransferValues;
  failureReason?: string;
  updatedAt: string;
  updatedAtMs?: number;
  clientSessionId?: string;
  reconciliationAttempts?: number;
  lastReconciledAt?: string;
  providerEventAt?: string;
  webhookReceivedAt?: string;
  history?: PayoutTransitionRecord[];
  lastReconciliationResult?:
    | 'transitioned'
    | 'no_change'
    | 'provider_unavailable'
    | 'invalid_transition'
    | 'error';
  nextRetryAt?: number;
}

// Key is the transfer reference
export const transferStore = new Map<string, TransferStatusRecord>();

export function getTransferStatus(
  reference: string,
): TransferStatusRecord | undefined {
  return transferStore.get(reference);
}

export function setTransferStatus(
  record: TransferStatusRecord,
): TransferStatusRecord {
  transferStore.set(record.reference, record);
  return record;
}

export function transitionPayoutStatus(input: {
  reference: string;
  targetStatus: PayoutStatus;
  actor: PayoutActor | string;
  providerReference?: string;
  reason?: string;
  amount?: number;
  updatedAt?: string;
  clientSessionId?: string;
}): TransferStatusRecord {
  const current = getTransferStatus(input.reference);
  const currentStatus = current?.status ?? 'none';
  validatePayoutTransition(currentStatus, input.targetStatus, input.reference);

  if (currentStatus === input.targetStatus && current) return current;

  const timestamp = input.updatedAt || new Date().toISOString();
  const transition: PayoutTransitionRecord = {
    fromStatus: currentStatus,
    toStatus: input.targetStatus,
    actor: input.actor,
    providerReference: input.providerReference,
    timestamp,
    reason: input.reason,
  };
  return setTransferStatus({
    reference: input.reference,
    status: input.targetStatus,
    amount: input.amount ?? current?.amount ?? 0,
    amountMinor: current?.amountMinor,
    currency: current?.currency,
    failureReason: input.targetStatus === 'failed' ? input.reason : undefined,
    updatedAt: timestamp,
    clientSessionId: input.clientSessionId ?? current?.clientSessionId,
    history: [...(current?.history ?? []), transition],
  });
}

export function getAllTransfers(): TransferStatusRecord[] {
  return Array.from(transferStore.values());
}

export function clearTransferStore(): void {
  transferStore.clear();
}
