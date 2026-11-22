import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { serverEnv } from '@/lib/serverEnv';
import { telemetry } from '@/lib/telemetry';
import { redactForLog } from '@/lib/logging/redaction';
import {
  isReplayEvent,
  getTransferStatus,
  transitionPayoutStatus,
  InvalidPayoutTransitionError,
} from '@/lib/transferStore';
import { publishPaymentStatus } from '@/lib/paymentStatusEvents';
import { credentialManager } from '@/lib/payout/credentialManager';
import {
  payoutReconciliationService,
  type DomainPayoutStatus,
} from '@/lib/payout/reconciliation';
import { webhookDeduplicationService } from '@/lib/payout/webhookDeduplication';
import { payoutReservationLedger } from '@/lib/payout/reservationLedger';
import {
  applyRateLimit,
  getClientIp,
  ROUTE_COST_BUCKETS,
} from '@/lib/rateLimit';

interface PaystackWebhookData {
  id?: string | number;
  reference?: string;
  amount?: number;
  recipient?: string;
  status?: string;
  failure_reason?: string;
  created_at?: string;
  updated_at?: string;
}

interface PaystackWebhookEvent {
  event: string;
  created_at?: string;
  data: PaystackWebhookData;
}

function isValidSignature(payload: string, signature: string, secret: string) {
  if (!/^[\da-f]{128}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha512', secret).update(payload).digest();
  const received = Buffer.from(signature, 'hex');
  return (
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected)
  );
}

function toDomainStatus(
  status: string | undefined,
): DomainPayoutStatus | undefined {
  switch (status) {
    case 'initiated':
      return 'pending';
    case 'pending':
    case 'success':
    case 'failed':
    case 'reversed':
    case 'cancelled':
      return status;
    default:
      return undefined;
  }
}

