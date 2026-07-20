export function BookingProcessingState() {
  return (
    <section aria-labelledby="booking-processing-title" className="card border border-card-border">
      <h1 id="booking-processing-title" className="text-xl font-bold text-text-primary">
        Your booking is being processed
      </h1>
      <p className="mt-2 text-sm text-text-secondary">
        We’re confirming your flight. Please refresh this page shortly to check its status.
      </p>
    </section>
  );
}
