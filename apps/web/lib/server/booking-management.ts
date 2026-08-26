import 'server-only';
import * as NextAuth from 'next-auth';
import { z } from 'zod';
import {
  BookingAirlineViewSchema,
  BookingAirportViewSchema,
  BookingDetailViewSchema,
  BookingListItemViewSchema,
  BookingListViewSchema,
  BookingSegmentViewSchema,
  CancellationQuoteViewSchema,
  CancellationResultViewSchema,
  CancellationStatusViewSchema,
  DisruptionAlertViewSchema,
  ItineraryRevisionViewSchema,
  type BookingAirlineView,
  type BookingAirportView,
  type BookingDetailView,
  type BookingItineraryView,
  type BookingListItemView,
  type BookingListView,
  type BookingManagementOutcome,
  type BookingSegmentView,
  type CancellationQuoteView,
  type CancellationResultView,
  type CancellationStatusView,
  type DisruptionAlertView,
  type ItineraryRevisionView,
} from '@shared/types/booking-management.types';
import { authOptions } from '../auth.ts';

export type BookingTab = 'upcoming' | 'past';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_READ_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 100;

type FetchResult =
  | { ok: true; response: Response }
  | { ok: false };

/**
 * Lists user bookings filtered by tab and paginated.
 */
export async function listBookings(
  tab: BookingTab,
  page: number,
  limit: number,
): Promise<BookingManagementOutcome<BookingListView>> {
  if (tab !== 'upcoming' && tab !== 'past') {
    return outcomeFailure('INVALID_COMMAND', 'Invalid booking tab. Must be "upcoming" or "past".', false);
  }

  const validPage = Number.isInteger(page) && page >= 1 ? page : 1;
  const validLimit = Number.isInteger(limit) && limit >= 1 ? limit : 10;

  const token = await getAccessToken();
  if (!token) {
    return outcomeFailure('UNAUTHENTICATED', 'Please sign in to view bookings.', false);
  }

  const upstream = await fetchWithRetry(
    `/api/bookings?tab=${encodeURIComponent(tab)}&page=${validPage}&limit=${validLimit}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    },
  );

  if (!upstream.ok) return unavailableOutcomeFailure();
  const statusOutcome = await handleUpstreamStatus(upstream.response);
  if (statusOutcome) return statusOutcome;

  try {
    const payload: unknown = await upstream.response.json();
    if (!payload || typeof payload !== 'object') {
      return unavailableOutcomeFailure();
    }

    const raw = payload as { bookings?: unknown[]; pagination?: { page?: number; limit?: number; total?: number; totalPages?: number } };
    const rawBookings = Array.isArray(raw.bookings) ? raw.bookings : [];
    const mappedBookings = rawBookings.map(mapListItem);

    const pagination = {
      page: typeof raw.pagination?.page === 'number' ? raw.pagination.page : validPage,
      limit: typeof raw.pagination?.limit === 'number' ? raw.pagination.limit : validLimit,
      total: typeof raw.pagination?.total === 'number' ? raw.pagination.total : mappedBookings.length,
      totalPages: typeof raw.pagination?.totalPages === 'number' ? raw.pagination.totalPages : Math.ceil(mappedBookings.length / validLimit),
    };

    const validated = BookingListViewSchema.safeParse({
      bookings: mappedBookings,
      tab,
      pagination,
    });

    if (!validated.success) {
      return outcomeFailure('UPSTREAM_UNAVAILABLE', 'Booking list returned an invalid response. Please try again.', true);
    }

    return { ok: true, data: validated.data };
  } catch {
    return unavailableOutcomeFailure();
  }
}

/**
 * Retrieves detailed information for a specific booking.
 */
export async function getBookingDetail(
  bookingId: string,
): Promise<BookingManagementOutcome<BookingDetailView>> {
  if (!bookingId || typeof bookingId !== 'string' || bookingId.trim().length === 0) {
    return outcomeFailure('INVALID_COMMAND', 'Booking ID is required.', false);
  }

  const token = await getAccessToken();
  if (!token) {
    return outcomeFailure('UNAUTHENTICATED', 'Please sign in to view booking details.', false);
  }

  const upstream = await fetchWithRetry(`/api/bookings/${encodeURIComponent(bookingId.trim())}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  if (!upstream.ok) return unavailableOutcomeFailure();
  const statusOutcome = await handleUpstreamStatus(upstream.response);
  if (statusOutcome) return statusOutcome;

  try {
    const payload: unknown = await upstream.response.json();
    if (!payload || typeof payload !== 'object') {
      return unavailableOutcomeFailure();
    }

    const mapped = mapDetail(payload as Record<string, unknown>);
    const validated = BookingDetailViewSchema.safeParse(mapped);

    if (!validated.success) {
      return outcomeFailure('UPSTREAM_UNAVAILABLE', 'Booking details returned an invalid response. Please try again.', true);
    }

    return { ok: true, data: validated.data };
  } catch {
    return unavailableOutcomeFailure();
  }
}

/**
 * Retrieves cancellation status for a booking.
 */
export async function getCancellationStatus(
  bookingId: string,
): Promise<BookingManagementOutcome<CancellationStatusView>> {
  if (!bookingId || typeof bookingId !== 'string' || bookingId.trim().length === 0) {
    return outcomeFailure('INVALID_COMMAND', 'Booking ID is required.', false);
  }

  const token = await getAccessToken();
  if (!token) {
    return outcomeFailure('UNAUTHENTICATED', 'Please sign in to view cancellation status.', false);
  }

  const upstream = await fetchWithRetry(`/api/bookings/${encodeURIComponent(bookingId.trim())}/cancellation`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });

  if (!upstream.ok) return unavailableOutcomeFailure();
  const statusOutcome = await handleUpstreamStatus(upstream.response);
  if (statusOutcome) return statusOutcome;

  try {
    const payload: unknown = await upstream.response.json();
    if (!payload || typeof payload !== 'object') {
      return unavailableOutcomeFailure();
    }

    const raw = payload as Record<string, unknown>;
    const mapped = {
      bookingId: String(raw.bookingId ?? bookingId),
      bookingStatus: String(raw.bookingStatus ?? ''),
      cancellationDeadline: typeof raw.cancellationDeadline === 'string' ? raw.cancellationDeadline : null,
      airlineRefundAmount: raw.airlineRefundAmount != null ? String(raw.airlineRefundAmount) : null,
      customerRefundAmount: raw.customerRefundAmount != null ? String(raw.customerRefundAmount) : null,
      refundStatus: raw.refundStatus != null ? String(raw.refundStatus) : null,
      nextRetryAt: typeof raw.nextRetryAt === 'string' ? raw.nextRetryAt : null,
      escalationMessage: typeof raw.escalationMessage === 'string' ? raw.escalationMessage : null,
    };

    const validated = CancellationStatusViewSchema.safeParse(mapped);
    if (!validated.success) {
      return outcomeFailure('UPSTREAM_UNAVAILABLE', 'Cancellation status returned an invalid response. Please try again.', true);
    }

    return { ok: true, data: validated.data };
  } catch {
    return unavailableOutcomeFailure();
  }
}

