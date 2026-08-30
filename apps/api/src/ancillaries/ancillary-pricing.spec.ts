import type {
  NormalizedBaggageSelection,
  NormalizedSeatSelection,
} from '@shared/types/ancillary.types';
import { calculateAncillaryTotals } from './ancillary-pricing';

const seats: NormalizedSeatSelection[] = [
  {
    intentPassengerId: 'p1',
    segmentId: 's1',
    serviceId: 'seat',
    seatDesignator: '1A',
    amount: '18.10',
    currency: 'USD',
  },
];
const baggage: NormalizedBaggageSelection[] = [
  {
    intentPassengerId: 'p1',
    serviceId: 'bag',
    type: 'checked',
    weightValue: 23,
    weightUnit: 'kg',
    quantity: 2,
    amount: '30.05',
    currency: 'USD',
    segmentIds: ['s1'],
  },
];

describe('calculateAncillaryTotals', () => {
  it('adds exact decimal seat, quantity-adjusted baggage, and base amounts', () => {
    expect(
      calculateAncillaryTotals({ baseAmount: '420.15', currency: 'USD', seats, baggage }),
    ).toEqual({
      seats: '18.10',
      baggage: '60.10',
      ancillaries: '78.20',
      estimatedGrandTotal: '498.35',
      currency: 'USD',
    });
  });

  it('supports an empty ancillary selection', () => {
    expect(
      calculateAncillaryTotals({ baseAmount: '420.00', currency: 'USD', seats: [], baggage: [] }),
    ).toEqual({
      seats: '0.00',
      baggage: '0.00',
      ancillaries: '0.00',
      estimatedGrandTotal: '420.00',
      currency: 'USD',
    });
  });

  it('rejects mixed currencies', () => {
    expect(() =>
      calculateAncillaryTotals({
        baseAmount: '420.00',
        currency: 'USD',
        seats: [{ ...seats[0], currency: 'EUR' }],
        baggage: [],
      }),
    ).toThrow('currency');
  });
});
