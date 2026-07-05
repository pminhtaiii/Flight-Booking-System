'use client';

import { useEffect, useRef, useState } from 'react';
import Map, { MapRef, MapProvider } from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import { Airport } from '@shared/types';
import { getMapBounds } from './map-utils';
import { MapControls } from './MapControls';
import { AirportMarkerLayer } from './AirportMarkerLayer';
import { AirportPopup } from './AirportPopup';
import { FlightRouteLayer } from './FlightRouteLayer';

import 'maplibre-gl/dist/maplibre-gl.css';

type Props = {
  origin?: Airport | null;
  destination?: Airport | null;
  stops?: (Airport & { layoverDuration?: string })[];
  allAirports?: Airport[];
  preview?: boolean;
};

const DEFAULT_VIEW_STATE = {
  longitude: 105.807, // Default to Noi Bai (HAN)
  latitude: 21.2212,
  zoom: 3,
};

export default function MapContainerInner({
  origin,
  destination,
  stops = [],
  allAirports = [],
  preview = false,
}: Props) {
  const mapRef = useRef<MapRef>(null);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [selectedAirport, setSelectedAirport] = useState<Airport | null>(null);

  // Sync dark mode style based on system theme or HTML document class
  useEffect(() => {
    const checkDark = () => {
      const isDark = document.documentElement.classList.contains('dark');
      setIsDarkMode(isDark);
    };

    checkDark();

    // Set up a MutationObserver to listen for changes to the HTML class list
    const observer = new MutationObserver(checkDark);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  // Fit bounds to show origin, stops, and destination whenever they change
  useEffect(() => {
    if (!mapRef.current) return;

    const coords: [number, number][] = [];
    if (origin) coords.push([origin.longitude, origin.latitude]);
    if (destination) coords.push([destination.longitude, destination.latitude]);
    stops.forEach((s) => coords.push([s.longitude, s.latitude]));

    if (coords.length > 0) {
      const bounds = getMapBounds(coords);
      if (bounds) {
        mapRef.current.fitBounds(bounds, {
          padding: 80,
          duration: 1200,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin?.iataCode, destination?.iataCode, stops]);

  const mapStyle = isDarkMode
    ? 'https://tiles.openfreemap.org/styles/dark'
    : 'https://tiles.openfreemap.org/styles/liberty';

  return (
    <div className="relative w-full h-full rounded-2xl overflow-hidden border border-card-border shadow-inner min-h-[350px] bg-background">
      <MapProvider>
        <Map
          ref={mapRef}
          initialViewState={DEFAULT_VIEW_STATE}
          mapLib={maplibregl}
          mapStyle={mapStyle}
          style={{ width: '100%', height: '100%' }}
        >
          <FlightRouteLayer origin={origin} destination={destination} stops={stops} preview={preview} />
          
          <AirportMarkerLayer
            origin={origin}
            destination={destination}
            stops={stops}
            allAirports={allAirports}
            onSelectAirport={setSelectedAirport}
          />

          {selectedAirport && (
            <AirportPopup airport={selectedAirport} onClose={() => setSelectedAirport(null)} />
          )}

          <MapControls isDarkMode={isDarkMode} onToggleDarkMode={() => setIsDarkMode((prev) => !prev)} />
        </Map>
      </MapProvider>
    </div>
  );
}
