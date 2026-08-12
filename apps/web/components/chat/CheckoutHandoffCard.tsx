'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { HandoffEvent } from '@shared/types/chat.types';
import { appendHandoffCredential } from '@/lib/handoffFormSubmission';

type CheckoutHandoffCardProps = {
  event: HandoffEvent;
};

export function CheckoutHandoffCard({ event }: CheckoutHandoffCardProps): JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const form = formRef.current;
    if (!form) return undefined;

    const addCredential = (formDataEvent: FormDataEvent): void => {
      appendHandoffCredential(formDataEvent.formData, event.handoffToken);
    };

    form.addEventListener('formdata', addCredential);
    return () => form.removeEventListener('formdata', addCredential);
  }, [event.handoffToken]);

  function submitHandoff(): void {
    setSubmitting(true);
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
      <form
        ref={formRef}
        action="/checkout/handoff"
        method="post"
        onSubmit={submitHandoff}
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
