# DEX with Fiat Frontend

Frontend for the DEX-with-fiat flow. It renders the swap/transaction UI, drives the
intent pipeline, and talks to the backend contract/API layer.

## Network profiles

All network-specific values (network passphrase, RPC endpoint, Horizon endpoint,
contract IDs, and explorer base URL) live in a single typed source of truth —
the network profile. Do not scatter these constants across the codebase; read
them from the active profile instead.

- **Startup validation.** The active profile is validated at startup. A missing
  or malformed required field (for example an empty passphrase, a non-URL RPC or
  Horizon endpoint, or a missing contract ID) fails fast with a clear error
  naming the offending field, rather than surfacing later as a confusing
  runtime failure.
- **Unknown profiles block production writes.** When the active profile is
  unknown/unrecognized, production write operations (transaction submission) are
  refused. Read-only and non-production flows are unaffected. This preserves the
  existing financial safety properties: no transaction is ever signed or
  submitted against a network whose profile has not been validated.

Explorer links are built from the profile's explorer base URL so that links
always point at the same network the transaction targets.

## Model failover: conversation and policy versions

When the intent pipeline fails over from one model/provider to another, the
failover must be **transparent to financial safety**. Two invariants are enforced:

1. **Conversation and policy versions are preserved.** Each request trace records
   the model/provider identity together with the conversation version and the
   policy version(s) that were in effect when the request was issued. A failover
   to a different provider does not reset or bump these versions; the trace shows
   the same conversation and policy versions before and after the switch.
2. **Tool allowlists are identical across failover.** The set of tools (and thus
   the transaction permissions) available to the fallback provider is exactly the
   allowlist of the primary provider. A provider change can never broaden
   transaction permissions — any attempt to add tools during failover is rejected
   and the request fails closed rather than executing with wider permissions.

### Request trace fields

Each request trace includes:

- `model` / `provider` — the model and provider that served the request.
- `conversationVersion` — the conversation version at request time.
- `policyVersion` — the policy version(s) applied to the request.
- `toolAllowlist` — the effective tool allowlist used for the request.

### Regression coverage

Focused tests cover:

- the normal failover path (provider switch preserves conversation/policy versions
  and the tool allowlist), and
- the edge case where a provider change attempts to broaden the transaction
  permission allowlist — the request must be rejected and no transaction may be
  executed with the broadened permissions.

These properties preserve the existing financial safety guarantees; no
compatibility or behavior change is introduced for the non-failover path.

## Development

See the repository `CONTRIBUTING.md` for setup, checks, and contribution
conventions.
