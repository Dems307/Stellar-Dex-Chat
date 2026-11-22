-- Migration 001: Payout state and transitions schema (Issue #97)
--
-- This file is applied by the checksummed migration runner in
-- `payoutMigrations.ts`. The runner records the SHA-256 checksum of this file
-- in `schema_migrations` and refuses to re-apply a migration whose checksum
-- has changed (see Issue #247). Keep this file immutable once applied; make
-- schema changes in a new numbered migration instead.

-- ---------------------------------------------------------------------------
-- Migration metadata (Issue #247)
-- ---------------------------------------------------------------------------
-- Records every applied migration together with its checksum so that repeat
-- applies are idempotent and drift is detected. `rollback_evidence` documents
-- the forward-recovery / rollback procedure for the migration.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rollback_evidence TEXT
);

-- Coordination lock so concurrent runners cannot apply migrations in
-- parallel. A single row (id = 1) is used as an advisory lock; runners acquire
-- it with `SELECT ... FOR UPDATE` inside a transaction and release it on
-- commit/rollback.
CREATE TABLE IF NOT EXISTS migration_lock (
  id SMALLINT PRIMARY KEY,
  locked_by VARCHAR(128),
  locked_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT migration_lock_singleton CHECK (id = 1)
);

INSERT INTO migration_lock (id, locked_by, locked_at)
VALUES (1, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Payout schema (Issue #97)
-- ---------------------------------------------------------------------------
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

-- Transactional outbox for payout side effects (Issue #222).
-- Rows are written in the same DB transaction as the payout state mutation so
-- the state change and the outbound provider command commit or roll back
-- together. A dispatcher delivers pending rows asynchronously (at-least-once)
-- using the stable idempotency_key so provider retries and replays are safe.
CREATE TABLE IF NOT EXISTS payout_outbox (
  id BIGSERIAL PRIMARY KEY,
  payout_id VARCHAR(64) NOT NULL REFERENCES payout_intents(id) ON DELETE CASCADE,
  command_type VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) UNIQUE NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMP WITH TIME ZONE
);

-- Provider capability contract for reversals and recalls (Issue #223).
-- Each provider adapter declares which cancellation, recall, and status
-- semantics it supports. Actions a provider does not support are routed to an
-- explicit manual-review outcome instead of reporting a false success.
CREATE TABLE IF NOT EXISTS provider_capabilities (
  provider_id VARCHAR(64) PRIMARY KEY,
  supports_cancel BOOLEAN NOT NULL DEFAULT FALSE,
  supports_recall BOOLEAN NOT NULL DEFAULT FALSE,
  supports_status BOOLEAN NOT NULL DEFAULT FALSE,
  cancel_semantics VARCHAR(32) NOT NULL DEFAULT 'unsupported',
  recall_semantics VARCHAR(32) NOT NULL DEFAULT 'unsupported',
  status_semantics VARCHAR(32) NOT NULL DEFAULT 'unsupported',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT provider_capabilities_cancel_semantics_check
    CHECK (cancel_semantics IN ('unsupported', 'synchronous', 'asynchronous')),
  CONSTRAINT provider_capabilities_recall_semantics_check
    CHECK (recall_semantics IN ('unsupported', 'synchronous', 'asynchronous')),
  CONSTRAINT provider_capabilities_status_semantics_check
    CHECK (status_semantics IN ('unsupported', 'polling', 'webhook'))
);

-- Manual-review queue for actions a provider cannot perform. Rows are created
-- instead of emitting a success transition so operators can resolve them.
CREATE TABLE IF NOT EXISTS payout_manual_reviews (
  id BIGSERIAL PRIMARY KEY,
  payout_id VARCHAR(64) NOT NULL REFERENCES payout_intents(id) ON DELETE CASCADE,
  action VARCHAR(32) NOT NULL,
  provider_id VARCHAR(64) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT payout_manual_reviews_action_check
    CHECK (action IN ('cancel', 'recall', 'status')),
  CONSTRAINT payout_manual_reviews_status_check
    CHECK (status IN ('open', 'resolved', 'dismissed'))
);

-- Append-only reversal and dispute lifecycle (Issue #224).
-- Provider reversals and disputed transfers are recorded as immutable events
-- linked to the original payout. Each event captures the settlement evidence
-- (provider reference, amount, currency, evidence payload) so the original
-- settlement record is preserved even after the payout is reversed. Rows are
-- never updated or deleted; the current lifecycle state is derived from the
-- latest event per payout.
CREATE TABLE IF NOT EXISTS payout_reversals (
  id BIGSERIAL PRIMARY KEY,
  payout_id VARCHAR(64) NOT NULL REFERENCES payout_intents(id) ON DELETE CASCADE,
  event_type VARCHAR(32) NOT NULL,
  provider_reference VARCHAR(128),
  amount_minor_units BIGINT NOT NULL,
  currency VARCHAR(8) NOT NULL,
  reason TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT payout_reversals_event_type_check
    CHECK (event_type IN ('reversal_requested', 'reversal_settled', 'dispute_opened', 'dispute_resolved')),
  CONSTRAINT payout_reversals_amount_check CHECK (amount_minor_units > 0)
);

-- A payout may only be reversed once; disputes may be opened and resolved
-- repeatedly but a reversal event is terminal for the successful state.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_reversals_single_reversal
  ON payout_reversals(payout_id)
  WHERE event_type IN ('reversal_requested', 'reversal_settled');

-- Prevent a reversed transfer from remaining successful: once any reversal
-- event exists for a payout, the payout status must not be 'succeeded'.
CREATE OR REPLACE FUNCTION enforce_payout_reversal_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'succeeded' AND EXISTS (
    SELECT 1 FROM payout_reversals
    WHERE payout_id = NEW.id
      AND event_type IN ('reversal_requested', 'reversal_settled')
  ) THEN
    RAISE EXCEPTION 'payout % cannot remain succeeded after a reversal', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payout_intents_reversal_status ON payout_intents;
CREATE TRIGGER trg_payout_intents_reversal_status
  BEFORE UPDATE ON payout_intents
  FOR EACH ROW
  EXECUTE FUNCTION enforce_payout_reversal_status();

CREATE INDEX IF NOT EXISTS idx_payout_intents_status ON payout_intents(status);
CREATE INDEX IF NOT EXISTS idx_payout_intents_created_at ON payout_intents(created_at);

-- Least-privilege runtime roles (Issue #262)
-- Split read and mutation access to payout tables. No wildcard grants.
-- Roles are created without LOGIN; credentials are provisioned out-of-band
-- by the deployment environment (never committed to the repository).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payout_reader') THEN
    CREATE ROLE payout_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'payout_writer') THEN
    CREATE ROLE payout_writer NOLOGIN;
  END IF;
END
$$;

-- Read-only role: SELECT only on payout tables.
REVOKE ALL ON payout_intents FROM payout_reader;
REVOKE ALL ON payout_state_transitions FROM payout_reader;
GRANT SELECT ON payout_intents TO payout_reader;
GRANT SELECT ON payout_state_transitions TO payout_reader;

-- Mutation role: INSERT/UPDATE on payout tables, plus SELECT so that
-- RETURNING clauses and existence checks work. No DELETE/TRUNCATE.
REVOKE ALL ON payout_intents FROM payout_writer;
REVOKE ALL ON payout_state_transitions FROM payout_writer;
GRANT SELECT, INSERT, UPDATE ON payout_intents TO payout_writer;
GRANT SELECT, INSERT, UPDATE ON payout_state_transitions TO payout_writer;

-- Sequence usage for the transitions surrogate key (no wildcard sequence grant).
REVOKE ALL ON SEQUENCE payout_state_transitions_id_seq FROM payout_reader;
REVOKE ALL ON SEQUENCE payout_state_transitions_id_seq FROM payout_writer;
GRANT USAGE, SELECT ON SEQUENCE payout_state_transitions_id_seq TO payout_writer;

-- Explicitly ensure neither role can create objects or escalate.
REVOKE CREATE ON SCHEMA public FROM payout_reader;
REVOKE CREATE ON SCHEMA public FROM payout_writer;

-- Issue #217: Tenant-aware AI budget accounting with atomic reservations.
-- Reservations are taken before model dispatch against both a per-user and a
-- global spend ceiling; actual usage is reconciled afterward. The reserved
-- amount is held in `reserved_minor_units` until the request settles, at which
-- point it is released and `spent_minor_units` is incremented by the actual
-- cost. Concurrent requests are serialized per tenant/user via row locks so
-- that the sum of reserved + spent can never exceed the configured ceiling.

CREATE TABLE IF NOT EXISTS ai_budget_accounts (
  tenant_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'USD',
  -- Configured ceilings (NULL means unlimited for that scope).
  user_ceiling_minor_units BIGINT,
  global_ceiling_minor_units BIGINT,
  -- Running totals for this tenant/user scope.
  reserved_minor_units BIGINT NOT NULL DEFAULT 0,
  spent_minor_units BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT ai_budget_accounts_non_negative
    CHECK (reserved_minor_units >= 0 AND spent_minor_units >= 0)
);

-- One row per tenant to enforce the global ceiling atomically across users.
CREATE TABLE IF NOT EXISTS ai_budget_tenant_totals (
  tenant_id VARCHAR(64) PRIMARY KEY,
  currency VARCHAR(8) NOT NULL DEFAULT 'USD',
  global_ceiling_minor_units BIGINT,
  reserved_minor_units BIGINT NOT NULL DEFAULT 0,
  spent_minor_units BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ai_budget_tenant_totals_non_negative
    CHECK (reserved_minor_units >= 0 AND spent_minor_units >= 0)
);

-- Individual reservations. A reservation is created before dispatch and
-- settled (reconciled) or released (rolled back) afterward. The status column
-- makes the lifecycle explicit so partial/error responses can be reconciled.
CREATE TABLE IF NOT EXISTS ai_budget_reservations (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  request_id VARCHAR(128),
  status VARCHAR(32) NOT NULL DEFAULT 'reserved',
  reserved_minor_units BIGINT NOT NULL,
  actual_minor_units BIGINT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  settled_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT ai_budget_reservations_status_check
    CHECK (status IN ('reserved', 'settled', 'released')),
  CONSTRAINT ai_budget_reservations_amounts_check
    CHECK (reserved_minor_units >= 0 AND (actual_minor_units IS NULL OR actual_minor_units >= 0))
);

CREATE INDEX IF NOT EXISTS idx_ai_budget_reservations_scope
  ON ai_budget_reservations(tenant_id, user_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_budget_reservations_request
  ON ai_budget_reservations(request_id);

-- Issue #219: Privacy-safe retention controls for model traces and
-- evaluation fixtures. Stored traces hold only redacted prompts/completions
-- (secrets and payout identifiers are stripped at the trace-write boundary),
-- and every row carries an explicit expiry so retention is enforced by
-- deletion rather than by trusting callers. Traces are scoped to a tenant and
-- a user/session so they can be deleted on request (right-to-erasure) and
-- swept by the retention job once `expires_at` has passed.

CREATE TABLE IF NOT EXISTS ai_model_traces (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  session_id VARCHAR(128),
  request_id VARCHAR(128),
  -- Redacted prompt/completion payloads. Never store raw secrets or payout
  -- identifiers here; the write boundary sanitizes before insert.
  prompt_redacted TEXT,
  completion_redacted TEXT,
  -- True when redaction removed at least one sensitive span, so operators can
  -- audit that sanitization actually ran without seeing the removed data.
  redaction_applied BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  -- Hard retention deadline. Rows past this are eligible for deletion.
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  CONSTRAINT ai_model_traces_retention_check
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_ai_model_traces_user
  ON ai_model_traces(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_ai_model_traces_session
  ON ai_model_traces(tenant_id, session_id);
CREATE INDEX IF NOT EXISTS idx_ai_model_traces_expiry
  ON ai_model_traces(expires_at);

-- Evaluation fixtures follow the same retention contract: synthetic-only
-- inputs, redacted payloads, and an explicit expiry so fixtures cannot linger
-- indefinitely. `deleted_at` supports soft-deletion for audit while the
-- retention sweep hard-deletes expired rows.
CREATE TABLE IF NOT EXISTS ai_evaluation_fixtures (
  id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  input_redacted TEXT,
  expected_redacted TEXT,
  redaction_applied BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  deleted_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT ai_evaluation_fixtures_retention_check
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_ai_evaluation_fixtures_tenant
  ON ai_evaluation_fixtures(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ai_evaluation_fixtures_expiry
  ON ai_evaluation_fixtures(expires_at);
