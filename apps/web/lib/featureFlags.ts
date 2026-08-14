export function isBookingReadinessEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS === 'true';
}

export function isCheckoutEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_FLAG_CHECKOUT !== 'false';
}

export function getFeatureFlags() {
  return {
    FEATURE_FLAG_CHAT_MULTI_AGENT: process.env.NEXT_PUBLIC_FEATURE_FLAG_CHAT_MULTI_AGENT === 'true',
    FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: process.env.NEXT_PUBLIC_FEATURE_FLAG_CHAT_HANDOFF_ACCEPT === 'true',
  };
}
