# Synthetic Test Fixtures

This repository uses deterministic, privacy-safe synthetic fixtures for wallets, bank accounts, webhooks, and payouts.

## Rules

- **Deterministic**: fixture generators accept a seed and return stable output for the same seed.
- **Synthetic only**: no real user data, production credentials, live provider keys, or private keys.
- **Obvious markers**: synthetic records include `synthetic: true` and `syn_`/`000...` prefixes where practical.
- **Public identifiers only**: Stellar public addresses/contract IDs in fixtures are non-secret test identifiers.

## Frontend

Central generators live in `src/lib/fixtures/`:

- `seededRandom.ts` - seeded PRNG/helpers
- `synthetic.ts` - wallet/bank/webhook/payout fixtures
- `privacyGuard.ts` - runtime/text fixture safety checks

Run checks:

```bash
pnpm test:fixtures:privacy
pnpm test:unit
```

## Contract fixtures

Contract JSON fixtures under `Dechat/stellar-contracts/fixtures/` must remain synthetic/public-only. The frontend privacy guard scans committed fixture directories, and contract tests should avoid embedding secrets or production identifiers.

## Event compatibility fixtures (golden events)

Every state-changing public contract method has a deterministic golden event fixture in
`Dechat/stellar-contracts/fixtures/events/golden_events.json`. Each entry snapshots the emitted
**topics** and **payload encoding** so that any change to an event's shape is caught by tests
rather than discovered in production indexers.

### Schema version

The fixture file carries an explicit top-level `schema_version` field. The regression test
(`golden_events` test) asserts that the committed fixtures match the current contract event
encoding for the normal path, and fails on:

- a `schema_version` mismatch between the fixture file and the expected version, or
- an unexpected topic or payload field change for any mutation.

### Changing an event

When you intentionally change an event's topics or payload fields:

1. Bump `schema_version` in `golden_events.json`.
2. Regenerate the affected fixtures so they reflect the new encoding.
3. Add a **compatibility note** in the PR description (and the relevant changelog) describing
   the old vs. new shape and the migration impact for indexers/consumers.

A field or topic change without a `schema_version` bump and compatibility note is treated as a
regression and will fail the contract checks.

### Regenerating fixtures

Regenerate golden events from the contract test harness after an intentional change, then run:

```bash
cargo test -p <contract-crate> golden_events
```

Keep fixtures synthetic: use public test addresses/contract IDs only, never real user data or
credentials.
