'use client';

import { useEffect, useRef, useState } from 'react';

type CheckoutLoadingEscalationProps = {
  bookingId: string;
  onNavigate: (destination: string) => void;
};

const steps = ['Authorizing payment', 'Reserving your flight', 'Finalizing your booking'];

export function CheckoutLoadingEscalation({
  bookingId,
  onNavigate,
}: CheckoutLoadingEscalationProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const redirected = useRef(false);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setElapsedSeconds((current) => current + 1);
    }, 1000);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (elapsedSeconds < 45 || redirected.current) {
      return;
    }

    redirected.current = true;
    onNavigate(`/bookings/${bookingId}`);
  }, [bookingId, elapsedSeconds, onNavigate]);

  const showReassurance = elapsedSeconds >= 10;
  const showEscapeHatch = elapsedSeconds >= 20;
  const showConfidentStepper = elapsedSeconds < 10;

  return (
    <section aria-labelledby="checkout-processing-title" className="card max-w-xl space-y-6">
      <div className="space-y-2">
        <h1 id="checkout-processing-title" className="text-xl font-bold text-text-primary">
          Completing your booking
        </h1>
        <p
          aria-live="polite"
          className={`text-sm text-text-secondary ${elapsedSeconds >= 10 && elapsedSeconds < 20 ? 'animate-pulse [animation-duration:3s]' : ''}`}
        >
          {showReassurance
            ? 'This is taking a little longer than usual. Your payment is still being processed securely.'
            : 'Please keep this page open while we confirm your payment and reserve your flight.'}
        </p>
      </div>

      <ol aria-label="Booking progress" className="space-y-3">
        {steps.map((step, index) => {
          const isComplete = elapsedSeconds >= (index + 1) * 3;
          const isCurrent = !isComplete && index === Math.min(2, Math.floor(elapsedSeconds / 3));

          return (
            <li key={step} className="flex items-center gap-3 text-sm">
              <span
                aria-hidden="true"
                className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs font-bold ${
                  isComplete
                    ? 'border-text-confirmed bg-bg-confirmed text-text-confirmed'
                    : isCurrent
                      ? `border-accent bg-card text-accent ${showConfidentStepper ? 'animate-pulse' : ''}`
                      : 'border-card-border bg-background text-text-muted'
                }`}
              >
                {isComplete ? '✓' : index + 1}
              </span>
              <span className={isCurrent ? 'font-semibold text-text-primary' : 'text-text-secondary'}>
                {step}
              </span>
            </li>
          );
        })}
      </ol>

      {showEscapeHatch && (
        <div className="rounded-lg border border-card-border bg-background p-4 text-sm text-text-secondary">
          <p>Your booking is still processing. You can safely view its latest status now.</p>
          <button
            type="button"
            onClick={() => onNavigate(`/bookings/${bookingId}`)}
            className="btn-secondary mt-3"
          >
            Check My Bookings
          </button>
        </div>
      )}
    </section>
  );
}
