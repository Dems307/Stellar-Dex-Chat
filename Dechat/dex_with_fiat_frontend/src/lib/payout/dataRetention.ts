import crypto from 'crypto';

/**
 * Sensitivity level classifications for payout and financial data.
 */
export type SensitivityLevel =
  | 'RESTRICTED_PII'   // Sensitive personally identifiable info (account number, name, BVN)
  | 'OPERATIONAL'        // Transient provider credentials & identifiers (recipient_code, transfer_code)
  | 'AUDIT_FINANCIAL';   // Minimal non-identifying financial data preserved for compliance and accounting

export type PayoutStatus =
  | 'pending'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export type DeletionTrigger =
  | 'automated_expiry'
  | 'user_request'
  | 'admin_cleanup'
  | 'compliance_mandate';

export interface FieldPolicy {
  sensitivity: SensitivityLevel;
  redactInLogs: boolean;
  encryptAtRest: boolean;
  wipeOnDeletion: boolean;
  description: string;
}

/**
 * Declarative field classification registry.
 */
export const FIELD_CLASSIFICATIONS: Record<string, FieldPolicy> = {
  // RESTRICTED_PII: Highly sensitive personal and banking identifiers
  account_number: {
    sensitivity: 'RESTRICTED_PII',
    redactInLogs: true,
    encryptAtRest: true,
    wipeOnDeletion: true,
    description: 'Bank account number of beneficiary',
  },
  account_name: {
    sensitivity: 'RESTRICTED_PII',
    redactInLogs: true,
    encryptAtRest: true,
    wipeOnDeletion: true,
    description: 'Full legal name associated with bank account',
  },
  bvn: {
    sensitivity: 'RESTRICTED_PII',
    redactInLogs: true,
    encryptAtRest: true,
    wipeOnDeletion: true,
    description: 'Bank verification number or national tax identifier',
  },
  phone_number: {
    sensitivity: 'RESTRICTED_PII',
    redactInLogs: true,
    encryptAtRest: true,
    wipeOnDeletion: true,
    description: 'Beneficiary telephone contact number',
  },
  email: {
    sensitivity: 'RESTRICTED_PII',
    redactInLogs: true,
    encryptAtRest: true,
    wipeOnDeletion: true,
    description: 'Beneficiary email address',
  },

  // OPERATIONAL: Provider identifiers needed during execution but not for long-term audit
  recipient_code: {
    sensitivity: 'OPERATIONAL',
    redactInLogs: true,
    encryptAtRest: false,
    wipeOnDeletion: true,
    description: 'Provider recipient reference token (e.g., Paystack RCP_xxx)',
  },
  transfer_code: {
    sensitivity: 'OPERATIONAL',
    redactInLogs: true,
    encryptAtRest: false,
    wipeOnDeletion: true,
    description: 'Provider internal transfer transaction identifier',
  },
  bank_code: {
    sensitivity: 'OPERATIONAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Routing or institution code of beneficiary bank',
  },

  // AUDIT_FINANCIAL: Non-identifying minimal audit data preserved indefinitely
  reference: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Unique non-identifying transfer reference',
  },
  amount: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Numeric transfer amount in stroops or smallest fiat unit',
  },
  currency: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'ISO 4217 fiat or Stellar asset code',
  },
  fee: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Transaction processing fee',
  },
  status: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Current lifecycle state of payout',
  },
  createdAt: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Timestamp when payout was requested',
  },
  settledAt: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Timestamp when payout was settled or reached terminal status',
  },
  bankToken: {
    sensitivity: 'AUDIT_FINANCIAL',
    redactInLogs: false,
    encryptAtRest: false,
    wipeOnDeletion: false,
    description: 'Non-reversible deterministic token of bank identifier for deduplication',
  },
};

/**
 * Retention periods (in milliseconds) before automatic deletion triggers.
 */
