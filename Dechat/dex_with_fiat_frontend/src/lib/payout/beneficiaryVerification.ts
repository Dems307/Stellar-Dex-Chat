import crypto from 'node:crypto';
import { serverEnv as env } from '@/lib/serverEnv';
import {
  deriveBeneficiaryDedupeKey,
  maskAccountNumber,
  type DeriveDedupeKeyInput,
} from './beneficiaryStore';
import type { CallerIdentity } from './auth';

const VERIFICATION_TTL_MS = 5 * 60 * 1000;

export type BeneficiaryVerificationFailure =
  | 'required'
  | 'expired'
  | 'details_changed';

export function getWalletIdentityScope(
  identity: CallerIdentity | null,
): string | null {
  if (!identity || identity.type !== 'wallet') return null;
  const address = identity.address.trim().toUpperCase();
  return address ? `wallet:${address}` : null;
}

function getDetailsKey(
  input: DeriveDedupeKeyInput & { identityScope: string },
): string {
  return deriveBeneficiaryDedupeKey({
    accountNumber: input.accountNumber,
    bankCode: input.bankCode,
    currency: input.currency,
    userScope: input.identityScope,
  });
}

function getVerificationSecret(): string {
  const secret = env.BENEFICIARY_DEDUPE_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Beneficiary verification secret is not configured');
  }
  return (
    env.ADMIN_SECRET ||
    env.PAYSTACK_SECRET_KEY ||
    'stellar-dex-chat-beneficiary-verification-dev-secret'
  );
}

function hashIdentityScope(identityScope: string): string {
  return crypto
    .createHmac('sha256', getVerificationSecret())
    .update(identityScope)
    .digest('hex');
}

function hashAccountName(accountName: string): string {
  return crypto
    .createHmac('sha256', getVerificationSecret())
    .update(accountName.trim().toLowerCase())
    .digest('hex');
}

function signPayload(payload: string): string {
  return crypto
    .createHmac('sha256', getVerificationSecret())
    .update(payload)
    .digest('hex');
}

export function issueBeneficiaryVerification(
  input: DeriveDedupeKeyInput & {
    identityScope: string;
    accountName: string;
  },
): { verificationToken: string; expiresAt: string; accountNumberMasked: string } {
  const now = Date.now();
  const expiresAt = now + VERIFICATION_TTL_MS;
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      identityHash: hashIdentityScope(input.identityScope),
      detailsKey: getDetailsKey(input),
      accountNameHash: hashAccountName(input.accountName),
      expiresAt,
      nonce: crypto.randomBytes(16).toString('base64url'),
    }),
  ).toString('base64url');
  const verificationToken = `${payload}.${signPayload(payload)}`;

  return {
    verificationToken,
    expiresAt: new Date(expiresAt).toISOString(),
    accountNumberMasked: maskAccountNumber(input.accountNumber),
  };
}

function readVerificationToken(
  token: string,
): {
  version?: number;
  identityHash?: string;
  detailsKey?: string;
  accountNameHash?: string;
  expiresAt?: number;
} | null {
  const [payload, signature, ...extra] = token.split('.');
  if (
    !payload ||
    !/^[A-Za-z0-9_-]+$/.test(payload) ||
    !signature ||
    !/^[a-f0-9]{64}$/i.test(signature) ||
    extra.length > 0
  ) {
    return null;
  }

  const expected = Buffer.from(signPayload(payload), 'hex');
  const actual = Buffer.from(signature, 'hex');
  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(expected, actual)
  ) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as {
      version?: number;
      identityHash?: string;
      detailsKey?: string;
      accountNameHash?: string;
      expiresAt?: number;
    };
  } catch {
    return null;
  }
}

export function validateBeneficiaryVerification(
  verificationToken: string | undefined,
  input: DeriveDedupeKeyInput & {
    identityScope: string;
    accountName: string;
  },
): { valid: true } | { valid: false; reason: BeneficiaryVerificationFailure } {
  if (!verificationToken) {
    return { valid: false, reason: 'required' };
  }

  const claims = readVerificationToken(verificationToken);
  if (
    !claims ||
    claims.version !== 1 ||
    typeof claims.expiresAt !== 'number' ||
    typeof claims.identityHash !== 'string' ||
    typeof claims.detailsKey !== 'string' ||
    typeof claims.accountNameHash !== 'string'
  ) {
    return { valid: false, reason: 'required' };
  }

  if (claims.expiresAt <= Date.now()) {
    return { valid: false, reason: 'expired' };
  }
  if (claims.identityHash !== hashIdentityScope(input.identityScope)) {
    return { valid: false, reason: 'required' };
  }
  if (
    claims.detailsKey !== getDetailsKey(input) ||
    claims.accountNameHash !== hashAccountName(input.accountName)
  ) {
    return { valid: false, reason: 'details_changed' };
  }
  return { valid: true };
}
