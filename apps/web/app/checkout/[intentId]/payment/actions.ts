'use server';

import { z } from 'zod';
import { backendClient } from '@/lib/server/backend-client';

export type PaymentActionFailureReason =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_COMMAND'
  | 'UPSTREAM_UNAVAILABLE';

export type PaymentActionOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; reason: PaymentActionFailureReason; message: string; retryable: boolean };

export type CreatePaymentInput = {
  bookingIntentId: string;
  ancillarySelectionId?: string;
  ancillarySelectionVersion?: number;
  paymentMethodId?: string;
  saveCard?: boolean;
  idempotencyKey: string;
};

export type CreatePaymentReadyResult = {
  status: 'READY';
  paymentId: string;
  clientSecret: string;
  paymentStatus: string;
};

export type CreatePaymentPendingResult = {
  status: 'PENDING';
  paymentId: string;
  paymentStatus: string;
};

export type CreatePaymentResult = CreatePaymentReadyResult | CreatePaymentPendingResult;

export type ConfirmPaymentInput = {
  bookingId: string;
  paymentId: string;
  idempotencyKey?: string;
};

export type ConfirmPaymentStatus =
  | 'CONFIRMED'
  | 'SUCCEEDED'
  | 'PENDING'
  | 'FAILED'
  | 'COMPENSATED_FAILURE'
  | 'DEFINITIVE_FAILURE'
  | 'REJECTED';

export type ConfirmPaymentResult = {
  status: ConfirmPaymentStatus;
  paymentId: string;
  bookingReference?: string;
  duffelOrderId?: string;
  message?: string;
};

export type PaymentStatusResult = {
  paymentId: string;
  status: string;
  amount: number;
  currency: string;
  bookingIntentStatus?: string;
  attemptNumber?: number;
};

const CreatePaymentInputSchema = z
  .object({
    bookingIntentId: z.string().trim().min(1),
    ancillarySelectionId: z.string().uuid().optional(),
    ancillarySelectionVersion: z.number().int().min(1).optional(),
    paymentMethodId: z.string().trim().min(1).optional(),
    saveCard: z.boolean().optional(),
    idempotencyKey: z.string().trim().min(1),
  })
  .strict();

const RawPaymentCreateResponseSchema = z
  .object({
    paymentId: z.string().trim().min(1),
    clientSecret: z.string().optional().nullable(),
    status: z.string().trim().min(1),
  })
  .passthrough();

const ConfirmPaymentInputSchema = z
  .object({
    bookingId: z.string().uuid(),
    paymentId: z.string().trim().min(1),
    idempotencyKey: z.string().trim().min(1).optional(),
  })
  .strict();

const RawPaymentConfirmResponseSchema = z
  .object({
    status: z.unknown().optional(),
    success: z.unknown().optional(),
    paymentId: z.unknown().optional(),
    bookingReference: z.unknown().optional(),
    duffelOrderId: z.unknown().optional(),
    message: z.unknown().optional(),
    pollUrl: z.unknown().optional(),
    error: z.unknown().optional(),
    bookingStatus: z.unknown().optional(),
  })
  .passthrough();

const RECOGNIZED_PAYMENT_STATUSES = [
  'PENDING',
  'REQUIRES_ACTION',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'CREATED',
  'AUTHORIZED',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'DISPUTED',
  'EXPIRED',
  'CHARGEBACK_LOST',
  'RESERVED',
] as const;

export type RecognizedPaymentStatus = (typeof RECOGNIZED_PAYMENT_STATUSES)[number];

const RawPaymentStatusResponseSchema = z
  .object({
    paymentId: z.string().trim().min(1).optional(),
    status: z.enum(RECOGNIZED_PAYMENT_STATUSES),
    amount: z.number().int().nonnegative(),
    currency: z.string().trim().min(3).max(3),
    bookingIntentStatus: z.string().optional(),
    attemptNumber: z.number().int().nonnegative().optional(),
  })
  .passthrough();

