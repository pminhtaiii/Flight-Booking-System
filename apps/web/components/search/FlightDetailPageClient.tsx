'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Airport } from '@shared/types';
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
  BatteryCharging
} from 'lucide-react';

type Props = {
  flight: {
    id: string;
    airline: string;
    flightNumber: string;
    departureTime: string;
    arrivalTime: string;
    duration: string;
    stops: number;
    price: number;
    layoverAirport?: string;
    layoverDuration?: string;
    matchScore: number;
    matchGrade: string;
    matchClass: string;
  };
  origin: Airport | null;
  destination: Airport | null;
  layover: Airport | null;
  allAirports: Airport[];
};

export function FlightDetailPageClient({
  flight,
  origin,
  destination,
  layover,
  allAirports
}: Props) {
  const [isBooked, setIsBooked] = useState(false);
  const [pnrCode, setPnrCode] = useState('');

  const handleBook = () => {
    // Generate a mock PNR code
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setPnrCode(`DEMO-${code}`);
    setIsBooked(true);
  };

  // Construct stops array with layoverDuration attached
  const stops = layover
    ? [{ ...layover, layoverDuration: flight.layoverDuration }]
    : [];

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
                  {origin?.iataCode} → {layover ? `${layover.iataCode} → ` : ''}{destination?.iataCode}
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
                <span className={`text-xs font-bold px-2 py-0.5 rounded ${flight.matchClass}`}>
                  {flight.matchScore}% Match · {flight.matchGrade}
                </span>
                <span className="text-xs text-text-muted">Personalized Recommendation</span>
              </div>
            </div>

            {/* Timeline Segment */}
            <div className="relative border-l-2 border-dashed border-card-border ml-4 pl-8 space-y-8 py-2">
              {/* Origin Stop */}
              <div className="relative">
                <div className="absolute -left-[41px] top-0.5 bg-bg-confirmed border-2 border-text-confirmed rounded-full p-1.5 z-10">
                  <MapPin className="w-3.5 h-3.5 text-text-confirmed" />
                </div>
                <div>
                  <span className="text-xs text-text-muted font-semibold block">Departure</span>
                  <div className="flex items-baseline gap-2 mt-0.5">
                    <span className="font-extrabold text-base text-text-primary">{flight.departureTime}</span>
                    <span className="font-bold text-accent">{origin?.iataCode}</span>
                  </div>
                  <span className="text-sm font-medium text-text-secondary block mt-0.5">
                    {origin?.name}
                  </span>
                  <span className="text-xs text-text-muted">
                    {origin?.city}, {origin?.country}
                  </span>
                </div>
              </div>

              {/* Layover Stop if applicable */}
              {layover && (
                <div className="relative">
                  <div className="absolute -left-[41px] top-0.5 bg-bg-pending border-2 border-text-pending rounded-full p-1.5 z-10">
                    <Clock className="w-3.5 h-3.5 text-text-pending" />
                  </div>
                  <div className="bg-bg-pending border border-text-pending/10 rounded-xl p-3 max-w-md">
                    <span className="text-xs text-text-pending font-bold block">
                      Layover in {layover.city} ({layover.iataCode})
                    </span>
                    <span className="text-xs text-text-secondary mt-0.5 block">
                      {layover.name}
                    </span>
                    <span className="text-xs font-semibold text-text-pending mt-1 block">
                      Duration: {flight.layoverDuration}
                    </span>
                  </div>
                </div>
              )}

              {/* Destination Stop */}
              <div className="relative">
                <div className="absolute -left-[41px] top-0.5 bg-bg-cancelled border-2 border-text-cancelled rounded-full p-1.5 z-10">
                  <MapPin className="w-3.5 h-3.5 text-text-cancelled" />
                </div>
                <div>
                  <span className="text-xs text-text-muted font-semibold block">Arrival</span>
                  <div className="flex items-baseline gap-2 mt-0.5">
                    <span className="font-extrabold text-base text-text-primary">{flight.arrivalTime}</span>
                    <span className="font-bold text-accent">{destination?.iataCode}</span>
                  </div>
                  <span className="text-sm font-medium text-text-secondary block mt-0.5">
                    {destination?.name}
                  </span>
                  <span className="text-xs text-text-muted">
                    {destination?.city}, {destination?.country}
                  </span>
                </div>
              </div>
            </div>

            {/* Flight info details summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 border-y border-card-border py-4 my-2">
              <div>
                <span className="text-xs text-text-muted block font-medium">Flight Duration</span>
                <span className="font-bold text-sm text-text-primary">{flight.duration}</span>
              </div>
              <div>
                <span className="text-xs text-text-muted block font-medium">Stops</span>
                <span className="font-bold text-sm text-text-primary">
                  {flight.stops === 0 ? 'Non-stop' : `${flight.stops} Stop`}
                </span>
              </div>
              <div>
                <span className="text-xs text-text-muted block font-medium">Baggage</span>
                <span className="font-bold text-sm text-text-primary">23kg Included</span>
              </div>
              <div>
                <span className="text-xs text-text-muted block font-medium">Fare Type</span>
                <span className="font-bold text-sm text-text-primary">Economy Standard</span>
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
                <span className="text-2xl font-extrabold text-accent">${flight.price}</span>
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
