type BookingConfirmationBannerProps = {
  pnrReference?: string;
};

export function BookingConfirmationBanner({ pnrReference }: BookingConfirmationBannerProps) {
  return (
    <section
      aria-labelledby="booking-confirmed-title"
      className="card border border-text-confirmed bg-bg-confirmed"
    >
      <h1 id="booking-confirmed-title" className="text-xl font-bold text-text-confirmed">
        Booking confirmed
      </h1>
      <p className="mt-2 text-sm text-text-secondary">
        Your flight is confirmed and your itinerary is ready.
      </p>
      {pnrReference && (
        <p className="mt-3 text-sm font-semibold text-text-primary">
          Booking reference: {pnrReference}
        </p>
      )}
    </section>
  );
}
