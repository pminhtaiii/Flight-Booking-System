'use client';

import { Popup } from 'react-map-gl/maplibre';
import { Airport } from '@shared/types';
import { X } from 'lucide-react';

type Props = {
  airport: Airport;
  onClose: () => void;
};

export function AirportPopup({ airport, onClose }: Props) {
  const formatAirportType = (type: string) => {
    return type
      .replace('_', ' ')
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  };

  return (
    <Popup
      longitude={airport.longitude}
      latitude={airport.latitude}
      anchor="top"
      onClose={onClose}
      closeButton={false}
      closeOnClick={false}
      className="z-20 font-sans"
    >
      <div className="p-3 max-w-[240px] text-text-primary bg-card rounded-md">
        <div className="flex justify-between items-start mb-2">
          <div>
            <h4 className="font-bold text-sm tracking-tight pr-4 leading-snug">{airport.name}</h4>
            <span className="inline-block bg-accent/10 text-accent text-[10px] font-semibold px-2 py-0.5 rounded mt-1">
              {airport.iataCode}
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary p-0.5 rounded hover:bg-background transition focus:outline-none cursor-pointer"
            type="button"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="text-xs space-y-1 text-text-secondary border-t border-card-border pt-2 mt-2">
          <div>
            <span className="font-medium text-text-muted">Location:</span> {airport.city}, {airport.country}
          </div>
          <div>
            <span className="font-medium text-text-muted">Type:</span> {formatAirportType(airport.type)}
          </div>
          <div className="text-[10px] text-text-muted mt-1">
            {airport.latitude.toFixed(4)}°, {airport.longitude.toFixed(4)}°
          </div>
        </div>
      </div>
    </Popup>
  );
}