function outcomeFailure(
  reason: PaymentActionFailureReason,
  message: string,
  retryable: boolean,
): { ok: false; reason: PaymentActionFailureReason; message: string; retryable: boolean } {
  return { ok: false, reason, message, retryable };
}

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `key_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export async function createPaymentAction(
  input: CreatePaymentInput,
): Promise<PaymentActionOutcome<CreatePaymentResult>> {
  const parsedInput = CreatePaymentInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return outcomeFailure(
      'INVALID_COMMAND',
      'Valid booking intent ID and idempotency key are required to initiate payment.',
      false,
    );
  }

  const {
    bookingIntentId,
    ancillarySelectionId,
    ancillarySelectionVersion,
    paymentMethodId,
    saveCard,
    idempotencyKey,
  } = parsedInput.data;

  const requestBody: {
    bookingIntentId: string;
    ancillarySelectionId?: string;
    ancillarySelectionVersion?: number;
    paymentMethodId?: string;
    saveCard?: boolean;
  } = {
    bookingIntentId,
    ...(ancillarySelectionId !== undefined ? { ancillarySelectionId } : {}),
    ...(ancillarySelectionVersion !== undefined ? { ancillarySelectionVersion } : {}),
    ...(paymentMethodId !== undefined ? { paymentMethodId } : {}),
    ...(saveCard !== undefined ? { saveCard } : {}),
  };

  const result = await backendClient.request(
    '/api/bookings/payment/create',
    RawPaymentCreateResponseSchema,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(requestBody),
    },
  );

  if (!result.ok) {
    if (result.kind === 'transport') {
      if (result.cause === 'missing_token') {
        return outcomeFailure('UNAUTHENTICATED', 'Please sign in to proceed with payment.', false);
      }
      return outcomeFailure(
        'UPSTREAM_UNAVAILABLE',
        'Payment service is temporarily unavailable. Please try again.',
        true,
      );
    }

    if (result.status === 401) {
      return outcomeFailure('UNAUTHENTICATED', 'Session expired. Please sign in again.', false);
    }
    if (result.status === 403) {
      return outcomeFailure('FORBIDDEN', 'You do not have access to this booking intent.', false);
    }
    if (result.status === 404) {
      return outcomeFailure('NOT_FOUND', 'Booking intent was not found.', false);
    }
    if (result.status === 400 || result.status === 422) {
      return outcomeFailure(
        'INVALID_COMMAND',
        'Invalid payment request. Please review your booking details.',
        false,
      );
    }

    return outcomeFailure(
      'UPSTREAM_UNAVAILABLE',
      'Payment service encountered an unexpected error. Please try again.',
      true,
    );
  }

  const raw = result.data;
  const isPendingOutcome = raw.status === 'RESERVED' || raw.status === 'PENDING';
  if (isPendingOutcome) {
    return {
      ok: true,
      data: {
        status: 'PENDING',
        paymentId: raw.paymentId,
        paymentStatus: raw.status,
      },
    };
  }

  // Ready requires actual nonempty secret; null/empty clientSecret with ready status is malformed and fails closed
  if (typeof raw.clientSecret !== 'string' || raw.clientSecret.trim().length === 0) {
    return outcomeFailure(
      'UPSTREAM_UNAVAILABLE',
      'Payment service encountered an unexpected error. Please try again.',
      true,
    );
  }

  return {
    ok: true,
    data: {
      status: 'READY',
      paymentId: raw.paymentId,
      clientSecret: raw.clientSecret,
      paymentStatus: raw.status,
    },
  };
}

export async function confirmPaymentAction(
  input: ConfirmPaymentInput,
): Promise<PaymentActionOutcome<ConfirmPaymentResult>> {
  const parsedInput = ConfirmPaymentInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return outcomeFailure(
      'INVALID_COMMAND',
      'Valid booking ID and payment ID are required to confirm payment.',
      false,
    );
  }

  const { bookingId, paymentId, idempotencyKey } = parsedInput.data;
  const resolvedIdempotencyKey = idempotencyKey ?? generateIdempotencyKey();

  const result = await backendClient.request(
    '/api/bookings/payment/confirm',
    RawPaymentConfirmResponseSchema,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': resolvedIdempotencyKey,
      },
      body: JSON.stringify({ bookingId, paymentId }),
    },
  );

  const responseBody = result.ok ? result.data : result.kind === 'http' ? result.body : undefined;
  if (typeof responseBody === 'object' && responseBody !== null && 'paymentId' in responseBody) {
    const responsePaymentId = responseBody.paymentId;
    if (
      typeof responsePaymentId !== 'string' ||
      responsePaymentId.trim().length === 0 ||
      responsePaymentId !== paymentId
    ) {
      return outcomeFailure(
        'UPSTREAM_UNAVAILABLE',
        'Invalid confirmation payload received from upstream service.',
        true,
      );
    }
  }

  if (!result.ok) {
    if (result.kind === 'transport') {
      if (result.cause === 'missing_token') {
        return outcomeFailure('UNAUTHENTICATED', 'Please sign in to confirm your booking.', false);
      }
      if (result.cause === 'timeout' || result.cause === 'network') {
        return {
          ok: true,
          data: {
            status: 'PENDING',
            paymentId,
            message: 'Payment confirmation is in progress. Please wait while status is verified.',
          },
        };
      }
      return outcomeFailure(
        'UPSTREAM_UNAVAILABLE',
        'Payment confirmation service is temporarily unavailable.',
        true,
      );
    }

    if (result.status === 401) {
      return outcomeFailure('UNAUTHENTICATED', 'Session expired. Please sign in again.', false);
    }
    if (result.status === 403) {
      return outcomeFailure('FORBIDDEN', 'You do not have access to confirm this payment.', false);
    }
    if (result.status === 404) {
      return outcomeFailure('NOT_FOUND', 'Payment or booking was not found.', false);
    }
    if (result.status === 400 || result.status === 422) {
      return outcomeFailure(
        'INVALID_COMMAND',
        'Invalid confirmation request. Please review your booking details.',
        false,
      );
    }

    // Check if 500/502 body contains explicit saga status
    if (typeof result.body === 'object' && result.body !== null) {
      const errBookingStatus = Reflect.get(result.body, 'bookingStatus');
      const errStatus = Reflect.get(result.body, 'status');

      // Unresolved capture or processing outcome stays truthful PENDING
      if (
        errBookingStatus === 'PROCESSING' ||
        errBookingStatus === 'PENDING' ||
        errStatus === 'PROCESSING' ||
        errStatus === 'PENDING' ||
        errStatus === 'NONFINAL' ||
        errStatus === 'UNRESOLVED'
      ) {
        return {
          ok: true,
          data: {
            status: 'PENDING',
            paymentId,
            message: 'Payment confirmation is in progress. Please wait while status is verified.',
          },
        };
      }

      // Valid legacy final cancelled / failed status
      if (errBookingStatus === 'CANCELLED' || errStatus === 'CANCELLED' || errStatus === 'FAILED') {
        return {
          ok: true,
          data: {
            status: 'FAILED',
            paymentId,
            message: 'Payment confirmation failed.',
          },
        };
      }

      // Narrow legacy saga failure projection:
      // payment-fulfillment.saga.ts catches booking/passenger failure, sets bookingStatus: 'AWAITING_PAYMENT' or 'CANCELLED',
      // success: false, and nonempty error message.
      // Requires: boolean success strictly false, nonempty string error, valid legacy booking status,
      // and errStatus undefined or non-contradictory.
      const errSuccess = Reflect.get(result.body, 'success');
      const errError = Reflect.get(result.body, 'error');
      const isProvenLegacyFailure =
        errSuccess === false &&
        typeof errError === 'string' &&
        errError.trim().length > 0 &&
        (errBookingStatus === 'AWAITING_PAYMENT' || errBookingStatus === 'CANCELLED') &&
        (errStatus === undefined || errStatus === 'CANCELLED' || errStatus === 'FAILED');

      if (isProvenLegacyFailure) {
        return {
          ok: true,
          data: {
            status: 'FAILED',
            paymentId,
            message: 'Payment confirmation failed.',
          },
        };
      }
    }

    return outcomeFailure(
      'UPSTREAM_UNAVAILABLE',
      'Upstream service encountered an error while confirming payment.',
      true,
    );
  }

  const raw = result.data;
  const rawStatus = typeof raw.status === 'string' ? raw.status : undefined;
  const rawSuccess = typeof raw.success === 'boolean' ? raw.success : undefined;
  const rawBookingStatus = typeof raw.bookingStatus === 'string' ? raw.bookingStatus : undefined;

  // 2. Authoritative CONFIRMED outcome: requires valid supplier order fields (bookingReference AND duffelOrderId)
  if (rawStatus === 'CONFIRMED') {
    const bookingReference =
      typeof raw.bookingReference === 'string' && raw.bookingReference.trim().length > 0
        ? raw.bookingReference.trim()
        : undefined;
    const duffelOrderId =
      typeof raw.duffelOrderId === 'string' && raw.duffelOrderId.trim().length > 0
        ? raw.duffelOrderId.trim()
        : undefined;

    if (!bookingReference || !duffelOrderId) {
      return outcomeFailure(
        'UPSTREAM_UNAVAILABLE',
        'Invalid confirmation payload received from upstream service.',
        true,
      );
    }

    return {
      ok: true,
      data: {
        status: 'CONFIRMED',
        paymentId,
        bookingReference,
        duffelOrderId,
      },
    };
  }

  // 3. Authoritative COMPENSATED_FAILURE: verified completed compensation with safe hold release evidence
  if (rawStatus === 'COMPENSATED_FAILURE') {
    return {
      ok: true,
      data: {
        status: 'COMPENSATED_FAILURE',
        paymentId,
        message: 'Payment confirmation failed. Any holds have been released.',
      },
    };
  }

  // 4. Authoritative DEFINITIVE_FAILURE: verified terminal failure with neutral safe message (no holds claim)
  if (rawStatus === 'DEFINITIVE_FAILURE') {
    return {
      ok: true,
      data: {
        status: 'DEFINITIVE_FAILURE',
        paymentId,
        message: 'Payment confirmation failed.',
      },
    };
  }

  // 5. Authoritative REJECTED: preflight or authorization failed before next side effect
  if (rawStatus === 'REJECTED') {
    return {
      ok: true,
      data: {
        status: 'REJECTED',
        paymentId,
        message: 'Payment confirmation was rejected.',
      },
    };
  }

  // 6. Authoritative unresolved explicit variants take precedence
  if (
    rawStatus === 'PENDING' ||
    rawStatus === 'PROCESSING' ||
    rawStatus === 'NONFINAL' ||
    rawStatus === 'UNRESOLVED' ||
    rawBookingStatus === 'PROCESSING' ||
    rawBookingStatus === 'PENDING'
  ) {
    return {
      ok: true,
      data: {
        status: 'PENDING',
        paymentId,
        message:
          'Payment confirmation is in progress. Please poll status while booking is confirmed.',
      },
    };
  }

  // 7. Succeeded legacy outcome: requires valid supplier order fields (bookingReference AND duffelOrderId)
  const isExplicitSucceeded = rawStatus === 'SUCCEEDED';
  const isLegacySucceeded = rawSuccess === true && rawStatus === undefined;

  if (isExplicitSucceeded || isLegacySucceeded) {
    const bookingReference =
      typeof raw.bookingReference === 'string' && raw.bookingReference.trim().length > 0
        ? raw.bookingReference.trim()
        : undefined;
    const duffelOrderId =
      typeof raw.duffelOrderId === 'string' && raw.duffelOrderId.trim().length > 0
        ? raw.duffelOrderId.trim()
        : undefined;

    if (!bookingReference || !duffelOrderId) {
      // Incomplete success: Boolean alone never certifies booking without supplier order evidence
      return outcomeFailure(
        'UPSTREAM_UNAVAILABLE',
        'Invalid confirmation payload received from upstream service.',
        true,
      );
    }

    return {
      ok: true,
      data: {
        status: 'SUCCEEDED',
        paymentId,
        bookingReference,
        duffelOrderId,
      },
    };
  }

  // 8. Handle explicit legacy saga failure or cancelled/failed status
  const isExplicitFailed =
    rawBookingStatus === 'CANCELLED' || rawStatus === 'CANCELLED' || rawStatus === 'FAILED';

  const rawError = typeof raw.error === 'string' ? raw.error : undefined;
  const isProvenLegacyFailure =
    rawSuccess === false &&
    rawError !== undefined &&
    rawError.trim().length > 0 &&
    (rawBookingStatus === 'AWAITING_PAYMENT' || rawBookingStatus === 'CANCELLED') &&
    (rawStatus === undefined || rawStatus === 'CANCELLED' || rawStatus === 'FAILED');

  if (isExplicitFailed || isProvenLegacyFailure) {
    return {
      ok: true,
      data: {
        status: 'FAILED',
        paymentId,
        message: 'Payment confirmation failed.',
      },
    };
  }

  // 9. Unrecognized status / malformed payload fails closed
  return outcomeFailure(
    'UPSTREAM_UNAVAILABLE',
    'Invalid confirmation payload received from upstream service.',
    true,
  );
}

export async function getPaymentStatusAction(
  paymentId: string,
): Promise<PaymentActionOutcome<PaymentStatusResult>> {
  if (typeof paymentId !== 'string' || paymentId.trim().length === 0) {
    return outcomeFailure('INVALID_COMMAND', 'Payment ID is required.', false);
  }

  const normalizedPaymentId = paymentId.trim();

  const result = await backendClient.request(
    `/api/bookings/payment/${encodeURIComponent(normalizedPaymentId)}/status`,
    RawPaymentStatusResponseSchema,
    {
      method: 'GET',
    },
  );

  if (!result.ok) {
    if (result.kind === 'transport') {
      if (result.cause === 'missing_token') {
        return outcomeFailure('UNAUTHENTICATED', 'Please sign in to view payment status.', false);
      }
      return outcomeFailure(
        'UPSTREAM_UNAVAILABLE',
        'Payment status service is temporarily unavailable.',
        true,
      );
    }

    if (result.status === 401) {
      return outcomeFailure('UNAUTHENTICATED', 'Session expired. Please sign in again.', false);
    }
    if (result.status === 403) {
      return outcomeFailure('FORBIDDEN', 'You do not have permission to view this payment.', false);
    }
    if (result.status === 404) {
      return outcomeFailure('NOT_FOUND', 'Payment was not found.', false);
    }

    return outcomeFailure('UPSTREAM_UNAVAILABLE', 'Failed to retrieve payment status.', true);
  }

  const raw = result.data;

  // Validate that upstream paymentId matches requested resource if provided
  if (raw.paymentId !== undefined && raw.paymentId !== normalizedPaymentId) {
    return outcomeFailure(
      'UPSTREAM_UNAVAILABLE',
      'Payment verification failed due to invalid upstream data.',
      true,
    );
  }

  return {
    ok: true,
    data: {
      paymentId: normalizedPaymentId,
      status: raw.status,
      amount: raw.amount,
      currency: raw.currency.toUpperCase(),
      ...(typeof raw.bookingIntentStatus === 'string'
        ? { bookingIntentStatus: raw.bookingIntentStatus }
        : {}),
      ...(typeof raw.attemptNumber === 'number' ? { attemptNumber: raw.attemptNumber } : {}),
    },
  };
}
