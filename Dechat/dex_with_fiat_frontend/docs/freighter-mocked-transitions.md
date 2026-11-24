# Freighter-Mocked Transitions (#273)

## Coverage

- **Account/network switch during signing**: `StellarWalletContext.signTx` validates live Freighter address/network against expected context and throws `WALLET_CONTEXT_CHANGED` before signing/submitting writes.
- **Wrong-network write block**: signing rejects when passphrase is not Stellar Testnet / expected context.
- **Account-scoped UI state clearing**: disconnect and account selection clear generic pending tx markers and account-scoped pending tx keys for the previous account; context version increments on account switch.

## Least-Privilege Permissions (#195)

- **Read-only vs. signing**: connecting only requests account access (`requestAccess` / `getAddress`). Transaction signing (`signTransaction`) is requested per action, at the moment a write is submitted — never bundled into connect.
- **Prompt explanation**: each permission prompt is explained in the UI at the point of request so the user knows whether they are granting read-only account access or authorizing a specific transaction signature.
- **Denial handling**: denying account access or a signing request leaves no partially authenticated session — the wallet stays disconnected (or the pending action is aborted) with a recoverable UI state and no stale connected markers.
- **Compatibility note**: this is an intentional behavior change from a blanket connect+sign flow; callers must request signing only when a write is actually submitted.

## Tests

- `src/contexts/__tests__/walletContextTransitions.test.tsx`
  - account change during signing -> blocked, no `signTransaction`
  - wrong network before write -> blocked, no `signTransaction`
  - disconnect clears account-scoped pending tx UI state
- `src/contexts/__tests__/walletLeastPrivilege.test.tsx`
  - connect requests account access only, no `signTransaction`
  - denied account access -> no connected session, recoverable state
  - denied signing -> pending action aborted, no stale connected state

## Safety

- No credentials or real user data in fixtures.
- Existing financial safety checks preserved; wrong-context writes fail closed.
