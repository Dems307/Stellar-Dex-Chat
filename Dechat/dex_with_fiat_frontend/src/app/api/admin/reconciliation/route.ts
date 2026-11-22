import { NextRequest, NextResponse } from 'next/server';
import { ReconciliationRecord } from '@/types';
import { requireAdminAuth } from '../_utils/requireAdminAuth';
import { enforceAdminIpAllowlist } from '@/lib/security';
import {
  reconcileStalePayouts,
  payoutReconciliationService,
} from '@/lib/payout/reconciliation';
import { getAllTransfers } from '@/lib/transferStore';

/**
 * Reconciliation SLO metadata attached to each admin record (Issue #241).
 * Provides operators with age, amount at risk, next action, source evidence
 * and a runbook link for unresolved payouts.
 */
export interface ReconciliationSloFields {
  ageSeconds: number | null;
  amountAtRisk: string;
  nextAction: string;
  sourceEvidence: string;
  runbookUrl: string;
}

export type ReconciliationRecordWithSlo = ReconciliationRecord &
  ReconciliationSloFields;

export interface ReconciliationTotals {
  matched: number;
  unmatchedDeposits: number;
  unmatchedPayouts: number;
  amountMismatched: number;
  duplicated: number;
  totalRecords: number;
  unresolved: number;
  amountAtRiskTotal: string;
  dbVerified: boolean;
  mismatch: boolean;
  verification?: ReconciliationVerification;
}

export interface ReconciliationVerification {
  expected: {
    matched: number;
    unmatchedDeposits: number;
    unmatchedPayouts: number;
    amountMismatched: number;
    duplicated: number;
    totalRecords: number;
  };
  actual: {
    matched: number;
    unmatchedDeposits: number;
    unmatchedPayouts: number;
    amountMismatched: number;
    duplicated: number;
    totalRecords: number;
  };
  mismatch: boolean;
}

const RUNBOOK_BASE_URL =
  process.env.RECONCILIATION_RUNBOOK_BASE_URL ||
  'https://docs.dechat.example/runbooks/reconciliation';

const SLO_UNRESOLVED_AGE_SECONDS = Number(
  process.env.RECONCILIATION_SLO_UNRESOLVED_AGE_SECONDS || 3600,
);

function runbookUrl(anchor: string): string {
  return `${RUNBOOK_BASE_URL.replace(/\/$/, '')}#${anchor}`;
}

function computeAgeSeconds(timestamp: string | undefined | null): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  const ageSeconds = Math.floor((Date.now() - parsed) / 1000);
  return ageSeconds < 0 ? 0 : ageSeconds;
}

function nextActionForStatus(
  status: ReconciliationRecord['status'],
  hasDeposit: boolean,
  hasPayout: boolean,
): { nextAction: string; anchor: string } {
  if (status === 'matched') {
    return { nextAction: 'none', anchor: 'matched' };
  }
  if (status === 'error') {
    return {
      nextAction: 'investigate-amount-mismatch',
      anchor: 'amount-mismatch',
    };
  }
  if (hasDeposit && !hasPayout) {
    return { nextAction: 'investigate-missing-payout', anchor: 'missing-payout' };
  }
  if (!hasDeposit && hasPayout) {
    return {
      nextAction: 'investigate-missing-deposit',
      anchor: 'missing-deposit',
    };
  }
  return { nextAction: 'investigate-unmatched', anchor: 'unmatched' };
}

function attachSlo(
  record: ReconciliationRecord,
  amountAtRisk: string,
): ReconciliationRecordWithSlo {
  const hasDeposit = Boolean(record.depositTxHash);
  const hasPayout = Boolean(record.payoutId);
  const { nextAction, anchor } = nextActionForStatus(
    record.status,
    hasDeposit,
    hasPayout,
  );
  const ageSeconds = computeAgeSeconds(
    record.payoutDate || record.depositDate || null,
  );
  const sourceEvidence = [
    record.depositTxHash ? `deposit:${record.depositTxHash}` : null,
    record.payoutId ? `payout:${record.payoutId}` : null,
  ]
    .filter(Boolean)
    .join('|');

  return {
    ...record,
    ageSeconds,
    amountAtRisk,
    nextAction,
    sourceEvidence,
    runbookUrl: runbookUrl(anchor),
  };
}

