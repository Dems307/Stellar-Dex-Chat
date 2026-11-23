import fs from 'fs';
import path from 'path';
import { payoutAuditLedger, PayoutAuditLedger } from './auditLedger';
import {
  PayoutEvidence,
  PayoutEvidenceResolution,
  payoutEvidenceConflictResolver,
} from './evidenceConflictResolver';
import { getAllTransfers, setTransferStatus } from '../transferStore';
import { getPayoutProvider } from './providers/registry';

export type DomainPayoutStatus =
  'pending' | 'success' | 'failed' | 'reversed' | 'cancelled';

export interface RejectedEventRecord {
  id: string;
  eventId: string;
  payoutReference: string;
  eventType: string;
  currentStatus?: DomainPayoutStatus;
  targetStatus?: DomainPayoutStatus;
  reason: string;
  payload: Record<string, unknown>;
  timestamp: string;
  providerEventAt: string;
  receivedAt: string;
}

export interface PayoutWebhookEventRecord {
  eventId: string;
  payoutReference: string;
  eventType: string;
  targetStatus?: DomainPayoutStatus;
  decision: ReconciliationDecisionType;
  initialStatus: DomainPayoutStatus;
  effectiveStatus: DomainPayoutStatus;
  providerEventAt: string;
  receivedAt: string;
}

export type ReconciliationDecisionType =
  | 'APPLIED'
  | 'IDEMPOTENT_NOOP'
  | 'REJECTED_OUT_OF_ORDER'
  | 'UNRECOGNIZED_EVENT';

/**
 * Confidence classification for cross-source payout reconciliation.
 *
 * - `matched`: all present sources agree on identifiers, amount and currency.
 * - `ambiguous`: a stable identifier maps to more than one record, so the
 *   correct counterpart cannot be determined automatically.
 * - `unmatched`: at least one expected source is missing, so the payout cannot
 *   be confirmed.
 * - `conflict`: sources disagree on amount or currency.
 */
export type ReconciliationConfidence =
  | 'matched'
  | 'ambiguous'
  | 'unmatched'
  | 'conflict';

export interface ContractPayoutEvent {
  txHash: string;
  payoutReference: string;
  /** Amount in minor units of `currency`. */
  amountMinor: string | number | bigint;
  currency: string;
  eventType?: string;
}

export interface InternalPayoutRecord {
  payoutReference: string;
  /** Amount in minor units of `currency`. */
  amountMinor: string | number | bigint;
  currency: string;
  status?: DomainPayoutStatus;
}

export interface ProviderPayoutEvidence {
  providerReference: string;
  payoutReference: string;
  /** Amount in minor units of `currency`. */
  amountMinor: string | number | bigint;
  currency: string;
  eventType?: string;
}

export interface ReconciliationRecord {
  /** Deterministic key derived from the stable identifiers. */
  id: string;
  txHash?: string;
  payoutReference?: string;
  providerReference?: string;
  confidence: ReconciliationConfidence;
  /** Normalized amount in minor units (string) when determinable. */
  amountMinor?: string;
  currency?: string;
  /** True only when confidence is `matched`; never auto-settle otherwise. */
  autoSettled: boolean;
  reasons: string[];
  contractEvent?: ContractPayoutEvent;
  internalRecord?: InternalPayoutRecord;
  providerEvidence?: ProviderPayoutEvidence;
  createdAt: string;
}

export interface ReconciliationInput {
  contractEvents?: ContractPayoutEvent[];
  internalRecords?: InternalPayoutRecord[];
  providerEvidence?: ProviderPayoutEvidence[];
}

export interface ReconciliationResult {
  records: ReconciliationRecord[];
  /** Records that require manual review (ambiguous/unmatched/conflict). */
  reviewQueue: ReconciliationRecord[];
}

/**
 * Normalizes an amount to a canonical minor-unit string.
 * Accepts decimal strings, numbers and bigints. Rejects non-integer or
 * negative values so that fractional minor units never silently round.
 */
