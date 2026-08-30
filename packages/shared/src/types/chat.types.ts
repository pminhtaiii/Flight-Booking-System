import { z } from 'zod';

export type RouterIntent = 'GENERAL' | 'SEARCH' | 'BOOKING_INQUIRY' | 'CHECKOUT';

export type RouteDecision = {
  intent: RouterIntent;
  confidence: number;
  isCommitment: boolean;
  selectionIndex?: number;
};

export type SSEActionType =
  | 'begin_checkout'
  | 'action_required'
  | 'chat_message'
  | 'error'
  | 'agent_state';

export const HANDOFF_CREDENTIAL_PATTERN = /^chk_handoff_v[0-9]+_[A-Za-z0-9_-]{43}$/;

export type BaseSSEEvent = {
  version: 1;
  action: SSEActionType;
};

export const actionHandoffSchema = z
  .object({
    version: z.literal(1),
    action: z.literal('begin_checkout'),
    handoffToken: z.string().regex(HANDOFF_CREDENTIAL_PATTERN),
    expiresAt: z.string().datetime({ offset: false }),
    display: z
      .object({
        airline: z.string(),
        origin: z.string(),
        destination: z.string(),
        departureAt: z.string(),
        arrivalAt: z.string(),
        price: z.string(),
        currency: z.string(),
      })
      .strict(),
  })
  .strict();

export type HandoffEvent = z.infer<typeof actionHandoffSchema>;

export type ActionRequiredEvent = BaseSSEEvent & {
  action: 'action_required';
  message: string;
};

export type ChatMessageEvent = BaseSSEEvent & {
  action: 'chat_message';
  content: string;
  role: 'assistant' | 'system' | 'user';
};

export type ChatEvent = HandoffEvent | ActionRequiredEvent | ChatMessageEvent;

export type HandoffErrorCode =
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'TOKEN_CONSUMED'
  | 'UNAUTHORIZED_OWNER'
  | 'STALE_SESSION'
  | 'OFFER_EXPIRED';

export type HandoffError = {
  code: HandoffErrorCode;
  message: string;
};

export type BookingSummary = {
  bookingReference: string;
  airline: string;
  origin: string;
  destination: string;
  departureTime: string;
  arrivalTime: string;
  status: string;
  durationMinutes: number;
  stops: number;
};

export type BookingDetail = BookingSummary & {
  flightNumber?: string | null;
  baggageAllowance?: string | null;
  changeable?: boolean | null;
  refundable?: boolean | null;
};
