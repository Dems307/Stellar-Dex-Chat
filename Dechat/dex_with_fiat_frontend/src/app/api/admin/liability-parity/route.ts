import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '../_utils/requireAdminAuth';
import { enforceAdminIpAllowlist } from '@/lib/security';
import {
  buildLiabilityParityReport,
  LiabilityParityInput,
} from '@/lib/payout/liabilityParity';
import { collectLiabilityParitySources } from '@/lib/payout/liabilityParitySources';

export const dynamic = 'force-dynamic';

function parsePositiveInteger(
  value: string | null,
  fallback: number,
): number | null {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseSnapshotBody(body: unknown):
  | { ok: true; input: LiabilityParityInput }
  | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const value = body as Record<string, unknown>;
  if (!Array.isArray(value.liabilities) || !Array.isArray(value.reservations)) {
    return {
      ok: false,
      error: 'liabilities and reservations must be arrays',
    };
  }
  if (
    value.assetAliases !== undefined &&
    (typeof value.assetAliases !== 'object' ||
      value.assetAliases === null ||
      Array.isArray(value.assetAliases))
  ) {
    return { ok: false, error: 'assetAliases must be an object' };
  }
  if (
    value.filters !== undefined &&
    (typeof value.filters !== 'object' ||
      value.filters === null ||
      Array.isArray(value.filters))
  ) {
    return { ok: false, error: 'filters must be an object' };
  }
  return { ok: true, input: value as unknown as LiabilityParityInput };
}

export async function GET(request: NextRequest) {
  try {
    const blockedResponse = enforceAdminIpAllowlist(request);
    if (blockedResponse) return blockedResponse;

    const authError = requireAdminAuth(request);
    if (authError) return authError;

    const pageSize = parsePositiveInteger(
      request.nextUrl.searchParams.get('pageSize'),
      100,
    );
    const maxPages = parsePositiveInteger(
      request.nextUrl.searchParams.get('maxPages'),
      100,
    );
    if (pageSize === null || maxPages === null) {
      return NextResponse.json(
        { error: 'pageSize and maxPages must be positive integers' },
        { status: 400 },
      );
    }

    const sources = await collectLiabilityParitySources({ pageSize, maxPages });
    const report = buildLiabilityParityReport({
      ...sources,
      filters: {
        asset: request.nextUrl.searchParams.get('asset') ?? undefined,
        receiptId: request.nextUrl.searchParams.get('receiptId') ?? undefined,
      },
    });
    return NextResponse.json(report);
  } catch (error) {
    console.error('Error checking escrow liability parity:', error);
    return NextResponse.json(
      { error: 'Failed to check escrow liability parity' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const blockedResponse = enforceAdminIpAllowlist(request);
    if (blockedResponse) return blockedResponse;

    const authError = requireAdminAuth(request);
    if (authError) return authError;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const parsed = parseSnapshotBody(body);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const report = buildLiabilityParityReport(parsed.input);
    return NextResponse.json(report);
  } catch (error) {
    console.error('Error comparing liability snapshot:', error);
    return NextResponse.json(
      { error: 'Failed to compare liability snapshot' },
      { status: 500 },
    );
  }
}
