import {
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import {
  ContractReceipt,
  ContractReceiptAuditPage,
  ContractReceiptAuditStatus,
  ContractReceiptAuditView,
  ContractWithdrawRequest,
} from './types';

/**
 * Encodes JavaScript arguments into typed Soroban ScVal representations according to ABI specification.
 */
export function encodeAddress(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

export function encodeI128(value: bigint | number | string): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: 'i128' });
}

export function encodeU64(value: bigint | number): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: 'u64' });
}

export function encodeU32(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: 'u32' });
}

export function encodeBool(value: boolean): xdr.ScVal {
  return nativeToScVal(value, { type: 'bool' });
}

/**
 * Decodes native values into typed ContractReceipt.
 */
export function decodeReceipt(raw: unknown): ContractReceipt | null {
  if (!raw || typeof raw !== 'object') return null;

  const r = raw as Record<string, unknown>;
  if (!r.depositor && !r._0) return null;

  return {
    depositor: String(r.depositor ?? r._0),
    amount: BigInt(String(r.amount ?? r._1 ?? 0)),
    ledger: Number(r.ledger ?? r._2 ?? 0),
  };
}

/**
 * Decodes native values into typed ContractWithdrawRequest.
 */
export function decodeWithdrawRequest(raw: unknown): ContractWithdrawRequest | null {
  if (!raw || typeof raw !== 'object') return null;

  const w = raw as Record<string, unknown>;
  if (w.id === undefined && w._0 === undefined) return null;

  return {
    id: BigInt(String(w.id ?? w._0 ?? 0)),
    user: String(w.user ?? w._1 ?? ''),
    token: String(w.token ?? w._2 ?? ''),
    amount: BigInt(String(w.amount ?? w._3 ?? 0)),
    destination: String(w.destination ?? w._4 ?? ''),
    queuedAtLedger: Number(w.queued_at_ledger ?? w._5 ?? 0),
  };
}

function bytesToHex(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    return Array.from(value)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
  if (Array.isArray(value)) {
    return value
      .map((byte) => Number(byte).toString(16).padStart(2, '0'))
      .join('');
  }
  return String(value ?? '');
}

function decodeReceiptAuditStatus(
  value: unknown,
): ContractReceiptAuditStatus {
  if (value === 2 || value === 2n || String(value).toLowerCase() === 'migrated') {
    return 'migrated';
  }
  return 'active';
}

export function decodeReceiptAuditView(raw: unknown): ContractReceiptAuditView | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const receiptId = bytesToHex(
    record.receipt_id ?? record.receiptId ?? record._1,
  );
  const token = String(record.token ?? record._2 ?? '');
  if (!receiptId || !token) return null;
  return {
    version: Number(record.version ?? record._0 ?? 0),
    receiptId,
    token,
    amount: BigInt(String(record.amount ?? record._3 ?? 0)),
    status: decodeReceiptAuditStatus(record.status ?? record._4),
  };
}

export function decodeReceiptAuditPage(raw: unknown): ContractReceiptAuditPage {
  if (!raw || typeof raw !== 'object') {
    return { records: [], nextCursor: null };
  }
  const page = raw as Record<string, unknown>;
  const recordsValue = page.records ?? page._0;
  const records = Array.isArray(recordsValue)
    ? recordsValue
        .map((record) => decodeReceiptAuditView(record))
        .filter((record): record is ContractReceiptAuditView => record !== null)
    : [];
  const cursorValue = page.next_cursor ?? page.nextCursor ?? page._1;
  const cursor =
    cursorValue === null || cursorValue === undefined
      ? null
      : Number(cursorValue);
  return {
    records,
    nextCursor: Number.isSafeInteger(cursor) ? cursor : null,
  };
}

/**
 * Decodes an ScVal response into native JavaScript types.
 */
export function decodeScVal<T>(val: xdr.ScVal | undefined | null): T {
  if (!val) {
    throw new Error('No return value from contract call');
  }
  return scValToNative(val) as T;
}
