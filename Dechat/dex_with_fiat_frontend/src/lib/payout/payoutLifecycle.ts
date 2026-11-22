import type { CalculationLineage } from '../lineage/calculationLineage';

export type PayoutStatus =
  | 'initiated'
  | 'pending'
  | 'success'
  | 'failed'
  | 'reversed'
  | 'cancelled';

export type PayoutActor =
  | 'user'
  | 'admin'
  | 'webhook'
  | 'polling'
  | 'system';

export interface PayoutTransitionRecord {
  fromStatus: PayoutStatus | 'none';
  toStatus: PayoutStatus;
  actor: PayoutActor | string;
  providerReference?: string;
  timestamp: string;
  reason?: string;
  /**
   * Data lineage captured at the moment the payout was initiated or settled.
   * Persisted alongside the payout so auditors can recompute every paid amount.
   * Absent on failure paths (failed/cancelled) where no amount was paid.
   */
  lineage?: CalculationLineage;
}

/**
 * Payout lifecycle record persisted for a payout reference.
 * The lineage is attached when the payout is initiated and/or settled so it is
 * retrievable by the receipt and admin payout-audit APIs.
 */
export interface PayoutLifecycleRecord {
  reference: string;
  status: PayoutStatus;
  /** Lineage captured at initiation (input sources, rounding decisions). */
  initiationLineage?: CalculationLineage;
  /** Lineage captured at settlement (final paid amount recomputation). */
  settlementLineage?: CalculationLineage;
  transitions: PayoutTransitionRecord[];
}

/**
 * Statuses for which a calculation lineage must be persisted because an amount
 * was (or is about to be) paid out.
 */
export const LINEAGE_REQUIRED_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  'initiated',
  'pending',
  'success',
  'reversed',
];

export function requiresPayoutLineage(status: PayoutStatus): boolean {
  return LINEAGE_REQUIRED_PAYOUT_STATUSES.includes(status);
}

export class MissingPayoutLineageError extends Error {
  constructor(
    public readonly reference: string,
    public readonly status: PayoutStatus,
  ) {
    super(
      `Missing calculation lineage for payout reference "${reference}" at status "${status}"; lineage is required to recompute the paid amount.`,
    );
    this.name = 'MissingPayoutLineageError';
  }
}

/**
 * Attach lineage to a payout lifecycle record for the given transition.
 * Lineage is required for initiation and settlement transitions and is
 * intentionally omitted on failure paths.
 */
export function attachPayoutLineage(
  record: PayoutLifecycleRecord,
  transition: PayoutTransitionRecord,
  lineage?: CalculationLineage,
): PayoutLifecycleRecord {
  const isInitiation =
    transition.toStatus === 'initiated' || transition.toStatus === 'pending';
  const isSettlement = transition.toStatus === 'success';

  if (requiresPayoutLineage(transition.toStatus) && !lineage) {
    throw new MissingPayoutLineageError(record.reference, transition.toStatus);
  }

  const nextTransition: PayoutTransitionRecord = lineage
    ? { ...transition, lineage }
    : { ...transition };

  const nextRecord: PayoutLifecycleRecord = {
    ...record,
    status: transition.toStatus,
    transitions: [...record.transitions, nextTransition],
  };

  if (lineage && isInitiation) {
    nextRecord.initiationLineage = lineage;
  }
  if (lineage && isSettlement) {
    nextRecord.settlementLineage = lineage;
  }

  return nextRecord;
}

/**
 * Retrieve the lineage persisted for a payout, preferring settlement lineage
 * (the final paid amount) and falling back to initiation lineage.
 */
export function getPayoutLineage(
  record: PayoutLifecycleRecord,
): CalculationLineage | undefined {
  return record.settlementLineage ?? record.initiationLineage;
}

/**
 * Allowed transitions for payout lifecycle:
 * - initiation -> pending
 * - pending -> success (settlement) | failed | cancelled
 * - success -> reversed (documented reversal handling)
 * - failed, reversed, cancelled -> immutable terminal states
 */
export const ALLOWED_PAYOUT_TRANSITIONS: Record<
  PayoutStatus | 'none',
  readonly PayoutStatus[]
