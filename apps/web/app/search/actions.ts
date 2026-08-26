'use server';

import type { FlightSearchOutcome, FlightSearchQuery, FlightSelectionOutcome } from '@shared/types';
import { searchFlights, selectFlightOffer } from '@/lib/server/flight-search';

export async function searchFlightsAction(query: FlightSearchQuery): Promise<FlightSearchOutcome> {
  return searchFlights(query);
}

export async function selectFlightOfferAction(offerId: string): Promise<FlightSelectionOutcome> {
  return selectFlightOffer(offerId);
}
