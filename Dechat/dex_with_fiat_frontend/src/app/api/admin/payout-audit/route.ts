import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '../_utils/requireAdminAuth';
import { payoutAuditLedger, PayoutAuditAction } from '@/lib/payout/auditLedger';
import {
  ADMIN_PAYOUT_AUDIT_CORS_POLICY,
  enforceCorsPolicy,
} from '@/lib/security/corsPolicy';
import {
  payoutAuditArchive,
  PayoutAuditArchiveManifest,
} from '@/lib/payout/auditArchive';

export async function GET(request: NextRequest) {
  const corsError = enforceCorsPolicy(request, ADMIN_PAYOUT_AUDIT_CORS_POLICY);
  if (corsError) {
    return corsError;
  }

  const authError = requireAdminAuth(request);
  if (authError) {
    return authError;
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const format = searchParams.get('format') || 'json';
    const verify = searchParams.get('verify') === 'true';
    const payoutId = searchParams.get('payoutId') || undefined;
    const action =
      (searchParams.get('action') as PayoutAuditAction) || undefined;
    const actor = searchParams.get('actor') || undefined;
    const providerReference =
      searchParams.get('providerReference') || undefined;
    const startDate = searchParams.get('startDate') || undefined;
    const endDate = searchParams.get('endDate') || undefined;
    // Optional: restrict the query to a single retention partition
    // ('hot' | 'archive'). Omitted means query across both partitions.
    const partitionParam = searchParams.get('partition');
    const partition =
      partitionParam === 'hot' || partitionParam === 'archive'
        ? partitionParam
        : undefined;

    const filter = {
      payoutId,
      action,
      actor,
      providerReference,
      startDate,
      endDate,
    };

    if (verify) {
      const verification = payoutAuditLedger.verifyChain();
      return NextResponse.json(verification, {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    }

    const manifest: PayoutAuditArchiveManifest =
      payoutAuditArchive.getManifest();

    if (format === 'csv') {
      const maxRows = Math.min(
        Math.max(Number(searchParams.get('maxRows') || 10000), 1),
        10000,
      );
      const csvData = payoutAuditLedger.exportCsv(filter, maxRows);
      return new NextResponse(csvData, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition':
            'attachment; filename="payout-audit-ledger.csv"',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'X-Audit-Archive-Version': manifest.version,
          'X-Audit-Archive-Hot-Count': String(manifest.hotCount),
          'X-Audit-Archive-Archived-Count': String(manifest.archivedCount),
        },
      });
    }

    const page = Math.max(Number(searchParams.get('page') || 1), 1);
    const limit = Math.min(
      Math.max(Number(searchParams.get('limit') || 20), 1),
      100,
    );

    // Pagination is computed over the merged hot+archive view so cursors stay
    // stable across the archival boundary. The manifest version is surfaced so
    // clients can detect when a new archival run has shifted the boundary.
    const result = payoutAuditLedger.getEntries(filter, {
      page,
      limit,
      partition,
    });

    // Read-model freshness: expose the source ledger cursor and the latest
    // audit entry timestamp so clients never present stale projections as
    // confirmed settlement state.
    const latestEntry = result.entries.reduce<{ timestamp?: string } | null>(
      (latest, entry) => {
        const timestamp = (entry as { timestamp?: string }).timestamp;
        if (!timestamp) return latest;
        if (!latest?.timestamp) return { timestamp };
        return new Date(timestamp).getTime() >
          new Date(latest.timestamp).getTime()
          ? { timestamp }
          : latest;
      },
      null,
    );

    const freshness = buildFreshnessMetadata({
      dbUpdatedAt: latestEntry?.timestamp ?? null,
    });

    // Data lineage (#252): attach persisted calculation lineage per payout
    // entry when available so auditors can recompute displayed/paid amounts.
    const entries = result.entries.map((entry) => {
      const payoutId = (entry as { payoutId?: string }).payoutId;
      const lineage = payoutId
        ? getCalculationLineageForPayout(payoutId)
        : undefined;
      return lineage ? { ...entry, lineage } : entry;
    });

    return NextResponse.json(
      { ...result, entries, freshness },
      {
        status: 200,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      },
    );
  } catch (err: unknown) {
    console.error('Error in /api/admin/payout-audit:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve payout audit records' },
      { status: 500 },
    );
  }
}

// Append-only enforcement: Prevent mutating or deleting audit history
export async function POST(request: NextRequest) {
  const corsError = enforceCorsPolicy(request, ADMIN_PAYOUT_AUDIT_CORS_POLICY);
  if (corsError) {
    return corsError;
  }

  return NextResponse.json(
    { error: 'Method Not Allowed: The payout audit ledger is append-only' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export async function PUT(request: NextRequest) {
  const corsError = enforceCorsPolicy(request, ADMIN_PAYOUT_AUDIT_CORS_POLICY);
  if (corsError) {
    return corsError;
  }

  return NextResponse.json(
    { error: 'Method Not Allowed: The payout audit ledger is append-only' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export async function DELETE(request: NextRequest) {
  const corsError = enforceCorsPolicy(request, ADMIN_PAYOUT_AUDIT_CORS_POLICY);
  if (corsError) {
    return corsError;
  }

  return NextResponse.json(
    { error: 'Method Not Allowed: The payout audit ledger is append-only' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}

export async function PATCH(request: NextRequest) {
  const corsError = enforceCorsPolicy(request, ADMIN_PAYOUT_AUDIT_CORS_POLICY);
  if (corsError) {
    return corsError;
  }

  return NextResponse.json(
    { error: 'Method Not Allowed: The payout audit ledger is append-only' },
    { status: 405, headers: { Allow: 'GET' } },
  );
}