/**
 * Requests a cancellation quote for a booking.
 */
export async function getCancellationQuote(
  bookingId: string,
): Promise<BookingManagementOutcome<CancellationQuoteView>> {
  if (!bookingId || typeof bookingId !== 'string' || bookingId.trim().length === 0) {
    return outcomeFailure('INVALID_COMMAND', 'Booking ID is required.', false);
  }

  const token = await getAccessToken();
  if (!token) {
    return outcomeFailure('UNAUTHENTICATED', 'Please sign in to request a cancellation quote.', false);
  }

  const upstream = await fetchWithRetry(`/api/bookings/${encodeURIComponent(bookingId.trim())}/cancellation-quote`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });

  if (!upstream.ok) return unavailableOutcomeFailure();
  const statusOutcome = await handleUpstreamStatus(upstream.response);
  if (statusOutcome) return statusOutcome;

  try {
    const payload: unknown = await upstream.response.json();
    if (!payload || typeof payload !== 'object') {
      return unavailableOutcomeFailure();
    }

    const raw = payload as Record<string, unknown>;
    const mapped = {
      bookingId: String(raw.bookingId ?? bookingId),
      quoteId: String(raw.quoteId ?? ''),
      refundAmount: formatMoneyAmount(raw.refundAmount),
      currency: String(raw.currency ?? ''),
      expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : '',
      refundable: Boolean(raw.refundable),
      ...(raw.cancellationDeadline ? { cancellationDeadline: String(raw.cancellationDeadline) } : {}),
      ...(raw.refundTo ? { refundTo: String(raw.refundTo) } : {}),
      ...(raw.nonRefundableAncillaryAmount ? { nonRefundableAncillaryAmount: String(raw.nonRefundableAncillaryAmount) } : {}),
      ...(raw.nonRefundableAncillaryCurrency ? { nonRefundableAncillaryCurrency: String(raw.nonRefundableAncillaryCurrency) } : {}),
    };

    const validated = CancellationQuoteViewSchema.safeParse(mapped);
    if (!validated.success) {
      return outcomeFailure('UPSTREAM_UNAVAILABLE', 'Cancellation quote returned an invalid response. Please try again.', true);
    }

    return { ok: true, data: validated.data };
  } catch {
    return unavailableOutcomeFailure();
  }
}

/**
 * Confirms cancellation of a booking using a valid quote.
 */
