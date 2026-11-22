export type LiabilityParityRecordSource = 'contract' | 'database';

export type LiabilityParityMismatchType =
  | 'AMOUNT_MISMATCH'
  | 'MISSING_RESERVATION'
  | 'MISSING_LIABILITY'
  | 'DUPLICATE_RESERVATION'
  | 'INVALID_RECORD'
  | 'SOURCE_TRUNCATED';

export type EscrowLiabilityStatus = 'active' | 'migrated' | 'released';

export type PayoutReservationStatus =
  | 'reserved'
  | 'under_review'
  | 'settled'
  | 'released';

export interface EscrowLiabilityInput {
  receiptId: string;
  asset: string;
  amountMinor: string | number | bigint;
  status?: EscrowLiabilityStatus;
}

export interface PayoutReservationInput {
  payoutId: string;
  receiptId: string;
  asset: string;
  amountMinor: string | number | bigint;
  status?: PayoutReservationStatus;
}

export interface LiabilityParityFilters {
  asset?: string;
  receiptId?: string;
}

export interface LiabilityParityInput {
  liabilities: readonly EscrowLiabilityInput[];
  reservations: readonly PayoutReservationInput[];
  assetAliases?: Record<string, string>;
  filters?: LiabilityParityFilters;
  sourceTruncated?: boolean;
}

export interface LiabilityParityMismatch {
  key: string;
  asset: string;
  receiptId: string;
  payoutIds: string[];
  type: LiabilityParityMismatchType;
  source: LiabilityParityRecordSource | 'source';
  onChainMinor: string;
  reservedMinor: string;
  deltaMinor: string;
  reason: string;
}

export interface LiabilityParityReceipt {
  key: string;
  asset: string;
  receiptId: string;
  onChainMinor: string;
  reservedMinor: string;
  deltaMinor: string;
  payoutIds: string[];
  mismatchTypes: LiabilityParityMismatchType[];
  matched: boolean;
}

export interface LiabilityParityAssetTotal {
  asset: string;
  onChainMinor: string;
  reservedMinor: string;
  deltaMinor: string;
  receiptCount: number;
  matched: boolean;
}

export interface LiabilityParityReport {
  schemaVersion: 1;
  readOnly: true;
  correctionsApplied: 0;
  ok: boolean;
  totals: {
    assets: number;
    receipts: number;
    matchedReceipts: number;
    mismatchedReceipts: number;
    invalidRecords: number;
    onChainMinor: string;
    reservedMinor: string;
    deltaMinor: string;
  };
  byAsset: LiabilityParityAssetTotal[];
  byReceipt: LiabilityParityReceipt[];
  mismatches: LiabilityParityMismatch[];
}

interface ParityGroup {
  asset: string;
  receiptId: string;
  onChainMinor: bigint;
  reservedMinor: bigint;
  payoutIds: Set<string>;
  liabilityCount: number;
  reservationCount: number;
}

function normalizeAmountMinor(value: unknown): bigint | null {
  if (typeof value === 'bigint') {
    return value >= 0n ? value : null;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    return BigInt(trimmed);
  }
  return null;
}

function buildAliasMap(aliases: Record<string, string> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(aliases ?? {})) {
    const normalizedKey = key.trim().toUpperCase();
    const normalizedValue = value.trim().toUpperCase();
    if (normalizedKey && normalizedValue) {
      map.set(normalizedKey, normalizedValue);
    }
  }
  return map;
}

function normalizeAsset(
  value: unknown,
  aliases: Map<string, string>,
): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const upper = raw.toUpperCase();
  return aliases.get(upper) ?? upper;
}

function normalizeReceiptId(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  return /^[0-9a-fA-F]{64}$/.test(raw) ? raw.toLowerCase() : raw;
}

function normalizeLiabilityStatus(
  value: unknown,
): EscrowLiabilityStatus | null {
  const raw = String(value ?? 'active').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (raw === '' || raw === 'active') return 'active';
  if (raw === 'migrated') return 'migrated';
  if (raw === 'released') return 'released';
  return null;
}

function normalizeReservationStatus(
  value: unknown,
): PayoutReservationStatus | null {
  const raw = String(value ?? 'reserved').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (raw === '' || raw === 'reserved') return 'reserved';
  if (raw === 'under_review' || raw === 'review') return 'under_review';
  if (raw === 'settled') return 'settled';
  if (raw === 'released') return 'released';
  return null;
}

function groupKey(asset: string, receiptId: string): string {
  return `${asset}\u0000${receiptId}`;
}

function displayKey(asset: string, receiptId: string): string {
  return `${asset}:${receiptId}`;
}

