'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Airport } from '@shared/types';
import { cn } from '@/lib/utils';
import { MapContainer } from '@/components/map/MapContainer';
import { 
  ArrowLeft, 
  Clock, 
  ShieldCheck, 
  CheckCircle2, 
  MapPin,
  Wifi,
  Tv,
  Coffee,
  BatteryCharging,
  AlertCircle
} from 'lucide-react';

type FlightSegment = {
  carrierCode: string;
  flightNumber: string;
  operatingCarrier: string;
  departureAirport: string;
  departureTerminal: string | null;
  departureTime: string;
  arrivalAirport: string;
  arrivalTerminal: string | null;
  arrivalTime: string;
  duration: number;
  aircraft: string | null;
  cabinClass?: string;
};

type Props = {
  flight: {
    id: string;
    airline: string;
    flightNumber: string;
    departureAirport: string;
    arrivalAirport: string;
    departureTime: string;
    arrivalTime: string;
    duration: number;
    stops: number;
    originalPrice: number;
    confirmedPrice: number;
    priceChanged: boolean;
    currency: string;
    fareClass: string | null;
    baggageAllowance: string | null;
    segments: FlightSegment[];
    returnSegments: FlightSegment[] | null;
    expiresAt: string;
    requestedCabinClass?: 'economy' | 'premium_economy' | 'business' | 'first';
    cabinClassMatch?: 'full' | 'mixed' | 'downgraded';
    cabinMismatchDetails?: {
      segmentIndex: number;
      leg: 'outbound' | 'return';
      expected: string;
      actual: string;
      route: string;
    }[] | null;
    conditions: {
      refundable: boolean;
      changeable: boolean;
      changeBeforeDeparture: {
        allowed: boolean;
        penaltyAmount: string | null;
        penaltyCurrency: string | null;
      } | null;
    };
  };
  allAirports: Airport[];
};

function computeLayoverDuration(arrivalStr: string, departureStr: string): string {
  const arrivalTime = new Date(arrivalStr);
  const departureTime = new Date(departureStr);
  const diffMs = departureTime.getTime() - arrivalTime.getTime();
  const diffMin = Math.max(0, Math.floor(diffMs / 60000));
  return `${Math.floor(diffMin / 60)}h ${diffMin % 60}m`;
}

type TimelineProps = {
  segments: FlightSegment[];
  allAirports: Airport[];
  formatTime: (isoString: string) => string;
  formatDate: (isoString: string) => string;
};