export async function cancelBooking(
  bookingId: string,
  quoteId: string,
): Promise<BookingManagementOutcome<CancellationResultView>> {
  if (
    !bookingId ||
    !quoteId ||
    typeof bookingId !== 'string' ||
    typeof quoteId !== 'string' ||
    bookingId.trim().length === 0 ||
    quoteId.trim().length === 0
  ) {
    return outcomeFailure('INVALID_COMMAND', 'Booking ID and quote ID are required.', false);
  }

  const token = await getAccessToken();
  if (!token) {
    return outcomeFailure('UNAUTHENTICATED', 'Please sign in to cancel your booking.', false);
  }

  const upstream = await fetchWithRetry(`/api/bookings/${encodeURIComponent(bookingId.trim())}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ quoteId: quoteId.trim() }),
    cache: 'no-store',
  });

  if (!upstream.ok) return unavailableOutcomeFailure();
  const statusOutcome = await handleUpstreamStatus(upstream.response);
  if (statusOutcome) return statusOutcome;

  try {
    const payload: unknown = await upstream.response.json();
    if (!payload || typeof payload !== 'object') {
      return unavailableOutcomeFailure();
    }

    const raw = payload as Record<string, unknown>;
    const mapped = {
      bookingId: String(raw.bookingId ?? bookingId),
      bookingStatus: String(raw.bookingStatus ?? ''),
      cancellationStatus: String(raw.cancellationStatus ?? ''),
      refundStatus: String(raw.refundStatus ?? ''),
      refundAmount: formatMoneyAmount(raw.refundAmount),
      ...(raw.nextRetryAt ? { nextRetryAt: String(raw.nextRetryAt) } : {}),
    };

    const validated = CancellationResultViewSchema.safeParse(mapped);
    if (!validated.success) {
      return outcomeFailure('UPSTREAM_UNAVAILABLE', 'Cancellation result returned an invalid response. Please try again.', true);
    }

    return { ok: true, data: validated.data };
  } catch {
    return unavailableOutcomeFailure();
  }
}

/**
 * Acknowledges a disruption revision for a booking.
 */
export async function acknowledgeDisruption(
  bookingId: string,
  revisionId?: string,
): Promise<BookingManagementOutcome<{ ok: true }>> {
  if (!bookingId || typeof bookingId !== 'string' || bookingId.trim().length === 0) {
    return outcomeFailure('INVALID_COMMAND', 'Booking ID is required.', false);
  }

  if (!revisionId || typeof revisionId !== 'string' || revisionId.trim().length === 0) {
    return outcomeFailure('INVALID_COMMAND', 'Revision ID is required.', false);
  }

  const token = await getAccessToken();
  if (!token) {
    return outcomeFailure('UNAUTHENTICATED', 'Please sign in to acknowledge disruption.', false);
  }

  const upstream = await fetchWithRetry(
    `/api/bookings/${encodeURIComponent(bookingId.trim())}/disruptions/${encodeURIComponent(revisionId.trim())}/acknowledge`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    },
  );

  if (!upstream.ok) return unavailableOutcomeFailure();
  const statusOutcome = await handleUpstreamStatus(upstream.response);
  if (statusOutcome) return statusOutcome;

  return { ok: true, data: { ok: true } };
}

/**
 * Accepts a disruption revision for a booking.
 */
export async function acceptDisruption(
  bookingId: string,
  revisionId: string,
): Promise<BookingManagementOutcome<{ ok: true }>> {
  if (
    !bookingId ||
    !revisionId ||
    typeof bookingId !== 'string' ||
    typeof revisionId !== 'string' ||
    bookingId.trim().length === 0 ||
    revisionId.trim().length === 0
  ) {
    return outcomeFailure('INVALID_COMMAND', 'Booking ID and revision ID are required.', false);
  }

  const token = await getAccessToken();
  if (!token) {
    return outcomeFailure('UNAUTHENTICATED', 'Please sign in to accept disruption.', false);
  }

  const upstream = await fetchWithRetry(
    `/api/bookings/${encodeURIComponent(bookingId.trim())}/disruptions/${encodeURIComponent(revisionId.trim())}/accept`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    },
  );

  if (!upstream.ok) return unavailableOutcomeFailure();
  const statusOutcome = await handleUpstreamStatus(upstream.response);
  if (statusOutcome) return statusOutcome;

  return { ok: true, data: { ok: true } };
}

/**
 * Retrieves the paginated itinerary revisions for a booking.
 */
export async function getItineraryRevisions(
  bookingId: string,
  page?: number,
  limit?: number,
): Promise<
  BookingManagementOutcome<{
    revisions: ItineraryRevisionView[];
    totalPages: number;
    total: number;
    page: number;
    limit: number;
  }>
> {
  if (!bookingId || typeof bookingId !== 'string' || bookingId.trim().length === 0) {
    return outcomeFailure('INVALID_COMMAND', 'Booking ID is required.', false);
  }

  const validPage = typeof page === 'number' && page >= 1 ? page : 1;
  const validLimit = typeof limit === 'number' && limit >= 1 ? limit : 5;

  const token = await getAccessToken();
  if (!token) {
    return outcomeFailure('UNAUTHENTICATED', 'Please sign in to view itinerary history.', false);
  }

  const upstream = await fetchWithRetry(
    `/api/bookings/${encodeURIComponent(bookingId.trim())}/disruptions?page=${validPage}&limit=${validLimit}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    },
  );

  if (!upstream.ok) return unavailableOutcomeFailure();
  const statusOutcome = await handleUpstreamStatus(upstream.response);
  if (statusOutcome) return statusOutcome;

  try {
    const payload: unknown = await upstream.response.json();
    if (!payload || typeof payload !== 'object') {
      return unavailableOutcomeFailure();
    }

    const raw = payload as { items?: unknown[]; revisions?: unknown[]; page?: number; limit?: number; total?: number; totalPages?: number };
    const rawItems = Array.isArray(raw.items) ? raw.items : (Array.isArray(raw.revisions) ? raw.revisions : []);

    const mappedRevisions = rawItems.map((item) => {
      const it = item as Record<string, unknown>;
      const rawSegs = Array.isArray(it.segments) ? it.segments : [];
      return {
        revisionId: String(it.revisionId ?? it.id ?? ''),
        version: Math.max(1, typeof it.version === 'number' ? it.version : 1),
        observedAt: typeof it.observedAt === 'string' ? it.observedAt : new Date(Number(it.observedAt) || Date.now()).toISOString(),
        isMaterial: Boolean(it.isMaterial),
        materialReasons: Array.isArray(it.materialReasons) ? it.materialReasons.map(String) : [],
        segments: rawSegs.map(mapSegment),
      };
    });

    const validatedRevisions = z.array(ItineraryRevisionViewSchema).safeParse(mappedRevisions);
    if (!validatedRevisions.success) {
      return outcomeFailure('UPSTREAM_UNAVAILABLE', 'Itinerary revisions returned an invalid response. Please try again.', true);
    }

    const total = typeof raw.total === 'number' ? raw.total : validatedRevisions.data.length;
    const paginationPage = typeof raw.page === 'number' ? raw.page : validPage;
    const paginationLimit = typeof raw.limit === 'number' ? raw.limit : validLimit;
    const totalPages = typeof raw.totalPages === 'number' ? raw.totalPages : Math.ceil(total / paginationLimit);

    return {
      ok: true,
      data: {
        revisions: validatedRevisions.data,
        page: paginationPage,
        limit: paginationLimit,
        total,
        totalPages,
      },
    };
  } catch {
    return unavailableOutcomeFailure();
  }
}

