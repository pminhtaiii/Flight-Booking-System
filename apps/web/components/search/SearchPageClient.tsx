/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import Link from 'next/link';
import { Airport } from '@shared/types';
import { MapContainer } from '@/components/map/MapContainer';
import { Search, Calendar, Users, PlaneTakeoff, PlaneLanding, Info } from 'lucide-react';

const EMPTY_STOPS: Airport[] = [];

type Props = {
  allAirports: Airport[];
};

export function SearchPageClient({ allAirports }: Props) {
  const originRef = useRef<HTMLDivElement>(null);
  const destRef = useRef<HTMLDivElement>(null);

  const [originInput, setOriginInput] = useState('');
  const [destInput, setDestInput] = useState('');
  const [departDate, setDepartDate] = useState('2026-07-10');
  const [passengers, setPassengers] = useState(1);

  const [selectedOrigin, setSelectedOrigin] = useState<Airport | null>(null);
  const [selectedDest, setSelectedDest] = useState<Airport | null>(null);

  const [mapOrigin, setMapOrigin] = useState<Airport | null>(null);
  const [mapDest, setMapDest] = useState<Airport | null>(null);

  const [showOriginDropdown, setShowOriginDropdown] = useState(false);
  const [showDestDropdown, setShowDestDropdown] = useState(false);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (originRef.current && !originRef.current.contains(event.target as Node)) {
        setShowOriginDropdown(false);
      }
      if (destRef.current && !destRef.current.contains(event.target as Node)) {
        setShowDestDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const [hasSearched, setHasSearched] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);

  const originSuggestions = useMemo(() => {
    if (originInput.length < 2) return [];
    const term = originInput.toLowerCase();
    return allAirports
      .filter(
        (ap) =>
          ap.iataCode.toLowerCase().includes(term) ||
          ap.name.toLowerCase().includes(term) ||
          ap.city.toLowerCase().includes(term)
      )
      .slice(0, 5);
  }, [originInput, allAirports]);

  const destSuggestions = useMemo(() => {
    if (destInput.length < 2) return [];
    const term = destInput.toLowerCase();
    return allAirports
      .filter(
        (ap) =>
          ap.iataCode.toLowerCase().includes(term) ||
          ap.name.toLowerCase().includes(term) ||
          ap.city.toLowerCase().includes(term)
      )
      .slice(0, 5);
  }, [destInput, allAirports]);

  const handleSelectOrigin = (ap: Airport) => {
    setSelectedOrigin(ap);
    setOriginInput(`${ap.iataCode} - ${ap.name}`);
    setShowOriginDropdown(false);
    setMapOrigin(ap);
  };

  const handleSelectDest = (ap: Airport) => {
    setSelectedDest(ap);
    setDestInput(`${ap.iataCode} - ${ap.name}`);
    setShowDestDropdown(false);
    setMapDest(ap);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrigin || !selectedDest) return;

    setIsSearching(true);
    setMapOrigin(selectedOrigin);
    setMapDest(selectedDest);

    setTimeout(() => {
      const mockRoutes = [
        {
          id: 'FL-101',
          airline: 'SkyLink Express',
          flightNumber: 'SL101',
          departureTime: '08:00 AM',
          arrivalTime: '12:30 PM',
          duration: '4h 30m',
          stops: 0,
          price: 340,
          matchScore: 92,
          matchGrade: 'Strong Match',
          matchClass: 'bg-bg-match-strong text-text-match-strong',
        },
        {
          id: 'FL-202',
          airline: 'Pacific Airways',
          flightNumber: 'PA202',
          departureTime: '11:15 AM',
          arrivalTime: '06:45 PM',
          duration: '7h 30m',
          stops: 1,
          layoverAirport: 'ICN',
          price: 280,
          matchScore: 84,
          matchGrade: 'Fair Match',
          matchClass: 'bg-bg-match-fair text-text-match-fair',
        },
        {
          id: 'FL-303',
          airline: 'Global Connect',
          flightNumber: 'GC303',
          departureTime: '09:30 PM',
          arrivalTime: '05:00 AM',
          duration: '7h 30m',
          stops: 1,
          layoverAirport: 'TPE',
          price: 220,
          matchScore: 68,
          matchGrade: 'Weak Match',
          matchClass: 'bg-bg-match-weak text-text-match-weak',
        },
      ];

      setSearchResults(mockRoutes);
      setIsSearching(false);
      setHasSearched(true);
    }, 800);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 min-h-[calc(100vh-80px)]">
      <div className="lg:col-span-6 flex flex-col gap-6">
        <div className="card">
          <h3 className="text-xl font-bold text-text-primary mb-4 flex items-center gap-2">
            Search Flights
          </h3>

          <form onSubmit={handleSearch} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 relative">
              <div ref={originRef} className="relative">
                <label className="block text-xs font-semibold text-text-secondary mb-1">Origin</label>
                <div className="relative">
                  <PlaneTakeoff className="absolute left-3 top-3 w-4 h-4 text-text-muted" />
                  <input
                    type="text"
                    value={originInput}
                    onChange={(e) => {
                      setOriginInput(e.target.value);
                      setSelectedOrigin(null);
                      setMapOrigin(null);
                      setShowOriginDropdown(true);
                    }}
                    onFocus={() => setShowOriginDropdown(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setShowOriginDropdown(false);
                      }
                    }}
                    placeholder="Enter city or airport code"
                    className="form-input w-full pl-10"
                    required
                  />
                </div>

                {showOriginDropdown && originSuggestions.length > 0 && (
                  <div className="absolute left-0 right-0 mt-1 bg-card border border-card-border rounded-lg shadow-lg z-30 max-h-48 overflow-y-auto">
                    {originSuggestions.map((ap) => (
                      <button
                        key={ap.iataCode}
                        type="button"
                        onClick={() => handleSelectOrigin(ap)}
                        className="w-full text-left px-4 py-2 hover:bg-background transition text-sm text-text-primary flex justify-between items-center cursor-pointer"
                      >
                        <div>
                          <span className="font-bold text-accent mr-2">{ap.iataCode}</span>
                          <span>{ap.name}</span>
                        </div>
                        <span className="text-xs text-text-muted">{ap.city}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div ref={destRef} className="relative">
                <label className="block text-xs font-semibold text-text-secondary mb-1">Destination</label>
                <div className="relative">
                  <PlaneLanding className="absolute left-3 top-3 w-4 h-4 text-text-muted" />
                  <input
                    type="text"
                    value={destInput}
                    onChange={(e) => {
                      setDestInput(e.target.value);
                      setSelectedDest(null);
                      setMapDest(null);
                      setShowDestDropdown(true);
                    }}
                    onFocus={() => setShowDestDropdown(true)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setShowDestDropdown(false);
                      }
                    }}
                    placeholder="Enter city or airport code"
                    className="form-input w-full pl-10"
                    required
                  />
                </div>

                {showDestDropdown && destSuggestions.length > 0 && (
                  <div className="absolute left-0 right-0 mt-1 bg-card border border-card-border rounded-lg shadow-lg z-30 max-h-48 overflow-y-auto">
                    {destSuggestions.map((ap) => (
                      <button
                        key={ap.iataCode}
                        type="button"
                        onClick={() => handleSelectDest(ap)}
                        className="w-full text-left px-4 py-2 hover:bg-background transition text-sm text-text-primary flex justify-between items-center cursor-pointer"
                      >
                        <div>
                          <span className="font-bold text-accent mr-2">{ap.iataCode}</span>
                          <span>{ap.name}</span>
                        </div>
                        <span className="text-xs text-text-muted">{ap.city}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-text-secondary mb-1">Departure Date</label>
                <div className="relative">
                  <Calendar className="absolute left-3 top-3 w-4 h-4 text-text-muted" />
                  <input
                    type="date"
                    value={departDate}
                    onChange={(e) => setDepartDate(e.target.value)}
                    className="form-input w-full pl-10"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-text-secondary mb-1">Passengers</label>
                <div className="relative">
                  <Users className="absolute left-3 top-3 w-4 h-4 text-text-muted" />
                  <input
                    type="number"
                    min="1"
                    max="9"
                    value={passengers}
                    onChange={(e) => setPassengers(Number.isNaN(parseInt(e.target.value, 10)) ? 1 : parseInt(e.target.value, 10))}
                    className="form-input w-full pl-10"
                    required
                  />
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={!selectedOrigin || !selectedDest || isSearching}
              className="btn-primary w-full py-2.5 mt-2 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Search className="w-4 h-4" />
              {isSearching ? 'Searching Flights...' : 'Search Flights'}
            </button>
          </form>
        </div>

        <div className="flex-1 flex flex-col gap-4">
          {isSearching && (
            <div className="card flex items-center justify-center p-12">
              <div className="w-8 h-8 border-4 border-accent border-t-transparent rounded-full animate-spin mr-3" />
              <span className="text-sm font-medium text-text-secondary">Fetching flight schedules...</span>
            </div>
          )}

          {!isSearching && !hasSearched && (
            <div className="card flex flex-col items-center justify-center p-12 text-center text-text-muted bg-card">
              <Info className="w-12 h-12 mb-3 text-text-muted/45" />
              <p className="text-sm font-medium">Select origin and destination to search flights.</p>
              <p className="text-xs mt-1 text-text-muted">E.g. HAN (Hanoi) to NRT (Tokyo Narita) to view interactive map arc.</p>
            </div>
          )}

          {!isSearching && hasSearched && (
            <div className="space-y-4">
              <div className="flex justify-between items-center px-1">
                <h4 className="font-bold text-text-primary text-sm">
                  Flight Offers ({searchResults.length} found)
                </h4>
              </div>

              {searchResults.map((flight) => (
                <div key={flight.id} className="card p-4 hover:shadow-md transition duration-200">
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-accent/5 flex items-center justify-center text-accent font-bold text-xs border border-accent/10">
                        {flight.airline.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <span className="text-xs text-text-muted block font-semibold">
                          {flight.airline} · {flight.flightNumber}
                        </span>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="font-bold text-sm text-text-primary">{flight.departureTime}</span>
                          <span className="text-xs text-text-muted">→</span>
                          <span className="font-bold text-sm text-text-primary">{flight.arrivalTime}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex sm:flex-col items-end justify-between w-full sm:w-auto border-t sm:border-t-0 border-card-border pt-3 sm:pt-0 mt-3 sm:mt-0">
                      <div className="text-left sm:text-right mb-1">
                        <span className="text-xs text-text-muted block font-semibold">Duration</span>
                        <span className="text-sm font-medium text-text-primary">
                          {flight.duration} {flight.stops === 0 ? '(Non-stop)' : `(1 stop: ${flight.layoverAirport})`}
                        </span>
                      </div>
                    </div>

                    <div className="flex sm:flex-col items-end justify-between w-full sm:w-auto">
                      <div className="flex items-center gap-2 mb-2 sm:mb-1">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${flight.matchClass}`}>
                          {flight.matchScore}% Match
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="text-lg font-extrabold text-accent">${flight.price}</span>
                        <Link
                          href={`/search/${flight.id}?from=${selectedOrigin?.iataCode || ''}&to=${selectedDest?.iataCode || ''}`}
                          className="btn-primary py-1 px-3 text-xs ml-3 sm:mt-1 cursor-pointer no-underline inline-block"
                        >
                          View Details & Book
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="lg:col-span-6 h-[calc(100vh-140px)] min-h-[450px] lg:sticky lg:top-20">
        <MapContainer
          origin={mapOrigin}
          destination={mapDest}
          stops={EMPTY_STOPS}
          allAirports={allAirports}
          preview={!hasSearched && !!mapOrigin && !!mapDest}
        />
      </div>
    </div>
  );
}
