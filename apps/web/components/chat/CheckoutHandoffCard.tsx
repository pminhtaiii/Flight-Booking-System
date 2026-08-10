'use client';

import React, { useState } from 'react';
import type { HandoffEvent } from '@shared/types/chat.types';

type CheckoutHandoffCardProps = {
  event: HandoffEvent;
};

export function CheckoutHandoffCard({ event }: CheckoutHandoffCardProps): JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);

  async function submitHandoff(): Promise<void> {
    setSubmitting(true);
    setError(false);

    try {
      const body = new URLSearchParams({ handoffToken: event.handoffToken });
      const response = await fetch('/checkout/handoff', {
        method: 'POST',
        body,
        credentials: 'same-origin',
        redirect: 'manual',
      });

      if (response.status === 303 || response.type === 'opaqueredirect') {
        window.location.assign('/checkout/passengers');
        return;
      }
      setError(true);
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card rounded border border-card-border bg-card p-4 space-y-3">
      <h3 className="text-sm font-semibold text-text-primary">Flight Selected</h3>
      <div className="flex flex-col gap-1 text-sm text-text-secondary">
        <div><span className="font-medium text-text-primary">Airline:</span> {event.display.airline}</div>
        <div><span className="font-medium text-text-primary">Route:</span> {event.display.origin} to {event.display.destination}</div>
        <div><span className="font-medium text-text-primary">Departure:</span> {new Date(event.display.departureAt).toLocaleString()}</div>
        <div><span className="font-medium text-text-primary">Arrival:</span> {new Date(event.display.arrivalAt).toLocaleString()}</div>
        <div><span className="font-medium text-text-primary">Price:</span> {event.display.price} {event.display.currency}</div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-text-secondary">
          We couldn&apos;t open checkout. Please try again.
        </p>
      ) : null}
      <form
        onSubmit={(formEvent) => {
          formEvent.preventDefault();
          void submitHandoff();
        }}
        className="mt-2 text-right"
      >
        <button
          type="submit"
          disabled={submitting}
          className="btn-primary w-full rounded px-4 py-2 text-sm font-medium"
        >
          {submitting ? 'Opening Checkout...' : 'Continue to Checkout'}
        </button>
      </form>
    </div>
  );
}