export const RETENTION_PERIODS_MS: Record<PayoutStatus, number> = {
  completed: 24 * 60 * 60 * 1000,      // 24 hours after completion
  failed: 48 * 60 * 60 * 1000,         // 48 hours to facilitate retry/support
  cancelled: 24 * 60 * 60 * 1000,      // 24 hours
  rejected: 24 * 60 * 60 * 1000,       // 24 hours
  pending: Number.POSITIVE_INFINITY,   // Active transfers must never be auto-deleted
};

/**
 * Legal/audit retention exceptions that override user-initiated account deletion.
 * Each exception documents why a category of user-linked data must survive an
 * account deletion request and what transformation is permitted instead.
 */
export type RetentionExceptionCategory =
  | 'financial_audit'      // Accounting / tax records of settled payouts
  | 'financial_logs'       // Operational financial logs required for reconciliation
  | 'dispute_hold'         // Records under active dispute or chargeback investigation
  | 'regulatory_mandate';  // Statutory retention imposed by a regulator

export type RetentionAction =
  | 'retain'               // Keep the record as-is (already non-identifying)
  | 'deidentify'           // Irreversibly strip identifiers, keep the audit skeleton
  | 'delete';              // No exception applies; erase the record

export interface RetentionException {
  id: string;
  category: RetentionExceptionCategory;
  description: string;
  /** Minimum period the exception keeps the record alive, in milliseconds. */
  retentionMs: number;
  /** Fields that must be irreversibly de-identified when the exception applies. */
  deidentifyFields: string[];
  /** Fields that may be preserved verbatim under the exception. */
  preservedFields: string[];
}

/**
 * Declarative registry of legal/audit retention exceptions.
 */
export const RETENTION_EXCEPTIONS: Record<string, RetentionException> = {
  payout_financial_audit: {
    id: 'payout_financial_audit',
    category: 'financial_audit',
    description:
      'Settled payout audit summaries are retained for accounting and tax reporting.',
    retentionMs: 7 * 365 * 24 * 60 * 60 * 1000, // 7 years
    deidentifyFields: [
      'account_number',
      'account_name',
      'bvn',
      'phone_number',
      'email',
      'recipient_code',
      'transfer_code',
    ],
    preservedFields: [
      'reference',
      'amount',
      'currency',
      'fee',
      'status',
      'createdAt',
      'settledAt',
      'bankToken',
    ],
  },
  payout_financial_logs: {
    id: 'payout_financial_logs',
    category: 'financial_logs',
    description:
      'Financial transaction logs are retained for reconciliation and fraud review.',
    retentionMs: 2 * 365 * 24 * 60 * 60 * 1000, // 2 years
    deidentifyFields: [
      'account_number',
      'account_name',
      'bvn',
      'phone_number',
      'email',
      'recipient_code',
      'transfer_code',
    ],
    preservedFields: ['reference', 'amount', 'currency', 'status', 'createdAt'],
  },
  payout_dispute_hold: {
    id: 'payout_dispute_hold',
    category: 'dispute_hold',
    description:
      'Records tied to an open dispute or chargeback are frozen until resolution.',
    retentionMs: 180 * 24 * 60 * 60 * 1000, // 180 days
    deidentifyFields: [
      'account_number',
      'account_name',
      'bvn',
      'phone_number',
      'email',
    ],
    preservedFields: ['reference', 'amount', 'currency', 'status', 'createdAt'],
  },
};

export interface RetentionDecision {
  action: RetentionAction;
  /** Matched exception id, if any. */
  exceptionId?: string;
  /** Fields that must be irreversibly de-identified. */
  deidentifyFields: string[];
  /** Fields that may be preserved under the exception. */
  preservedFields: string[];
  /** Timestamp (ms) until which the record must be retained, if applicable. */
  retainUntil?: number;
  reason: string;
}

export interface RetentionEvaluationInput {
  status: PayoutStatus;
  createdAt: number;
  settledAt?: number;
  /** True when the record is linked to an open dispute or chargeback. */
  hasOpenDispute?: boolean;
  /** True when the record is a financial log entry rather than a payout record. */
  isFinancialLog?: boolean;
  /** Current time in ms (injectable for deterministic tests). */
  now?: number;
}