export function normalizeAmountMinor(
  amount: string | number | bigint,
): string | null {
  if (typeof amount === 'bigint') {
    return amount >= 0n ? amount.toString() : null;
  }
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) {
      return null;
    }
    return BigInt(amount).toString();
  }
  const trimmed = amount.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return BigInt(trimmed).toString();
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

export interface ReconciliationDecision {
  decision: ReconciliationDecisionType;
  currentStatus?: DomainPayoutStatus;
  targetStatus?: DomainPayoutStatus;
  effectiveStatus: DomainPayoutStatus;
  reason?: string;
}

export type ReconciliationAlertState =
  | 'OK'
  | 'PENDING_AGING'
  | 'FAILED_UNRESOLVED'
  | 'REVERSED_UNRESOLVED'
  | 'TOTALS_MISMATCH';

export interface ReconciliationSourceEvidence {
  providerReferences: string[];
  transactionHashes: string[];
  auditEntryIds: string[];
}

export interface UnresolvedPayoutRecord {
  payoutReference: string;
  status: DomainPayoutStatus;
  amountMinor: number;
  currency?: string;
  createdAt: string;
  providerReference?: string;
  transactionHash?: string;
  auditEntryIds?: string[];
}

export interface ReconciliationSloEntry {
  payoutReference: string;
  status: DomainPayoutStatus;
  ageSeconds: number;
  ageHours: number;
  amountAtRiskMinor: number;
  currency?: string;
  nextAction: string;
  alertState: ReconciliationAlertState;
  runbookUrl: string;
  evidence: ReconciliationSourceEvidence;
}

export interface ReconciliationSloThresholds {
  pendingAgingSeconds: number;
  failedUnresolvedSeconds: number;
  reversedUnresolvedSeconds: number;
}

export const DEFAULT_RECONCILIATION_SLO_THRESHOLDS: ReconciliationSloThresholds =
  {
    pendingAgingSeconds: 60 * 60,
    failedUnresolvedSeconds: 24 * 60 * 60,
    reversedUnresolvedSeconds: 24 * 60 * 60,
  };

export const RECONCILIATION_RUNBOOK_BASE_URL =
  'https://github.com/Dechat/dex_with_fiat_frontend/blob/main/docs/runbooks/payout-reconciliation.md';

export function getRunbookUrlForAlertState(
  alertState: ReconciliationAlertState,
): string {
  const anchorByState: Record<ReconciliationAlertState, string> = {
    OK: 'healthy-state',
    PENDING_AGING: 'pending-payout-aging',
    FAILED_UNRESOLVED: 'failed-payout-unresolved',
    REVERSED_UNRESOLVED: 'reversed-payout-unresolved',
    TOTALS_MISMATCH: 'reconciliation-totals-mismatch',
  };
  return `${RECONCILIATION_RUNBOOK_BASE_URL}#${anchorByState[alertState]}`;
}

export interface ReconciliationTotals {
  pendingCount: number;
  pendingAmountMinor: number;
  failedCount: number;
  failedAmountMinor: number;
  atRiskCount: number;
  atRiskAmountMinor: number;
}

export interface ReconciliationTotalsMismatch {
  field: keyof ReconciliationTotals;
  expected: number;
  actual: number;
  delta: number;
}

export interface ReconciliationTotalsVerification {
  ok: boolean;
  computed: ReconciliationTotals;
  db: ReconciliationTotals;
  mismatches: ReconciliationTotalsMismatch[];
  runbookUrl: string;
}

export class PayoutReconciliationService {
  private rejectedEvents: RejectedEventRecord[] = [];
  private webhookEvents: PayoutWebhookEventRecord[] = [];
  private storageFilePath: string | null = null;
  private webhookEventsFilePath: string | null = null;
  private auditLedger: PayoutAuditLedger;

