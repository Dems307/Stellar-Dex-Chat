import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getWalletIdentityScope,
  issueBeneficiaryVerification,
  validateBeneficiaryVerification,
} from './beneficiaryVerification';

const DETAILS = {
  accountNumber: '0123456789',
  bankCode: '058',
  currency: 'NGN',
  accountName: 'Ada Lovelace',
};
const WALLET_A = {
  type: 'wallet' as const,
  address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  isOperator: false as const,
};
const WALLET_B = {
  type: 'wallet' as const,
  address: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF',
  isOperator: false as const,
};

describe('beneficiary verification authorization', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('binds exact beneficiary details to the wallet identity', () => {
    const identityScope = getWalletIdentityScope(WALLET_A)!;
    const { verificationToken } = issueBeneficiaryVerification({
      ...DETAILS,
      identityScope,
    });

    expect(
      validateBeneficiaryVerification(verificationToken, {
        ...DETAILS,
        identityScope,
      }),
    ).toEqual({ valid: true });

    expect(
      validateBeneficiaryVerification(verificationToken, {
        ...DETAILS,
        identityScope: getWalletIdentityScope(WALLET_B)!,
      }),
    ).toEqual({ valid: false, reason: 'required' });

    expect(
      validateBeneficiaryVerification(verificationToken, {
        ...DETAILS,
        accountNumber: '9876543210',
        identityScope,
      }),
    ).toEqual({ valid: false, reason: 'details_changed' });

    expect(
      validateBeneficiaryVerification(verificationToken, {
        ...DETAILS,
        bankCode: '044',
        identityScope,
      }),
    ).toEqual({ valid: false, reason: 'details_changed' });

    expect(
      validateBeneficiaryVerification(verificationToken, {
        ...DETAILS,
        accountName: 'Another Name',
        identityScope,
      }),
    ).toEqual({ valid: false, reason: 'details_changed' });

    const [payload, signature] = verificationToken.split('.');
    const changedSignature = `${signature[0] === '0' ? '1' : '0'}${signature.slice(1)}`;
    expect(
      validateBeneficiaryVerification(`${payload}.${changedSignature}`, {
        ...DETAILS,
        identityScope,
      }),
    ).toEqual({ valid: false, reason: 'required' });

    expect(
      validateBeneficiaryVerification(`${verificationToken}x`, {
        ...DETAILS,
        identityScope,
      }),
    ).toEqual({ valid: false, reason: 'required' });
  });

  it('expires verification after five minutes and rejects missing tokens', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-21T18:00:00.000Z'));
    const identityScope = getWalletIdentityScope(WALLET_A)!;
    const { verificationToken, expiresAt } = issueBeneficiaryVerification({
      ...DETAILS,
      identityScope,
    });
    expect(expiresAt).toBe('2026-11-21T18:05:00.000Z');

    expect(
      validateBeneficiaryVerification(undefined, { ...DETAILS, identityScope }),
    ).toEqual({ valid: false, reason: 'required' });

    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(
      validateBeneficiaryVerification(verificationToken, {
        ...DETAILS,
        identityScope,
      }),
    ).toEqual({ valid: false, reason: 'expired' });
  });
});