export async function POST(request: NextRequest) {
  const traceContext = telemetry.extractTraceFromHeaders(request.headers);
  const span = telemetry.createSpan(
    'webhook-handler',
    traceContext.spanId,
    traceContext.traceId,
  );

  try {
    const secretKey = serverEnv.PAYSTACK_SECRET_KEY;
    if (!secretKey) {
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Missing PAYSTACK_SECRET_KEY',
      });
      return NextResponse.json(
        { message: 'Webhook processing is not configured' },
        { status: 400 },
      );
    }

    const payload = await request.text();
    const signature = request.headers.get('x-paystack-signature');
    if (!signature) {
      const limited = applyRateLimit(
        getClientIp(request),
        '/api/webhook',
        ROUTE_COST_BUCKETS['/api/webhook'],
      );
      if (limited) return limited;
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'No signature provided',
      });
      return NextResponse.json(
        { message: 'No signature provided' },
        { status: 401 },
      );
    }

    const candidateKeys = credentialManager
      .getAllWebhookCredentials()
      .map((credential) => ({
        version: credential.version,
        secretKey: credential.secretKey,
      }));
    if (!candidateKeys.some((candidate) => candidate.secretKey === secretKey)) {
      candidateKeys.push({ version: 'v1', secretKey });
    }

    const matchedCredential = candidateKeys.find((credential) =>
      isValidSignature(payload, signature, credential.secretKey),
    );

    if (!matchedCredential) {
      telemetry.addLog(
        span.spanId,
        'error',
        'Invalid webhook signature',
        redactForLog({ receivedSignature: signature }) as Record<string, unknown>,
      );
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Invalid signature',
      });
      return NextResponse.json(
        { message: 'Invalid signature' },
        { status: 401 },
      );
    }

    let event: PaystackWebhookEvent;
    try {
      event = JSON.parse(payload) as PaystackWebhookEvent;
    } catch {
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Invalid JSON payload',
      });
      return NextResponse.json(
        { message: 'Webhook payload must be valid JSON' },
        { status: 400 },
      );
    }

    if (!event || typeof event.event !== 'string' || !event.data) {
      return NextResponse.json(
        { message: 'Webhook event and data are required' },
        { status: 400 },
      );
    }

    const data = event.data;
    const eventId = String(data.id ?? data.reference ?? '');
    if (!eventId) {
      return NextResponse.json(
        { message: 'Event data must contain id or reference' },
        { status: 400 },
      );
    }

    const receivedAt = new Date().toISOString();
    const providerEventAt =
      data.updated_at || data.created_at || event.created_at || receivedAt;
    const payloadHash = crypto
      .createHash('sha256')
      .update(payload)
      .digest('hex');

    telemetry.addLog(
      span.spanId,
      'info',
      'Webhook signature verified',
      redactForLog({
        eventType: event.event,
        reference: event.data?.reference,
        eventId,
        credentialVersion: matchedCredential.version,
      }) as Record<string, unknown>,
    );

    console.log('Received Paystack webhook:', event.event);

    // Durable deduplication and replay protection (Issue #35)
    const { acquired, isDuplicate } =
      await webhookDeduplicationService.acquireOrCheck(
        eventId,
        event.event,
        payloadHash,
        data.reference,
      );

    if (!acquired && isDuplicate) {
      const response = NextResponse.json({
        received: true,
        duplicate: true,
      });
      telemetry.setTraceHeaders(response.headers, traceContext);
      return response;
    }

    try {
      const payoutReference = data.reference ?? '';
      const existingRecord = getTransferStatus(payoutReference);
      const reconciliation = payoutReconciliationService.reconcileEvent({
        eventId,
        payoutReference,
        eventType: event.event,
        currentStatus: toDomainStatus(existingRecord?.status),
        payload: data as Record<string, unknown>,
        correlationId: traceContext.traceId,
        providerEventAt,
        receivedAt,
      });

      if (
        (reconciliation.decision === 'REJECTED_OUT_OF_ORDER' &&
          reconciliation.effectiveStatus ===
            (toDomainStatus(existingRecord?.status) || 'pending')) ||
        reconciliation.decision === 'IDEMPOTENT_NOOP' ||
        reconciliation.decision === 'UNRECOGNIZED_EVENT'
      ) {
        webhookDeduplicationService.commit(eventId);
        const response = NextResponse.json({
          received: true,
          status:
            reconciliation.decision === 'REJECTED_OUT_OF_ORDER'
              ? 'ignored_out_of_order'
              : reconciliation.decision === 'IDEMPOTENT_NOOP'
                ? 'already_applied'
                : 'ignored',
        });
        telemetry.setTraceHeaders(response.headers, traceContext);
        return response;
      }

      const status = reconciliation.effectiveStatus;
      const updatedAt = receivedAt;
      const nextRecord = transitionPayoutStatus({
        reference: payoutReference,
        status,
        amount: Number(data.amount ?? existingRecord?.amount ?? 0),
        failureReason: status === 'failed' ? data.failure_reason : undefined,
        updatedAt,
        clientSessionId: existingRecord?.clientSessionId,
        providerEventAt: new Date(providerEventAt).toISOString(),
        webhookReceivedAt: receivedAt,
      });

      const reservation =
        payoutReservationLedger.getReservationByProviderReference(
          payoutReference,
        );

      if (reservation) {
        if (status === 'success') {
          payoutReservationLedger.settle(reservation.payoutId, receivedAt);
        } else if (status === 'failed') {
          payoutReservationLedger.release(reservation.payoutId, receivedAt);
        } else if (status === 'reversed') {
          payoutReservationLedger.markUnderReview(
            reservation.payoutId,
            receivedAt,
          );
        }
      }

      publishPaymentStatus(nextRecord.clientSessionId, {
        reference: nextRecord.reference,
        status: nextRecord.status,
        amount: nextRecord.amount,
        updatedAt,
        ...(nextRecord.failureReason
          ? { failureReason: nextRecord.failureReason }
          : {}),
      });

      webhookDeduplicationService.commit(eventId);
      telemetry.finishSpan(span.spanId, {
        success: true,
        credentialVersion: matchedCredential.version,
      });

      const response = NextResponse.json({ received: true });
      telemetry.setTraceHeaders(response.headers, traceContext);
      return response;
    } catch (error) {
      webhookDeduplicationService.releaseOnError(eventId);
      throw error;
    }
  } catch (error) {
    telemetry.addLog(
      span.spanId,
      'error',
      'Webhook processing error',
      redactForLog({
        error: error instanceof Error ? error.message : 'Unknown error',
      }) as Record<string, unknown>,
    );
    telemetry.finishSpan(span.spanId, {
      success: false,
      error: 'Webhook processing failed',
    });
    console.error('Webhook processing error:', error);
    return NextResponse.json(
      { message: 'Webhook processing failed' },
      { status: 500 },
    );
  }
}
