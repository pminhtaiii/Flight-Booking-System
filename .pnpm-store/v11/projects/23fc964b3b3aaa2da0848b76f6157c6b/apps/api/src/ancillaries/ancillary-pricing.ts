import type {
  AncillaryTotals,
  NormalizedBaggageSelection,
  NormalizedSeatSelection,
} from '@shared/types/ancillary.types';

type PricingInput = {
  baseAmount: string;
  currency: string;
  seats: NormalizedSeatSelection[];
  baggage: NormalizedBaggageSelection[];
};

const parseCents = (amount: string): bigint => {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) {
    throw new Error(`Invalid ancillary amount: ${amount}`);
  }
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
};

const formatCents = (amount: bigint): string => {
  const whole = amount / 100n;
  const fractional = (amount % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${fractional}`;
};

const assertCurrency = (currency: string, expectedCurrency: string): void => {
  if (currency !== expectedCurrency) {
    throw new Error('Ancillary currency does not match the offer currency.');
  }
};

export const calculateAncillaryTotals = (input: PricingInput): AncillaryTotals => {
  let seatTotal = 0n;
  for (const selection of input.seats) {
    assertCurrency(selection.currency, input.currency);
    seatTotal += parseCents(selection.amount);
  }

  let baggageTotal = 0n;
  for (const selection of input.baggage) {
    assertCurrency(selection.currency, input.currency);
    baggageTotal += parseCents(selection.amount) * BigInt(selection.quantity);
  }

  const ancillaryTotal = seatTotal + baggageTotal;
  return {
    seats: formatCents(seatTotal),
    baggage: formatCents(baggageTotal),
    ancillaries: formatCents(ancillaryTotal),
    estimatedGrandTotal: formatCents(parseCents(input.baseAmount) + ancillaryTotal),
    currency: input.currency,
  };
};
