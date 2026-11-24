# Contributing

Thanks for helping improve the DEX with Fiat frontend. This guide covers local setup, the checks we run in CI, and how to keep our visual regression baselines healthy.

## Getting started

1. Install dependencies with your package manager of choice (the repo uses `pnpm`).
2. Copy `.env.example` to `.env.local` and fill in local-only values. Never commit real credentials or user data.
3. Start the dev server with `pnpm dev`.

## Checks before opening a PR

Run the applicable checks locally before pushing:

- `pnpm lint` — static analysis and style.
- `pnpm typecheck` — TypeScript contract checks.
- `pnpm test` — unit and integration tests.
- `pnpm test:e2e` — Playwright end-to-end and visual regression tests.

If a check is not applicable to your change, note why in the PR description.

## Visual regression tests

Critical financial states are covered by Playwright screenshot tests so that regressions in layout, copy, or state handling are caught before merge. The covered states are:

- Wallet disconnected
- Stale quote
- Pending payout
- Failed payout
- Degraded RPC

Each state is captured across both the **mobile** and **desktop** viewport projects defined in `playwright.config.ts`. Volatile data (timestamps, wallet addresses, token amounts, transaction IDs) is masked in the tests so screenshots stay stable across runs and machines.

### Running visual tests

```bash
pnpm test:e2e -- --project=mobile
pnpm test:e2e -- --project=desktop
```

To update snapshots locally after an intentional UI change:

```bash
pnpm test:e2e -- --update-snapshots
```

### Updating baselines intentionally

Baselines should only change when the UI change is intentional and reviewed. When updating snapshots:

1. Confirm the diff is expected and limited to the states your change affects.
2. Run the update command above for both `mobile` and `desktop` projects.
3. Review the regenerated images in the PR diff — call out the intentional change in the PR description.
4. Do **not** commit snapshots that contain real user data, credentials, or unmasked volatile values. If a new dynamic field appears, add it to the mask list in the test rather than accepting an unstable baseline.
5. Get reviewer sign-off on the baseline change before merging.

If a snapshot fails unexpectedly, treat it as a potential regression first — investigate before reaching for `--update-snapshots`.

## Wallet session lifecycle

Logging out is a security boundary, not just a UI reset. When a user logs out we must ensure a second account can never observe the previous account's drafts or transaction data.

### Logout contract

On logout the app performs the following, in order:

1. **Revoke the server wallet session.** Call the existing session-revocation endpoint through the shared API client. Revocation is best-effort: a network failure or an already-expired/unauthorized session must not block the local logout. Log the failure and continue.
2. **Clear account-scoped caches.** Drop any cached drafts, quotes, balances, and transaction history keyed to the previous account so they cannot leak into the next session.
3. **Reset pending UI state.** Cancel in-flight requests and clear pending transaction/quote state so stale spinners or optimistic rows do not survive the logout.
4. **Tear down subscriptions.** Unsubscribe from wallet, RPC, and quote streams tied to the previous session.

### Financial safety

Logout must never mutate on-chain state or cancel a transaction that has already been broadcast. Revocation only affects the server-side session and local caches; any submitted transaction continues to settle independently. If revocation fails, surface it in logs but still complete the local cleanup so the next account starts from a clean slate.

### Testing logout

Regression tests for logout should cover:

- The normal path: session revoked, caches cleared, subscriptions torn down.
- Revocation failure (network error): local cleanup still completes.
- Authorization edge case (session already expired or unauthorized): logout still succeeds locally.
- Recovery: logging in as a second account shows no drafts or transaction data from the first.

## Wallet permissions

We request the least-privilege wallet permission needed for each action instead of a blanket connect-and-sign flow. Each action asks only for the account or signing operation it actually needs, and the prompt is explained to the user at the point of request.

### Permission tiers

- **Read-only account access** — connecting to view balances, quotes, and history. No signing capability is requested.
- **Message signing** — authenticating a session or proving account ownership. Requests a signature only; it does not authorize a transaction.
- **Transaction signing** — submitting an order or payout. Requested only at the moment the user confirms a specific transaction, scoped to that transaction.

### Prompting and denial

- Explain the scope of each prompt in the UI before it is triggered so the user knows exactly what is being requested and why.
- If the user denies a permission or signing request, do not create a partially authenticated session. Leave the app in a recoverable state: no stale connected state, no half-signed session, and a clear retry path.
- A denial at the transaction-signing step must not leave an optimistic pending row or a session that appears authenticated for signing.

### Financial safety

Requesting a permission never mutates on-chain state. Denying a signing request simply aborts that action; any previously broadcast transaction continues to settle independently. Least-privilege requests must not weaken existing safety checks — pre-submit revalidation and typed transaction state still apply.

### Testing permissions

Regression tests for wallet permissions should cover:

- The normal path: each action requests only its minimal permission tier.
- Denial of account access: no connected state is established.
- Denial of a signing request: no partially authenticated session and a recoverable UI state.
- Recovery: retrying after a denial requests the permission again cleanly.

## Pre-submit revalidation

Wallet state can change between the moment a user confirms a transaction and the moment we hand the signed XDR to the network. To prevent submitting a transaction that no longer matches what the user approved, we revalidate the wallet session immediately before submission.

### Revalidation contract

After the user confirms and immediately before submitting the XDR, re-read the following values and compare them against the snapshot captured at confirmation time:

1. **Active wallet address** — the connected account's public key.
2. **Network passphrase** — the network the wallet is currently pointed at.
3. **Configured contract identity** — the contract ID the app is configured to interact with.

If any of these values changed since confirmation, abort the submission and surface a recoverable, user-facing message explaining that the wallet or network changed and the action must be retried. Do not submit the stale XDR.

### Financial safety

Revalidation is a read-only check and never mutates on-chain state. It complements, and must not weaken, existing safeguards: double-submit protection still prevents duplicate submissions, and audit logging still records the attempt and the abort reason. An aborted submission leaves the app in a recoverable state so the user can re-confirm against the current wallet and network.

### Testing revalidation

Regression tests for pre-submit revalidation should cover:

- The normal path: unchanged address, passphrase, and contract identity submit successfully.
- A changed wallet address aborts submission with a recoverable message.
- A changed network passphrase aborts submission with a recoverable message.
- A changed contract identity aborts submission with a recoverable message.
- Recovery: after an abort, re-confirming against the current wallet and network submits cleanly.

## Commit and PR conventions

- Keep changes scoped to the issue you are solving.
- Write clear commit messages describing the behavior change.
- Include tests for new behavior, including failure and recovery paths where relevant.
- Update documentation when behavior, APIs, or operational procedures change.
