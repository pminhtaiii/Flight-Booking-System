import type {
  AncillaryBaggageService,
  NormalizedBaggageSelection,
  NormalizedSeatSelection,
} from '@shared/types/ancillary.types';

type AncillarySelectionHydration = {
  seats: NormalizedSeatSelection[];
  baggage: NormalizedBaggageSelection[];
};

export type AncillarySelectionState = {
  seatsByScope: Record<string, NormalizedSeatSelection>;
  baggageByService: Record<string, NormalizedBaggageSelection>;
  reconciliationIssues: AncillaryReconciliationIssue[];
};

export type AncillaryReconciliationIssue = {
  kind: 'SEAT' | 'BAGGAGE';
  serviceId: string;
  reason: 'REMOVED' | 'CHANGED';
};

type RefreshedService = {
  serviceId: string;
  amount: string;
  currency: string;
};

export type AncillaryCalculatedTotals = {
  base: string;
  seats: string;
  baggage: string;
  ancillaries: string;
  grand: string;
  currency: string;
};

export type AncillarySelectionAction =
  | {
      type: 'toggleSeat';
      seat: NormalizedSeatSelection;
      relatedServiceIds: string[];
    }
  | {
      type: 'setBaggageQuantity';
      baggage: NormalizedBaggageSelection;
      conflictingServiceIds: string[];
    }
  | {
      type: 'reconcileCatalog';
      services: RefreshedService[];
    }
  | {
      type: 'removeFlaggedSelections';
    };

function seatScopeKey(
  selection: Pick<NormalizedSeatSelection, 'segmentId' | 'intentPassengerId'>,
): string {
  return JSON.stringify([selection.segmentId, selection.intentPassengerId]);
}

function baggageServiceKey(
  selection: Pick<NormalizedBaggageSelection, 'intentPassengerId' | 'serviceId'>,
): string {
  return JSON.stringify([selection.intentPassengerId, selection.serviceId]);
}

export function createAncillarySelectionState(
  hydration: AncillarySelectionHydration,
): AncillarySelectionState {
  return {
    seatsByScope: Object.fromEntries(hydration.seats.map((seat) => [seatScopeKey(seat), seat])),
    baggageByService: Object.fromEntries(
      hydration.baggage.map((bag) => [baggageServiceKey(bag), bag]),
    ),
    reconciliationIssues: [],
  };
}

export function ancillarySelectionReducer(
  state: AncillarySelectionState,
  action: AncillarySelectionAction,
): AncillarySelectionState {
  if (action.type === 'removeFlaggedSelections') {
    const flaggedIds = new Set(state.reconciliationIssues.map((issue) => issue.serviceId));
    return {
      seatsByScope: Object.fromEntries(
        Object.entries(state.seatsByScope).filter(([, seat]) => !flaggedIds.has(seat.serviceId)),
      ),
      baggageByService: Object.fromEntries(
        Object.entries(state.baggageByService).filter(
          ([, baggage]) => !flaggedIds.has(baggage.serviceId),
        ),
      ),
      reconciliationIssues: [],
    };
  }

  if (action.type === 'reconcileCatalog') {
    const services = new Map(action.services.map((service) => [service.serviceId, service]));
    const issuesFor = (
      kind: AncillaryReconciliationIssue['kind'],
      selections: Array<NormalizedSeatSelection | NormalizedBaggageSelection>,
    ): AncillaryReconciliationIssue[] =>
      selections.flatMap<AncillaryReconciliationIssue>((selection) => {
        const service = services.get(selection.serviceId);
        if (!service) {
          return [{ kind, serviceId: selection.serviceId, reason: 'REMOVED' as const }];
        }
        if (service.amount !== selection.amount || service.currency !== selection.currency) {
          return [{ kind, serviceId: selection.serviceId, reason: 'CHANGED' as const }];
        }
        return [];
      });

    return {
      ...state,
      reconciliationIssues: [
        ...issuesFor('SEAT', getSeatSelections(state)),
        ...issuesFor('BAGGAGE', getBaggageSelections(state)),
      ],
    };
  }

  if (action.type === 'setBaggageQuantity') {
    const baggageByService = Object.fromEntries(
      Object.entries(state.baggageByService).filter(
        ([, baggage]) =>
          !(
            baggage.intentPassengerId === action.baggage.intentPassengerId &&
            (baggage.serviceId === action.baggage.serviceId ||
              action.conflictingServiceIds.includes(baggage.serviceId))
          ),
      ),
    );

    if (action.baggage.quantity > 0) {
      baggageByService[baggageServiceKey(action.baggage)] = action.baggage;
    }

    return { ...state, baggageByService };
  }

  const scopeKey = seatScopeKey(action.seat);
  const currentSeat = state.seatsByScope[scopeKey];

  if (currentSeat?.serviceId === action.seat.serviceId) {
    const seatsByScope = { ...state.seatsByScope };
    delete seatsByScope[scopeKey];
    return { ...state, seatsByScope };
  }

  const selectedByGroup = Object.values(state.seatsByScope).some(
    (seat) =>
      seat.intentPassengerId !== action.seat.intentPassengerId &&
      action.relatedServiceIds.includes(seat.serviceId),
  );

  if (selectedByGroup) {
    return state;
  }

  return {
    ...state,
    seatsByScope: {
      ...state.seatsByScope,
      [scopeKey]: action.seat,
    },
  };
}