/**
 * Decides how a user-linked payout record must be handled after an account
 * deletion request: retained, irreversibly de-identified, or deleted.
 *
 * Pending payouts are never deleted or de-identified because they are still
 * in flight; the caller must wait for a terminal status.
 */
export function evaluateRetention(
  input: RetentionEvaluationInput,
): RetentionDecision {
  const now = input.now ?? Date.now();

  if (input.status === 'pending') {
    return {
      action: 'retain',
      deidentifyFields: [],
      preservedFields: [],
      reason:
        'Pending payouts are in flight and cannot be deleted or de-identified until terminal status.',
    };
  }

  if (input.hasOpenDispute) {
    const exception = RETENTION_EXCEPTIONS.payout_dispute_hold;
    return {
      action: 'deidentify',
      exceptionId: exception.id,
      deidentifyFields: [...exception.deidentifyFields],
      preservedFields: [...exception.preservedFields],
      retainUntil: now + exception.retentionMs,
      reason: exception.description,
    };
  }

  if (input.isFinancialLog) {
    const exception = RETENTION_EXCEPTIONS.payout_financial_logs;
    return {
      action: 'deidentify',
      exceptionId: exception.id,
      deidentifyFields: [...exception.deidentifyFields],
      preservedFields: [...exception.preservedFields],
      retainUntil: now + exception.retentionMs,
      reason: exception.description,
    };
  }

  if (input.status === 'completed') {
    const exception = RETENTION_EXCEPTIONS.payout_financial_audit;
    const settledAt = input.settledAt ?? input.createdAt;
    const retainUntil = settledAt + exception.retentionMs;
    return {
      action: retainUntil > now ? 'deidentify' : 'delete',
      exceptionId: exception.id,
      deidentifyFields: [...exception.deidentifyFields],
      preservedFields: [...exception.preservedFields],
      retainUntil,
      reason: exception.description,
    };
  }

  // Failed, cancelled, and rejected payouts carry no legal retention obligation.
  return {
    action: 'delete',
    deidentifyFields: [],
    preservedFields: [],
    reason: 'No legal or audit retention exception applies to this record.',
  };
}

/**
 * Retention horizons for high-volume audit and event data.
 * Each horizon defines how long rows remain in the hot (queryable) partition
 * before being moved to archive storage. Audit evidence is never destroyed.
 */
export type EvidenceClass = 'audit' | 'webhook' | 'provider_evidence';

/**
 * Storage tiers for evidence. `hot` is queryable online, `warm` is retained for
 * operational lookups, and `archive` is retained for compliance/export only.
 */
export type RetentionTier = 'hot' | 'warm' | 'archive';

