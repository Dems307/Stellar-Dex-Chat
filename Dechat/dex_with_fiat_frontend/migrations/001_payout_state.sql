-- Migration 001: Payout state and transitions schema (Issue #97)

CREATE TABLE IF NOT EXISTS payout_intents (
  id VARCHAR(64) PRIMARY KEY,
  idempotency_key VARCHAR(128) UNIQUE NOT NULL,
  contract_tx_hash VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL,
  amount_minor_units BIGINT NOT NULL,
  currency VARCHAR(8) NOT NULL,
  provider_reference VARCHAR(128) UNIQUE,
  recipient_account_masked VARCHAR(32) NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payout_state_transitions (
  id BIGSERIAL PRIMARY KEY,
  payout_id VARCHAR(64) REFERENCES payout_intents(id) ON DELETE CASCADE,
  from_status VARCHAR(32) NOT NULL,
  to_status VARCHAR(32) NOT NULL,
  reason TEXT,
  transitioned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Dual control for high-risk manual payout actions (Issue #229).
-- Each row records a requested retry/release/override action that requires an
-- independent reviewer approval before it is applied to the payout intent.
CREATE TABLE IF NOT EXISTS payout_dual_control_actions (
  id VARCHAR(64) PRIMARY KEY,
  payout_id VARCHAR(64) NOT NULL REFERENCES payout_intents(id) ON DELETE CASCADE,
  action_type VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  requester_id VARCHAR(128) NOT NULL,
  approver_id VARCHAR(128),
  reason TEXT NOT NULL,
  before_state JSONB NOT NULL,
  after_state JSONB NOT NULL,
  requested_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  decided_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT payout_dual_control_action_type_check
    CHECK (action_type IN ('retry', 'release', 'override')),
  CONSTRAINT payout_dual_control_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  CONSTRAINT payout_dual_control_no_self_approval
    CHECK (approver_id IS NULL OR approver_id <> requester_id),
  CONSTRAINT payout_dual_control_decision_consistency
    CHECK (
      (status = 'pending' AND approver_id IS NULL AND decided_at IS NULL)
      OR (status IN ('approved', 'rejected') AND approver_id IS NOT NULL AND decided_at IS NOT NULL)
      OR (status = 'cancelled' AND decided_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_payout_intents_status ON payout_intents(status);
CREATE INDEX IF NOT EXISTS idx_payout_intents_created_at ON payout_intents(created_at);
CREATE INDEX IF NOT EXISTS idx_payout_dual_control_payout_id ON payout_dual_control_actions(payout_id);
CREATE INDEX IF NOT EXISTS idx_payout_dual_control_status ON payout_dual_control_actions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_dual_control_pending_unique
  ON payout_dual_control_actions(payout_id, action_type)
  WHERE status = 'pending';