export function getSeatSelections(state: AncillarySelectionState): NormalizedSeatSelection[] {
  return Object.values(state.seatsByScope);
}

export function getBaggageSelections(state: AncillarySelectionState): NormalizedBaggageSelection[] {
  return Object.values(state.baggageByService);
}

export function getReconciliationIssues(
  state: AncillarySelectionState,
): AncillaryReconciliationIssue[] {
  return state.reconciliationIssues;
}

function decimalToMinor(amount: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) {
    throw new Error(`Invalid two-decimal amount: ${amount}`);
  }

  const minor = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`Amount exceeds safe minor-unit range: ${amount}`);
  }
  return minor;
}

function minorToDecimal(minor: number): string {
  const absolute = Math.abs(minor);
  const sign = minor < 0 ? '-' : '';
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

function hasEquivalentBaggageTier(
  left: AncillaryBaggageService,
  right: AncillaryBaggageService,
): boolean {
  return (
    left.passengerId === right.passengerId &&
    left.type.toLowerCase() === right.type.toLowerCase() &&
    left.weightValue === right.weightValue &&
    left.weightUnit?.toLowerCase() === right.weightUnit?.toLowerCase() &&
    left.currency === right.currency
  );
}

export function calculateBaggageSavings(
  journeyService: AncillaryBaggageService,
  candidateServices: AncillaryBaggageService[],
): string | null {
  if (journeyService.segmentIds.length < 2) {
    return null;
  }

  const segmentPrices = journeyService.segmentIds.map(
    (segmentId) =>
      candidateServices
        .filter(
          (candidate) =>
            candidate.segmentIds.length === 1 &&
            candidate.segmentIds[0] === segmentId &&
            hasEquivalentBaggageTier(journeyService, candidate),
        )
        .map((candidate) => decimalToMinor(candidate.amount))
        .sort((left, right) => left - right)[0],
  );

  if (segmentPrices.some((price) => price === undefined)) {
    return null;
  }

  const separateMinor = segmentPrices.reduce((total, price) => total + price, 0);
  const savingsMinor = separateMinor - decimalToMinor(journeyService.amount);
  return savingsMinor > 0 ? minorToDecimal(savingsMinor) : null;
}

export function calculateAncillaryTotals(
  state: AncillarySelectionState,
  baseAmount: string,
  currency: string,
): AncillaryCalculatedTotals {
  const seats = getSeatSelections(state);
  const baggage = getBaggageSelections(state);
  const mismatched = [...seats, ...baggage].find((selection) => selection.currency !== currency);
  if (mismatched) {
    throw new Error(`Ancillary currency ${mismatched.currency} does not match ${currency}`);
  }

  const baseMinor = decimalToMinor(baseAmount);
  const seatMinor = seats.reduce((total, seat) => total + decimalToMinor(seat.amount), 0);
  const baggageMinor = baggage.reduce(
    (total, bag) => total + decimalToMinor(bag.amount) * bag.quantity,
    0,
  );
  const ancillaryMinor = seatMinor + baggageMinor;

  return {
    base: minorToDecimal(baseMinor),
    seats: minorToDecimal(seatMinor),
    baggage: minorToDecimal(baggageMinor),
    ancillaries: minorToDecimal(ancillaryMinor),
    grand: minorToDecimal(baseMinor + ancillaryMinor),
    currency,
  };
}
