import { z } from 'zod';

export type RouterIntent = 'GENERAL' | 'SEARCH' | 'BOOKING_INQUIRY' | 'CHECKOUT';

export type RouteDecision = {
  intent: RouterIntent;
  confidence: number;
  isCommitment: boolean;
  selectionIndex?: number;
};

export type SSEActionType = 'begin_checkout' | 'action_required' | 'chat_message' | 'error' | 'agent_state';

export interface BaseSSEEvent {
  version: 1;
  action: SSEActionType;
}

export const actionHandoffSchema = z.object({
  version: z.literal(1),
  action: z.literal('begin_checkout'),
  handoffToken: z.string(),
  expiresAt: z.string(),
  display: z.object({
    airline: z.string(),
    origin: z.string(),
    destination: z.string(),
    departureAt: z.string(),
    arrivalAt: z.string(),
    price: z.string(),
    currency: z.string(),
  }).strict(),
}).strict();

export type HandoffEvent = z.infer<typeof actionHandoffSchema>;

export interface ActionRequiredEvent extends BaseSSEEvent {
  action: 'action_required';
  message: string;
}

export interface ChatMessageEvent extends BaseSSEEvent {
  action: 'chat_message';
  content: string;
  role: 'assistant' | 'system' | 'user';
}

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
  reference: string;
  status: string;
  origin: string;
  destination: string;
  departureTime: string;
  arrivalTime: string;
  airline: string;
};

export type BookingDetail = BookingSummary & {
  flightNumber: string;
  passengers: number;
  baggageAllowance?: string | null;
  fareConditions: {
    refundable: boolean;
    changeable: boolean;
  };
};