  constructor(storageDir?: string, auditLedgerInstance?: PayoutAuditLedger) {
    this.auditLedger = auditLedgerInstance || payoutAuditLedger;
    const dir = storageDir || process.env.PAYOUT_DATA_DIR;
    if (dir) {
      this.initStorage(dir);
    }
  }

  public initStorage(storageDir: string): void {
    try {
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }
      this.storageFilePath = path.join(
        storageDir,
        'payout_rejected_events.jsonl',
      );
      this.webhookEventsFilePath = path.join(
        storageDir,
        'payout_webhook_events.jsonl',
      );
      this.loadFromFile();
      this.loadWebhookEvents();
    } catch (err) {
      console.warn('Failed to initialize reconciliation storage:', err);
    }
  }

  private loadWebhookEvents(): void {
    if (
      !this.webhookEventsFilePath ||
      !fs.existsSync(this.webhookEventsFilePath)
    ) {
      return;
    }

    try {
      const data = fs.readFileSync(this.webhookEventsFilePath, 'utf8');
      this.webhookEvents = data
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as PayoutWebhookEventRecord);
    } catch (err) {
      console.warn('Failed to load webhook event ordering data:', err);
    }
  }

  private appendWebhookEvent(record: PayoutWebhookEventRecord): void {
    this.webhookEvents.push(record);
    if (!this.webhookEventsFilePath) return;

    try {
      fs.appendFileSync(
        this.webhookEventsFilePath,
        `${JSON.stringify(record)}\n`,
        'utf8',
      );
    } catch (err) {
      console.error('Failed to persist webhook event ordering data:', err);
      this.webhookEvents.pop();
      throw err;
    }
  }

  private loadFromFile(): void {
    if (!this.storageFilePath || !fs.existsSync(this.storageFilePath)) {
      return;
    }

    try {
      const data = fs.readFileSync(this.storageFilePath, 'utf8');
      const lines = data.split('\n').filter((l) => l.trim().length > 0);
      this.rejectedEvents = lines.map(
        (l) => JSON.parse(l) as RejectedEventRecord,
      );
    } catch (err) {
      console.warn('Failed to load rejected events from disk:', err);
    }
  }

  private appendRejectedRecord(record: RejectedEventRecord): void {
    this.rejectedEvents.push(record);
    if (!this.storageFilePath) return;

    try {
      fs.appendFileSync(
        this.storageFilePath,
        JSON.stringify(record) + '\n',
        'utf8',
      );
    } catch (err) {
      console.error('Failed to append rejected event to disk:', err);
    }
  }

  /**
   * Maps incoming provider event string to domain payout status.
   */
  public mapEventToStatus(eventType: string): DomainPayoutStatus | null {
    switch (eventType) {
      case 'transfer.success':
        return 'success';
      case 'transfer.failed':
        return 'failed';
      case 'transfer.reversed':
        return 'reversed';
      default:
        return null;
    }
  }

  /**
   * Determines if transition from currentStatus to targetStatus satisfies
   * monotonic precedence rules.
   */
  public evaluateTransition(
    currentStatus: DomainPayoutStatus | undefined,
    targetStatus: DomainPayoutStatus,
  ): { allowed: boolean; reason?: string } {
    if (!currentStatus) {
      return { allowed: true };
    }

    if (currentStatus === targetStatus) {
      return { allowed: true, reason: 'IDEMPOTENT_SAME_STATE' };
    }

    // Monotonic domain rules:
    // 1. Terminal / reversed state cannot regress to anything else
    if (currentStatus === 'reversed') {
      return {
        allowed: false,
        reason: `Monotonic violation: payout is already reversed and cannot transition to ${targetStatus}`,
      };
    }

    // 2. Settled success can only transition to reversed
    if (currentStatus === 'success') {
      if (targetStatus === 'reversed') {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `Monotonic violation: settled payout cannot regress to ${targetStatus}`,
      };
    }

    // 3. Terminal failure cannot regress to pending or settled
    if (currentStatus === 'failed') {
      return {
        allowed: false,
        reason: `Monotonic violation: failed payout cannot regress to ${targetStatus}`,
      };
    }

    // 4. Pending can transition to success, failed, reversed, or cancelled
    if (currentStatus === 'pending') {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Invalid transition from ${currentStatus} to ${targetStatus}`,
    };
  }

  /**
   * Reconciles an incoming provider event against current payout state.
   */
  public reconcileEvent(params: {
    eventId: string;
    payoutReference: string;
    eventType: string;
    currentStatus?: DomainPayoutStatus;
    payload?: Record<string, unknown>;
    correlationId?: string;
    providerEventAt?: string;
    receivedAt?: string;
  }): ReconciliationDecision {
    const {
      eventId,
      payoutReference,
      eventType,
      currentStatus,
      payload,
      correlationId,
      providerEventAt,
      receivedAt,
    } = params;
    const targetStatus = this.mapEventToStatus(eventType);
    const received = receivedAt ? new Date(receivedAt) : new Date();
    const providerTime = providerEventAt ? new Date(providerEventAt) : received;
    if (
      !Number.isFinite(received.getTime()) ||
      !Number.isFinite(providerTime.getTime())
    ) {
      throw new Error('Webhook event and receipt times must be valid dates');
    }
    const eventTimestamp = providerTime.toISOString();
    const receiptTimestamp = received.toISOString();
    const payoutEvents = this.webhookEvents.filter(
      (event) => event.payoutReference === payoutReference,
    );
    const initialStatus =
      payoutEvents[0]?.initialStatus ?? currentStatus ?? 'pending';

    if (!targetStatus) {
      this.appendWebhookEvent({
        eventId,
        payoutReference,
        eventType,
        decision: 'UNRECOGNIZED_EVENT',
        initialStatus,
        effectiveStatus: currentStatus ?? initialStatus,
        providerEventAt: eventTimestamp,
        receivedAt: receiptTimestamp,
      });
      return {
        decision: 'UNRECOGNIZED_EVENT',
        currentStatus,
        effectiveStatus: currentStatus || 'pending',
        reason: `Unrecognized event type: ${eventType}`,
      };
    }

    const latestEvent = payoutEvents.reduce<
      PayoutWebhookEventRecord | undefined
    >(
      (latest, event) =>
        !latest || this.compareEventOrder(event, latest) > 0 ? event : latest,
      undefined,
    );
    const candidate: PayoutWebhookEventRecord = {
      eventId,
      payoutReference,
      eventType,
      targetStatus,
      decision: 'APPLIED',
      initialStatus,
      effectiveStatus: initialStatus,
      providerEventAt: eventTimestamp,
      receivedAt: receiptTimestamp,
    };
    const orderedEvents = [...payoutEvents, candidate]
      .filter((event) => event.targetStatus)
      .sort((left, right) => this.compareEventOrder(left, right));
    let effectiveStatus = initialStatus;
    let candidateAllowed = false;
    let candidateRejectionReason: string | undefined;
    for (const event of orderedEvents) {
      const eventTarget = event.targetStatus!;
      const transition = this.evaluateTransition(effectiveStatus, eventTarget);
      const allowed =
        transition.allowed ||
        (effectiveStatus === 'failed' && eventTarget === 'success');
      if (allowed) {
        effectiveStatus = eventTarget;
        if (event === candidate) candidateAllowed = true;
      } else if (event === candidate) {
        candidateRejectionReason = transition.reason;
      }
    }

    candidate.effectiveStatus = effectiveStatus;
    const isDuplicate = payoutEvents.some((event) => event.eventId === eventId);
    const isOlderThanLatest =
      latestEvent && this.compareEventOrder(candidate, latestEvent) <= 0;
    const reject = (reason: string): ReconciliationDecision => {
      candidate.decision = 'REJECTED_OUT_OF_ORDER';
      this.appendWebhookEvent(candidate);
      this.appendRejectedRecord({
        id: `rej_${Date.now()}_${eventId}`,
        eventId,
        payoutReference,
        eventType,
        currentStatus,
        targetStatus,
        reason,
        payload: payload || {},
        timestamp: receiptTimestamp,
        providerEventAt: eventTimestamp,
        receivedAt: receiptTimestamp,
      });
      this.auditLedger.recordEvent({
        payoutId: payoutReference,
        action: 'payout_event_rejected',
        actor: 'system:reconciliation',
        requestCorrelationId: correlationId || eventId,
        providerReference: eventId,
        metadata: { eventId, eventType, currentStatus, targetStatus, reason },
      });
      return {
        decision: 'REJECTED_OUT_OF_ORDER',
        currentStatus,
        targetStatus,
        effectiveStatus,
        reason,
      };
    };

    if (isDuplicate) {
      return reject('Webhook event identifier has already been processed');
    }
    if (!candidateAllowed) {
      return reject(
        candidateRejectionReason || 'Out-of-order transition rejected',
      );
    }
    if (isOlderThanLatest && effectiveStatus === (currentStatus ?? 'pending')) {
      return reject(
        'Webhook event is older than or duplicates the latest provider event',
      );
    }

    if (effectiveStatus === (currentStatus ?? 'pending')) {
      candidate.decision = 'IDEMPOTENT_NOOP';
      this.appendWebhookEvent(candidate);
      return {
        decision: 'IDEMPOTENT_NOOP',
        currentStatus,
        targetStatus,
        effectiveStatus,
        reason: 'Current state already matches event status',
      };
    }

    // Transition is allowed: audit record is created for domain action
    let auditAction: 'payout_succeeded' | 'payout_failed' | 'payout_reversed' =
      effectiveStatus === 'success' ? 'payout_succeeded' : 'payout_failed';
    if (effectiveStatus === 'reversed') auditAction = 'payout_reversed';

    this.auditLedger.recordEvent({
      payoutId: payoutReference,
      action: auditAction,
      actor: `webhook:${eventType}`,
      requestCorrelationId: correlationId || eventId,
      providerReference: eventId,
      metadata: {
        eventId,
        eventType,
        previousStatus: currentStatus,
        newStatus: effectiveStatus,
      },
    });
    this.appendWebhookEvent(candidate);

    return {
      decision: 'APPLIED',
      currentStatus,
      targetStatus,
      effectiveStatus,
    };
  }

  private compareEventOrder(
    left: PayoutWebhookEventRecord,
    right: PayoutWebhookEventRecord,
  ): number {
    const timeDifference =
      new Date(left.providerEventAt).getTime() -
      new Date(right.providerEventAt).getTime();
    if (timeDifference !== 0) return timeDifference;

    const priority: Record<DomainPayoutStatus, number> = {
      pending: 0,
      failed: 1,
      cancelled: 1,
      success: 2,
      reversed: 3,
    };
    const priorityDifference =
      priority[left.targetStatus ?? 'pending'] -
      priority[right.targetStatus ?? 'pending'];
    if (priorityDifference !== 0) return priorityDifference;
    return left.eventId.localeCompare(right.eventId);
  }

  public getWebhookEvents(
    payoutReference?: string,
  ): PayoutWebhookEventRecord[] {
    return payoutReference
      ? this.webhookEvents.filter(
          (event) => event.payoutReference === payoutReference,
        )
      : [...this.webhookEvents];
  }

  /**
   * Retrieve stored rejected or deferred events for investigation.
   */
  public getRejectedEvents(filter?: {
    eventId?: string;
    payoutReference?: string;
  }): RejectedEventRecord[] {
    let result = [...this.rejectedEvents];
    if (filter?.eventId) {
      result = result.filter((r) => r.eventId === filter.eventId);
    }
    if (filter?.payoutReference) {
      result = result.filter(
        (r) => r.payoutReference === filter.payoutReference,
      );
    }
    return result;
  }

  /**
   * Resolves signed webhook, provider polling, and imported statement evidence.
   * Conflicting evidence is persisted for review and never silently overwrites
   * the effective status.
   */
  public reconcileEvidence(params: {
    payoutReference: string;
    evidence: PayoutEvidence[];
  }): PayoutEvidenceResolution {
    const resolution = payoutEvidenceConflictResolver.resolve(params);
    if (resolution.conflict) {
      this.auditLedger.recordEvent({
        payoutId: params.payoutReference,
        action: 'payout_event_rejected',
        actor: 'system:evidence-resolution',
        requestCorrelationId: resolution.conflictId,
        providerReference: resolution.effectiveStatus,
        metadata: {
          conflictId: resolution.conflictId,
          effectiveStatus: resolution.effectiveStatus,
          precedenceSource: resolution.precedenceSource,
          evidenceSources: params.evidence.map((item) => item.source),
          reason: resolution.reason,
        },
      });
    }
    return resolution;
  }

  public getEvidenceConflicts(payoutReference?: string) {
    return payoutEvidenceConflictResolver.getConflicts(payoutReference);
  }

  public _resetForTest(newDir?: string): void {
    this.rejectedEvents = [];
    this.webhookEvents = [];
    this.storageFilePath = null;
    this.webhookEventsFilePath = null;
    if (newDir) {
      this.initStorage(newDir);
    }
  }
}

export interface RestoredEvidenceRecord {
  payoutReference: string;
  status: DomainPayoutStatus;
  eventId?: string;
  timestamp?: string;
}

export interface ActivePayoutState {
  payoutReference: string;
  status: DomainPayoutStatus;
}

export type RestoredEvidenceMismatchType =
  | 'MISSING_ACTIVE_PAYOUT'
  | 'STATUS_MISMATCH';

export interface RestoredEvidenceMismatch {
  payoutReference: string;
  type: RestoredEvidenceMismatchType;
  restoredStatus: DomainPayoutStatus;
  activeStatus?: DomainPayoutStatus;
  reason: string;
}

export interface RestoredEvidenceReconciliationResult {
  reconciled: boolean;
  checkedCount: number;
  matchedCount: number;
  mismatches: RestoredEvidenceMismatch[];
}

/**
 * Compares restored evidence records against active payout state to prove
 * that an import reconciles to the live domain state. Any restored record
 * without a matching active payout, or whose status diverges from the active
 * payout status, is reported as a mismatch.
 */
export function reconcileRestoredEvidence(
  restored: RestoredEvidenceRecord[],
  activePayouts: ActivePayoutState[],
): RestoredEvidenceReconciliationResult {
  const activeByReference = new Map<string, DomainPayoutStatus>();
  for (const active of activePayouts) {
    activeByReference.set(active.payoutReference, active.status);
  }

  const mismatches: RestoredEvidenceMismatch[] = [];
  let matchedCount = 0;

  for (const record of restored) {
    const activeStatus = activeByReference.get(record.payoutReference);

    if (activeStatus === undefined) {
      mismatches.push({
        payoutReference: record.payoutReference,
        type: 'MISSING_ACTIVE_PAYOUT',
        restoredStatus: record.status,
        reason: `Restored evidence references payout ${record.payoutReference} which has no active payout state`,
      });
      continue;
    }

    if (activeStatus !== record.status) {
      mismatches.push({
        payoutReference: record.payoutReference,
        type: 'STATUS_MISMATCH',
        restoredStatus: record.status,
        activeStatus,
        reason: `Restored status ${record.status} does not match active status ${activeStatus} for payout ${record.payoutReference}`,
      });
      continue;
    }

    matchedCount += 1;
  }

  return {
    reconciled: mismatches.length === 0,
    checkedCount: restored.length,
    matchedCount,
    mismatches,
  };
}

export const payoutReconciliationService = new PayoutReconciliationService();

/*
 * Threat-model coverage map (see docs/payout-threat-model.md):
 *
 * - TM-RECON-1 (out-of-order / replay regression): a provider event that would
 *   regress a settled or reversed payout is rejected and persisted for
 *   investigation. Covered by "rejects out-of-order transitions" tests.
 * - TM-RECON-2 (duplicate delivery / idempotency): re-delivering the same
 *   terminal event must be a no-op and must not mutate state. Covered by
 *   "treats duplicate terminal events as idempotent no-ops".
 * - TM-RECON-3 (unrecognized / spoofed event types): unknown event types are
 *   never applied and never reach the audit ledger as domain actions. Covered
 *   by "ignores unrecognized event types".
 * - TM-RECON-4 (audit trail integrity): every rejected event is recorded in the
 *   immutable audit ledger with the provider reference and reason so finance
 *   can reconcile. Covered by "records rejected events in the audit ledger".
 *
 * All fixtures use synthetic payout references (e.g. "po_test_...") and never
 * contain real user data or credentials.
 */
export interface ReconciliationThreatCase {
  id: string;
  description: string;
  run: (service: PayoutReconciliationService) => void;
}

export function buildReconciliationThreatCases(): ReconciliationThreatCase[] {
  return [
    {
      id: 'TM-RECON-1',
      description:
        'Out-of-order event attempting to regress a settled payout is rejected',
      run: (service) => {
        const decision = service.reconcileEvent({
          eventId: 'evt_test_regress_001',
          payoutReference: 'po_test_regress_001',
          eventType: 'transfer.failed',
          currentStatus: 'success',
        });
        if (decision.decision !== 'REJECTED_OUT_OF_ORDER') {
          throw new Error(
            `Expected REJECTED_OUT_OF_ORDER, got ${decision.decision}`,
          );
        }
        if (decision.effectiveStatus !== 'success') {
          throw new Error(
            `Effective status must remain success, got ${decision.effectiveStatus}`,
          );
        }
      },
    },
    {
      id: 'TM-RECON-2',
      description: 'Duplicate terminal event is an idempotent no-op',
      run: (service) => {
        const decision = service.reconcileEvent({
          eventId: 'evt_test_dup_001',
          payoutReference: 'po_test_dup_001',
          eventType: 'transfer.success',
          currentStatus: 'success',
        });
        if (decision.decision !== 'IDEMPOTENT_NOOP') {
          throw new Error(
            `Expected IDEMPOTENT_NOOP, got ${decision.decision}`,
          );
        }
        if (decision.effectiveStatus !== 'success') {
          throw new Error(
            `Effective status must remain success, got ${decision.effectiveStatus}`,
          );
        }
      },
    },
    {
      id: 'TM-RECON-3',
      description: 'Unrecognized event type is never applied',
      run: (service) => {
        const decision = service.reconcileEvent({
          eventId: 'evt_test_unknown_001',
          payoutReference: 'po_test_unknown_001',
          eventType: 'transfer.spoofed',
          currentStatus: 'pending',
        });
        if (decision.decision !== 'UNRECOGNIZED_EVENT') {
          throw new Error(
            `Expected UNRECOGNIZED_EVENT, got ${decision.decision}`,
          );
        }
        if (decision.effectiveStatus !== 'pending') {
          throw new Error(
            `Effective status must remain pending, got ${decision.effectiveStatus}`,
          );
        }
      },
    },
    {
      id: 'TM-RECON-4',
      description: 'Rejected events are persisted for audit investigation',
      run: (service) => {
        service.reconcileEvent({
          eventId: 'evt_test_audit_001',
          payoutReference: 'po_test_audit_001',
          eventType: 'transfer.reversed',
          currentStatus: 'reversed',
        });
        service.reconcileEvent({
          eventId: 'evt_test_audit_002',
          payoutReference: 'po_test_audit_001',
          eventType: 'transfer.success',
          currentStatus: 'reversed',
        });
        const rejected = service.getRejectedEvents({
          payoutReference: 'po_test_audit_001',
        });
        if (rejected.length !== 1) {
          throw new Error(
            `Expected 1 rejected event, got ${rejected.length}`,
          );
        }
        if (rejected[0].eventId !== 'evt_test_audit_002') {
          throw new Error(
            `Unexpected rejected event id ${rejected[0].eventId}`,
          );
        }
      },
    },
  ];
}

export function reconcileEvidence(params: {
  payoutReference: string;
  evidence: PayoutEvidence[];
}): PayoutEvidenceResolution {
  return payoutReconciliationService.reconcileEvidence(params);
}

export async function reconcileStalePayouts(params?: {
  staleAgeMs?: number;
  batchSize?: number;
}): Promise<{
  processed: number;
  transitioned: number;
  noChange: number;
  providerUnavailable: number;
  conflicts: number;
  errors: number;
  results: Array<{
    payoutReference: string;
    outcome:
      | 'transitioned'
      | 'no_change'
      | 'provider_unavailable'
      | 'conflict'
      | 'error';
  }>;
  timestamp: number;
}> {
  const staleAgeMs = params?.staleAgeMs ?? 5 * 60 * 1000;
  const batchSize = params?.batchSize ?? 25;
  const now = Date.now();
  const candidates = getAllTransfers()
    .filter(
      (record) =>
        record.status !== 'success' &&
        record.status !== 'failed' &&
        record.status !== 'reversed' &&
        record.status !== 'cancelled' &&
        now - Date.parse(record.updatedAt) >= staleAgeMs,
    )
    .slice(0, batchSize);

  const summary = {
    processed: candidates.length,
    transitioned: 0,
    noChange: 0,
    providerUnavailable: 0,
    conflicts: 0,
    errors: 0,
    results: [] as Array<{
      payoutReference: string;
      outcome:
        | 'transitioned'
        | 'no_change'
        | 'provider_unavailable'
        | 'conflict'
        | 'error';
    }>,
    timestamp: now,
  };

  for (const record of candidates) {
    try {
      const provider = getPayoutProvider();
      const providerStatus = await provider.checkTransferStatus({
        reference: record.reference,
      });
      const resolution = payoutReconciliationService.reconcileEvidence({
        payoutReference: record.reference,
        evidence: [
          {
            source: 'provider_poll',
            status: providerStatus.status,
            observedAt: new Date().toISOString(),
            reference: record.reference,
            evidenceId: providerStatus.providerReference || record.reference,
            amountMinor: providerStatus.amountMinor?.toString(),
            currency: providerStatus.currency,
          },
        ],
      });

      if (resolution.conflict) {
        summary.conflicts++;
        summary.results.push({
          payoutReference: record.reference,
          outcome: 'conflict',
        });
        continue;
      }

      if (resolution.effectiveStatus === record.status) {
        summary.noChange++;
        summary.results.push({
          payoutReference: record.reference,
          outcome: 'no_change',
        });
        continue;
      }

      setTransferStatus({
        ...record,
        status: resolution.effectiveStatus,
        updatedAt: new Date().toISOString(),
      });
      summary.transitioned++;
      summary.results.push({
        payoutReference: record.reference,
        outcome: 'transitioned',
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.toLowerCase().includes('unavailable') ||
          error.message.toLowerCase().includes('timeout'))
      ) {
        summary.providerUnavailable++;
        summary.results.push({
          payoutReference: record.reference,
          outcome: 'provider_unavailable',
        });
      } else {
        summary.errors++;
        summary.results.push({
          payoutReference: record.reference,
          outcome: 'error',
        });
      }
    }
  }

  return summary;
}
}
