'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { AncillaryBaggageService, AncillaryRowElement, AncillarySeatService } from '@shared/types/ancillary.types';
import type { AncillaryCatalogPayload } from '@/lib/checkout';

type ServiceView = 'seats' | 'baggage';
type SeatChoice = { intentPassengerId: string; segmentId: string; serviceId: string; seatDesignator: string };
type BaggageChoice = { intentPassengerId: string; serviceId: string; quantity: number };
type SeatTier = 'standard' | 'preferred' | 'extraLegroom' | 'premium';

type Props = {
  data: AncillaryCatalogPayload;
  intentId: string;
  accessToken: string;
  // Kept for the checkout route's flight-context handoff; the catalog is authoritative here.
  intent?: unknown;
};

const tierClasses: Record<SeatTier, string> = {
  standard: 'seat-tier-standard',
  preferred: 'seat-tier-preferred',
  extraLegroom: 'seat-tier-extra-legroom',
  premium: 'seat-tier-premium',
};

function money(amount: string | number, currency: string): string {
  const value = Number(amount);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0);
}

function priceKey(service: { amount: string; currency: string }): string {
  return `${service.currency}:${service.amount}`;
}

function seatKey(selection: Pick<SeatChoice, 'intentPassengerId' | 'segmentId'>): string {
  return `${selection.intentPassengerId}:${selection.segmentId}`;
}

function seatTier(service: AncillarySeatService, orderedPrices: string[]): SeatTier {
  const index = Math.max(0, orderedPrices.indexOf(priceKey(service)));
  return (['standard', 'preferred', 'extraLegroom', 'premium'] as SeatTier[])[index % 4];
}

function isSeat(element: AncillaryRowElement): boolean {
  return element.type === 'seat' && Boolean(element.designator);
}

function makeIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `ancillary-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function AncillarySelectionClient({ data, intentId, accessToken }: Props): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const service = searchParams.get('service') === 'baggage' ? 'baggage' : 'seats';
  const seatEligiblePassengers = data.passengers.filter((passenger) => passenger.seatEligible);
  const [activePassengerId, setActivePassengerId] = useState(seatEligiblePassengers[0]?.intentPassengerId ?? data.passengers[0]?.intentPassengerId ?? '');
  const [activeSegmentId, setActiveSegmentId] = useState(data.catalog.segments[0]?.segmentId ?? '');
  const [seats, setSeats] = useState<SeatChoice[]>(data.selection.seats.map((seat) => ({ intentPassengerId: seat.intentPassengerId, segmentId: seat.segmentId, serviceId: seat.serviceId, seatDesignator: seat.seatDesignator })));
  const [baggage, setBaggage] = useState<BaggageChoice[]>(data.selection.baggage.map((bag) => ({ intentPassengerId: bag.intentPassengerId, serviceId: bag.serviceId, quantity: bag.quantity })));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commitKeyRef = useRef<string | null>(null);

  const activePassenger = data.passengers.find((passenger) => passenger.intentPassengerId === activePassengerId) ?? data.passengers[0];
  const activeSegment = data.catalog.segments.find((segment) => segment.segmentId === activeSegmentId) ?? data.catalog.segments[0];
  const allSeatServices = useMemo(() => data.catalog.segments.flatMap((segment) => segment.seatMap?.cabins.flatMap((cabin) => cabin.rows.flatMap((row) => row.elements.flatMap((element) => element.availableServices ?? []))) ?? []), [data.catalog.segments]);
  const allBaggageServices = data.catalog.baggageServices;
  const seatPrices = useMemo(() => Array.from(new Map(allSeatServices.map((item) => [priceKey(item), item])).values()).sort((a, b) => Number(a.amount) - Number(b.amount)), [allSeatServices]);
  const selectedSeat = seats.find((seat) => seatKey(seat) === seatKey({ intentPassengerId: activePassengerId, segmentId: activeSegmentId }));

  const total = useMemo(() => {
    const seatsTotal = seats.reduce((sum, choice) => sum + Number(allSeatServices.find((serviceItem) => serviceItem.serviceId === choice.serviceId)?.amount ?? 0), 0);
    const baggageTotal = baggage.reduce((sum, choice) => sum + Number(allBaggageServices.find((serviceItem) => serviceItem.serviceId === choice.serviceId)?.amount ?? 0) * choice.quantity, 0);
    return { seats: seatsTotal, baggage: baggageTotal, ancillaries: seatsTotal + baggageTotal, grand: Number(data.baseAmount ?? 0) + seatsTotal + baggageTotal };
  }, [allBaggageServices, allSeatServices, baggage, data.baseAmount, seats]);

  const setView = (next: ServiceView): void => {
    const query = new URLSearchParams(searchParams.toString());
    query.set('service', next);
    router.replace(`/checkout/${intentId}/ancillaries?${query.toString()}`);
  };

  const resetCommitKey = (): void => { commitKeyRef.current = null; };

  const selectSeat = (element: AncillaryRowElement): void => {
    if (!activePassenger || !activeSegment || !element.designator || element.restricted) return;
    const serviceForPassenger = element.availableServices?.find((item) => item.passengerId === activePassenger.duffelPassengerId);
    if (!serviceForPassenger) return;
    resetCommitKey();
    setError(null);
    setSeats((current) => [...current.filter((item) => seatKey(item) !== seatKey({ intentPassengerId: activePassenger.intentPassengerId, segmentId: activeSegment.segmentId })), { intentPassengerId: activePassenger.intentPassengerId, segmentId: activeSegment.segmentId, serviceId: serviceForPassenger.serviceId, seatDesignator: element.designator! }]);
  };

  const setBaggageQuantity = (item: AncillaryBaggageService, quantity: number): void => {
    if (!activePassenger) return;
    resetCommitKey();
    setError(null);
    setBaggage((current) => {
      const conflicts = new Set(allBaggageServices.filter((candidate) => candidate.serviceId !== item.serviceId && candidate.type.toUpperCase() === item.type.toUpperCase() && candidate.weightValue === item.weightValue && candidate.weightUnit?.toUpperCase() === item.weightUnit?.toUpperCase() && candidate.segmentIds.some((segmentId) => item.segmentIds.includes(segmentId))).map((candidate) => candidate.serviceId));
      const remaining = current.filter((choice) => !(choice.intentPassengerId === activePassenger.intentPassengerId && (choice.serviceId === item.serviceId || (quantity > 0 && conflicts.has(choice.serviceId)))));
      return quantity > 0 ? [...remaining, { intentPassengerId: activePassenger.intentPassengerId, serviceId: item.serviceId, quantity }] : remaining;
    });
  };

  const commit = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    const idempotencyKey = commitKeyRef.current ?? makeIdempotencyKey();
    commitKeyRef.current = idempotencyKey;
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/api/bookings/intent/${intentId}/ancillaries`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ expectedVersion: data.selectionVersion, catalogFingerprint: data.catalog.fingerprint, seats: seats.map(({ intentPassengerId, segmentId, serviceId }) => ({ intentPassengerId, segmentId, serviceId })), baggage }),
      });
      if (!response.ok) {
        const details = await response.json().catch(() => null) as { code?: string; message?: string } | null;
        if (response.status === 409 || details?.code === 'ANCILLARY_VERSION_CONFLICT' || details?.code === 'ANCILLARY_SELECTION_STALE') {
          throw new Error('Your choices were updated in another session or are no longer available. Refresh the choices, then try again.');
        }
        throw new Error(details?.message || 'We could not save your ancillary choices. Please try again.');
      }
      router.push(`/checkout/${intentId}/review`);
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : 'We could not save your ancillary choices. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const selectableBags = allBaggageServices.filter((item) => item.passengerId === activePassenger?.duffelPassengerId);

  return <div className="space-y-6">
    <header className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Step 2 of 4 · Tailor your journey</p>
      <h1 className="text-3xl font-bold text-text-primary">Your flight extras</h1>
      <p className="max-w-2xl text-text-secondary">Seats and baggage are separate views, so you can decide one thing at a time.</p>
    </header>

    {error && <div role="alert" className="card bg-bg-cancelled text-text-cancelled p-4"><p className="font-semibold">Your changes were not saved</p><p className="mt-1 text-sm">{error}</p>{error.includes('Refresh') && <button type="button" onClick={() => router.refresh()} className="btn-secondary mt-3">Refresh choices</button>}</div>}

    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="space-y-6">
        <nav className="flex w-full gap-1 rounded-xl border border-card-border bg-card p-1 sm:w-fit" aria-label="Ancillary service">
          {(['seats', 'baggage'] as const).map((item) => <button key={item} type="button" onClick={() => setView(item)} className={`flex-1 rounded-lg px-5 py-3 text-sm font-semibold transition sm:flex-none ${service === item ? 'bg-primary text-primary-foreground shadow-sm' : 'text-text-secondary hover:bg-background'}`} aria-current={service === item ? 'page' : undefined}>{item === 'seats' ? 'Seats' : 'Baggage'}</button>)}
        </nav>

        <section className="card space-y-5" aria-label="Traveller and flight selection">
          <div><h2 className="font-semibold text-text-primary">Choose for a traveller</h2><p className="mt-1 text-sm text-text-secondary">Seat availability and baggage options are shown for the selected traveller.</p></div>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Travellers">
            {data.passengers.map((passenger) => <button key={passenger.intentPassengerId} type="button" role="tab" aria-selected={passenger.intentPassengerId === activePassenger?.intentPassengerId} onClick={() => { setActivePassengerId(passenger.intentPassengerId); setError(null); }} className={`rounded-lg border px-4 py-2 text-sm font-semibold ${passenger.intentPassengerId === activePassenger?.intentPassengerId ? 'border-primary bg-secondary text-text-primary' : 'border-card-border text-text-secondary hover:border-primary'}`}>{passenger.displayName}{!passenger.seatEligible && service === 'seats' ? ' · seat unavailable' : ''}</button>)}
          </div>
          {service === 'seats' && <div className="flex flex-wrap gap-2" role="tablist" aria-label="Flight segments">{data.catalog.segments.map((segment) => <button key={segment.segmentId} type="button" role="tab" aria-selected={segment.segmentId === activeSegment?.segmentId} onClick={() => { setActiveSegmentId(segment.segmentId); setError(null); }} className={`rounded-lg border px-4 py-2 text-sm font-semibold ${segment.segmentId === activeSegment?.segmentId ? 'border-primary bg-secondary text-text-primary' : 'border-card-border text-text-secondary hover:border-primary'}`}>{segment.origin} → {segment.destination}</button>)}</div>}
        </section>

        {service === 'seats' ? <SeatMap segment={activeSegment} passenger={activePassenger} selected={selectedSeat} seatPrices={seatPrices} onSelect={selectSeat} currency={data.currency ?? data.selection.totals.currency} /> : <BaggageOptions services={selectableBags} passengerId={activePassenger?.intentPassengerId ?? ''} selected={baggage} onQuantityChange={setBaggageQuantity} currency={data.currency ?? data.selection.totals.currency} />}
      </div>

      <aside className="card h-fit space-y-4 lg:sticky lg:top-6" aria-label="Estimated total">
        <div><p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Your estimate</p><p className="mt-1 text-2xl font-bold text-text-primary">{money(total.grand, data.currency ?? data.selection.totals.currency)}</p></div>
        <dl className="space-y-2 border-t border-card-border pt-4 text-sm text-text-secondary"><div className="flex justify-between gap-4"><dt>Flight</dt><dd>{money(data.baseAmount ?? 0, data.currency ?? data.selection.totals.currency)}</dd></div><div className="flex justify-between gap-4"><dt>Seats</dt><dd>{money(total.seats, data.currency ?? data.selection.totals.currency)}</dd></div><div className="flex justify-between gap-4"><dt>Baggage</dt><dd>{money(total.baggage, data.currency ?? data.selection.totals.currency)}</dd></div></dl>
        <button type="button" onClick={commit} disabled={submitting} className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-60">{submitting ? 'Saving choices…' : 'Continue to review'}</button>
        <p className="text-xs text-text-muted">Your selection is checked against current airline availability before it is saved.</p>
      </aside>
    </div>
  </div>;
}

