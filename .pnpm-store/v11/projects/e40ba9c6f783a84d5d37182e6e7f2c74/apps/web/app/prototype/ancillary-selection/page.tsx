import { Header } from '@/components/layout/Header';
import { AncillarySelectionPrototype } from './AncillarySelectionPrototype';
import type { BookingIntentDto } from '@/lib/checkout';

const prototypeIntent = {
  intentId: 'prototype-ancillary-intent',
  status: 'PENDING',
  originalPrice: 150,
  confirmedPrice: 150,
  priceChanged: false,
  currency: 'USD',
  pricedAt: '2026-07-27T00:00:00.000Z',
  intentExpiresAt: '2026-07-27T00:30:00.000Z',
  offerExpiresAt: null,
  createdAt: '2026-07-27T00:00:00.000Z',
  passengers: [
    {
      id: 'prototype-passenger-1',
      type: 'ADULT',
      givenName: 'Alex',
      familyName: 'Doe',
      dateOfBirth: '1990-01-01',
      gender: 'unspecified',
      nationality: null,
      passportNumber: null,
      passportExpiry: null,
      preFilledFromProfile: false,
    },
    {
      id: 'prototype-passenger-2',
      type: 'ADULT',
      givenName: 'Jordan',
      familyName: 'Doe',
      dateOfBirth: '1992-01-01',
      gender: 'unspecified',
      nationality: null,
      passportNumber: null,
      passportExpiry: null,
      preFilledFromProfile: false,
    },
  ],
  flight: {
    origin: 'JFK',
    destination: 'LHR',
    departureDate: '2026-10-10',
    returnDate: null,
    cabinClass: 'economy',
    adults: 2,
    children: 0,
    infants: 0,
  },
} satisfies BookingIntentDto;

export default function AncillarySelectionPrototypePage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main className="mx-auto w-full max-w-7xl py-12 px-4">
        <AncillarySelectionPrototype intent={prototypeIntent} />
      </main>
    </div>
  );
}
