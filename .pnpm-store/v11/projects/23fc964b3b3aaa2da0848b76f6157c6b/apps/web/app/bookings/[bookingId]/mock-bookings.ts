import { BookingStatus } from '@shared/booking-status';
import { BookingFailureReason } from '@shared/booking-failure-reason';
import { DisruptionStatus, MaterialDisruptionReason } from '@shared/disruption-types';
import type { BookingDetailDto, FlightSegmentSnapshot, PassengerSnapshot } from '@shared/booking-types';
import type { CurrentItineraryDto, BookingDisruptionDto } from '@shared/disruption-types';

type MockBookingDetailResponse = BookingDetailDto & {
  payment?: { status: string } | null;
  bookingIntent?: { id: string; offerId: string };
  currentItinerary?: CurrentItineraryDto;
  disruption?: BookingDisruptionDto;
};

export const MOCK_BOOKINGS: Record<string, MockBookingDetailResponse> = {
  'confirmed-booking': {
    id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a9a',
    status: BookingStatus.CONFIRMED,
    pnrReference: 'PNR123',
    totalAmount: '499.00',
    currency: 'GBP',
    paymentStatus: 'SUCCEEDED',
    flightSnapshot: {
      segments: [{
        airline: { name: 'Example Air', iataCode: 'EA' },
        flightNumber: 'EA101',
        departureAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
        arrivalAirport: { iataCode: 'JFK', name: 'John F. Kennedy', city: 'New York' },
        departureAt: '2026-08-01T09:00:00.000Z',
        arrivalAt: '2026-08-01T17:00:00.000Z',
        duration: 'PT8H',
      } as unknown as FlightSegmentSnapshot],
      totalDuration: 'PT8H',
      stops: 0,
      cabinClass: 'ECONOMY',
      baggageAllowance: '1 checked bag',
    },
    passengerSnapshot: {
      passengers: [{ type: 'adult', firstName: 'Ada', lastName: 'Lovelace' } as unknown as PassengerSnapshot],
      contactEmail: 'traveler@example.com',
    } as unknown as PassengerSnapshot,
    createdAt: '2026-07-25T10:00:00.000Z',
    updatedAt: '2026-07-25T10:00:00.000Z',
  },
  'processing-booking': {
    id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a9a',
    status: BookingStatus.PROCESSING,
    totalAmount: '499.00',
    currency: 'GBP',
    createdAt: '2026-07-25T10:00:00.000Z',
    updatedAt: '2026-07-25T10:00:00.000Z',
  },
  'expired-offer': {
    id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a9a',
    status: BookingStatus.FAILED,
    failureReason: BookingFailureReason.OFFER_EXPIRED,
    totalAmount: '499.00',
    currency: 'GBP',
    flightSnapshot: {
      segments: [{
        airline: { name: 'Example Air', iataCode: 'EA' },
        flightNumber: 'EA101',
        departureAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
        arrivalAirport: { iataCode: 'JFK', name: 'John F. Kennedy', city: 'New York' },
        departureAt: '2026-08-01T09:00:00.000Z',
        arrivalAt: '2026-08-01T17:00:00.000Z',
        duration: 'PT8H',
      } as unknown as FlightSegmentSnapshot],
      totalDuration: 'PT8H',
      stops: 0,
      cabinClass: 'ECONOMY',
    },
    createdAt: '2026-07-25T10:00:00.000Z',
    updatedAt: '2026-07-25T10:00:00.000Z',
  },
  'price-changed': {
    id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a9a',
    status: BookingStatus.FAILED,
    failureReason: BookingFailureReason.PRICE_CHANGED,
    totalAmount: '499.00',
    currency: 'GBP',
    bookingIntent: { id: 'intent-123', offerId: 'offer-123' },
    payment: { status: 'AUTHORIZED' },
    createdAt: '2026-07-25T10:00:00.000Z',
    updatedAt: '2026-07-25T10:00:00.000Z',
  },
  'disruption-detected': {
    id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a9a',
    status: BookingStatus.CONFIRMED,
    pnrReference: 'PNR123',
    totalAmount: '499.00',
    currency: 'GBP',
    cancellationDeadline: '2029-12-31T23:59:59.000Z',
    cancellationRefundable: true,
    flightSnapshot: {
      segments: [{
        airline: { name: 'Original Air', iataCode: 'OA' },
        flightNumber: 'OA101',
        departureAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
        arrivalAirport: { iataCode: 'JFK', name: 'John F. Kennedy', city: 'New York' },
        departureAt: '2026-08-01T09:00:00.000Z',
        arrivalAt: '2026-08-01T17:00:00.000Z',
        duration: 'PT8H',
      } as unknown as FlightSegmentSnapshot],
      totalDuration: 'PT8H',
      stops: 0,
      cabinClass: 'ECONOMY',
    },
    currentItinerary: {
      source: 'REVISION',
      revisionId: '9b8577bc-89cd-5b56-9f0f-0c4d73370b0b',
      version: 1,
      segments: [{
        airline: { name: 'Revised Air', iataCode: 'RA' },
        flightNumber: 'RA202',
        departureAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
        arrivalAirport: { iataCode: 'JFK', name: 'John F. Kennedy', city: 'New York' },
        departureAt: '2026-08-01T13:00:00.000Z',
        arrivalAt: '2026-08-01T21:00:00.000Z',
        duration: 'PT8H',
      } as unknown as FlightSegmentSnapshot],
      nextUnflownDepartureAt: '2026-08-01T13:00:00.000Z',
      finalArrivalAt: '2026-08-01T21:00:00.000Z',
    },
    disruption: {
      status: DisruptionStatus.DETECTED,
      activeRevisionId: '9b8577bc-89cd-5b56-9f0f-0c4d73370b0b',
      isMaterial: true,
      materialReasons: [MaterialDisruptionReason.DEPARTURE_MOVED_LATER],
      incrementalSummary: {
        isRoutingChanged: false,
        hasStopsChanged: false,
        sliceSummaries: [{
          sliceOrder: 0,
          originIata: 'LHR',
          destinationIata: 'JFK',
          finalArrivalShiftMinutes: 240,
        }],
      },
      cumulativeSummary: {
        isRoutingChanged: false,
        hasStopsChanged: false,
        sliceSummaries: [{
          sliceOrder: 0,
          originIata: 'LHR',
          destinationIata: 'JFK',
          finalArrivalShiftMinutes: 240,
        }],
      },
      stabilizationWarning: true,
      resolvedReason: null,
      resolvedAt: null,
    },
    createdAt: '2026-07-25T10:00:00.000Z',
    updatedAt: '2026-07-25T10:00:00.000Z',
  },
  'disruption-acknowledged': {
    id: '8a7466ab-78bd-4a45-8e9e-9b3c62269a9a',
    status: BookingStatus.CONFIRMED,
    totalAmount: '499.00',
    currency: 'GBP',
    flightSnapshot: {
      segments: [],
      totalDuration: 'PT0H',
      stops: 0,
      cabinClass: 'ECONOMY',
    },
    disruption: {
      status: DisruptionStatus.ACKNOWLEDGED,
      activeRevisionId: '9b8577bc-89cd-5b56-9f0f-0c4d73370b0b',
      isMaterial: true,
      materialReasons: [MaterialDisruptionReason.SEGMENT_REMOVED],
      incrementalSummary: {},
      cumulativeSummary: {},
      stabilizationWarning: false,
      resolvedReason: null,
      resolvedAt: null,
    },
    createdAt: '2026-07-25T10:00:00.000Z',
    updatedAt: '2026-07-25T10:00:00.000Z',
  },
};
