import { NextRequest, NextResponse } from 'next/server';
import { ReconciliationRecord } from '@/types';
import { requireAdminAuth } from '../_utils/requireAdminAuth';
import { enforceAdminIpAllowlist } from '@/lib/security';
import { reconcileStalePayouts } from '@/lib/payout/reconciliation';
import { buildReadModelFreshness } from '@/lib/readModelFreshness';

export async function GET(request: NextRequest) {
  try {
    const blockedResponse = enforceAdminIpAllowlist(request);
    if (blockedResponse) return blockedResponse;

    const authError = requireAdminAuth(request);
    if (authError) {
      return authError;
    }

    // Read-only reconciliation job by default (Issue #39)
    const deposits = reconciliationStore.getDeposits();
    const payouts = reconciliationStore.getPayouts();
    const report = reconcileRecords(deposits, payouts);

    // Read-model freshness metadata (Issue #249): expose the source ledger
    // cursor and database update time so stale projections are never
    // represented as confirmed settlement state.
    const freshness = await buildReadModelFreshness({
      dbUpdatedAt: report.evaluatedAt,
    });

    // If caller requests structured report format
    const format = request.nextUrl.searchParams.get('format');
    if (format === 'report') {
      return NextResponse.json({
        ...serializeReconciliationReport(report),
        freshness,
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

    for (const dup of report.duplicated) {
      for (const d of dup.deposits) {
        records.push({
          id: String(counter++),
          depositTxHash: d.txHash,
          depositAmount: fromMinorUnits(d.amountMinor, d.currency),
          depositUser: d.wallet,
          depositDate: d.timestamp,
          payoutId: dup.payouts[0]?.payoutId || '',
          payoutAmount: dup.payouts[0]
            ? fromMinorUnits(
                dup.payouts[0].amountMinor,
                dup.payouts[0].currency,
              )
            : '',
          payoutRecipient: dup.payouts[0]?.recipient || '',
          payoutStatus: dup.payouts[0]?.payoutStatus || 'pending',
          payoutDate: dup.payouts[0]?.payoutDate || '',
          status: 'error',
        });
      }
    }

    return NextResponse.json({ data: records, freshness });
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
