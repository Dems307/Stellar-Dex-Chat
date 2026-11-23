import crypto from 'crypto';
import axios from 'axios';
import { credentialManager } from '../credentialManager';
import { toMinorUnits } from '../minorUnits';
import {
  estimateSettlementWindow,
  PAYSTACK_SETTLEMENT_CALENDARS,
} from '../settlementCalendar';
import { PayoutProviderError } from './types';
import {
  ProviderIdempotencyReconciliationRequiredError,
  providerIdempotencyRegistry,
} from '../providerIdempotency';
import { executeWithTimeoutBudget } from '../timeoutBudget';
import { redactForLog } from '../../logging/redaction';

import type {
  CancelTransferInput,
  CancelTransferResult,
  CreateRecipientInput,
  CreatedRecipient,
  InitiatedTransfer,
  InitiateTransferInput,
  InitiateTransferResult,
  NormalizedPayoutStatus,
  PayoutProvider,
  TransferStatus,
  TransferStatusInput,
  TransferStatusResult,
  VerifyAccountInput,
  VerifyAccountResult,
} from './types';
import { PayoutProviderError } from './types';

const DEFAULT_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const PAYSTACK_IDEMPOTENCY_WINDOW_MS = Number(
  process.env.PAYSTACK_IDEMPOTENCY_WINDOW_MS || DEFAULT_IDEMPOTENCY_WINDOW_MS,
);

if (
  !Number.isSafeInteger(PAYSTACK_IDEMPOTENCY_WINDOW_MS) ||
  PAYSTACK_IDEMPOTENCY_WINDOW_MS <= 0
) {
  throw new Error('PAYSTACK_IDEMPOTENCY_WINDOW_MS must be a positive integer');
}

export function toKobo(amountNgn: number): number {
  return Math.round(amountNgn * 100);
}

function paystackHeaders(secretKey: string) {
  return {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/json',
  };
}

function normalizePaystackStatus(status?: string): NormalizedPayoutStatus {
  switch (status?.toLowerCase()) {
    case 'success':
      return 'success';
    case 'failed':
    case 'rejected':
      return 'failed';
    case 'reversed':
      return 'reversed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error('Paystack returned an invalid response');
  }
  return value as Record<string, unknown>;
}

function toPayoutProviderError(
  message: string,
  code: string,
  status: number | undefined,
  retryable: boolean,
  providerCode?: string,
  error?: { response?: { data?: unknown } },
): PayoutProviderError {
  return new PayoutProviderError({
    message,
    code,
    statusCode: status,
    retryable,
    providerCode,
    rawResponse: error?.response?.data,
  });
}
  }
  return value as Record<string, unknown>;
}

function toInitiatedTransfer(
  response: Record<string, unknown>,
  input: InitiateTransferInput,
  providerKey: string,
  credentialVersion: string,
): InitiatedTransfer {
  const reference =
    typeof response.reference === 'string' && response.reference
      ? response.reference
      : providerKey;
  const amountMinor =
    typeof response.amount === 'number' && Number.isSafeInteger(response.amount)
      ? BigInt(response.amount)
      : toMinorUnits(input.amount, input.currency || 'NGN');

  return {
    reference,
    status: normalizePaystackStatus(
      typeof response.status === 'string' ? response.status : undefined,
    ),
    providerReference:
      typeof response.id === 'string' || typeof response.id === 'number'
        ? String(response.id)
        : reference,
    transferCode:
      typeof response.transfer_code === 'string'
        ? response.transfer_code
        : undefined,
    amountMinor,
    currency:
      typeof response.currency === 'string'
        ? response.currency
        : input.currency || 'NGN',
    recipientCode:
      typeof response.recipient === 'string'
        ? response.recipient
        : input.recipient,
    credentialVersion,
    rawResponse: response,
  };
}

function getErrorStatus(error: unknown): number | undefined {
  if (error instanceof PayoutProviderError) return error.statusCode;
  if (!axios.isAxiosError(error)) return undefined;
  return error.response?.status;
}

