import React from 'react';
import type { HandoffEvent } from '@shared/types/chat.types';

type CheckoutHandoffCardProps = {
  event: HandoffEvent;
};

export function CheckoutHandoffCard({ event }: CheckoutHandoffCardProps): JSX.Element {
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
      <form action="/checkout/handoff" method="POST" className="mt-2 text-right">
        <input type="hidden" name="handoffToken" value={event.handoffToken} />
        <button
          type="submit"
          className="btn-primary w-full text-sm font-medium py-2 px-4 rounded bg-blue-600 text-white hover:bg-blue-700"
        >
          Continue to Checkout
        </button>
      </form>
    </div>
  );
}
