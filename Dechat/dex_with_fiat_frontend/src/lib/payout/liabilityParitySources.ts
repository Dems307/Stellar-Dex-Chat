import { FiatBridgeContractClient } from '@/contracts/client';
import { getStellarDeploymentConfig } from '@/lib/clientEnv';
import {
  EscrowLiabilityInput,
  PayoutReservationInput,
} from './liabilityParity';
import {
  PayoutReservationEntry,
  PayoutReservationLedger,
  payoutReservationLedger,
} from './reservationLedger';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const MAX_PAGE_SIZE = 100;

export interface CollectLiabilityParitySourcesOptions {
  pageSize?: number;
  maxPages?: number;
  assetAliases?: Record<string, string>;
  client?: Pick<FiatBridgeContractClient, 'getReceiptAuditViews'>;
  ledger?: Pick<PayoutReservationLedger, 'getEntries'>;
}

export interface LiabilityParitySources {
  liabilities: EscrowLiabilityInput[];
  reservations: PayoutReservationInput[];
  assetAliases: Record<string, string>;
  sourceTruncated: boolean;
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer > 0 ? integer : fallback;
}

function reservationStatus(entry: PayoutReservationEntry): PayoutReservationInput['status'] {
  if (entry.action === 'provider_linked') return 'reserved';
  return entry.action;
}

export function reservationsFromLedgerEntries(
  entries: readonly PayoutReservationEntry[],
): PayoutReservationInput[] {
  const byPayout = new Map<string, PayoutReservationEntry[]>();
  for (const entry of entries) {
    const payoutEntries = byPayout.get(entry.payoutId) ?? [];
    payoutEntries.push(entry);
    byPayout.set(entry.payoutId, payoutEntries);
  }

  const reservations: PayoutReservationInput[] = [];
  for (const [payoutId, payoutEntries] of byPayout) {
    const reserved = payoutEntries.find((entry) => entry.action === 'reserved');
    if (!reserved) continue;
    const latest = payoutEntries.at(-1);
    if (!latest) continue;
    reservations.push({
      payoutId,
      receiptId: reserved.contractReceiptId,
      asset: reserved.currency,
      amountMinor: reserved.amountMinor,
      status: reservationStatus(latest),
    });
  }
  return reservations.sort(
    (left, right) =>
      left.receiptId.localeCompare(right.receiptId) ||
      left.payoutId.localeCompare(right.payoutId),
  );
}

export async function collectLiabilityParitySources(
  options: CollectLiabilityParitySourcesOptions = {},
): Promise<LiabilityParitySources> {
  const deployment = getStellarDeploymentConfig();
  const pageSize = Math.min(
    clampPositiveInteger(options.pageSize, DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const maxPages = clampPositiveInteger(options.maxPages, DEFAULT_MAX_PAGES);
  const client =
    options.client ??
    new FiatBridgeContractClient({
      contractId: deployment.contractId,
      rpcUrl: deployment.rpcUrl,
      networkPassphrase: deployment.networkPassphrase,
    });
  const ledger = options.ledger ?? payoutReservationLedger;

  const liabilities: EscrowLiabilityInput[] = [];
  let cursor = 0;
  let sourceTruncated = false;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await client.getReceiptAuditViews(cursor, pageSize);
    for (const record of result.records) {
      liabilities.push({
        receiptId: record.receiptId,
        asset: record.token,
        amountMinor: record.amount,
        status: record.status,
      });
    }
    const nextCursor = result.nextCursor;
    if (nextCursor === null || nextCursor === undefined) break;
    if (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor) break;
    cursor = nextCursor;
    if (page === maxPages - 1) {
      sourceTruncated = true;
    }
  }

  return {
    liabilities,
    reservations: reservationsFromLedgerEntries(ledger.getEntries()),
    assetAliases: {
      [deployment.xlmSacId]: 'XLM',
      ...options.assetAliases,
    },
    sourceTruncated,
  };
}