export interface RetentionTierPolicy {
  tier: RetentionTier;
  /** Age (ms) at which evidence enters this tier. */
  minAgeMs: number;
  /** Age (ms) at which evidence leaves this tier; Infinity for archive. */
  maxAgeMs: number;
  /** Whether the evidence is expected to be exported to cold storage. */
  exportable: boolean;
  description: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Declarative retention tier boundaries per evidence class.
 * Boundaries are inclusive of `minAgeMs` and exclusive of `maxAgeMs`.
 */
export const RETENTION_TIERS: Record<EvidenceClass, RetentionTierPolicy[]> = {
  audit: [
    {
      tier: 'hot',
      minAgeMs: 0,
      maxAgeMs: 30 * DAY_MS,
      exportable: false,
      description: 'Audit summaries queryable online for 30 days',
    },
    {
      tier: 'warm',
      minAgeMs: 30 * DAY_MS,
      maxAgeMs: 365 * DAY_MS,
      exportable: true,
      description: 'Audit summaries retained for operational lookups up to 1 year',
    },
    {
      tier: 'archive',
      minAgeMs: 365 * DAY_MS,
      maxAgeMs: Number.POSITIVE_INFINITY,
      exportable: true,
      description: 'Audit summaries retained indefinitely for compliance',
    },
  ],
  webhook: [
    {
      tier: 'hot',
      minAgeMs: 0,
      maxAgeMs: 7 * DAY_MS,
      exportable: false,
      description: 'Webhook payloads queryable online for 7 days',
    },
    {
      tier: 'warm',
      minAgeMs: 7 * DAY_MS,
      maxAgeMs: 90 * DAY_MS,
      exportable: true,
      description: 'Webhook payloads retained for replay/debugging up to 90 days',
    },
    {
      tier: 'archive',
      minAgeMs: 90 * DAY_MS,
      maxAgeMs: Number.POSITIVE_INFINITY,
      exportable: true,
      description: 'Webhook payloads archived for dispute resolution',
    },
  ],
  provider_evidence: [
    {
      tier: 'hot',
      minAgeMs: 0,
      maxAgeMs: 14 * DAY_MS,
      exportable: false,
      description: 'Provider evidence queryable online for 14 days',
    },
    {
      tier: 'warm',
      minAgeMs: 14 * DAY_MS,
      maxAgeMs: 180 * DAY_MS,
      exportable: true,
      description: 'Provider evidence retained for reconciliation up to 180 days',
    },
    {
      tier: 'archive',
      minAgeMs: 180 * DAY_MS,
      maxAgeMs: Number.POSITIVE_INFINITY,
      exportable: true,
      description: 'Provider evidence archived for financial audit',
    },
  ],
};

/**
 * Resolves the retention tier for a piece of evidence of the given class and age.
 * Throws on unknown evidence classes or invalid (negative/non-finite) ages.
 */
export function getRetentionTier(
  evidenceClass: EvidenceClass,
  ageMs: number,
): RetentionTier {
  const policies = RETENTION_TIERS[evidenceClass];
  if (!policies) {
    throw new Error(`Unknown evidence class: ${String(evidenceClass)}`);
  }
  if (typeof ageMs !== 'number' || Number.isNaN(ageMs) || ageMs < 0) {
    throw new Error(`Invalid evidence age: ${String(ageMs)}`);
  }

  for (const policy of policies) {
    if (ageMs >= policy.minAgeMs && ageMs < policy.maxAgeMs) {
      return policy.tier;
    }
  }

  // Only reachable for non-finite ages beyond the final tier.
  return policies[policies.length - 1].tier;
}

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

const DEFAULT_ENCRYPTION_SECRET =
  process.env.PAYOUT_ENCRYPTION_KEY ||
  'default-test-secret-key-32-chars-long!';

/**
 * Derives a 32-byte key from the configured secret.
 */
function getDerivedKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts sensitive string data at rest using AES-256-GCM.
 */
export function encryptAtRest(
  plaintext: string,
  secretKey: string = DEFAULT_ENCRYPTION_SECRET,
): EncryptedPayload {
  const iv = crypto.randomBytes(12);
  const key = getDerivedKey(secretKey);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return {
    ciphertext,
    iv: iv.toString('hex'),
    tag,
  };
}

/**
 * Decrypts AES-256-GCM encrypted payload at rest.
 */
export function decryptAtRest(
  payload: EncryptedPayload,
  secretKey: string = DEFAULT_ENCRYPTION_SECRET,
): string {
  const key = getDerivedKey(secretKey);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(payload.iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));