export function SegmentTimeline({
  segments,
  allAirports,
  formatTime,
  formatDate,
}: TimelineProps) {
  return (
    <div className="relative border-l-2 border-dashed border-card-border ml-4 pl-8 space-y-6 py-2">
      {segments.map((segment, index) => {
        const segOrigin = allAirports.find(ap => ap.iataCode === segment.departureAirport);
        const segDest = allAirports.find(ap => ap.iataCode === segment.arrivalAirport);
        const showLayover = index < segments.length - 1;
        const layoverAirport = showLayover ? allAirports.find(ap => ap.iataCode === segment.arrivalAirport) : null;
        
        const layoverDuration = showLayover && segments[index + 1]
          ? computeLayoverDuration(segment.arrivalTime, segments[index + 1].departureTime)
          : '';

        return (
          <div key={index} className="space-y-6">
            {/* Segment Departure */}
            <div className="relative">
              <div className="absolute -left-[41px] top-0.5 bg-bg-confirmed border-2 border-text-confirmed rounded-full p-1.5 z-10">
                <MapPin className="w-3.5 h-3.5 text-text-confirmed" />
              </div>
              <div>
                <span className="text-xs text-text-muted font-semibold block">
                  Departure · {formatDate(segment.departureTime)}
                </span>
                <div className="flex items-baseline gap-2 mt-0.5">
                  <span className="font-extrabold text-base text-text-primary">{formatTime(segment.departureTime)}</span>
                  <span className="font-bold text-accent">{segment.departureAirport}</span>
                  {segment.departureTerminal && (
                    <span className="text-xs text-text-muted">Terminal {segment.departureTerminal}</span>
                  )}
                </div>
                <span className="text-xs font-medium text-text-secondary block mt-0.5">
                  {segOrigin?.name || segment.departureAirport}
                </span>
                <span className="text-[10px] text-text-muted block">
                  {segOrigin?.city || ''}, {segOrigin?.country || ''}
                </span>
              </div>
            </div>

            {/* Segment Mid Info */}
            <div className="bg-background border border-card-border rounded-xl p-3 max-w-md ml-2 text-xs text-text-secondary space-y-1">
              <div className="flex justify-between">
                <span className="font-semibold text-text-primary">{segment.operatingCarrier} ({segment.carrierCode}{segment.flightNumber})</span>
                <span>Duration: {Math.floor(segment.duration / 60)}h {segment.duration % 60}m</span>
              </div>
              {segment.aircraft && (
                <div className="text-[11px] text-text-muted">Aircraft: {segment.aircraft}</div>
              )}
              {segment.cabinClass && (
                <div className="text-[11px] text-text-muted">
                  Cabin: <strong className="text-text-secondary uppercase">{segment.cabinClass.replace('_', ' ')}</strong>
                </div>
              )}
            </div>

            {/* Segment Arrival */}
            <div className="relative">
              <div className="absolute -left-[41px] top-0.5 bg-bg-cancelled border-2 border-text-cancelled rounded-full p-1.5 z-10">
                <MapPin className="w-3.5 h-3.5 text-text-cancelled" />
              </div>
              <div>
                <span className="text-xs text-text-muted font-semibold block">
                  Arrival · {formatDate(segment.arrivalTime)}
                </span>
                <div className="flex items-baseline gap-2 mt-0.5">
                  <span className="font-extrabold text-base text-text-primary">{formatTime(segment.arrivalTime)}</span>
                  <span className="font-bold text-accent">{segment.arrivalAirport}</span>
                  {segment.arrivalTerminal && (
                    <span className="text-xs text-text-muted">Terminal {segment.arrivalTerminal}</span>
                  )}
                </div>
                <span className="text-xs font-medium text-text-secondary block mt-0.5">
                  {segDest?.name || segment.arrivalAirport}
                </span>
                <span className="text-[10px] text-text-muted block">
                  {segDest?.city || ''}, {segDest?.country || ''}
                </span>
              </div>
            </div>

            {/* Layover block */}
            {showLayover && layoverAirport && (
              <div className="relative">
                <div className="absolute -left-[41px] top-0.5 bg-bg-pending border-2 border-text-pending rounded-full p-1.5 z-10">
                  <Clock className="w-3.5 h-3.5 text-text-pending" />
                </div>
                <div className="bg-bg-pending border border-text-pending/10 rounded-xl p-3 max-w-md ml-2">
                  <span className="text-xs text-text-pending font-bold block">
                    Layover in {layoverAirport.city} ({layoverAirport.iataCode})
                  </span>
                  <span className="text-[11px] text-text-secondary mt-0.5 block">
                    {layoverAirport.name}
                  </span>
                  <span className="text-xs font-semibold text-text-pending mt-1 block">
                    Duration: {layoverDuration}
                  </span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function FlightDetailPageClient({
  flight,
  allAirports
}: Props) {
  const [isBooked, setIsBooked] = useState(false);
  const [pnrCode, setPnrCode] = useState('');

  const origin = allAirports.find(ap => ap.iataCode === flight.departureAirport) || null;
  const destination = allAirports.find(ap => ap.iataCode === flight.arrivalAirport) || null;

  const handleBook = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setPnrCode(`DEMO-${code}`);
    setIsBooked(true);
  };

  // Construct stops array with layoverDuration dynamically computed
  const stops: Airport[] = [];
  if (flight.segments && flight.segments.length > 1) {
    for (let i = 0; i < flight.segments.length - 1; i++) {
      const segment = flight.segments[i];
      const nextSegment = flight.segments[i + 1];
      const connectionAirport = allAirports.find(ap => ap.iataCode === segment.arrivalAirport);
      if (connectionAirport) {
        stops.push({
          ...connectionAirport,
          layoverDuration: computeLayoverDuration(segment.arrivalTime, nextSegment.departureTime)
        } as Airport);
      }
    }
  }

  const formatTime = (isoString: string) => {
    try {
      return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return isoString;
    }
  };

  const formatDate = (isoString: string) => {
    try {
      return new Date(isoString).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    } catch {
      return isoString;
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 min-h-[calc(100vh-80px)]">
      <div className="lg:col-span-6 flex flex-col gap-6">
        <div>
          <Link 
            href="/search" 
            className="btn-secondary py-1.5 px-3 flex items-center gap-2 cursor-pointer no-underline w-fit mb-4"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Search
          </Link>
          
          <h2 className="text-2xl font-extrabold text-text-primary tracking-tight">
            Flight Details
          </h2>
          <p className="text-sm text-text-muted mt-1">
            Review your itinerary and spatial flight path before booking.
          </p>
        </div>

        {flight.priceChanged && (
          <div className="bg-bg-match-fair border border-text-match-fair/20 text-text-primary rounded-xl p-4 flex gap-2.5 items-start">
            <AlertCircle className="w-5 h-5 text-text-match-fair flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="font-bold text-sm text-text-match-fair">Price Update Notification</h4>
              <p className="text-xs text-text-secondary mt-0.5">
                The price of this flight changed since your initial search. Original price: <span className="font-bold">${flight.originalPrice.toFixed(2)}</span>. Current live confirmed price: <span className="font-extrabold text-accent">${flight.confirmedPrice.toFixed(2)}</span>.
              </p>
            </div>
          </div>
        )}

        {flight.cabinClassMatch && flight.cabinClassMatch !== 'full' && (
          <div className={cn(
            "border rounded-xl p-4 flex gap-2.5 items-start",
            flight.cabinClassMatch === 'mixed'
              ? "bg-bg-pending border-text-pending/20 text-text-primary"
              : "bg-bg-cancelled border-text-cancelled/20 text-text-primary"
          )}>
            <AlertCircle className={cn(
              "w-5 h-5 flex-shrink-0 mt-0.5",
              flight.cabinClassMatch === 'mixed' ? "text-text-pending" : "text-text-cancelled"
            )} />
            <div>
              <h4 className={cn(
                "font-bold text-sm",
                flight.cabinClassMatch === 'mixed' ? "text-text-pending" : "text-text-cancelled"
              )}>
                {flight.cabinClassMatch === 'mixed' ? 'Mixed Cabin Warning' : 'Cabin Class Downgrade Warning'}
              </h4>
              <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">
                {flight.cabinClassMatch === 'mixed'
                  ? `Some segments of your flight are in a different cabin class than the requested ${flight.requestedCabinClass?.replace('_', ' ')}.`
                  : `Your main/longest flight segment has been downgraded from your requested ${flight.requestedCabinClass?.replace('_', ' ')}.`
                }
              </p>
              {flight.cabinMismatchDetails && flight.cabinMismatchDetails.length > 0 && (
                <div className="mt-2 text-xs space-y-1 border-t border-card-border/50 pt-2 text-text-secondary">
                  {flight.cabinMismatchDetails.map((detail, idx) => (
                    <div key={idx}>
                      • Segment {detail.segmentIndex + 1} ({detail.route}) on {detail.leg} is in <strong className="text-text-cancelled uppercase">{detail.actual.replace('_', ' ')}</strong> (expected <strong className="text-text-confirmed uppercase">{detail.expected.replace('_', ' ')}</strong>).
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {isBooked ? (
          <div className="card border-text-confirmed bg-bg-confirmed text-text-primary p-6 flex flex-col items-center text-center gap-4">
            <CheckCircle2 className="w-16 h-16 text-text-confirmed" />
            <div>
              <h3 className="text-xl font-bold text-text-confirmed">Booking Preview Created</h3>
              <p className="text-sm text-text-secondary mt-1">
                This is a simulated flight itinerary preview. Please note that this is not a real booking.
              </p>
            </div>
            <div className="bg-card border border-card-border rounded-xl p-4 w-full max-w-sm mt-2 flex flex-col gap-2">
              <div className="flex justify-between text-sm">
                <span className="text-text-muted font-medium">Demo Reference:</span>
                <span className="font-extrabold text-accent">{pnrCode}</span>
              </div>
              <div className="flex justify-between text-sm border-t border-card-border pt-2">
                <span className="text-text-muted font-medium">Flight:</span>
                <span className="font-bold">{flight.airline} · {flight.flightNumber}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-text-muted font-medium">Route:</span>
                <span className="font-bold">
                  {origin?.iataCode} → {stops.length > 0 ? stops.map(s => s.iataCode).join(' → ') + ' → ' : ''}{destination?.iataCode}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="card flex flex-col gap-6">
            <div className="flex justify-between items-start">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-accent/5 flex items-center justify-center text-accent font-bold text-sm border border-accent/10">
                  {flight.airline.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <span className="text-xs text-text-muted block font-semibold">
                    {flight.airline}
                  </span>
                  <span className="font-extrabold text-lg text-text-primary">
                    {flight.flightNumber}
                  </span>
                </div>
              </div>

              <div className="flex flex-col items-end gap-1">
                <span className="text-xs font-bold px-2 py-0.5 rounded bg-bg-match-strong text-text-match-strong">
                  {flight.stops === 0 ? 'Non-stop' : `${flight.stops} Stop(s)`}
                </span>
                <span className="text-xs text-text-muted">Live Re-confirmed Price</span>
              </div>
            </div>

            {/* Outbound Timeline */}
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted mb-4">Outbound Flight Itinerary</h3>
              <SegmentTimeline
                segments={flight.segments}
                allAirports={allAirports}
                formatTime={formatTime}
                formatDate={formatDate}
              />
            </div>

            {/* Return Timeline (if present) */}
            {flight.returnSegments && flight.returnSegments.length > 0 && (
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted mb-4">Return Flight Itinerary</h3>
                <SegmentTimeline
                  segments={flight.returnSegments}
                  allAirports={allAirports}
                  formatTime={formatTime}
                  formatDate={formatDate}
                />
              </div>
            )}

            {/* Flight info details summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 border-y border-card-border py-4 my-2">
              <div>
                <span className="text-xs text-text-muted block font-medium">Total Duration</span>
                <span className="font-bold text-sm text-text-primary">{Math.floor(flight.duration / 60)}h {flight.duration % 60}m</span>
              </div>
              <div>
                <span className="text-xs text-text-muted block font-medium">Stops</span>
                <span className="font-bold text-sm text-text-primary">
                  {flight.stops === 0 ? 'Non-stop' : `${flight.stops} Stop(s)`}
                </span>
              </div>
              <div>
                <span className="text-xs text-text-muted block font-medium">Baggage</span>
                <span className="font-bold text-sm text-text-primary">{flight.baggageAllowance || 'Checked bag included'}</span>
              </div>
              <div>
                <span className="text-xs text-text-muted block font-medium">Fare Type</span>
                <span className="font-bold text-sm text-text-primary">{flight.fareClass || 'Economy Standard'}</span>
              </div>
            </div>

            {/* Fare Conditions */}
            <div className="bg-background border border-card-border rounded-xl p-4 space-y-3">
              <h4 className="font-bold text-sm text-text-primary">Fare Conditions & Rules</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="flex justify-between border-b border-card-border/50 pb-2">
                  <span className="text-text-muted font-medium">Refundable:</span>
                  <span className={flight.conditions.refundable ? "text-text-confirmed font-bold" : "text-text-cancelled font-bold"}>
                    {flight.conditions.refundable ? "Yes" : "No"}
                  </span>
                </div>
                <div className="flex justify-between border-b border-card-border/50 pb-2">
                  <span className="text-text-muted font-medium">Changeable:</span>
                  <span className={flight.conditions.changeable ? "text-text-confirmed font-bold" : "text-text-cancelled font-bold"}>
                    {flight.conditions.changeable ? "Yes" : "No"}
                  </span>
                </div>
                {flight.conditions.changeBeforeDeparture && (
                  <div className="flex justify-between col-span-1 md:col-span-2">
                    <span className="text-text-muted font-medium">Change Penalty (Before Departure):</span>
                    <span className="font-bold text-text-primary">
                      {flight.conditions.changeBeforeDeparture.allowed
                        ? flight.conditions.changeBeforeDeparture.penaltyAmount
                          ? `${flight.conditions.changeBeforeDeparture.penaltyAmount} ${flight.conditions.changeBeforeDeparture.penaltyCurrency}`
                          : "No Penalty"
                        : "Not Allowed"}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Amenities Section */}
            <div>
              <h4 className="font-bold text-sm text-text-primary mb-3">Onboard Amenities</h4>
              <div className="grid grid-cols-2 gap-3 text-xs text-text-secondary">
                <div className="flex items-center gap-2">
                  <Wifi className="w-4 h-4 text-accent" />
                  <span>High-Speed Wi-Fi</span>
                </div>
                <div className="flex items-center gap-2">
                  <Tv className="w-4 h-4 text-accent" />
                  <span>Seatback Entertainment</span>
                </div>
                <div className="flex items-center gap-2">
                  <Coffee className="w-4 h-4 text-accent" />
                  <span>Complimentary Meals & Drinks</span>
                </div>
                <div className="flex items-center gap-2">
                  <BatteryCharging className="w-4 h-4 text-accent" />
                  <span>In-Seat USB & Power Outlets</span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-card-border pt-4 mt-2">
              <div>
                <span className="text-xs text-text-muted block font-medium">Total Fare (1 Adult)</span>
                <span className="text-2xl font-extrabold text-accent">
                  ${flight.confirmedPrice.toFixed(2)}
                </span>
              </div>
              <button 
                onClick={handleBook}
                className="btn-primary py-2.5 px-6 font-bold cursor-pointer text-sm"
              >
                Preview Booking
              </button>
            </div>
          </div>
        )}
        
        <div className="card bg-accent/5 border-accent/15 p-4 flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 text-accent mt-0.5 flex-shrink-0" />
          <div>
            <h5 className="font-bold text-xs text-accent">Simulated Itinerary Preview</h5>
            <p className="text-[11px] text-text-secondary mt-0.5 leading-relaxed">
              This page demonstrates the layout and routing map for the flight details page. No actual booking, ticket confirmation, or payment transactions are processed.
            </p>
          </div>
        </div>
      </div>

      <div className="lg:col-span-6 h-[calc(100vh-140px)] min-h-[450px] lg:sticky lg:top-20">
        <MapContainer
          origin={origin}
          destination={destination}
          stops={stops}
          allAirports={allAirports}
          preview={false}
        />
      </div>
    </div>
  );
}
