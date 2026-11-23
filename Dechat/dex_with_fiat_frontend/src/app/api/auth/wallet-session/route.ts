import { NextRequest, NextResponse } from 'next/server';
import { verifySignature } from '@/lib/stellarSignature';
import { createWalletSessionToken } from '@/lib/payout/auth';
import {
  applyCorsHeaders,
  isOriginAllowed,
  rejectDisallowedOrigin,
} from '@/lib/security/cors';
import { generateCsrfToken } from '@/lib/payout/security';

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

export async function OPTIONS(request: NextRequest) {
  if (!isOriginAllowed(request, 'wallet-session')) {
    return rejectDisallowedOrigin();
  }

  const response = new NextResponse(null, { status: 204 });
  return applyCorsHeaders(request, response, 'wallet-session');
}

export async function POST(request: NextRequest) {
  if (!isOriginAllowed(request, 'wallet-session')) {
    return rejectDisallowedOrigin();
  }

  try {
    const body = await request.json().catch(() => ({}));
    const { address, signature, timestamp, nonce } = body;

    // Validate all redirect/callback destinations before any session work.
    const destinations = collectDestinations(request, body);
    const validatedDestinations: Record<string, string> = {};

    for (const { field, value } of destinations) {
      const result: DestinationValidationResult = validateRedirectDestination(value);
      if (!result.ok) {
        return NextResponse.json(
          {
            success: false,
            message: `Invalid ${field} destination: ${result.reason}`,
          },
          { status: 400 },
        );
      }
      validatedDestinations[field] = result.url;
    }

    if (!address || !signature || !timestamp) {
      return NextResponse.json(
        {
          success: false,
          message:
            'Missing required authentication fields: address, signature, timestamp, nonce',
        },
        { status: 400 },
      );
    }

    const ts = Number(timestamp);
    if (
      !Number.isFinite(ts) ||
      Math.abs(Date.now() - ts) > TIMESTAMP_TOLERANCE_MS
    ) {
      return NextResponse.json(
        {
          success: false,
          message: 'Signature expired or invalid timestamp',
        },
        { status: 401 },
      );
    }

    // Atomically consume the server-issued nonce. This is a one-time use
    // operation: concurrent replays, expired nonces, wallet mismatches and
    // origin mismatches are all rejected here before signature verification.
    const nonceResult = consumeWalletNonce({
      nonce: String(nonce),
      address: String(address),
      origin: getRequestOrigin(request),
    });

    if (!nonceResult.ok) {
      return NextResponse.json(
        {
          success: false,
          message: 'Invalid, expired, or already used authentication nonce',
        },
        { status: 401 },
      );
    }

    const payload = nonceResult.message;
    const isValid = await verifySignature(payload, signature, address);

    if (!isValid) {
      return NextResponse.json(
        {
          success: false,
          message: 'Invalid signature for wallet address',
        },
        { status: 401 },
      );
    }

    // Bind the session to the verified address only; never echo client input.
    const session = createWalletSessionToken(address);
    const csrfToken = generateCsrfToken();

    const response = NextResponse.json({
      success: true,
      data: {
        sessionToken: session.sessionToken,
        expiresAt: session.expiresAt,
        address: session.address,
        csrfToken,
        ...(Object.keys(validatedDestinations).length > 0
          ? { destinations: validatedDestinations }
          : {}),
      },
    });

    response.cookies.set('wallet_session', session.sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
      path: '/',
    });

    return applyCorsHeaders(request, response, 'wallet-session');
  } catch (error) {
    console.error('Wallet session authentication error:', error);
    return applyCorsHeaders(
      request,
      NextResponse.json(
        { success: false, message: 'Authentication failed' },
        { status: 500 },
      ),
      'wallet-session',
    );
  }
}