  let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Deterministically tokenizes a bank account identifier for reconciliation and deduplication.
 * This is an irreversible, salted cryptographic hash that prevents storing raw account numbers.
 */
export function tokenizeBankIdentifier(
  accountNumber: string,
  bankCode: string,
  salt: string = 'stellar-payout-token-salt',
): string {
  const cleanAccount = accountNumber.replace(/\D/g, '');
  const cleanBank = bankCode.trim().toLowerCase();
  const hash = crypto
    .createHmac('sha256', salt)
    .update(`${cleanBank}:${cleanAccount}`)
    .digest('hex');
  return `tok_bank_${hash.slice(0, 16)}`;
}

/**
 * Masks a bank account number, retaining only the last 4 digits.
 */
export function maskAccountNumber(accountNumber: string): string {
  const cleaned = accountNumber.trim();
  if (cleaned.length <= 4) {
    return '****';
  }
  const lastFour = cleaned.slice(-4);
  return `${'*'.repeat(cleaned.length - 4)}${lastFour}`;
}

/**
 * Redacts sensitive payout PII from logs, analytics, and telemetry objects.
 * Recursively scrubs fields classified as sensitive and replaces them with [REDACTED].
 */
export function redactSensitivePayoutData<T>(input: T): T {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input !== 'object') {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactSensitivePayoutData(item)) as unknown as T;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const policy = FIELD_CLASSIFICATIONS[key];
    const isSensitiveKey =
      (policy && policy.redactInLogs) ||
      /account_?number|account_?name|bvn|recipient_?code|transfer_?code|phone|email/i.test(
        key,
      );

    if (isSensitiveKey) {
      if (typeof value === 'string' && /account_?number/i.test(key)) {
        redacted[key] = maskAccountNumber(value);
      } else {
        redacted[key] = '[REDACTED]';
      }
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitivePayoutData(value);
    } else {
      redacted[key] = value;
    }
  }

  return redacted as T;
}

export interface MinimalFinancialAuditSummary {
  reference: string;
  amount: number;
  currency: string;
  status: PayoutStatus;
  bankToken: string;
  createdAt: number;
  settledAt?: number;
}

export interface DeletionProof {
  deletionProofId: string;
  reference: string;
  deletedAt: string;
  reason: DeletionTrigger;
  requestedBy?: string;
  fieldsWiped: string[];
  auditHash: string;
  preservedAuditReference: MinimalFinancialAuditSummary;
}

export interface PayoutRecord {
  reference: string;
  amount: number;
  currency: string;
  status: PayoutStatus;
  createdAt: number;
  settledAt?: number;
  bankCode: string;
  bankToken: string;

  // Sensitive PII fields (cleared upon verifiable deletion)
  accountNumber?: string;
  accountName?: string;
  bvn?: string;
  encryptedPii?: EncryptedPayload;
  recipientCode?: string;
  transferCode?: string;

  // Deletion metadata
  isPiiDeleted?: boolean;
  deletionProof?: DeletionProof;
}

/**
 * Computes a verifiable cryptographic SHA-256 hash certificate for deletion.
 */