// ---------------------------------------------------------------------------
// Helpers & Internal Mapping
// ---------------------------------------------------------------------------

async function getAccessToken(): Promise<string | null> {
  try {
    const sessionFn =
      typeof NextAuth.getServerSession === 'function'
        ? NextAuth.getServerSession
        : (NextAuth as unknown as { default?: { getServerSession: typeof NextAuth.getServerSession } }).default?.getServerSession;
    if (!sessionFn) return null;
    const session: unknown = await sessionFn(authOptions);
    if (!session || typeof session !== 'object' || !('accessToken' in session)) return null;
    const token = (session as { accessToken?: unknown }).accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function fetchWithRetry(pathname: string, init: RequestInit): Promise<FetchResult> {
  const isIdempotentRead = !init.method || init.method.toUpperCase() === 'GET';
  const maxAttempts = isIdempotentRead ? MAX_READ_ATTEMPTS : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiUrl()}${pathname}`, {
        ...init,
        signal: controller.signal,
      });
      if (response.status < 500 || attempt === maxAttempts - 1) {
        return { ok: true, response };
      }
    } catch {
      if (attempt === maxAttempts - 1) return { ok: false };
    } finally {
      clearTimeout(timeout);
    }

    await delay(RETRY_BASE_DELAY_MS * 2 ** attempt);
  }

  return { ok: false };
}

function apiUrl(): string {
  const configuredUrl = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  return configuredUrl.replace(/\/+$/, '');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve: () => void) => setTimeout(resolve, milliseconds));
}

function outcomeFailure<T = never>(
  reason: Extract<BookingManagementOutcome<T>, { ok: false }>['reason'],
  message: string,
  retryable: boolean,
): BookingManagementOutcome<T> {
  return { ok: false, reason, message, retryable };
}

function unavailableOutcomeFailure<T = never>(): BookingManagementOutcome<T> {
  return outcomeFailure('UPSTREAM_UNAVAILABLE', 'Booking service is temporarily unavailable. Please try again.', true);
}

async function handleUpstreamStatus(response: Response): Promise<BookingManagementOutcome<never> | null> {
  if (response.ok) return null;
  if (response.status === 401) {
    return outcomeFailure('UNAUTHENTICATED', 'Please sign in to continue.', false);
  }
  if (response.status === 403) {
    return outcomeFailure('FORBIDDEN', 'You do not have access to this booking.', false);
  }
  if (response.status === 404) {
    return outcomeFailure('NOT_FOUND', 'We could not find this booking.', false);
  }
  if (response.status === 409) {
    return outcomeFailure('STALE_REVISION', 'A newer change exists and must be reviewed.', false);
  }
  if (response.status === 400 || response.status === 422) {
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const msg = typeof data?.message === 'string' ? data.message : 'Invalid request. Please check your details and try again.';
    return outcomeFailure('INVALID_COMMAND', msg, false);
  }
  return unavailableOutcomeFailure();
}

function formatMoneyAmount(value: unknown): string {
  if (typeof value === 'number') {
    return value.toFixed(2);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+(\.\d{1,2})?$/.test(trimmed)) {
      return trimmed;
    }
    const parsed = parseFloat(trimmed);
    if (!isNaN(parsed)) {
      return parsed.toFixed(2);
    }
  }
  return '0.00';
}

function mapAirline(raw: unknown): BookingAirlineView | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const airline = raw as Record<string, unknown>;
  const name = typeof airline.name === 'string' ? airline.name : '';
  const iataCode = typeof airline.iataCode === 'string' ? airline.iataCode : '';
  if (!name || !iataCode) return undefined;

  let logoUrl: string | undefined;
  if (typeof airline.logoUrl === 'string') {
    try {
      new URL(airline.logoUrl);
      logoUrl = airline.logoUrl;
    } catch {
      // invalid URL -> omit
    }
  }

  const result = { name, iataCode, ...(logoUrl ? { logoUrl } : {}) };
  return BookingAirlineViewSchema.safeParse(result).success ? result : undefined;
}

function mapAirport(raw: unknown): BookingAirportView | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const airport = raw as Record<string, unknown>;
  const iataCode = typeof airport.iataCode === 'string' ? airport.iataCode : '';
  const name = typeof airport.name === 'string' ? airport.name : '';
  const city = typeof airport.city === 'string' ? airport.city : '';
  if (!iataCode || !name || !city) return undefined;

  const terminal = typeof airport.terminal === 'string' && airport.terminal.length > 0 ? airport.terminal : undefined;
  const gate = typeof airport.gate === 'string' && airport.gate.length > 0 ? airport.gate : undefined;

  const result = { iataCode, name, city, ...(terminal ? { terminal } : {}), ...(gate ? { gate } : {}) };
  return BookingAirportViewSchema.safeParse(result).success ? result : undefined;
}

function mapSegment(raw: unknown): BookingSegmentView {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid segment');
  }
  const seg = raw as Record<string, unknown>;

  const airline =
    mapAirline(seg.airline) ||
    mapAirline({
      name: seg.airlineName,
      iataCode: seg.marketingCarrierIata || seg.carrierCode || seg.operatingCarrier,
      logoUrl: seg.airlineLogoUrl,
    }) ||
    { name: 'Unknown Airline', iataCode: 'XX' };

  const depAirport =
    mapAirport(seg.departureAirport) ||
    mapAirport({
      iataCode: seg.departureAirportIata || seg.departureAirport,
      name: seg.departureAirportName || seg.departureAirportIata || seg.departureAirport || 'Departure Airport',
      city: seg.departureCity || 'City',
      terminal: seg.departureTerminal,
    }) ||
    { iataCode: 'DEP', name: 'Departure Airport', city: 'City' };

  const arrAirport =
    mapAirport(seg.arrivalAirport) ||
    mapAirport({
      iataCode: seg.arrivalAirportIata || seg.arrivalAirport,
      name: seg.arrivalAirportName || seg.arrivalAirportIata || seg.arrivalAirport || 'Arrival Airport',
      city: seg.arrivalCity || 'City',
      terminal: seg.arrivalTerminal,
    }) ||
    { iataCode: 'ARR', name: 'Arrival Airport', city: 'City' };

  const departureAt =
    typeof seg.departureAt === 'string'
      ? seg.departureAt
      : typeof seg.departureTime === 'string'
      ? seg.departureTime
      : new Date().toISOString();

  const arrivalAt =
    typeof seg.arrivalAt === 'string'
      ? seg.arrivalAt
      : typeof seg.arrivalTime === 'string'
      ? seg.arrivalTime
      : new Date().toISOString();

  let durationStr = 'PT0M';
  if (typeof seg.duration === 'string') {
    durationStr = seg.duration;
  } else if (typeof seg.duration === 'number') {
    const hours = Math.floor(seg.duration / 60);
    const mins = seg.duration % 60;
    durationStr = `PT${hours > 0 ? `${hours}H` : ''}${mins > 0 ? `${mins}M` : '0M'}`;
  } else if (typeof seg.durationMinutes === 'number') {
    const hours = Math.floor(seg.durationMinutes / 60);
    const mins = seg.durationMinutes % 60;
    durationStr = `PT${hours > 0 ? `${hours}H` : ''}${mins > 0 ? `${mins}M` : '0M'}`;
  }

  const result: BookingSegmentView = {
    airline,
    flightNumber: String(seg.flightNumber ?? '000'),
    departureAirport: depAirport,
    arrivalAirport: arrAirport,
    departureAt,
    arrivalAt,
    duration: durationStr,
    ...(typeof seg.aircraftType === 'string' && seg.aircraftType.length > 0 ? { aircraftType: seg.aircraftType } : {}),
    ...(typeof seg.sliceOrder === 'number' ? { sliceOrder: seg.sliceOrder } : {}),
    ...(typeof seg.segmentOrder === 'number' ? { segmentOrder: seg.segmentOrder } : {}),
    ...(typeof seg.globalOrder === 'number' ? { globalOrder: seg.globalOrder } : {}),
  };

  return BookingSegmentViewSchema.parse(result);
}

function mapDisruptionAlert(raw: unknown): DisruptionAlertView | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  const status = typeof d.status === 'string' ? d.status : undefined;
  if (!status || status === 'NONE') return undefined;

  const result: DisruptionAlertView = {
    status,
    ...(typeof d.activeRevisionId === 'string' && d.activeRevisionId.length > 0
      ? { activeRevisionId: d.activeRevisionId }
      : d.activeRevisionId === null
      ? { activeRevisionId: null }
      : {}),
    isMaterial: Boolean(d.isMaterial),
    materialReasons: Array.isArray(d.materialReasons) ? d.materialReasons.map(String) : [],
    ...(d.incrementalSummary && typeof d.incrementalSummary === 'object'
      ? { incrementalSummary: d.incrementalSummary as Record<string, unknown> }
      : d.incrementalSummary === null
      ? { incrementalSummary: null }
      : {}),
    ...(d.cumulativeSummary && typeof d.cumulativeSummary === 'object'
      ? { cumulativeSummary: d.cumulativeSummary as Record<string, unknown> }
      : d.cumulativeSummary === null
      ? { cumulativeSummary: null }
      : {}),
    stabilizationWarning: Boolean(d.stabilizationWarning),
    ...(d.resolvedReason !== undefined ? { resolvedReason: d.resolvedReason != null ? String(d.resolvedReason) : null } : {}),
    ...(d.resolvedAt !== undefined ? { resolvedAt: typeof d.resolvedAt === 'string' ? d.resolvedAt : null } : {}),
  };

  return DisruptionAlertViewSchema.safeParse(result).success ? result : undefined;
}

function mapListItem(raw: unknown): BookingListItemView {
  const item = (raw ?? {}) as Record<string, unknown>;
  const currentItin = (item.currentItinerary ?? {}) as Record<string, unknown>;
  const flightSnap = (item.flightSnapshot ?? {}) as Record<string, unknown>;
  const rawSegments = (Array.isArray(currentItin.segments) ? currentItin.segments : (Array.isArray(flightSnap.segments) ? flightSnap.segments : [])) as unknown[];
  const segments = rawSegments.map((s) => {
    try {
      return mapSegment(s);
    } catch {
      return null;
    }
  }).filter((s): s is BookingSegmentView => s !== null);

  const firstSeg = segments[0];
  const lastSeg = segments[segments.length - 1];

  let airline = mapAirline(item.airline);
  if (!airline && firstSeg) {
    airline = firstSeg.airline;
  }

  let origin: { iataCode: string; city: string } | undefined;
  if (item.origin && typeof item.origin === 'object') {
    const o = item.origin as Record<string, unknown>;
    if (typeof o.iataCode === 'string' && typeof o.city === 'string') {
      origin = { iataCode: o.iataCode, city: o.city };
    }
  } else if (firstSeg) {
    origin = {
      iataCode: firstSeg.departureAirport.iataCode,
      city: firstSeg.departureAirport.city,
    };
  }

  let destination: { iataCode: string; city: string } | undefined;
  if (item.destination && typeof item.destination === 'object') {
    const d = item.destination as Record<string, unknown>;
    if (typeof d.iataCode === 'string' && typeof d.city === 'string') {
      destination = { iataCode: d.iataCode, city: d.city };
    }
  } else if (lastSeg) {
    destination = {
      iataCode: lastSeg.arrivalAirport.iataCode,
      city: lastSeg.arrivalAirport.city,
    };
  }

  const departureAt =
    typeof item.departureAt === 'string'
      ? item.departureAt
      : typeof currentItin.nextUnflownDepartureAt === 'string'
      ? currentItin.nextUnflownDepartureAt
      : firstSeg?.departureAt ?? null;

  const arrivalAt =
    typeof item.arrivalAt === 'string'
      ? item.arrivalAt
      : typeof currentItin.finalArrivalAt === 'string'
      ? currentItin.finalArrivalAt
      : lastSeg?.arrivalAt ?? null;

  const disruption = mapDisruptionAlert(item.disruption);

  const paymentStatus =
    typeof (item.payment as { status?: unknown } | undefined)?.status === 'string'
      ? (item.payment as { status: string }).status
      : typeof item.paymentStatus === 'string'
      ? item.paymentStatus
      : undefined;

  const result: BookingListItemView = {
    id: String(item.id ?? ''),
    status: String(item.status ?? ''),
    ...(item.failureReason !== undefined ? { failureReason: item.failureReason != null ? String(item.failureReason) : null } : {}),
    ...(paymentStatus !== undefined ? { paymentStatus: paymentStatus != null ? String(paymentStatus) : null } : {}),
    ...(item.pnrReference !== undefined ? { pnrReference: item.pnrReference != null ? String(item.pnrReference) : null } : {}),
    totalAmount: formatMoneyAmount(item.totalAmount),
    currency: String(item.currency ?? 'USD'),
    ...(departureAt !== undefined ? { departureAt } : {}),
    ...(arrivalAt !== undefined ? { arrivalAt } : {}),
    ...(airline ? { airline } : {}),
    ...(origin ? { origin } : {}),
    ...(destination ? { destination } : {}),
    ...(disruption ? { disruption } : {}),
  };

  return BookingListItemViewSchema.parse(result);
}

function mapDetail(item: Record<string, unknown>): BookingDetailView {
  const currentItin = (item.currentItinerary ?? {}) as Record<string, unknown>;
  const flightSnap = (item.flightSnapshot ?? {}) as Record<string, unknown>;
  const rawItin = (item.itinerary ?? {}) as Record<string, unknown>;
  const rawSegments = (
    Array.isArray(rawItin.segments)
      ? rawItin.segments
      : Array.isArray(currentItin.segments)
      ? currentItin.segments
      : Array.isArray(flightSnap.segments)
      ? flightSnap.segments
      : []
  ) as unknown[];

  const segments = rawSegments.map((s) => {
    try {
      return mapSegment(s);
    } catch {
      return null;
    }
  }).filter((s): s is BookingSegmentView => s !== null);

  const firstSeg = segments[0];
  const lastSeg = segments[segments.length - 1];

  let airline = mapAirline(item.airline);
  if (!airline && firstSeg) {
    airline = firstSeg.airline;
  }

  let origin: { iataCode: string; city: string } | undefined;
  if (item.origin && typeof item.origin === 'object') {
    const o = item.origin as Record<string, unknown>;
    if (typeof o.iataCode === 'string' && typeof o.city === 'string') {
      origin = { iataCode: o.iataCode, city: o.city };
    }
  } else if (firstSeg) {
    origin = {
      iataCode: firstSeg.departureAirport.iataCode,
      city: firstSeg.departureAirport.city,
    };
  }

  let destination: { iataCode: string; city: string } | undefined;
  if (item.destination && typeof item.destination === 'object') {
    const d = item.destination as Record<string, unknown>;
    if (typeof d.iataCode === 'string' && typeof d.city === 'string') {
      destination = { iataCode: d.iataCode, city: d.city };
    }
  } else if (lastSeg) {
    destination = {
      iataCode: lastSeg.arrivalAirport.iataCode,
      city: lastSeg.arrivalAirport.city,
    };
  }

  const departureAt =
    typeof item.departureAt === 'string'
      ? item.departureAt
      : typeof currentItin.nextUnflownDepartureAt === 'string'
      ? currentItin.nextUnflownDepartureAt
      : firstSeg?.departureAt ?? null;

  const arrivalAt =
    typeof item.arrivalAt === 'string'
      ? item.arrivalAt
      : typeof currentItin.finalArrivalAt === 'string'
      ? currentItin.finalArrivalAt
      : lastSeg?.arrivalAt ?? null;

  const rawPassengers = (
    Array.isArray(item.passengers)
      ? item.passengers
      : Array.isArray(item.passengerSnapshot)
      ? item.passengerSnapshot
      : Array.isArray((item.passengerSnapshot as { passengers?: unknown[] } | undefined)?.passengers)
      ? (item.passengerSnapshot as { passengers: unknown[] }).passengers
      : Array.isArray((item.bookingIntent as { passengers?: unknown[] } | undefined)?.passengers)
      ? (item.bookingIntent as { passengers: unknown[] }).passengers
      : []
  ) as unknown[];

  const passengers = rawPassengers.map((p) => {
    const rawP = (p ?? {}) as Record<string, unknown>;
    const title = typeof rawP.title === 'string' && rawP.title.length > 0 ? rawP.title : undefined;
    return {
      type: typeof rawP.type === 'string' && rawP.type.length > 0 ? rawP.type : 'ADULT',
      ...(title ? { title } : {}),
      firstName: String(rawP.firstName ?? rawP.givenName ?? ''),
      lastName: String(rawP.lastName ?? rawP.familyName ?? ''),
    };
  });

  const itinerary: BookingItineraryView = {
    source: (rawItin.source === 'REVISION' || currentItin.source === 'REVISION') ? 'REVISION' : 'ORIGINAL',
    revisionId: (
      typeof rawItin.revisionId === 'string'
        ? rawItin.revisionId
        : typeof currentItin.revisionId === 'string'
        ? currentItin.revisionId
        : typeof (item.disruption as Record<string, unknown> | undefined)?.activeRevisionId === 'string'
        ? ((item.disruption as Record<string, unknown>).activeRevisionId as string)
        : null
    ),
    version: Math.max(1, typeof rawItin.version === 'number' ? rawItin.version : typeof currentItin.version === 'number' ? currentItin.version : 1),
    segments,
    nextUnflownDepartureAt: (typeof rawItin.nextUnflownDepartureAt === 'string' ? rawItin.nextUnflownDepartureAt : typeof currentItin.nextUnflownDepartureAt === 'string' ? currentItin.nextUnflownDepartureAt : (firstSeg?.departureAt || null)),
    finalArrivalAt: (typeof rawItin.finalArrivalAt === 'string' ? rawItin.finalArrivalAt : typeof currentItin.finalArrivalAt === 'string' ? currentItin.finalArrivalAt : (lastSeg?.arrivalAt || null)),
    ...(typeof rawItin.totalDuration === 'string' ? { totalDuration: rawItin.totalDuration } : typeof flightSnap.totalDuration === 'string' ? { totalDuration: flightSnap.totalDuration } : {}),
    ...(typeof rawItin.stops === 'number' ? { stops: rawItin.stops } : typeof flightSnap.stops === 'number' ? { stops: flightSnap.stops } : {}),
    ...(typeof rawItin.cabinClass === 'string' ? { cabinClass: rawItin.cabinClass } : typeof flightSnap.cabinClass === 'string' ? { cabinClass: flightSnap.cabinClass } : {}),
    ...(rawItin.fareClass !== undefined ? { fareClass: rawItin.fareClass != null ? String(rawItin.fareClass) : null } : flightSnap.fareClass !== undefined ? { fareClass: flightSnap.fareClass != null ? String(flightSnap.fareClass) : null } : {}),
    ...(rawItin.baggageAllowance !== undefined ? { baggageAllowance: rawItin.baggageAllowance != null ? String(rawItin.baggageAllowance) : null } : flightSnap.baggageAllowance !== undefined ? { baggageAllowance: flightSnap.baggageAllowance != null ? String(flightSnap.baggageAllowance) : null } : {}),
  };

  const disruption = mapDisruptionAlert(item.disruption);

  let ancillarySummary: BookingDetailView['ancillarySummary'];
  const rawAncillary = item.ancillarySummary as { seats?: unknown[]; baggage?: unknown[] } | undefined;
  if (rawAncillary && typeof rawAncillary === 'object') {
    const rawSeats = Array.isArray(rawAncillary.seats) ? rawAncillary.seats : [];
    const rawBaggage = Array.isArray(rawAncillary.baggage) ? rawAncillary.baggage : [];
    if (rawSeats.length > 0 || rawBaggage.length > 0) {
      ancillarySummary = {
        seats: rawSeats.map((s) => {
          const seat = (s ?? {}) as Record<string, unknown>;
          return {
            passengerName: String(seat.passengerName ?? ''),
            seatDesignator: String(seat.seatDesignator ?? ''),
            amount: formatMoneyAmount(seat.amount),
            currency: String(seat.currency ?? 'USD'),
          };
        }),
        baggage: rawBaggage.map((b) => {
          const bag = (b ?? {}) as Record<string, unknown>;
          return {
            passengerName: String(bag.passengerName ?? ''),
            type: String(bag.type ?? ''),
            quantity: typeof bag.quantity === 'number' && bag.quantity >= 1 ? bag.quantity : 1,
            amount: formatMoneyAmount(bag.amount),
            currency: String(bag.currency ?? 'USD'),
          };
        }),
      };
    }
  }

  let cancellation: BookingDetailView['cancellation'];
  if (item.cancellation && typeof item.cancellation === 'object') {
    const c = item.cancellation as Record<string, unknown>;
    cancellation = {
      deadline: typeof c.deadline === 'string' ? c.deadline : null,
      refundable: c.refundable != null ? Boolean(c.refundable) : null,
      airlineRefundAmount: c.airlineRefundAmount != null ? String(c.airlineRefundAmount) : null,
      customerRefundAmount: c.customerRefundAmount != null ? String(c.customerRefundAmount) : null,
    };
  } else if (
    item.cancellationDeadline !== undefined ||
    item.cancellationRefundable !== undefined ||
    item.airlineRefundAmount !== undefined ||
    item.customerRefundAmount !== undefined
  ) {
    cancellation = {
      deadline: typeof item.cancellationDeadline === 'string' ? item.cancellationDeadline : null,
      refundable: item.cancellationRefundable != null ? Boolean(item.cancellationRefundable) : null,
      airlineRefundAmount: item.airlineRefundAmount != null ? String(item.airlineRefundAmount) : null,
      customerRefundAmount: item.customerRefundAmount != null ? String(item.customerRefundAmount) : null,
    };
  }

  const paymentStatus =
    typeof (item.payment as { status?: unknown } | undefined)?.status === 'string'
      ? (item.payment as { status: string }).status
      : typeof item.paymentStatus === 'string'
      ? item.paymentStatus
      : undefined;

  const offerId =
    typeof (item.bookingIntent as { offerId?: unknown } | undefined)?.offerId === 'string'
      ? (item.bookingIntent as { offerId: string }).offerId
      : typeof item.offerId === 'string'
      ? item.offerId
      : undefined;

  const result: BookingDetailView = {
    id: String(item.id ?? ''),
    status: String(item.status ?? ''),
    ...(item.failureReason !== undefined ? { failureReason: item.failureReason != null ? String(item.failureReason) : null } : {}),
    ...(paymentStatus !== undefined ? { paymentStatus: paymentStatus != null ? String(paymentStatus) : null } : {}),
    ...(offerId !== undefined ? { offerId: offerId != null ? String(offerId) : null } : {}),
    ...(item.pnrReference !== undefined ? { pnrReference: item.pnrReference != null ? String(item.pnrReference) : null } : {}),
    totalAmount: formatMoneyAmount(item.totalAmount),
    currency: String(item.currency ?? 'USD'),
    ...(departureAt !== undefined ? { departureAt } : {}),
    ...(arrivalAt !== undefined ? { arrivalAt } : {}),
    ...(airline ? { airline } : {}),
    ...(origin ? { origin } : {}),
    ...(destination ? { destination } : {}),
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    itinerary,
    passengers,
    ...(ancillarySummary ? { ancillarySummary } : {}),
    ...(cancellation ? { cancellation } : {}),
    ...(disruption ? { disruption } : {}),
  };

  return BookingDetailViewSchema.parse(result);
}

/**
 * Maps raw backend DTO or mock scenario object into a strongly-typed BookingDetailView.
 */
export function mapBookingDetail(item: Record<string, unknown>): BookingDetailView {
  return mapDetail(item);
}