function toProviderError(error: unknown): PayoutProviderError {
  if (error instanceof PayoutProviderError) return error;

  const statusCode = getErrorStatus(error);
  const response = axios.isAxiosError(error) ? error.response?.data : undefined;
  const message =
    error instanceof Error ? error.message : 'Unknown Paystack error';
  const providerMessage =
    response && typeof response === 'object' && 'message' in response
      ? String(response.message)
      : message;
  const retryable =
    statusCode === undefined ||
    statusCode === 408 ||
    statusCode === 429 ||
    statusCode >= 500;

  return new PayoutProviderError({
    message: providerMessage,
    code:
      statusCode === 401 || statusCode === 403
        ? 'AUTHENTICATION_ERROR'
        : retryable
          ? 'PROVIDER_UNAVAILABLE'
          : statusCode === 404
            ? 'ACCOUNT_NOT_FOUND'
            : 'INVALID_REQUEST',
    statusCode,
    retryable,
    rawResponse: response,
  });
}

function getFingerprint(input: InitiateTransferInput): string {
  const amountMinor = toMinorUnits(input.amount, input.currency || 'NGN');
  const canonical = JSON.stringify({
    source: input.source,
    amountMinor: amountMinor.toString(),
    currency: (input.currency || 'NGN').toUpperCase(),
    recipient: input.recipient,
    reason: input.reason || 'Crypto withdrawal',
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function addSettlementEstimate(
  transfer: InitiatedTransfer,
  initiatedAt = new Date(),
): InitiatedTransfer {
  const currency = transfer.currency?.toUpperCase();
  const calendar = currency
    ? PAYSTACK_SETTLEMENT_CALENDARS[currency]
    : undefined;
  if (!calendar) return transfer;
  return {
    ...transfer,
    settlementEstimate: estimateSettlementWindow(calendar, initiatedAt),
  };
}

const paystackProvider: PayoutProvider = {
  name: 'paystack',
  settlementCalendars: Object.values(PAYSTACK_SETTLEMENT_CALENDARS),

  async verifyAccount(input: VerifyAccountInput): Promise<VerifiedAccount> {
    const credential = credentialManager.getActiveCredential();
    if (!credential?.secretKey) {
      return {
        accountNumber: input.accountNumber,
        accountName: 'Mock Account',
        bankCode: input.bankCode,
        rawResponse: { mock: true },
      };
    }

    try {
      const response = await executeWithTimeoutBudget(
        'verify',
        async (signal, phaseNotifier) => {
          const result = await axios.get(
            'https://api.paystack.co/bank/resolve',
            {
              headers: paystackHeaders(credential.secretKey),
              params: {
                account_number: input.accountNumber,
                bank_code: input.bankCode,
              },
              signal,
            },
          );
          phaseNotifier?.markConnected();
          return asRecord(result.data);
        },
      );
      const data = asRecord(response.data);
      return {
        accountNumber: String(data.account_number || input.accountNumber),
        accountName: String(data.account_name || ''),
        bankCode: input.bankCode,
        rawResponse: response,
      };
    } catch (error) {
      throw toProviderError(error);
    }
  },

  async createRecipient(
    input: CreateRecipientInput,
  ): Promise<CreateRecipientResult> {
    const credential = credentialManager.getActiveCredential();

    if (!credential?.secretKey) {
      console.warn(
        redactForLog(
          'Paystack secret key not found, using mock recipient creation',
        ),
      );
      return {
        recipientCode: `RCP_${crypto.randomUUID()}`,
        name: input.name,
        accountNumber: input.account_number,
        bankCode: input.bank_code,
        currency: input.currency,
        type: input.type,
        provider: 'paystack',
        rawResponse: { mock: true },
      };
    }

    try {
      const result = await executeWithTimeoutBudget(
        'recipient',
        async (signal, phaseNotifier) => {
          const response = await axios.post(
            'https://api.paystack.co/transferrecipient',
            input,
            { headers: paystackHeaders(credential.secretKey), signal },
          );
          phaseNotifier?.markConnected();
          return asRecord(response.data);
        },
      );
      const data = asRecord(result.data);
      return {
        recipientCode: String(data.recipient_code || ''),
        name: String(data.name || input.name),
        accountNumber: input.account_number,
        bankCode: input.bank_code,
        currency: input.currency,
        type: input.type,
        provider: 'paystack',
        rawResponse: data,
      };
    } catch (error) {
      throw toProviderError(error);
    }
  },

  async initiateTransfer(
    input: InitiateTransferInput,
  ): Promise<InitiatedTransfer> {
    const idempotencyKey = input.idempotencyKey || input.reference;
    if (!idempotencyKey) {
      throw new Error('A stable idempotency key is required for transfer');
    }
    const credential = credentialManager.getActiveCredential();
    const credentialVersion =
      credential?.version || input.credentialVersion || 'v1';
    const fingerprint = getFingerprint(input);

    const prepare = () =>
      providerIdempotencyRegistry.prepare({
        provider: 'paystack',
        idempotencyKey,
        requestFingerprint: fingerprint,
        windowMs: PAYSTACK_IDEMPOTENCY_WINDOW_MS,
      });

    let prepared;
    try {
      prepared = prepare();
    } catch (error) {
      if (!(error instanceof ProviderIdempotencyReconciliationRequiredError)) {
        throw error;
      }

      const previousAttempt = providerIdempotencyRegistry
        .get('paystack', idempotencyKey)
        ?.attempts.at(-1);
      if (!previousAttempt) throw error;

      try {
        const status = await this.checkTransferStatus({
          reference: previousAttempt.providerKey,
          credentialVersion,
        });
        providerIdempotencyRegistry.reconcile('paystack', idempotencyKey, {
          status: 'found',
          responseReference: status.reference,
        });
        return addSettlementEstimate({
          reference: status.reference,
          status: status.status,
          providerReference: status.providerReference,
          transferCode: status.transferCode,
          amountMinor: status.amountMinor,
          currency: status.currency,
          credentialVersion,
          rawResponse: status.rawResponse,
        });
      } catch (statusError) {
        if (getErrorStatus(statusError) !== 404) throw statusError;
        providerIdempotencyRegistry.reconcile('paystack', idempotencyKey, {
          status: 'absent',
        });
        prepared = prepare();
      }
    }

    if (prepared.mode === 'replay') {
      return addSettlementEstimate({
        reference: prepared.responseReference,
        status: 'pending',
        amountMinor: toMinorUnits(input.amount, input.currency || 'NGN'),
        currency: input.currency || 'NGN',
        recipientCode: input.recipient,
        credentialVersion,
      });
    }

    const providerKey = prepared.attempt.providerKey;
    if (!credential?.secretKey) {
      const mockResult: InitiatedTransfer = {
        reference: providerKey,
        status: 'pending',
        providerReference: providerKey,
        amountMinor: toMinorUnits(input.amount, input.currency || 'NGN'),
        currency: input.currency || 'NGN',
        recipientCode: input.recipient,
        credentialVersion,
        rawResponse: { mock: true },
      };
      providerIdempotencyRegistry.complete(
        'paystack',
        idempotencyKey,
        mockResult.reference,
      );
      return addSettlementEstimate(mockResult);
    }

    try {
      const response = await executeWithTimeoutBudget(
        'initiate',
        async (signal, phaseNotifier) => {
          const result = await axios.post(
            'https://api.paystack.co/transfer',
            {
              source: input.source,
              amount: Number(
                toMinorUnits(input.amount, input.currency || 'NGN'),
              ),
              recipient: input.recipient,
              reason: input.reason || 'Crypto withdrawal',
              reference: providerKey,
            },
            { headers: paystackHeaders(credential.secretKey), signal },
          );
          phaseNotifier?.markConnected();
          return asRecord(result.data);
        },
        { reference: providerKey },
      );
      const result = toInitiatedTransfer(
        asRecord(response.data),
        input,
        providerKey,
        credentialVersion,
      );
      providerIdempotencyRegistry.complete(
        'paystack',
        idempotencyKey,
        result.reference,
      );
      return addSettlementEstimate(result);
    } catch (error) {
      providerIdempotencyRegistry.markUncertain('paystack', idempotencyKey);
      throw toProviderError(error);
    }
  },

  async checkTransferStatus(
    input: TransferStatusInput,
  ): Promise<TransferStatusResult> {
    const { reference, credentialVersion } = input;
    // Look up versioned credential for existing in-flight intent, or fallback to active
    const cred = credentialManager.getCredential(credentialVersion);

    if (!cred || !cred.secretKey) {
      console.warn(
        redactForLog('Paystack secret key not found, using mock transfer status'),
      );

      return {
        reference,
        status: 'pending',
        providerReference: reference,
        rawResponse: { mock: true },
      };
    }

    try {
      const response = await executeWithTimeoutBudget(
        'status',
        async (signal, phaseNotifier) => {
          const result = await axios.get(
            `https://api.paystack.co/transfer/verify/${encodeURIComponent(input.reference)}`,
            { headers: paystackHeaders(credential.secretKey), signal },
          );
          phaseNotifier?.markConnected();
          return asRecord(result.data);
        },
        { reference: input.reference },
      );
      const data = asRecord(response.data);
      const amountMinor =
        typeof data.amount === 'number' && Number.isSafeInteger(data.amount)
          ? BigInt(data.amount)
          : undefined;
      return {
        reference:
          typeof data.reference === 'string' ? data.reference : input.reference,
        status: normalizePaystackStatus(
          typeof data.status === 'string' ? data.status : undefined,
        ),
        providerReference:
          typeof data.id === 'string' || typeof data.id === 'number'
            ? String(data.id)
            : undefined,
        transferCode:
          typeof data.transfer_code === 'string'
            ? data.transfer_code
            : undefined,
        amountMinor,
        currency: typeof data.currency === 'string' ? data.currency : undefined,
        failureReason:
          typeof data.failure_reason === 'string'
            ? data.failure_reason
            : undefined,
        completedAt:
          typeof data.updated_at === 'string' ? data.updated_at : undefined,
        rawResponse: data,
      };
    } catch (error) {
      throw toProviderError(error);
    }
  },

  async cancelTransfer(
    input: CancelTransferInput,
  ): Promise<CancelTransferResult> {
    const { reference } = input;

    const status = await this.checkTransferStatus({
      reference: input.reference,
    });
    if (status.status === 'success') {
      return {
        status: 'settled',
        cancellable: false,
        message: 'Transfer has already settled and cannot be cancelled',
        providerReference: status.providerReference,
      };
    }
    if (
      status.status === 'failed' ||
      status.status === 'reversed' ||
      status.status === 'cancelled'
    ) {
      return {
        status: 'rejected',
        cancellable: false,
        message: `Transfer is already in final state: ${status.status}`,
        providerReference: status.providerReference,
      };
    }

    if (!PAYSTACK_SECRET_KEY) {
      console.warn(
        redactForLog(
          'Paystack secret key not found, using mock transfer cancellation',
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        status: 'settled',
        cancellable: false,
        message: 'Transfer has already settled and cannot be cancelled',
        providerReference: status.providerReference,
      };
    }
    if (
      status.status === 'failed' ||
      status.status === 'reversed' ||
      status.status === 'cancelled'
    ) {
      return {
        status: 'rejected',
        cancellable: false,
        message: `Transfer is already in final state: ${status.status}`,
        providerReference: status.providerReference,
      };
    }
    return {
      status: 'confirmed',
      cancellable: true,
      message:
        input.reason || 'Transfer cancellation is eligible for processing',
      providerReference: status.providerReference,
    };
  },
};
    }
    return {
      status: 'confirmed',
      cancellable: true,
      message:
        input.reason || 'Transfer cancellation is eligible for processing',
      providerReference: status.providerReference,
    };
  },
};

export { paystackProvider };