export function generateAuditHash(
  reference: string,
  deletedAt: string,
  summary: MinimalFinancialAuditSummary,
): string {
  const content = JSON.stringify({
    reference,
    deletedAt,
    summary,
  });
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Verifiable deletion workflow:
 * Eradicates all restricted PII and operational identifiers while preserving
 * an immutable, non-identifying financial audit summary and verifiable cryptographic proof.
 *
 * Implements strict idempotency: if already deleted, returns the existing proof.
 */
export function deletePayoutPii(
  record: PayoutRecord,
  reason: DeletionTrigger,
  options?: { requestedBy?: string },
): { updatedRecord: PayoutRecord; proof: DeletionProof } {
  // Idempotency: If already deleted, return existing proof without altering history
  if (record.isPiiDeleted && record.deletionProof) {
    return {
      updatedRecord: record,
      proof: record.deletionProof,
    };
  }

  // Active pending transfers cannot be deleted
  if (record.status === 'pending') {
    throw new Error(
      `Cannot execute PII deletion on pending transfer ${record.reference}. Payout must reach terminal status before data retention deletion.`,
    );
  }

  const deletedAt = new Date().toISOString();
  const fieldsWiped: string[] = [];

  if (record.accountNumber !== undefined) fieldsWiped.push('account_number');
  if (record.accountName !== undefined) fieldsWiped.push('account_name');
  if (record.bvn !== undefined) fieldsWiped.push('bvn');
  if (record.encryptedPii !== undefined) fieldsWiped.push('encrypted_pii');
  if (record.recipientCode !== undefined) fieldsWiped.push('recipient_code');
  if (record.transferCode !== undefined) fieldsWiped.push('transfer_code');

  const preservedAuditReference: MinimalFinancialAuditSummary = {
    reference: record.reference,
    amount: record.amount,
    currency: record.currency,
    status: record.status,
    bankToken: record.bankToken,
    createdAt: record.createdAt,
    settledAt: record.settledAt,
  };

  const auditHash = generateAuditHash(
    record.reference,
    deletedAt,
    preservedAuditReference,
  );

  const proof: DeletionProof = {
    deletionProofId: `proof_${crypto.randomBytes(8).toString('hex')}`,
    reference: record.reference,
    deletedAt,
    reason,
    requestedBy: options?.requestedBy,
    fieldsWiped,
    auditHash,
    preservedAuditReference,
  };

  const updatedRecord: PayoutRecord = {
    reference: record.reference,
    amount: record.amount,
    currency: record.currency,
    status: record.status,
    createdAt: record.createdAt,
    settledAt: record.settledAt,
    bankCode: record.bankCode,
    bankToken: record.bankToken,
    isPiiDeleted: true,
    deletionProof: proof,
    // Sensitive fields explicitly scrubbed
    accountNumber: undefined,
    accountName: undefined,
    bvn: undefined,
    encryptedPii: undefined,
    recipientCode: undefined,
    transferCode: undefined,
  };

  return { updatedRecord, proof };
}

/**
 * Service managing payout data lifecycle, tokenization, encryption at rest,
 * automated retention pruning, and verifiable deletion workflows.
 */
export class PayoutRetentionService {
  private records = new Map<string, PayoutRecord>();
  private deletionProofs = new Map<string, DeletionProof>();
  private encryptionSecret: string;

  constructor(encryptionSecret: string = DEFAULT_ENCRYPTION_SECRET) {
    this.encryptionSecret = encryptionSecret;
  }

  /**
   * Securely saves a payout record, tokenizing bank details and encrypting sensitive PII at rest.
   */
  public savePayout(input: {
    reference: string;
    amount: number;
    currency: string;
    status: PayoutStatus;
    accountNumber: string;
    accountName: string;
    bankCode: string;
    bvn?: string;
    recipientCode?: string;
    transferCode?: string;
    createdAt?: number;
    settledAt?: number;
  }): PayoutRecord {
    const bankToken = tokenizeBankIdentifier(input.accountNumber, input.bankCode);

    // Encrypt sensitive PII blob at rest
    const piiPayload = JSON.stringify({
      accountNumber: input.accountNumber,
      accountName: input.accountName,
      bvn: input.bvn,
    });
    const encryptedPii = encryptAtRest(piiPayload, this.encryptionSecret);

    const record: PayoutRecord = {
      reference: input.reference,
      amount: input.amount,
      currency: input.currency,
      status: input.status,
      createdAt: input.createdAt || Date.now(),
      settledAt: input.settledAt,
      bankCode: input.bankCode,
      bankToken,
      accountNumber: input.accountNumber,
      accountName: input.accountName,
      bvn: input.bvn,
      encryptedPii,
      recipientCode: input.recipientCode,
      transferCode: input.transferCode,
      isPiiDeleted: false,
    };

    this.records.set(record.reference, record);
    return record;
  }

  public getRecord(
    reference: string,
    options?: { includeDecryptedPii?: boolean },
  ): PayoutRecord | null {
    const record = this.records.get(reference);
    if (!record) return null;

    if (!options?.includeDecryptedPii || record.isPiiDeleted) {
      return {
        ...record,
        // Redact in memory unless explicitly authorized
        accountNumber: record.accountNumber
          ? maskAccountNumber(record.accountNumber)
          : undefined,
        accountName: record.accountName ? '[REDACTED]' : undefined,
        bvn: record.bvn ? '[REDACTED]' : undefined,
      };
    }

    return record;
  }

  /**
   * Executes verifiable deletion workflow for a specific payout reference.
   */
  public deletePayoutPii(
    reference: string,
    reason: DeletionTrigger,
    options?: { requestedBy?: string },
  ): DeletionProof {
    const existing = this.records.get(reference);
    if (!existing) {
      throw new Error(`Payout record not found for reference: ${reference}`);
    }

    const { updatedRecord, proof } = deletePayoutPii(existing, reason, options);
    this.records.set(reference, updatedRecord);
    this.deletionProofs.set(reference, proof);
    return proof;
  }

  /**
   * Scans all stored records and prunes expired records based on retention policy.
   */
  public pruneExpiredPayouts(now: number = Date.now()): {
    prunedProofs: DeletionProof[];
    activeCount: number;
  } {
    const prunedProofs: DeletionProof[] = [];

    for (const [reference, record] of this.records.entries()) {
      if (record.isPiiDeleted) {
        continue;
      }

      const retentionPeriod = RETENTION_PERIODS_MS[record.status];
      if (retentionPeriod === Number.POSITIVE_INFINITY) {
        continue;
      }

      const timestamp = record.settledAt || record.createdAt;
      if (now - timestamp >= retentionPeriod) {
        const proof = this.deletePayoutPii(reference, 'automated_expiry');
        prunedProofs.push(proof);
      }
    }

    const activeCount = Array.from(this.records.values()).filter(
      (r) => !r.isPiiDeleted,
    ).length;

    return { prunedProofs, activeCount };
  }

  /**
   * Applies an account deletion request to a stored payout record, honoring
   * legal/audit retention exceptions. Returns the retention decision and, when
   * the record was de-identified or deleted, the resulting deletion proof.
   */
  public applyAccountDeletion(
    reference: string,
    options?: { requestedBy?: string; hasOpenDispute?: boolean; now?: number },
  ): { decision: RetentionDecision; proof?: DeletionProof } {
    const existing = this.records.get(reference);
    if (!existing) {
      throw new Error(`Payout record not found for reference: ${reference}`);
    }

    const decision = evaluateRetention({
      status: existing.status,
      createdAt: existing.createdAt,
      settledAt: existing.settledAt,
      hasOpenDispute: options?.hasOpenDispute,
      now: options?.now,
    });

    if (decision.action === 'retain') {
      return { decision };
    }

    const proof = this.deletePayoutPii(reference, 'user_request', {
      requestedBy: options?.requestedBy,
    });
    return { decision, proof };
  }

  public getDeletionProof(reference: string): DeletionProof | null {
    return this.deletionProofs.get(reference) || null;
  }

  public getAllDeletionProofs(): DeletionProof[] {
    return Array.from(this.deletionProofs.values());
  }

  public clear(): void {
    this.records.clear();
    this.deletionProofs.clear();
  }
}

/**
 * Online partition/archive service for high-volume audit and event tables.
 *
 * Rows are partitioned by retention horizon based on `occurredAt`. The archive
 * job moves rows that have crossed the WARM boundary into archive storage,
 * emitting a manifest with per-row and aggregate integrity hashes. Archived
 * audit evidence remains retrievable via `getArchivedRow` / `queryArchive`.
 */
export class AuditArchiveService {
  private hotRows = new Map<string, AuditEventRow>();
  private archivedRows = new Map<string, ArchivedRow>();
  private manifests = new Map<string, ArchiveManifest>();

  /**
   * Ingests an audit/event row into the hot partition.
   */
  public ingest(row: AuditEventRow): void {
    if (this.archivedRows.has(row.id)) {
      throw new Error(
        `Cannot re-ingest archived audit row ${row.id}; archive evidence is immutable.`,
      );
    }
    this.hotRows.set(row.id, row);
  }

  /**
   * Returns the retention horizon currently applicable to a row.
   */
  public horizonFor(rowId: string, now: number = Date.now()): RetentionHorizon | null {
    const hot = this.hotRows.get(rowId);
    if (hot) {
      return resolveRetentionHorizon(hot.occurredAt, now);
    }
    const archived = this.archivedRows.get(rowId);
    if (archived) {
      return 'ARCHIVE';
    }
    return null;
  }

  /**
   * Queries live (non-archived) rows within an optional horizon filter.
   * By default only HOT rows are returned; WARM requires explicit selection.
   */
  public queryLive(
    options: { horizon?: RetentionHorizon; now?: number } = {},
  ): AuditEventRow[] {
    const now = options.now ?? Date.now();
    const horizon = options.horizon ?? 'HOT';
    if (horizon === 'ARCHIVE') {
      return [];
    }
    const result: AuditEventRow[] = [];
    for (const row of this.hotRows.values()) {
      if (resolveRetentionHorizon(row.occurredAt, now) === horizon) {
        result.push(row);
      }
    }
    return result.sort((a, b) => a.occurredAt - b.occurredAt);
  }

  /**
   * Online archive job: moves rows older than the WARM boundary into archive
   * storage and produces a manifest with integrity hashes.
   *
   * Boundary semantics: rows with age >= WARM.maxAgeMs are archived.
   * Returns an empty manifest (rowCount 0) when nothing is eligible.
   */
  public runArchiveJob(now: number = Date.now()): ArchiveManifest {
    const cutoffMs = now - RETENTION_HORIZONS.WARM.maxAgeMs;
    const eligible: AuditEventRow[] = [];

    for (const [id, row] of this.hotRows.entries()) {
      if (row.occurredAt <= cutoffMs) {
        eligible.push(row);
        this.hotRows.delete(id);
      }
    }

    eligible.sort((a, b) => a.occurredAt - b.occurredAt);

    const archivedAt = new Date(now).toISOString();
    const entries: ArchiveManifestEntry[] = eligible.map((row) => {
      const rowHash = hashAuditRow(row);
      this.archivedRows.set(row.id, {
        ...row,
        archivedAt,
        horizon: 'ARCHIVE',
      });
      return {
        id: row.id,
        reference: row.reference,
        occurredAt: row.occurredAt,
        rowHash,
      };
    });

    const manifestId = `manifest_${crypto.randomBytes(8).toString('hex')}`;
    const integrityHash = computeManifestIntegrityHash(
      manifestId,
      archivedAt,
      cutoffMs,
      entries,
    );

    const manifest: ArchiveManifest = {
      manifestId,
      createdAt: archivedAt,
      cutoffMs,
      rowCount: entries.length,
      entries,
      integrityHash,
    };

    this.manifests.set(manifestId, manifest);
    return manifest;
  }

  /**
   * Retrieves an archived audit row by id. Archived evidence is immutable.
   */
  public getArchivedRow(rowId: string): ArchivedRow | null {
    return this.archivedRows.get(rowId) || null;
  }

  /**
   * Queries archived rows by reference and/or time range (inclusive bounds).
   */
  public queryArchive(options: {
    reference?: string;
    fromMs?: number;
    toMs?: number;
  } = {}): ArchivedRow[] {
    const result: ArchivedRow[] = [];
    for (const row of this.archivedRows.values()) {
      if (options.reference !== undefined && row.reference !== options.reference) {
        continue;
      }
      if (options.fromMs !== undefined && row.occurredAt < options.fromMs) {
        continue;
      }
      if (options.toMs !== undefined && row.occurredAt > options.toMs) {
        continue;
      }
      result.push(row);
    }
    return result.sort((a, b) => a.occurredAt - b.occurredAt);
  }

  public getManifest(manifestId: string): ArchiveManifest | null {
    return this.manifests.get(manifestId) || null;
  }

  public getAllManifests(): ArchiveManifest[] {
    return Array.from(this.manifests.values());
  }

  public clear(): void {
    this.hotRows.clear();
    this.archivedRows.clear();
    this.manifests.clear();
  }
}
