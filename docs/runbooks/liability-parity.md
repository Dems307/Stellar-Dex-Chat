# Escrow Liability Parity Runbook

Use this procedure to investigate differences between on-chain escrow liabilities
and persisted payout reservations. The check is read-only: it never settles,
releases, reserves, or modifies a payout or contract record.

## What is compared

The tool reads two sources:

- **On-chain**: paginated `get_receipt_audit_views` results from the FiatBridge
  contract. `Active` and `Migrated` receipts are outstanding escrow liabilities.
- **Persisted**: the append-only payout reservation ledger. Only `reserved` and
  `under_review` reservations are outstanding. `settled` and `released`
  reservations are excluded because their liability should already be gone.

Records are grouped by normalized asset and receipt. Token addresses are mapped
to asset codes with `assetAliases`; the configured XLM SAC address is mapped to
`XLM` automatically. Hexadecimal receipt identifiers are lowercased before
comparison. Amounts are compared as non-negative integer minor units.

## Mismatch types

| Type | Meaning |
|------|---------|
| `AMOUNT_MISMATCH` | On-chain amount and reserved amount differ for the same asset and receipt. |
| `MISSING_RESERVATION` | Outstanding on-chain liability has no active reservation. |
| `MISSING_LIABILITY` | Active reservation has no outstanding on-chain liability. |
| `DUPLICATE_RESERVATION` | More than one active payout reserves the same asset and receipt. |
| `INVALID_RECORD` | A source record is missing an identifier/asset or has a non-integer/negative amount. |
| `SOURCE_TRUNCATED` | Contract pagination stopped before the final page; the report is incomplete. |

`ok: true` is returned only when there are no mismatches and pagination was
complete. A truncated report must never be treated as proof of parity.

## Run the check

### Admin UI

Open `/admin/liability-parity`. The page shows totals by asset and a mismatch
table grouped by asset and receipt. Select **Run check** to refresh the report.
The page has no mutation controls.

### API

```bash
curl -sS \
  -H "x-admin-token: $ADMIN_SECRET" \
  'https://<host>/api/admin/liability-parity?asset=XLM&receiptId=<receipt>'
```

Optional query parameters:

- `asset` — case-insensitive asset code filter.
- `receiptId` — exact receipt filter.
- `pageSize` — contract page size, 1–100 (default 100).
- `maxPages` — maximum contract pages to read (default 100).

To reconcile an exported snapshot without contacting the chain:

```bash
curl -sS \
  -H "x-admin-token: $ADMIN_SECRET" \
  -H 'content-type: application/json' \
  -X POST 'https://<host>/api/admin/liability-parity' \
  -d '{"liabilities":[],"reservations":[],"assetAliases":{}}'
```

Both endpoints require admin authentication and pass the admin IP allowlist.
Failures return `401` (unauthenticated), `403` (IP blocked), `400` (invalid
pagination or snapshot body), or `500` (RPC/source failure).

## Investigate a mismatch

1. Confirm the report is not `SOURCE_TRUNCATED`. If it is, increase `maxPages`
   and rerun the check.
2. For `AMOUNT_MISMATCH`, compare the contract receipt amount with the original
   reservation entry before deciding which source is stale.
3. For `MISSING_RESERVATION`, check whether a payout intent was created but the
   reservation ledger append failed. Do not create a reservation from this tool.
4. For `MISSING_LIABILITY`, check whether the payout was settled or released
   prematurely. Do not alter the ledger from this tool.
5. For `DUPLICATE_RESERVATION`, stop and escalate. Two active payouts for one
   receipt can double-count the same escrow liability.
6. For `INVALID_RECORD`, fix the producer of the malformed source record. The
   parity engine intentionally refuses to guess an amount or identifier.

Escalate unresolved mismatches to the payout operations owner with the asset,
receipt ID, payout IDs, both amounts, and the mismatch type. All corrections
must go through the existing payout and contract procedures, never through this
reconciliation endpoint.
