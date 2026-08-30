'use client';

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type {
  AncillaryBaggageService,
  AncillaryRowElement,
  AncillarySeatService,
  CommitAncillarySelectionResponse,
  NormalizedBaggageSelection,
  NormalizedSeatSelection,
} from '@shared/types/ancillary.types';
import type { AncillaryCatalogPayload } from '@/lib/checkout';
import {
  ancillarySelectionReducer,
  calculateAncillaryTotals,
  calculateBaggageSavings,
  createAncillarySelectionState,
  getBaggageSelections,
  getReconciliationIssues,
  getSeatSelections,
} from '@/lib/ancillary-selection';
import { writeAncillaryRecovery } from '@/lib/ancillary-recovery';

type ServiceView = 'seats' | 'baggage';
type SeatChoice = NormalizedSeatSelection;
type BaggageChoice = NormalizedBaggageSelection;
type SeatTier =
  | 'standard'
  | 'economy'
  | 'economyPreferred'
  | 'premiumEconomy'
  | 'business'
  | 'first';

type Props = {
  data: AncillaryCatalogPayload;
  intentId: string;
  accessToken: string;
};

const tierClasses: Record<SeatTier, string> = {
  standard: 'border-match-bar-fair bg-match-bar-fair text-primary-foreground',
  economy: 'border-match-bar-fair bg-match-bar-fair text-primary-foreground',
  economyPreferred: 'border-text-match-fair bg-text-match-fair text-primary-foreground',
  premiumEconomy: 'border-match-bar-strong bg-match-bar-strong text-primary-foreground',
  business: 'border-text-confirmed bg-text-confirmed text-primary-foreground',
  first: 'border-match-bar-weak bg-match-bar-weak text-primary-foreground',
};

function money(amount: string | number, currency: string): string {
  const value = Number(amount);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function priceKey(service: { amount: string; currency: string }): string {
  return `${service.currency}:${service.amount}`;
}

function seatTier(service: AncillarySeatService, orderedPrices: string[]): SeatTier {
  const index = Math.max(0, orderedPrices.indexOf(priceKey(service)));
  return (['economy', 'economyPreferred', 'premiumEconomy', 'business', 'first'] as SeatTier[])[
    index % 5
  ];
}

function isSeat(element: AncillaryRowElement): boolean {
  return element.type === 'seat' && Boolean(element.designator);
}

function makeIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ancillary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function baggageServicesConflict(
  left: AncillaryBaggageService,
  right: AncillaryBaggageService,
): boolean {
  return (
    left.serviceId !== right.serviceId &&
    left.type.toLowerCase() === right.type.toLowerCase() &&
    left.weightValue === right.weightValue &&
    left.weightUnit?.toLowerCase() === right.weightUnit?.toLowerCase() &&
    left.segmentIds.some((segmentId) => right.segmentIds.includes(segmentId))
  );
}

function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = Array.from(
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
  );
  const index = tabs.indexOf(event.currentTarget);
  if (index < 0 || tabs.length === 0) return;
  event.preventDefault();
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[nextIndex].focus();
  tabs[nextIndex].click();
}