function toMinorUnits(amount: string): number {
  if (!amount) return 0;
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

function fromMinorUnitsSafe(minor: number): string {
  return (minor / 100).toFixed(2);
}

function isUnresolved(record: ReconciliationRecord): boolean {
  return record.status !== 'matched';
}

function isPastSlo(record: ReconciliationRecordWithSlo): boolean {
  return (
    isUnresolved(record) &&
    record.ageSeconds !== null &&
    record.ageSeconds > SLO_UNRESOLVED_AGE_SECONDS
  );
}

function buildVerification(
  report: ReturnType<typeof reconcileRecords>,
  records: ReconciliationRecordWithSlo[],
): ReconciliationVerification {
  const expected = {
    matched: report.matched.length,
    unmatchedDeposits: report.unmatched.depositsWithoutPayout.length,
    unmatchedPayouts: report.unmatched.payoutsWithoutDeposit.length,
    amountMismatched: report.amountMismatched.length,
    duplicated: report.duplicated.length,
    totalRecords: records.length,
  };
  const actual = {
    matched: records.filter((r) => r.status === 'matched').length,
    unmatchedDeposits: records.filter(
      (r) => r.status === 'unmatched' && r.depositTxHash && !r.payoutId,
    ).length,
    unmatchedPayouts: records.filter(
      (r) => r.status === 'unmatched' && !r.depositTxHash && r.payoutId,
    ).length,
    amountMismatched: records.filter(
      (r) => r.status === 'error' && r.depositTxHash && r.payoutId,
    ).length,
    duplicated: report.duplicated.length,
    totalRecords: records.length,
  };
  const mismatch =
    expected.matched !== actual.matched ||
    expected.unmatchedDeposits !== actual.unmatchedDeposits ||
    expected.unmatchedPayouts !== actual.unmatchedPayouts ||
    expected.amountMismatched !== actual.amountMismatched ||
    expected.totalRecords !== actual.totalRecords;
  return { expected, actual, mismatch };
}

export async function GET(request: NextRequest) {
  try {
    const blockedResponse = enforceAdminIpAllowlist(request);
    if (blockedResponse) return blockedResponse;

    const authError = requireAdminAuth(request);
    if (authError) {
      return authError;
    }

    const format = request.nextUrl.searchParams.get('format');
    if (format === 'conflicts') {
      return NextResponse.json({
        conflicts: payoutReconciliationService.getEvidenceConflicts(),
      });
    }

    // Read-only dashboard view from the in-memory transfer store.
    const records: ReconciliationRecord[] = [];
    let counter = 1;

    for (const payout of getAllTransfers()) {
      const payoutStatus =
        payout.status === 'success'
          ? 'completed'
          : payout.status === 'reversed'
            ? 'warning'
            : payout.status === 'initiated'
              ? 'pending'
              : payout.status;
      records.push({
        id: String(counter++),
        depositTxHash: '',
        depositAmount: '',
        depositUser: '',
        depositDate: payout.updatedAt,
        payoutId: payout.reference,
        payoutAmount:
          payout.amountMinor?.toString() ?? String(payout.amount || ''),
        payoutRecipient: '',
        payoutStatus,
        payoutDate: payout.updatedAt,
        status: payout.status === 'failed' ? 'error' : 'matched',
      });
    }

    return NextResponse.json(records);
  } catch (error) {
    console.error('Error fetching reconciliation data:', error);
    return NextResponse.json(
      { error: 'Failed to fetch reconciliation data' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const blockedResponse = enforceAdminIpAllowlist(request);
    if (blockedResponse) return blockedResponse;

    const authError = requireAdminAuth(request);
    if (authError) {
      return authError;
    }

    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      // Body is optional; default to empty object
    }

    const staleAgeMs =
      typeof body.staleAgeMs === 'number' ? body.staleAgeMs : undefined;
    const batchSize =
      typeof body.batchSize === 'number' ? body.batchSize : undefined;

    if (
      body.batchSize !== undefined &&
      (typeof body.batchSize !== 'number' ||
        !Number.isFinite(body.batchSize) ||
        body.batchSize <= 0)
    ) {
      return NextResponse.json(
        { error: 'batchSize must be a positive number' },
        { status: 400 },
      );
    }

    if (
      body.staleAgeMs !== undefined &&
      (typeof body.staleAgeMs !== 'number' ||
        !Number.isFinite(body.staleAgeMs) ||
        body.staleAgeMs < 0)
    ) {
      return NextResponse.json(
        { error: 'staleAgeMs must be a non-negative number' },
        { status: 400 },
      );
    }

    const summary = await reconcileStalePayouts({
      staleAgeMs,
      batchSize,
    });

    // Cross-source reconciliation pass. This is classification only: it
    // never settles ambiguous/unmatched/conflict entries. Callers must
    // review the queue before any settlement action.
    const crossSource = reconcileCrossSource({
      contractEvents: reconciliationStore.getContractEvents?.() ?? [],
      payoutRecords: reconciliationStore.getPayoutRecords?.() ?? [],
      providerEvidence: reconciliationStore.getProviderEvidence?.() ?? [],
    });
    const confidenceCounts = countByConfidence(crossSource);
    const reviewQueue = buildReviewQueue(crossSource);

    return NextResponse.json({
      success: true,
      data: summary,
      crossSource: {
        confidenceCounts,
        reviewQueue,
        autoSettled: false,
      },
    });
  } catch (error) {
    console.error('Error running reconciliation:', error);
    return NextResponse.json(
      { error: 'Failed to run payout reconciliation' },
      { status: 500 },
    );
  }
}

// Mock data - in production, this would come from a database
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockReconciliationData: ReconciliationRecord[] = [
  {
    id: '1',
    depositTxHash: '0x123abc',
    depositAmount: '100.0',
    depositUser: 'GA123...',
    depositDate: '2026-03-20T10:00:00Z',
    payoutId: 'TRF_123456',
    payoutAmount: '100.0',
    payoutRecipient: 'Ada Synthetic - 0000006789',
    payoutStatus: 'completed',
    payoutDate: '2026-03-20T11:00:00Z',
    status: 'matched',
  },
  {
    id: '2',
    depositTxHash: '0x456def',
    depositAmount: '50.0',
    depositUser: 'GA456...',
    depositDate: '2026-03-21T14:30:00Z',
    payoutId: 'TRF_789012',
    payoutAmount: '50.0',
    payoutRecipient: 'Kojo Synthetic - 0000004321',
    payoutStatus: 'pending',
    payoutDate: '2026-03-21T15:00:00Z',
    status: 'matched',
  },
  {
    id: '3',
    depositTxHash: '0x789ghi',
    depositAmount: '25.0',
    depositUser: 'GA789...',
    depositDate: '2026-03-22T09:15:00Z',
    payoutId: '',
    payoutAmount: '',
    payoutRecipient: '',
    payoutStatus: 'pending',
    payoutDate: '',
    status: 'unmatched',
  },
  {
    id: '4',
    depositTxHash: '0xabcpqr',
    depositAmount: '75.0',
    depositUser: 'GAABC...',
    depositDate: '2026-03-23T16:45:00Z',
    payoutId: 'TRF_345678',
    payoutAmount: '70.0',
    payoutRecipient: 'Bob Wilson - 1122334455',
    payoutStatus: 'failed',
    payoutDate: '2026-03-23T17:00:00Z',
    status: 'error',
  },
];

// Re-exported for consumers that need the confidence state list.
export { CONFIDENCE_STATES };
