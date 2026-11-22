import fs from 'fs';
import path from 'path';
import { payoutAuditLedger, PayoutAuditLedger } from './auditLedger';

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

export interface ReconciliationDecision {
  decision: ReconciliationDecisionType;
  currentStatus?: DomainPayoutStatus;
  targetStatus?: DomainPayoutStatus;
  effectiveStatus: DomainPayoutStatus;
  reason?: string;
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

export const payoutReconciliationService = new PayoutReconciliationService();
