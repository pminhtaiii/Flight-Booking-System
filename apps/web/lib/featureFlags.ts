export function isBookingReadinessEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS === 'true';
}

export function isCheckoutEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_FLAG_CHECKOUT !== 'false';
}