export function AncillarySelectionClient({ data, intentId, accessToken }: Props): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const service = searchParams.get('service') === 'baggage' ? 'baggage' : 'seats';
  const [catalogData, setCatalogData] = useState(data);
  const seatEligiblePassengers = catalogData.passengers.filter(
    (passenger) => passenger.seatEligible,
  );
  const visiblePassengers = service === 'seats' ? seatEligiblePassengers : catalogData.passengers;
  const [activePassengerId, setActivePassengerId] = useState(
    seatEligiblePassengers[0]?.intentPassengerId ?? data.passengers[0]?.intentPassengerId ?? '',
  );
  const [activeSegmentId, setActiveSegmentId] = useState(data.catalog.segments[0]?.segmentId ?? '');
  const [selectionState, dispatch] = useReducer(
    ancillarySelectionReducer,
    data.selection,
    createAncillarySelectionState,
  );
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commitKeyRef = useRef<string | null>(null);
  const submittingRef = useRef(false);

  const activePassenger =
    visiblePassengers.find((passenger) => passenger.intentPassengerId === activePassengerId) ??
    visiblePassengers[0];
  const activeSegment =
    catalogData.catalog.segments.find((segment) => segment.segmentId === activeSegmentId) ??
    catalogData.catalog.segments[0];
  const allSeatServices = useMemo(
    () =>
      catalogData.catalog.segments.flatMap(
        (segment) =>
          segment.seatMap?.cabins.flatMap((cabin) =>
            cabin.rows.flatMap((row) =>
              row.elements.flatMap((element) => element.availableServices ?? []),
            ),
          ) ?? [],
      ),
    [catalogData.catalog.segments],
  );
  const allBaggageServices = catalogData.catalog.baggageServices;
  const seatPrices = useMemo(
    () =>
      Array.from(new Map(allSeatServices.map((item) => [priceKey(item), item])).values()).sort(
        (a, b) => Number(a.amount) - Number(b.amount),
      ),
    [allSeatServices],
  );
  const seats = getSeatSelections(selectionState);
  const baggage = getBaggageSelections(selectionState);
  const reconciliationIssues = getReconciliationIssues(selectionState);
  const currency = catalogData.currency ?? catalogData.selection.totals.currency;
  const selectedSeat = seats.find(
    (seat) => seat.intentPassengerId === activePassengerId && seat.segmentId === activeSegmentId,
  );
  const total = useMemo(
    () => calculateAncillaryTotals(selectionState, catalogData.baseAmount ?? '0.00', currency),
    [catalogData.baseAmount, currency, selectionState],
  );

  const setView = (next: ServiceView): void => {
    if (
      next === 'seats' &&
      !seatEligiblePassengers.some((passenger) => passenger.intentPassengerId === activePassengerId)
    ) {
      setActivePassengerId(seatEligiblePassengers[0]?.intentPassengerId ?? '');
    }
    const query = new URLSearchParams(searchParams.toString());
    query.set('service', next);
    router.replace(`/checkout/${intentId}/ancillaries?${query.toString()}`);
  };

  const resetCommitKey = (): void => {
    commitKeyRef.current = null;
  };

  const selectSeat = (element: AncillaryRowElement): void => {
    if (!activePassenger || !activeSegment || !element.designator || element.restricted) return;
    const serviceForPassenger = element.availableServices?.find(
      (item) => item.passengerId === activePassenger.duffelPassengerId,
    );
    if (!serviceForPassenger) return;
    resetCommitKey();
    setError(null);
    dispatch({
      type: 'toggleSeat',
      seat: {
        intentPassengerId: activePassenger.intentPassengerId,
        segmentId: activeSegment.segmentId,
        serviceId: serviceForPassenger.serviceId,
        seatDesignator: element.designator,
        amount: serviceForPassenger.amount,
        currency: serviceForPassenger.currency,
      },
      relatedServiceIds: element.availableServices?.map((item) => item.serviceId) ?? [],
    });
  };

  const setBaggageQuantity = (item: AncillaryBaggageService, quantity: number): void => {
    if (!activePassenger) return;
    resetCommitKey();
    setError(null);
    dispatch({
      type: 'setBaggageQuantity',
      baggage: {
        intentPassengerId: activePassenger.intentPassengerId,
        serviceId: item.serviceId,
        type: item.type,
        weightValue: item.weightValue,
        weightUnit: item.weightUnit,
        quantity,
        amount: item.amount,
        currency: item.currency,
        segmentIds: item.segmentIds,
      },
      conflictingServiceIds: allBaggageServices
        .filter((candidate) => baggageServicesConflict(item, candidate))
        .map((candidate) => candidate.serviceId),
    });
  };

  const refreshCatalog = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/bookings/intent/${intentId}/ancillaries?refresh=true`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (!response.ok)
        throw new Error('We could not refresh the airline choices. Please try again.');
      const refreshed = (await response.json()) as AncillaryCatalogPayload;
      const refreshedSeatServices = refreshed.catalog.segments.flatMap(
        (segment) =>
          segment.seatMap?.cabins.flatMap((cabin) =>
            cabin.rows.flatMap((row) =>
              row.elements.flatMap((element) => element.availableServices ?? []),
            ),
          ) ?? [],
      );
      setCatalogData(refreshed);
      dispatch({
        type: 'reconcileCatalog',
        services: [...refreshedSeatServices, ...refreshed.catalog.baggageServices],
      });
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : 'We could not refresh the airline choices. Please try again.',
      );
    } finally {
      setRefreshing(false);
    }
  };

  const commit = async (): Promise<void> => {
    if (submittingRef.current) return;
    if (reconciliationIssues.length > 0) {
      setError('Resolve the refreshed seat or baggage changes before continuing.');
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    const idempotencyKey = commitKeyRef.current ?? makeIdempotencyKey();
    commitKeyRef.current = idempotencyKey;
    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/bookings/intent/${intentId}/ancillaries`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({
            expectedVersion: catalogData.selectionVersion,
            catalogFingerprint: catalogData.catalog.fingerprint,
            seats: seats.map(({ intentPassengerId, segmentId, serviceId }) => ({
              intentPassengerId,
              segmentId,
              serviceId,
            })),
            baggage: baggage.map(({ intentPassengerId, serviceId, quantity }) => ({
              intentPassengerId,
              serviceId,
              quantity,
            })),
          }),
        },
      );
      if (!response.ok) {
        const details = (await response.json().catch(() => null)) as {
          code?: string;
          message?: string;
        } | null;
        if (
          response.status === 409 ||
          details?.code === 'ANCILLARY_VERSION_CONFLICT' ||
          details?.code === 'ANCILLARY_SELECTION_STALE'
        ) {
          throw new Error(
            'Your choices were updated in another session or are no longer available. Refresh the choices, then try again.',
          );
        }
        throw new Error(
          details?.message || 'We could not save your ancillary choices. Please try again.',
        );
      }
      const committed = (await response.json()) as CommitAncillarySelectionResponse;
      try {
        writeAncillaryRecovery(window.localStorage, {
          intentId,
          selectionId: committed.selectionId,
          selectionVersion: committed.selectionVersion,
          intentExpiresAt: committed.intentExpiresAt,
          updatedAt: new Date().toISOString(),
          seats: seats.map(({ intentPassengerId, segmentId, serviceId, seatDesignator }) => ({
            intentPassengerId,
            segmentId,
            serviceId,
            seatDesignator,
          })),
          baggage: baggage.map(({ intentPassengerId, serviceId, quantity }) => ({
            intentPassengerId,
            serviceId,
            quantity,
          })),
        });
      } catch {
        /* Recovery storage is best-effort; the server commit already succeeded. */
      }
      router.push(`/checkout/${intentId}/review`);
    } catch (commitError) {
      setError(
        commitError instanceof Error
          ? commitError.message
          : 'We could not save your ancillary choices. Please try again.',
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const selectableBags = allBaggageServices.filter(
    (item) => item.passengerId === activePassenger?.duffelPassengerId,
  );

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Step 2 of 4 · Tailor your journey
          </p>
          <h1 className="text-3xl font-bold text-text-primary">Your flight extras</h1>
          <p className="max-w-2xl text-text-secondary">
            Seats and baggage are separate views, so you can decide one thing at a time.
          </p>
        </div>
        <button
          type="button"
          onClick={refreshCatalog}
          disabled={refreshing}
          className="btn-secondary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {refreshing ? 'Refreshing choices…' : 'Refresh airline choices'}
        </button>
      </header>

      {error && (
        <div role="alert" className="card bg-bg-cancelled text-text-cancelled p-4">
          <p className="font-semibold">Your changes were not saved</p>
          <p className="mt-1 text-sm">{error}</p>
          {error.toLowerCase().includes('refresh') && (
            <button type="button" onClick={refreshCatalog} className="btn-secondary mt-3">
              Refresh choices
            </button>
          )}
        </div>
      )}
      {reconciliationIssues.length > 0 && (
        <div role="alert" className="card bg-bg-pending p-4 text-text-pending">
          <p className="font-semibold">Review refreshed choices</p>
          <p className="mt-1 text-sm">
            {reconciliationIssues.length} saved choice{reconciliationIssues.length === 1 ? '' : 's'}{' '}
            changed or disappeared. Nothing was substituted automatically.
          </p>
          <button
            type="button"
            onClick={() => dispatch({ type: 'removeFlaggedSelections' })}
            className="btn-secondary mt-3"
          >
            Remove affected choices
          </button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="space-y-6">
          <nav
            className="flex w-full gap-1 rounded-xl border border-card-border bg-card p-1 sm:w-fit"
            aria-label="Ancillary service"
          >
            {(['seats', 'baggage'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setView(item)}
                className={`flex-1 rounded-lg px-5 py-3 text-sm font-semibold transition sm:flex-none ${service === item ? 'bg-primary text-primary-foreground shadow-sm' : 'text-text-secondary hover:bg-background'}`}
                aria-current={service === item ? 'page' : undefined}
              >
                {item === 'seats' ? 'Seats' : 'Baggage'}
              </button>
            ))}
          </nav>

          <section className="card space-y-5" aria-label="Traveller and flight selection">
            <div>
              <h2 className="font-semibold text-text-primary">Choose for a traveller</h2>
              <p className="mt-1 text-sm text-text-secondary">
                Seat availability and baggage options are shown for the selected traveller.
              </p>
            </div>
            {service === 'seats' && (
              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Flight segments">
                {catalogData.catalog.segments.map((segment) => (
                  <button
                    key={segment.segmentId}
                    type="button"
                    role="tab"
                    aria-selected={segment.segmentId === activeSegment?.segmentId}
                    tabIndex={segment.segmentId === activeSegment?.segmentId ? 0 : -1}
                    onKeyDown={handleTabKeyDown}
                    onClick={() => {
                      setActiveSegmentId(segment.segmentId);
                      setError(null);
                    }}
                    className={`rounded-lg border px-4 py-2 text-sm font-semibold ${segment.segmentId === activeSegment?.segmentId ? 'border-primary bg-secondary text-text-primary' : 'border-card-border text-text-secondary hover:border-primary'}`}
                  >
                    {segment.origin} → {segment.destination}
                  </button>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Travellers">
              {visiblePassengers.map((passenger) => (
                <button
                  key={passenger.intentPassengerId}
                  type="button"
                  role="tab"
                  aria-selected={passenger.intentPassengerId === activePassenger?.intentPassengerId}
                  tabIndex={
                    passenger.intentPassengerId === activePassenger?.intentPassengerId ? 0 : -1
                  }
                  onKeyDown={handleTabKeyDown}
                  onClick={() => {
                    setActivePassengerId(passenger.intentPassengerId);
                    setError(null);
                  }}
                  className={`rounded-lg border px-4 py-2 text-sm font-semibold ${passenger.intentPassengerId === activePassenger?.intentPassengerId ? 'border-primary bg-secondary text-text-primary' : 'border-card-border text-text-secondary hover:border-primary'}`}
                >
                  {passenger.displayName}
                </button>
              ))}
            </div>
            {service === 'seats' &&
              seatEligiblePassengers.length < catalogData.passengers.length && (
                <p className="text-sm text-text-secondary">
                  Lap infants are omitted because they do not have a separate seat entitlement.
                </p>
              )}
          </section>

          {service === 'seats' ? (
            <SeatMap
              segment={activeSegment}
              passenger={activePassenger}
              passengers={catalogData.passengers}
              selections={seats}
              selected={selectedSeat}
              seatPrices={seatPrices}
              onSelect={selectSeat}
              currency={currency}
            />
          ) : (
            <BaggageOptions
              services={selectableBags}
              passengerId={activePassenger?.intentPassengerId ?? ''}
              selected={baggage}
              onQuantityChange={setBaggageQuantity}
            />
          )}
        </div>

        <aside className="card h-fit space-y-4 lg:sticky lg:top-6" aria-label="Estimated total">
          <div aria-live="polite" aria-atomic="true">
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
              Your estimate
            </p>
            <p className="mt-1 text-2xl font-bold text-text-primary">
              {money(total.grand, currency)}
            </p>
            <span className="sr-only">
              Estimated total updated to {money(total.grand, currency)}
            </span>
          </div>
          <dl className="space-y-2 border-t border-card-border pt-4 text-sm text-text-secondary">
            <div className="flex justify-between gap-4">
              <dt>Flight</dt>
              <dd>{money(total.base, currency)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Seats</dt>
              <dd>{money(total.seats, currency)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Baggage</dt>
              <dd>{money(total.baggage, currency)}</dd>
            </div>
          </dl>
          <button
            type="button"
            onClick={commit}
            disabled={submitting || reconciliationIssues.length > 0}
            className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Saving choices…' : 'Continue to review'}
          </button>
          <p className="text-xs text-text-muted">
            Your selection is checked against current airline availability before it is saved.
          </p>
        </aside>
      </div>
    </div>
  );
}

function SeatMap({
  segment,
  passenger,
  passengers,
  selections,
  selected,
  seatPrices,
  onSelect,
  currency,
}: {
  segment: AncillaryCatalogPayload['catalog']['segments'][number] | undefined;
  passenger: AncillaryCatalogPayload['passengers'][number] | undefined;
  passengers: AncillaryCatalogPayload['passengers'];
  selections: SeatChoice[];
  selected: SeatChoice | undefined;
  seatPrices: AncillarySeatService[];
  onSelect: (element: AncillaryRowElement) => void;
  currency: string;
}): JSX.Element {
  const gridRef = useRef<HTMLDivElement>(null);
  const scopeKey = `${segment?.segmentId ?? 'none'}:${passenger?.intentPassengerId ?? 'none'}`;
  const previousScopeRef = useRef(scopeKey);
  const [rovingServiceId, setRovingServiceId] = useState<string | null>(
    selected?.serviceId ?? null,
  );

  useEffect(() => {
    if (previousScopeRef.current === scopeKey) return;
    previousScopeRef.current = scopeKey;
    setRovingServiceId(selected?.serviceId ?? null);
    window.requestAnimationFrame(() => {
      const cells = Array.from(
        gridRef.current?.querySelectorAll<HTMLButtonElement>('[role="gridcell"]:not([disabled])') ??
          [],
      );
      const target =
        cells.find((cell) => cell.dataset.seatServiceId === selected?.serviceId) ?? cells[0];
      target?.focus();
    });
  }, [scopeKey, selected?.serviceId]);

  if (!passenger?.seatEligible) {
    return (
      <section className="card" role="status">
        <h2 className="text-xl font-bold text-text-primary">Seat selection is unavailable</h2>
        <p className="mt-2 text-sm text-text-secondary">
          This traveller is not eligible for a seat selection on this journey.
        </p>
      </section>
    );
  }
  if (!segment?.seatMapAvailable || !segment.seatMap) {
    return (
      <section className="card" role="status">
        <h2 className="text-xl font-bold text-text-primary">
          Seats will be assigned by the airline
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          A seat map is not available for this flight segment.
        </p>
      </section>
    );
  }

  const rows = segment.seatMap.cabins.flatMap((cabin) => cabin.rows);
  const columnElements = rows[0]?.elements ?? [];
  const priceKeys = seatPrices.map(priceKey);
  const activePassengerNumber =
    passengers.findIndex((item) => item.intentPassengerId === passenger.intentPassengerId) + 1;
  const firstAvailableServiceId = rows
    .flatMap((row) => row.elements)
    .flatMap((element) => element.availableServices ?? [])
    .find((item) => item.passengerId === passenger.duffelPassengerId)?.serviceId;
  const activeRovingServiceId = rovingServiceId ?? selected?.serviceId ?? firstAvailableServiceId;

  const handleSeatKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const cells = Array.from(
      gridRef.current?.querySelectorAll<HTMLButtonElement>('[role="gridcell"]:not([disabled])') ??
        [],
    );
    const row = Number(event.currentTarget.dataset.seatRow);
    const column = Number(event.currentTarget.dataset.seatColumn);
    const candidates = cells.filter((cell) => {
      const candidateRow = Number(cell.dataset.seatRow);
      const candidateColumn = Number(cell.dataset.seatColumn);
      if (event.key === 'ArrowLeft') return candidateRow === row && candidateColumn < column;
      if (event.key === 'ArrowRight') return candidateRow === row && candidateColumn > column;
      if (event.key === 'ArrowUp') return candidateColumn === column && candidateRow < row;
      return candidateColumn === column && candidateRow > row;
    });
    const next = candidates.sort((left, right) => {
      const leftDistance =
        Math.abs(Number(left.dataset.seatRow) - row) +
        Math.abs(Number(left.dataset.seatColumn) - column);
      const rightDistance =
        Math.abs(Number(right.dataset.seatRow) - row) +
        Math.abs(Number(right.dataset.seatColumn) - column);
      return leftDistance - rightDistance;
    })[0];
    if (!next) return;
    event.preventDefault();
    setRovingServiceId(next.dataset.seatServiceId ?? null);
    next.focus();
  };

  return (
    <section className="card space-y-6" aria-labelledby="seat-map-title">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          {segment.origin} → {segment.destination}
        </p>
        <h2 id="seat-map-title" className="mt-1 text-2xl font-bold text-text-primary">
          Choose a seat for {passenger.displayName}
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          Seat colours indicate price bands; each price is listed below.
        </p>
      </div>

      <section
        className="rounded-2xl border border-card-border bg-background p-4"
        aria-labelledby="seat-price-guide-title"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="seat-price-guide-title" className="font-semibold text-text-primary">
            Seat price guide
          </h3>
          <span className="text-xs text-text-muted">{currency} per traveller</span>
        </div>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {seatPrices.slice(0, 5).map((item, index) => {
            const tier = seatTier(item, priceKeys);
            const labels = ['Economy', 'Economy Preferred', 'Premium Economy', 'Business', 'First'];
            return (
              <li key={priceKey(item)} className="flex items-center gap-3 text-sm">
                <span
                  className={`h-9 w-9 rounded-lg border ${tierClasses[tier]}`}
                  aria-hidden="true"
                />
                <span>
                  <span className="block font-semibold text-text-primary">
                    {labels[index]} · {money(item.amount, item.currency)}
                  </span>
                  <span className="block text-xs text-text-secondary">Supplier fare</span>
                </span>
              </li>
            );
          })}
          <li className="flex items-center gap-3 text-sm">
            <span
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-text-secondary/30 bg-text-secondary/40 text-primary-foreground"
              aria-hidden="true"
            >
              ×
            </span>
            <span>
              <span className="block font-semibold text-text-primary">Unavailable</span>
              <span className="block text-xs text-text-secondary">Not selectable</span>
            </span>
          </li>
        </ul>
      </section>

      <div className="overflow-x-auto rounded-[2rem] border border-card-border bg-background p-5 sm:p-7">
        <div
          ref={gridRef}
          className="mx-auto w-fit min-w-max space-y-3"
          role="grid"
          aria-label={`Seat map from ${segment.origin} to ${segment.destination}`}
        >
          <div className="flex items-center gap-2" role="row" aria-label="Seat columns">
            {columnElements.map((element, index) =>
              isSeat(element) ? (
                <span
                  key={`column-${index}`}
                  className="w-11 text-center text-sm font-bold text-text-primary"
                  role="columnheader"
                >
                  {element.designator?.slice(-1)}
                </span>
              ) : (
                <span
                  key={`column-${index}`}
                  className={element.type === 'aisle' ? 'mx-2 w-20' : 'w-11'}
                  aria-hidden="true"
                />
              ),
            )}
          </div>

          {rows.map((row) => (
            <div key={row.rowNumber} className="flex items-center gap-2" role="row">
              {row.elements.map((element, index) => {
                if (!isSeat(element)) {
                  return (
                    <span
                      key={`${row.rowNumber}-${index}`}
                      className={`flex h-11 items-center justify-center text-sm font-bold text-text-primary ${element.type === 'aisle' ? 'mx-2 w-20' : 'w-11'}`}
                      aria-hidden="true"
                    >
                      {element.type === 'aisle' ? row.rowNumber : ''}
                    </span>
                  );
                }

                const ownService = element.availableServices?.find(
                  (item) => item.passengerId === passenger.duffelPassengerId,
                );
                const relatedServiceIds =
                  element.availableServices?.map((item) => item.serviceId) ?? [];
                const selectedByOther = selections.find(
                  (choice) =>
                    choice.segmentId === segment.segmentId &&
                    choice.intentPassengerId !== passenger.intentPassengerId &&
                    relatedServiceIds.includes(choice.serviceId),
                );
                const selectedByOtherNumber = selectedByOther
                  ? passengers.findIndex(
                      (item) => item.intentPassengerId === selectedByOther.intentPassengerId,
                    ) + 1
                  : null;
                const chosen = selected?.serviceId === ownService?.serviceId;
                const available = !element.restricted && Boolean(ownService) && !selectedByOther;
                const tier = ownService ? seatTier(ownService, priceKeys) : 'standard';
                const state = chosen
                  ? `selected for ${passenger.displayName}`
                  : selectedByOther
                    ? `selected by traveller ${selectedByOtherNumber}`
                    : available
                      ? 'available'
                      : 'unavailable';

                return (
                  <button
                    key={element.designator}
                    type="button"
                    role="gridcell"
                    disabled={!available && !chosen}
                    tabIndex={ownService?.serviceId === activeRovingServiceId ? 0 : -1}
                    data-seat-row={row.rowNumber}
                    data-seat-column={index}
                    data-seat-service-id={ownService?.serviceId}
                    onKeyDown={handleSeatKeyDown}
                    onClick={() => {
                      setRovingServiceId(ownService?.serviceId ?? null);
                      onSelect(element);
                    }}
                    aria-selected={chosen}
                    aria-label={`${element.designator}, ${ownService ? money(ownService.amount, ownService.currency) : 'unavailable'}, ${state}`}
                    className={`relative flex h-11 w-11 items-center justify-center overflow-visible rounded-lg border text-xs font-bold shadow-sm transition motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${available || chosen ? tierClasses[tier] : 'cursor-not-allowed border-text-secondary/30 bg-text-secondary/40 text-primary-foreground'}`}
                  >
                    {chosen && ownService ? (
                      <>
                        <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-card-border bg-card px-2 py-1 text-xs font-semibold text-text-primary shadow-lg">
                          {money(ownService.amount, ownService.currency)}
                        </span>
                        <span
                          className="flex h-7 min-w-7 items-center justify-center rounded-md bg-text-secondary/80 px-2 text-primary-foreground shadow-sm"
                          aria-hidden="true"
                        >
                          {activePassengerNumber}
                        </span>
                      </>
                    ) : selectedByOtherNumber ? (
                      <span
                        className="flex h-7 min-w-7 items-center justify-center rounded-md bg-text-secondary/80 px-2 text-primary-foreground shadow-sm"
                        aria-hidden="true"
                      >
                        {selectedByOtherNumber}
                      </span>
                    ) : available ? null : (
                      '×'
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <p className="text-xs text-text-secondary">
        Column letters sit above the seats; row numbers sit in the aisle. Passenger numbers mark
        selected seats and the active selection shows its price · × unavailable.
      </p>
    </section>
  );
}

function BaggageOptions({
  services,
  passengerId,
  selected,
  onQuantityChange,
}: {
  services: AncillaryBaggageService[];
  passengerId: string;
  selected: BaggageChoice[];
  onQuantityChange: (service: AncillaryBaggageService, quantity: number) => void;
}): JSX.Element {
  if (!services.length)
    return (
      <section className="card" role="status">
        <h2 className="text-xl font-bold text-text-primary">No extra baggage is available</h2>
        <p className="mt-2 text-sm text-text-secondary">
          The airline has not offered additional baggage for this traveller.
        </p>
      </section>
    );
  const selectedServices = selected
    .filter((choice) => choice.intentPassengerId === passengerId && choice.quantity > 0)
    .flatMap((choice) => services.filter((item) => item.serviceId === choice.serviceId));
  const groups = [
    { title: 'Full journey', services: services.filter((item) => item.segmentIds.length > 1) },
    {
      title: 'This flight only',
      services: services.filter((item) => item.segmentIds.length === 1),
    },
  ].filter((group) => group.services.length > 0);

  return (
    <section className="space-y-5" aria-labelledby="baggage-title">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          Your journey
        </p>
        <h2 id="baggage-title" className="mt-1 text-2xl font-bold text-text-primary">
          Extra baggage
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          Add bags only where the airline offers them. Prices come directly from the current
          catalog.
        </p>
      </div>
      {groups.map((group) => (
        <section
          key={group.title}
          className="space-y-3"
          aria-labelledby={`baggage-${group.title.replaceAll(' ', '-').toLowerCase()}`}
        >
          <h3
            id={`baggage-${group.title.replaceAll(' ', '-').toLowerCase()}`}
            className="text-lg font-bold text-text-primary"
          >
            {group.title}
          </h3>
          {group.services.map((item) => {
            const quantity =
              selected.find(
                (choice) =>
                  choice.intentPassengerId === passengerId && choice.serviceId === item.serviceId,
              )?.quantity ?? 0;
            const conflictingSelection = selectedServices.find((selectedService) =>
              baggageServicesConflict(item, selectedService),
            );
            const blocked = quantity === 0 && Boolean(conflictingSelection);
            const label = `${item.type.replace('_', ' ')}${item.weightValue ? ` · ${item.weightValue} ${item.weightUnit ?? ''}` : ''}`;
            const savings =
              item.segmentIds.length > 1 ? calculateBaggageSavings(item, services) : null;
            return (
              <article
                key={item.serviceId}
                className={`card flex flex-wrap items-center justify-between gap-4 ${quantity ? 'border-primary ring-1 ring-primary' : ''}`}
              >
                <div>
                  <h4 className="font-bold capitalize text-text-primary">{label}</h4>
                  <p className="mt-1 text-sm text-text-secondary">
                    {money(item.amount, item.currency)} each · applies to{' '}
                    {item.segmentIds.length > 1 ? 'the full journey' : 'one flight segment'}
                    {savings ? ` · Save ${money(savings, item.currency)}` : ''}
                  </p>
                  {blocked && (
                    <p className="mt-1 text-sm font-semibold text-text-pending">
                      Remove the overlapping{' '}
                      {conflictingSelection?.segmentIds.length === 1
                        ? 'flight-only'
                        : 'full-journey'}{' '}
                      choice first.
                    </p>
                  )}
                </div>
                <label className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  Quantity
                  <select
                    aria-label={`${label} quantity`}
                    value={quantity}
                    disabled={blocked}
                    onChange={(event) => onQuantityChange(item, Number(event.target.value))}
                    className="rounded-lg border border-card-border bg-background px-3 py-2 text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <option value={0}>0</option>
                    {Array.from({ length: item.maxQuantity }, (_, index) => index + 1).map(
                      (value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              </article>
            );
          })}
        </section>
      ))}
      <p className="rounded-xl border border-card-border bg-background p-4 text-sm text-text-secondary">
        <span className="font-semibold text-text-primary">
          Baggage availability is supplier-controlled.
        </span>{' '}
        Journey-wide and flight-only choices with overlapping coverage cannot be combined.
      </p>
    </section>
  );
}
