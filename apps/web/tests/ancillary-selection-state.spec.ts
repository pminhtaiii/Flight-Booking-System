import { expect, test } from '@playwright/test';

import {
  ancillarySelectionReducer,
  calculateAncillaryTotals,
  calculateBaggageSavings,
  createAncillarySelectionState,
  getReconciliationIssues,
  getSeatSelections,
} from '../lib/ancillary-selection';

test.describe('ancillary selection state', () => {
  test('keeps seats isolated by segment and passenger, toggles a selected seat off, and prevents a group duplicate', () => {
    let state = createAncillarySelectionState({ seats: [], baggage: [] });

    state = ancillarySelectionReducer(state, {
      type: 'toggleSeat',
      seat: {
        intentPassengerId: 'passenger-1',
        segmentId: 'segment-1',
        serviceId: 'service-1a-passenger-1',
        seatDesignator: '1A',
        amount: '10.00',
        currency: 'USD',
      },
      relatedServiceIds: ['service-1a-passenger-1', 'service-1a-passenger-2'],
    });

    state = ancillarySelectionReducer(state, {
      type: 'toggleSeat',
      seat: {
        intentPassengerId: 'passenger-2',
        segmentId: 'segment-2',
        serviceId: 'service-2b-passenger-2',
        seatDesignator: '2B',
        amount: '12.00',
        currency: 'USD',
      },
      relatedServiceIds: ['service-2b-passenger-1', 'service-2b-passenger-2'],
    });

    const isolatedSeats = getSeatSelections(state);
    expect(isolatedSeats).toHaveLength(2);
    expect(isolatedSeats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          intentPassengerId: 'passenger-1',
          segmentId: 'segment-1',
          serviceId: 'service-1a-passenger-1',
        }),
        expect.objectContaining({
          intentPassengerId: 'passenger-2',
          segmentId: 'segment-2',
          serviceId: 'service-2b-passenger-2',
        }),
      ]),
    );

    const duplicateAttempt = ancillarySelectionReducer(state, {
      type: 'toggleSeat',
      seat: {
        intentPassengerId: 'passenger-2',
        segmentId: 'segment-1',
        serviceId: 'service-1a-passenger-2',
        seatDesignator: '1A',
        amount: '10.00',
        currency: 'USD',
      },
      relatedServiceIds: ['service-1a-passenger-1', 'service-1a-passenger-2'],
    });

    expect(getSeatSelections(duplicateAttempt)).toEqual(isolatedSeats);

    state = ancillarySelectionReducer(state, {
      type: 'toggleSeat',
      seat: isolatedSeats[0],
      relatedServiceIds: ['service-1a-passenger-1', 'service-1a-passenger-2'],
    });

    expect(getSeatSelections(state)).toEqual([
      expect.objectContaining({ intentPassengerId: 'passenger-2', segmentId: 'segment-2' }),
    ]);
  });

  test('stores a journey-wide baggage service once and removes overlapping segment coverage for the same passenger', () => {
    let state = createAncillarySelectionState({ seats: [], baggage: [] });

    state = ancillarySelectionReducer(state, {
      type: 'setBaggageQuantity',
      baggage: {
        intentPassengerId: 'passenger-1',
        serviceId: 'segment-bag-1',
        type: 'checked',
        weightValue: 20,
        weightUnit: 'kg',
        quantity: 1,
        amount: '18.00',
        currency: 'USD',
        segmentIds: ['segment-1'],
      },
      conflictingServiceIds: ['journey-bag'],
    });

    state = ancillarySelectionReducer(state, {
      type: 'setBaggageQuantity',
      baggage: {
        intentPassengerId: 'passenger-1',
        serviceId: 'journey-bag',
        type: 'checked',
        weightValue: 20,
        weightUnit: 'kg',
        quantity: 1,
        amount: '30.00',
        currency: 'USD',
        segmentIds: ['segment-1', 'segment-2'],
      },
      conflictingServiceIds: ['segment-bag-1', 'segment-bag-2'],
    });

    // User-approved correction: toHaveProperty parses JSON-string keys as paths rather than literal keys.
    expect(Object.keys(state.baggageByService)).toContain(
      JSON.stringify(['passenger-1', 'journey-bag']),
    );
    expect(Object.values(state.baggageByService)).toEqual([
      expect.objectContaining({
        serviceId: 'journey-bag',
        quantity: 1,
        segmentIds: ['segment-1', 'segment-2'],
      }),
    ]);
  });

  test('calculates base, seat, baggage, and grand totals in exact minor units', () => {
    const state = createAncillarySelectionState({
      seats: [
        {
          intentPassengerId: 'passenger-1',
          segmentId: 'segment-1',
          serviceId: 'seat-service',
          seatDesignator: '1A',
          amount: '0.10',
          currency: 'USD',
        },
      ],
      baggage: [
        {
          intentPassengerId: 'passenger-1',
          serviceId: 'bag-service',
          type: 'checked',
          weightValue: 20,
          weightUnit: 'kg',
          quantity: 1,
          amount: '0.20',
          currency: 'USD',
          segmentIds: ['segment-1', 'segment-2'],
        },
      ],
    });

    expect(calculateAncillaryTotals(state, '100.05', 'USD')).toEqual({
      base: '100.05',
      seats: '0.10',
      baggage: '0.20',
      ancillaries: '0.30',
      grand: '100.35',
      currency: 'USD',
    });
  });

  test('preserves selections across catalog refresh and flags removed or price-changed services for explicit resolution', () => {
    const state = createAncillarySelectionState({
      seats: [
        {
          intentPassengerId: 'passenger-1',
          segmentId: 'segment-1',
          serviceId: 'seat-still-valid',
          seatDesignator: '1A',
          amount: '10.00',
          currency: 'USD',
        },
        {
          intentPassengerId: 'passenger-1',
          segmentId: 'segment-2',
          serviceId: 'seat-removed',
          seatDesignator: '2A',
          amount: '12.00',
          currency: 'USD',
        },
      ],
      baggage: [
        {
          intentPassengerId: 'passenger-1',
          serviceId: 'bag-price-changed',
          type: 'checked',
          weightValue: 20,
          weightUnit: 'kg',
          quantity: 1,
          amount: '20.00',
          currency: 'USD',
          segmentIds: ['segment-1'],
        },
      ],
    });

    const refreshed = ancillarySelectionReducer(state, {
      type: 'reconcileCatalog',
      services: [
        { serviceId: 'seat-still-valid', amount: '10.00', currency: 'USD' },
        { serviceId: 'bag-price-changed', amount: '25.00', currency: 'USD' },
      ],
    });

    expect(getSeatSelections(refreshed)).toHaveLength(2);
    expect(Object.values(refreshed.baggageByService)).toHaveLength(1);
    expect(getReconciliationIssues(refreshed)).toEqual([
      { kind: 'SEAT', serviceId: 'seat-removed', reason: 'REMOVED' },
      { kind: 'BAGGAGE', serviceId: 'bag-price-changed', reason: 'CHANGED' },
    ]);
  });

  test('removes only refresh-conflicted choices after the traveller explicitly resolves them', () => {
    const state = createAncillarySelectionState({
      seats: [
        {
          intentPassengerId: 'passenger-1',
          segmentId: 'segment-1',
          serviceId: 'seat-valid',
          seatDesignator: '1A',
          amount: '10.00',
          currency: 'USD',
        },
        {
          intentPassengerId: 'passenger-1',
          segmentId: 'segment-2',
          serviceId: 'seat-removed',
          seatDesignator: '2A',
          amount: '12.00',
          currency: 'USD',
        },
      ],
      baggage: [
        {
          intentPassengerId: 'passenger-1',
          serviceId: 'bag-changed',
          type: 'checked',
          weightValue: 20,
          weightUnit: 'kg',
          quantity: 1,
          amount: '20.00',
          currency: 'USD',
          segmentIds: ['segment-1'],
        },
      ],
    });
    const refreshed = ancillarySelectionReducer(state, {
      type: 'reconcileCatalog',
      services: [
        { serviceId: 'seat-valid', amount: '10.00', currency: 'USD' },
        { serviceId: 'bag-changed', amount: '25.00', currency: 'USD' },
      ],
    });

    const resolved = ancillarySelectionReducer(refreshed, { type: 'removeFlaggedSelections' });

    expect(getSeatSelections(resolved)).toEqual([
      expect.objectContaining({ serviceId: 'seat-valid' }),
    ]);
    expect(Object.values(resolved.baggageByService)).toEqual([]);
    expect(getReconciliationIssues(resolved)).toEqual([]);
  });

  test('shows savings only when equivalent segment baggage costs more than journey-wide coverage', () => {
    const journey = {
      serviceId: 'journey',
      passengerId: 'duffel-1',
      segmentIds: ['segment-1', 'segment-2'],
      type: 'checked',
      weightValue: 20,
      weightUnit: 'kg',
      maxQuantity: 1,
      amount: '30.00',
      currency: 'USD',
    };
    const segmentServices = [
      {
        serviceId: 'segment-1-bag',
        passengerId: 'duffel-1',
        segmentIds: ['segment-1'],
        type: 'checked',
        weightValue: 20,
        weightUnit: 'kg',
        maxQuantity: 1,
        amount: '18.00',
        currency: 'USD',
      },
      {
        serviceId: 'segment-2-bag',
        passengerId: 'duffel-1',
        segmentIds: ['segment-2'],
        type: 'checked',
        weightValue: 20,
        weightUnit: 'kg',
        maxQuantity: 1,
        amount: '18.00',
        currency: 'USD',
      },
      {
        serviceId: 'wrong-tier',
        passengerId: 'duffel-1',
        segmentIds: ['segment-1'],
        type: 'checked',
        weightValue: 30,
        weightUnit: 'kg',
        maxQuantity: 1,
        amount: '1.00',
        currency: 'USD',
      },
    ];

    expect(calculateBaggageSavings(journey, segmentServices)).toBe('6.00');
    expect(calculateBaggageSavings({ ...journey, amount: '40.00' }, segmentServices)).toBeNull();
  });
});
