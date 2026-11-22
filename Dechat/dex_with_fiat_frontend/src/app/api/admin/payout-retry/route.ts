import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '../_utils/requireAdminAuth';
import { enforceRouteCors } from '@/lib/security/routeCors';
import { payoutRetryQueue } from '@/lib/payout/retryQueue';
import { getIndexerCursor } from '@/lib/indexer/cursor';

function buildFreshness(jobs: Array<{ updatedAt?: string }>) {
  const latestUpdatedAt = jobs.reduce<string | undefined>((latest, job) => {
    if (!job.updatedAt) return latest;
    if (!latest) return job.updatedAt;
    return job.updatedAt > latest ? job.updatedAt : latest;
  }, undefined);

  return {
    dbUpdatedAt: latestUpdatedAt ?? null,
    sourceLedgerCursor: getIndexerCursor(),
  };
}

// Contract tests for this route live in
// src/app/api/admin/payout-retry/__tests__/route.contract.test.ts and assert
// every response (401/403 auth failures, 400 validation errors, 200 success)
// against the published OpenAPI schema.

export async function GET(request: NextRequest) {
  const corsError = enforceRouteCors(request, 'admin/payout-retry');
  if (corsError) {
    return corsError;
  }

  const authError = requireAdminAuth(request);
  if (authError) {
    return authError;
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const status = searchParams.get('status') || undefined;

    if (status === 'dead_letter') {
      const deadLetterJobs = payoutRetryQueue.getDeadLetterJobs();
      return NextResponse.json({
        jobs: deadLetterJobs,
        count: deadLetterJobs.length,
        freshness: buildFreshness(deadLetterJobs),
      });
    }

    const jobs = payoutRetryQueue.getJobs(
      status as
        'pending' | 'processing' | 'dead_letter' | 'completed' | undefined,
    );
    return NextResponse.json({
      jobs,
      count: jobs.length,
      freshness: buildFreshness(jobs),
    });
  } catch (err: unknown) {
    console.error('Error fetching retry queue jobs:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve retry queue jobs' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const corsError = enforceRouteCors(request, 'admin/payout-retry');
  if (corsError) {
    return corsError;
  }

  const authError = requireAdminAuth(request);
  if (authError) {
    return authError;
  }

  try {
    const body = (await request.json()) as {
      jobId?: string;
      action?: string;
      actor?: string;
      reason?: string;
    };
    const { jobId, action, actor = 'operator:admin', reason } = body;

    if (!jobId) {
      return NextResponse.json(
        { error: 'Missing required field: jobId' },
        { status: 400 },
      );
    }

    if (action === 'preview') {
      const preview = payoutRetryQueue.previewDeadLetterReplay(jobId);
      return NextResponse.json({ preview });
    }

    if (action !== 'replay') {
      return NextResponse.json(
        { error: 'Unsupported action. Supported actions: preview, replay' },
        { status: 400 },
      );
    }

    if (!reason || !reason.trim()) {
      return NextResponse.json(
        { error: 'Missing required field: reason' },
        { status: 400 },
      );
    }

    const job = payoutRetryQueue.replayDeadLetterJob(jobId, actor, reason);

    return NextResponse.json({
      success: true,
      message:
        'Job scheduled for safe operator replay using original idempotency key',
      job,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error replaying retry job:', err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