> = {
  none: ['initiated', 'pending'],
  initiated: ['pending', 'failed', 'cancelled'],
  pending: ['success', 'failed', 'cancelled'],
  success: ['reversed'],
  failed: [],
  reversed: [],
  cancelled: [],
};

export const TERMINAL_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  'failed',
  'reversed',
  'cancelled',
];

export function isTerminalPayoutStatus(status: PayoutStatus): boolean {
  return TERMINAL_PAYOUT_STATUSES.includes(status);
}

export class InvalidPayoutTransitionError extends Error {
  constructor(
    public readonly reference: string,
    public readonly currentStatus: PayoutStatus | 'none',
    public readonly targetStatus: PayoutStatus,
    message?: string,
  ) {
    super(
      message ??
        `Invalid payout transition for reference "${reference}": cannot transition from "${currentStatus}" to "${targetStatus}".`,
    );
    this.name = 'InvalidPayoutTransitionError';
  }
}

export function canTransitionPayoutStatus(
  currentStatus: PayoutStatus | 'none',
  targetStatus: PayoutStatus,
): boolean {
  if (currentStatus === targetStatus) {
    return true; // Idempotent no-op
  }
  const allowed = ALLOWED_PAYOUT_TRANSITIONS[currentStatus];
  return allowed ? allowed.includes(targetStatus) : false;
}

export function validatePayoutTransition(
  currentStatus: PayoutStatus | 'none',
  targetStatus: PayoutStatus,
  reference: string,
): void {
  if (!canTransitionPayoutStatus(currentStatus, targetStatus)) {
    throw new InvalidPayoutTransitionError(
      reference,
      currentStatus,
      targetStatus,
    );
  }
}

/**
 * Deterministic, credential-free payout fixtures for cross-browser smoke
 * coverage. References are synthetic and must never be replaced with real
 * provider identifiers or user data.
 */
export const PAYOUT_SMOKE_FIXTURES = {
  success: {
    reference: 'smoke-payout-success-0001',
    providerReference: 'smoke-provider-success-0001',
    amount: '25.00',
    currency: 'USD',
    path: ['initiated', 'pending', 'success'] as const,
  },
  failed: {
    reference: 'smoke-payout-failed-0001',
    providerReference: 'smoke-provider-failed-0001',
    amount: '25.00',
    currency: 'USD',
    path: ['initiated', 'pending', 'failed'] as const,
  },
  cancelled: {
    reference: 'smoke-payout-cancelled-0001',
    providerReference: 'smoke-provider-cancelled-0001',
    amount: '25.00',
    currency: 'USD',
    path: ['initiated', 'pending', 'cancelled'] as const,
  },
} as const;

export type PayoutSmokeScenario = keyof typeof PAYOUT_SMOKE_FIXTURES;

export interface PayoutLifecycleResult {
  reference: string;
  status: PayoutStatus;
  history: PayoutTransitionRecord[];
}

/**
 * Replays a payout status path against the transition rules, producing a
 * deterministic transition history. Throws InvalidPayoutTransitionError when
 * any step violates the lifecycle contract.
 */
export function replayPayoutLifecycle(
  reference: string,
  path: readonly PayoutStatus[],
  options: {
    actor?: PayoutActor | string;
    providerReference?: string;
    timestamp?: string;
  } = {},
): PayoutLifecycleResult {
  const actor = options.actor ?? 'system';
  const timestamp = options.timestamp ?? '1970-01-01T00:00:00.000Z';
  let current: PayoutStatus | 'none' = 'none';
  const history: PayoutTransitionRecord[] = [];

  for (const target of path) {
    validatePayoutTransition(current, target, reference);
    if (current !== target) {
      history.push({
        fromStatus: current,
        toStatus: target,
        actor,
        providerReference: options.providerReference,
        timestamp,
      });
    }
    current = target;
  }

  return { reference, status: current as PayoutStatus, history };
}

/**
 * Builds the deterministic lifecycle result for a named smoke scenario.
 */
export function buildPayoutSmokeScenario(
  scenario: PayoutSmokeScenario,
): PayoutLifecycleResult {
  const fixture = PAYOUT_SMOKE_FIXTURES[scenario];
  return replayPayoutLifecycle(fixture.reference, fixture.path, {
    actor: 'webhook',
    providerReference: fixture.providerReference,
  });
}
