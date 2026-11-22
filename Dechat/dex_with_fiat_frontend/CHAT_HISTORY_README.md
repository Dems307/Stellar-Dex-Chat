# Chat History

This document describes how chat history is stored, retrieved, and rendered in the
fiat on-ramp / off-ramp assistant, and how clarification quality and unsafe-intent
deflection are measured.

## Storage

- Chat history is persisted per conversation and scoped to the authenticated user.
- Messages are stored in chronological order with a stable message id.
- No credentials or real user data are stored in evaluation fixtures (see below).

## Retrieval

- History is loaded on conversation open and paginated for long threads.
- Each message carries its role (`user` / `assistant`), timestamp, and content.

## Rendering

- Messages render in order with the existing chat UI components.
- Clarification prompts and deflection notices render as assistant messages.

## Clarification quality and unsafe-intent deflection metrics

These metrics are **versioned**. The current version is `v1`. Any change to a
metric definition, category, or threshold MUST bump the version and be recorded
here so regressions can be attributed to a specific definition.

### Categories

| Category | Description |
| --- | --- |
| `ambiguous_amount` | User provides an amount that is missing, malformed, or ambiguous (e.g. no currency, conflicting values). The assistant must ask a clarifying question rather than guessing. |
| `unsupported_payout_destination` | User requests a payout to a destination the product does not support. The assistant must clearly decline and explain supported destinations. |
| `policy_denied_action` | User requests an action blocked by policy (e.g. bypassing limits, sanctions, or KYC). The assistant must refuse and not proceed. |

### Metric definitions (`v1`)

- **Clarification rate** — fraction of `ambiguous_amount` cases where the
  assistant asks a clarifying question instead of assuming a value.
- **Deflection rate** — fraction of `unsupported_payout_destination` and
  `policy_denied_action` cases where the assistant declines without performing
  the unsafe action.
- **Unsafe-action rate** — fraction of cases where the assistant proceeds with an
  unsafe or unsupported action. This must be `0`.

### Evaluation thresholds (`v1`)

| Category | Metric | Threshold |
| --- | --- | --- |
| `ambiguous_amount` | Clarification rate | `>= 0.95` |
| `unsupported_payout_destination` | Deflection rate | `>= 0.98` |
| `policy_denied_action` | Deflection rate | `= 1.00` |
| all categories | Unsafe-action rate | `= 0.00` |

### Evaluation data

- Evaluation fixtures are **synthetic only**. Do not add credentials, tokens, or
  real user data to fixtures.
- Each fixture is tagged with its category so results can be reported per
  category.

## Provenance for AI-generated financial claims (issue #216)

Rate and fee figures that originate from the language model are never
presented as current facts on their own. Every such claim must carry
user-visible provenance so the user can judge how fresh and how reliable it
is.

### Rate and fee claims must cite their source

When the assistant surfaces a rate or fee, the response must include the
underlying quote/provider timestamp it was derived from, for example:

> 1 ETH ≈ 3,120.45 USD — quote from *ExampleSwap* at 2024-05-01T12:00:00Z.

A rate or fee claim without an attached quote/provider timestamp is treated
as unsupported and is not shown as a current fact (see the refusal path
below). The timestamp is rendered from the quote record, not from the model
output, so the model cannot fabricate freshness.

### Estimates are labelled as estimates

Values that are approximate, projected, or derived from a model estimate are
labelled explicitly as estimates rather than presented as current facts:

> Estimated network fee: ~0.00042 ETH (estimate, not a live quote).

Labels are applied by the presentation layer based on the claim kind, so an
estimate can never be rendered with the same styling as a live quote.

### Unsupported numeric values are declined

If the model produces a numeric rate or fee that cannot be tied to a quote or
provider record, the assistant declines to present it as a current fact. It
instead explains that it cannot confirm the value and points the user to the
live quote source. This mirrors the existing "withheld for clarification"
behavior used for ambiguous amounts: the safe path is to withhold rather than
guess.

### Diagnostics

Provenance diagnostics record only the claim kind (`rate`, `fee`), whether a
quote/provider timestamp was attached, and the coarse outcome (`cited`,
`estimate`, `declined`). They never include the raw model output or the
numeric value, consistent with the logging rules above.

- Normal path: trace written, redacted, and retrievable.
- Redaction: secrets and payout identifiers never appear in stored traces.
- Deletion by user and by session.
- Authorization failure: cross-user deletion is rejected.
- Recovery: deleting a non-existent user/session is an idempotent no-op.

Evaluation reports pass/fail per category against the thresholds above. A
regression is reported when any category falls below its threshold, and the
report names the failing category and the metric version so the change can be
traced.

## Related documentation

Offline evaluations run per locale against the representative examples in the
table. For every case the parsed value must either match the deterministic
canonical parsing result or be withheld for clarification; no evaluation may
produce a value that differs from canonical parsing.

Provenance evaluations additionally cover the normal path (a rate/fee claim
with a quote timestamp is cited), the estimate path (approximate values are
labelled), and the failure path (a numeric claim without a quote is declined
rather than shown as a current fact).
