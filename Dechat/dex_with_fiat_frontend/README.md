# DEX with Fiat Frontend

A React + TypeScript frontend for a decentralized exchange that supports fiat on-ramp flows and wallet-based trading.

## Getting started

```bash
npm install
npm run dev
```

## Wallet permissions

The app follows a least-privilege wallet model: each action requests only the
account or signing capability it actually needs, and permission prompts are
explained in the UI at the point of request.

| Action | Wallet request |
| --- | --- |
| View balances / portfolio | Read-only account access (`eth_requestAccounts`) |
| Place / cancel an order | Transaction signing for that single transaction |
| Fiat on-ramp handoff | Read-only account access only |

### Denial handling

If a user rejects a permission or signing prompt, the app does **not** create a
partially authenticated session. The pending action is aborted, no connected
state is persisted for that request, and the UI returns to a recoverable state
where the user can retry or continue browsing without a wallet.

### Pre-submit revalidation

After the user confirms a transaction and immediately before the signed XDR is
submitted, the app re-reads the active wallet address, the network passphrase,
and the configured contract identity. If any of these values changed since the
user confirmed (for example the wallet switched accounts or networks, or the
configured contract was updated), submission is aborted with a recoverable,
user-facing message. No transaction is submitted in that case; the user can
review the new state and retry. Existing safety properties (double-submit
protection and audit logging) are preserved across this check.

### Compatibility notes

- Read-only browsing remains available without any wallet connection.
- Signing is always requested per transaction; the app never asks for blanket
  signing approval up front.
- Existing financial safety properties (explicit confirmation before signing,
  no silent transaction submission) are preserved.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