function SeatMap({ segment, passenger, selected, seatPrices, onSelect, currency }: { segment: AncillaryCatalogPayload['catalog']['segments'][number] | undefined; passenger: AncillaryCatalogPayload['passengers'][number] | undefined; selected: SeatChoice | undefined; seatPrices: AncillarySeatService[]; onSelect: (element: AncillaryRowElement) => void; currency: string }): JSX.Element {
  if (!passenger?.seatEligible) return <section className="card" role="status"><h2 className="text-xl font-bold text-text-primary">Seat selection is unavailable</h2><p className="mt-2 text-sm text-text-secondary">This traveller is not eligible for a seat selection on this journey.</p></section>;
  if (!segment?.seatMapAvailable || !segment.seatMap) return <section className="card" role="status"><h2 className="text-xl font-bold text-text-primary">Seats will be assigned by the airline</h2><p className="mt-2 text-sm text-text-secondary">A seat map is not available for this flight segment.</p></section>;
  return <section className="card space-y-6" aria-labelledby="seat-map-title">
    <div><p className="text-xs font-semibold uppercase tracking-wider text-text-muted">{segment.origin} → {segment.destination}</p><h2 id="seat-map-title" className="mt-1 text-2xl font-bold text-text-primary">Choose a seat for {passenger.displayName}</h2><p className="mt-2 text-sm text-text-secondary">Seat colours indicate price bands; each price is listed below.</p></div>
    <section className="rounded-2xl border border-card-border bg-background p-4" aria-labelledby="seat-price-guide-title"><div className="flex flex-wrap items-center justify-between gap-2"><h3 id="seat-price-guide-title" className="font-semibold text-text-primary">Seat price guide</h3><span className="text-xs text-text-muted">{currency} per traveller</span></div><ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{seatPrices.slice(0, 4).map((item, index) => { const tier = seatTier(item, seatPrices.map(priceKey)); const labels = ['Standard', 'Preferred', 'Extra legroom', 'Front cabin']; return <li key={priceKey(item)} className="flex items-center gap-3 text-sm"><span className={`h-8 w-8 rounded-lg border ${tierClasses[tier]}`} aria-hidden="true" /><span><span className="block font-semibold text-text-primary">{labels[index]} · {money(item.amount, item.currency)}</span><span className="block text-xs text-text-secondary">Supplier fare for this seat type</span></span></li>; })}<li className="flex items-center gap-3 text-sm"><span className="seat-tier-unavailable flex h-8 w-8 items-center justify-center rounded-lg border" aria-hidden="true">×</span><span><span className="block font-semibold text-text-primary">Unavailable</span><span className="block text-xs text-text-secondary">Not selectable</span></span></li></ul></section>
    <div className="overflow-x-auto rounded-[2rem] border border-card-border bg-background p-5"><div className="mx-auto min-w-[31rem] max-w-3xl space-y-3" role="grid" aria-label={`Seat map from ${segment.origin} to ${segment.destination}`}>{segment.seatMap.cabins.flatMap((cabin) => cabin.rows).map((row) => <div key={row.rowNumber} className="flex items-center gap-2" role="row"><span className="w-8 text-xs font-semibold text-text-muted">{row.rowNumber}</span>{row.elements.map((element, index) => { if (!isSeat(element)) return <span key={`${row.rowNumber}-${index}`} className={`flex h-11 w-11 items-center justify-center text-xs text-text-muted ${element.type === 'aisle' ? 'mx-2' : ''}`} aria-hidden="true">{element.type === 'aisle' ? '|' : ''}</span>; const available = !element.restricted && Boolean(element.availableServices?.some((item) => item.passengerId === passenger.duffelPassengerId)); const ownService = element.availableServices?.find((item) => item.passengerId === passenger.duffelPassengerId); const chosen = selected?.serviceId === ownService?.serviceId; const tier = ownService ? seatTier(ownService, seatPrices.map(priceKey)) : 'standard'; return <button key={element.designator} type="button" role="gridcell" disabled={!available} onClick={() => onSelect(element)} aria-pressed={chosen} aria-label={`${element.designator}, ${available && ownService ? money(ownService.amount, ownService.currency) : 'unavailable'}${chosen ? ', selected' : ''}`} className={`relative flex h-11 w-11 items-center justify-center rounded-lg border text-xs font-bold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${available ? tierClasses[tier] : 'seat-tier-unavailable cursor-not-allowed'} ${chosen ? 'ring-4 ring-primary ring-offset-2 ring-offset-background' : ''}`}>{chosen ? '✓' : available ? element.designator?.slice(-1) : '×'}</button>; })}</div>)}</div></div>
    <p className="text-xs text-text-secondary">✓ selected · × unavailable. Seats remain identifiable with labels and symbols, not colour alone.</p>
  </section>;
}