function matchesFilters(
  asset: string,
  receiptId: string,
  aliases: Map<string, string>,
  filters: LiabilityParityFilters | undefined,
): boolean {
  if (filters?.asset) {
    const filterAsset = normalizeAsset(filters.asset, aliases);
    if (filterAsset !== asset) return false;
  }
  if (filters?.receiptId) {
    const filterReceipt = normalizeReceiptId(filters.receiptId);
    if (filterReceipt !== receiptId) return false;
  }
  return true;
}

function sortMismatches(left: LiabilityParityMismatch, right: LiabilityParityMismatch): number {
  return (
    left.asset.localeCompare(right.asset) ||
    left.receiptId.localeCompare(right.receiptId) ||
    left.type.localeCompare(right.type) ||
    left.source.localeCompare(right.source) ||
    left.key.localeCompare(right.key)
  );
}

export function buildLiabilityParityReport(
  input: LiabilityParityInput,
): LiabilityParityReport {
  const aliases = buildAliasMap(input.assetAliases);
  const groups = new Map<string, ParityGroup>();
  const invalid: LiabilityParityMismatch[] = [];

  const getGroup = (asset: string, receiptId: string): ParityGroup => {
    const key = groupKey(asset, receiptId);
    let group = groups.get(key);
    if (!group) {
      group = {
        asset,
        receiptId,
        onChainMinor: 0n,
        reservedMinor: 0n,
        payoutIds: new Set<string>(),
        liabilityCount: 0,
        reservationCount: 0,
      };
      groups.set(key, group);
    }
    return group;
  };

  const addInvalid = (
    source: LiabilityParityRecordSource,
    identifier: string,
    asset: string,
    receiptId: string,
    reason: string,
  ): void => {
    invalid.push({
      key: displayKey(asset || 'UNKNOWN', receiptId || identifier || 'unknown'),
      asset: asset || 'UNKNOWN',
      receiptId: receiptId || identifier || 'unknown',
      payoutIds: [],
      type: 'INVALID_RECORD',
      source,
      onChainMinor: '0',
      reservedMinor: '0',
      deltaMinor: '0',
      reason,
    });
  };

  for (const liability of input.liabilities ?? []) {
    const asset = normalizeAsset(liability?.asset, aliases);
    const receiptId = normalizeReceiptId(liability?.receiptId);
    const amount = normalizeAmountMinor(liability?.amountMinor);
    const status = normalizeLiabilityStatus(liability?.status);
    if (!asset || !receiptId || amount === null || status === null) {
      addInvalid(
        'contract',
        String(liability?.receiptId ?? ''),
        asset ?? '',
        receiptId ?? '',
        'Contract escrow record requires a receipt, asset, and non-negative integer minor amount',
      );
      continue;
    }
    if (status === 'released') continue;
    if (!matchesFilters(asset, receiptId, aliases, input.filters)) continue;
    const group = getGroup(asset, receiptId);
    group.onChainMinor += amount;
    group.liabilityCount += 1;
  }

  for (const reservation of input.reservations ?? []) {
    const asset = normalizeAsset(reservation?.asset, aliases);
    const receiptId = normalizeReceiptId(reservation?.receiptId);
    const amount = normalizeAmountMinor(reservation?.amountMinor);
    const status = normalizeReservationStatus(reservation?.status);
    const payoutId =
      typeof reservation?.payoutId === 'string' ? reservation.payoutId.trim() : '';
    if (!asset || !receiptId || !payoutId || amount === null || status === null) {
      addInvalid(
        'database',
        payoutId || String(reservation?.receiptId ?? ''),
        asset ?? '',
        receiptId ?? '',
        'Payout reservation requires a payout, receipt, asset, and non-negative integer minor amount',
      );
      continue;
    }
    if (status === 'settled' || status === 'released') continue;
    if (!matchesFilters(asset, receiptId, aliases, input.filters)) continue;
    const group = getGroup(asset, receiptId);
    group.reservedMinor += amount;
    group.payoutIds.add(payoutId);
    group.reservationCount += 1;
  }

  const byReceipt: LiabilityParityReceipt[] = [];
  const mismatches: LiabilityParityMismatch[] = [];

  for (const group of [...groups.values()].sort(
    (left, right) =>
      left.asset.localeCompare(right.asset) ||
      left.receiptId.localeCompare(right.receiptId),
  )) {
    const delta = group.onChainMinor - group.reservedMinor;
    const payoutIds = [...group.payoutIds].sort();
    const key = displayKey(group.asset, group.receiptId);
    const types: LiabilityParityMismatchType[] = [];

    if (group.reservationCount > 0 && payoutIds.length > 1) {
      types.push('DUPLICATE_RESERVATION');
      mismatches.push({
        key,
        asset: group.asset,
        receiptId: group.receiptId,
        payoutIds,
        type: 'DUPLICATE_RESERVATION',
        source: 'database',
        onChainMinor: group.onChainMinor.toString(),
        reservedMinor: group.reservedMinor.toString(),
        deltaMinor: delta.toString(),
        reason: 'Multiple active payouts reserve the same asset and receipt',
      });
    }
    if (group.onChainMinor === 0n) {
      types.push('MISSING_LIABILITY');
      mismatches.push({
        key,
        asset: group.asset,
        receiptId: group.receiptId,
        payoutIds,
        type: 'MISSING_LIABILITY',
        source: 'database',
        onChainMinor: group.onChainMinor.toString(),
        reservedMinor: group.reservedMinor.toString(),
        deltaMinor: delta.toString(),
        reason: 'Reservation exists without an active on-chain escrow liability',
      });
    } else if (group.reservedMinor === 0n) {
      types.push('MISSING_RESERVATION');
      mismatches.push({
        key,
        asset: group.asset,
        receiptId: group.receiptId,
        payoutIds,
        type: 'MISSING_RESERVATION',
        source: 'contract',
        onChainMinor: group.onChainMinor.toString(),
        reservedMinor: group.reservedMinor.toString(),
        deltaMinor: delta.toString(),
        reason: 'Active on-chain escrow liability has no persisted payout reservation',
      });
    } else if (delta !== 0n) {
      types.push('AMOUNT_MISMATCH');
      mismatches.push({
        key,
        asset: group.asset,
        receiptId: group.receiptId,
        payoutIds,
        type: 'AMOUNT_MISMATCH',
        source: 'contract',
        onChainMinor: group.onChainMinor.toString(),
        reservedMinor: group.reservedMinor.toString(),
        deltaMinor: delta.toString(),
        reason: 'On-chain escrow amount differs from the persisted reservation amount',
      });
    }

    byReceipt.push({
      key,
      asset: group.asset,
      receiptId: group.receiptId,
      onChainMinor: group.onChainMinor.toString(),
      reservedMinor: group.reservedMinor.toString(),
      deltaMinor: delta.toString(),
      payoutIds,
      mismatchTypes: types,
      matched: types.length === 0,
    });
  }

  if (input.sourceTruncated) {
    mismatches.push({
      key: 'SOURCE:TRUNCATED',
      asset: '*',
      receiptId: '*',
      payoutIds: [],
      type: 'SOURCE_TRUNCATED',
      source: 'source',
      onChainMinor: '0',
      reservedMinor: '0',
      deltaMinor: '0',
      reason: 'Contract audit pagination stopped before the final page; report is incomplete',
    });
  }

  mismatches.push(...invalid);
  mismatches.sort(sortMismatches);

  const assetMap = new Map<string, LiabilityParityAssetTotal>();
  let totalOnChain = 0n;
  let totalReserved = 0n;
  for (const receipt of byReceipt) {
    const onChain = BigInt(receipt.onChainMinor);
    const reserved = BigInt(receipt.reservedMinor);
    totalOnChain += onChain;
    totalReserved += reserved;
    let assetTotal = assetMap.get(receipt.asset);
    if (!assetTotal) {
      assetTotal = {
        asset: receipt.asset,
        onChainMinor: '0',
        reservedMinor: '0',
        deltaMinor: '0',
        receiptCount: 0,
        matched: true,
      };
      assetMap.set(receipt.asset, assetTotal);
    }
    const nextOnChain = BigInt(assetTotal.onChainMinor) + onChain;
    const nextReserved = BigInt(assetTotal.reservedMinor) + reserved;
    assetTotal.onChainMinor = nextOnChain.toString();
    assetTotal.reservedMinor = nextReserved.toString();
    assetTotal.deltaMinor = (nextOnChain - nextReserved).toString();
    assetTotal.receiptCount += 1;
    assetTotal.matched = assetTotal.matched && receipt.matched;
  }

  const byAsset = [...assetMap.values()].sort((left, right) =>
    left.asset.localeCompare(right.asset),
  );
  const matchedReceipts = byReceipt.filter((receipt) => receipt.matched).length;

  return {
    schemaVersion: 1,
    readOnly: true,
    correctionsApplied: 0,
    ok: mismatches.length === 0,
    totals: {
      assets: byAsset.length,
      receipts: byReceipt.length,
      matchedReceipts,
      mismatchedReceipts: byReceipt.length - matchedReceipts,
      invalidRecords: invalid.length,
      onChainMinor: totalOnChain.toString(),
      reservedMinor: totalReserved.toString(),
      deltaMinor: (totalOnChain - totalReserved).toString(),
    },
    byAsset,
    byReceipt,
    mismatches,
  };
}