function BaggageOptions({ services, passengerId, selected, onQuantityChange, currency }: { services: AncillaryBaggageService[]; passengerId: string; selected: BaggageChoice[]; onQuantityChange: (service: AncillaryBaggageService, quantity: number) => void; currency: string }): JSX.Element {
  if (!services.length) return <section className="card" role="status"><h2 className="text-xl font-bold text-text-primary">No extra baggage is available</h2><p className="mt-2 text-sm text-text-secondary">The airline has not offered additional baggage for this traveller.</p></section>;
  return <section className="space-y-5" aria-labelledby="baggage-title"><div><p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Your journey</p><h2 id="baggage-title" className="mt-1 text-2xl font-bold text-text-primary">Extra baggage</h2><p className="mt-2 text-sm text-text-secondary">Add bags only where the airline offers them. Prices come directly from the current catalog.</p></div>{services.map((item) => { const quantity = selected.find((choice) => choice.intentPassengerId === passengerId && choice.serviceId === item.serviceId)?.quantity ?? 0; const label = `${item.type.replace('_', ' ')}${item.weightValue ? ` · ${item.weightValue} ${item.weightUnit ?? ''}` : ''}`; return <article key={item.serviceId} className={`card flex flex-wrap items-center justify-between gap-4 ${quantity ? 'border-primary ring-1 ring-primary' : ''}`}><div><h3 className="font-bold capitalize text-text-primary">{label}</h3><p className="mt-1 text-sm text-text-secondary">{money(item.amount, item.currency)} each · applies to {item.segmentIds.length > 1 ? 'selected flight segments' : 'one flight segment'}</p></div><label className="flex items-center gap-2 text-sm font-semibold text-text-primary">Quantity<select value={quantity} onChange={(event) => onQuantityChange(item, Number(event.target.value))} className="rounded-lg border border-card-border bg-background px-3 py-2 text-text-primary"><option value={0}>0</option>{Array.from({ length: item.maxQuantity }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}</select></label></article>; })}<p className="rounded-xl border border-card-border bg-background p-4 text-sm text-text-secondary"><span className="font-semibold text-text-primary">Baggage availability is supplier-controlled.</span> Your final selection is verified before checkout.</p></section>;
}
