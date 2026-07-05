/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { Marker, Source, Layer } from 'react-map-gl/maplibre';
import { Airport } from '@shared/types';
import { getThemeColor } from './map-utils';
import { MapPin } from 'lucide-react';
import { useEffect, useState, useMemo } from 'react';

type Props = {
  origin?: Airport | null;
  destination?: Airport | null;
  stops?: (Airport & { layoverDuration?: string })[];
  allAirports?: Airport[];
  onSelectAirport: (airport: Airport) => void;
};

export function AirportMarkerLayer({
  origin,
  destination,
  stops = [],
  allAirports = [],
  onSelectAirport,
}: Props) {
  const [colors, setColors] = useState({
    accent: '#7C5CFC',
    confirmed: '#009966',
    cancelled: '#DC2626',
    pending: '#B45309',
  });

  useEffect(() => {
    setColors({
      accent: getThemeColor('--color-accent', '#7C5CFC'),
      confirmed: getThemeColor('--color-text-confirmed', '#009966'),
      cancelled: getThemeColor('--color-text-cancelled', '#DC2626'),
      pending: getThemeColor('--color-text-pending', '#B45309'),
    });
  }, []);

  // Filter out origin, destination, and stops from background clustered list
  const backgroundAirports = useMemo(() => {
    if (allAirports.length === 0) return [];
    const activeIatas = new Set<string>();
    if (origin) activeIatas.add(origin.iataCode);
    if (destination) activeIatas.add(destination.iataCode);
    stops.forEach((s) => activeIatas.add(s.iataCode));

    return allAirports.filter((ap) => !activeIatas.has(ap.iataCode));
  }, [allAirports, origin, destination, stops]);

  const geojson = useMemo(() => {
    return {
      type: 'FeatureCollection',
      features: backgroundAirports.map((ap) => ({
        type: 'Feature',
        properties: {
          iataCode: ap.iataCode,
          name: ap.name,
          city: ap.city,
          country: ap.country,
          type: ap.type,
          latitude: ap.latitude,
          longitude: ap.longitude,
        },
        geometry: {
          type: 'Point',
          coordinates: [ap.longitude, ap.latitude],
        },
      })),
    };
  }, [backgroundAirports]);

  const clusterLayer: any = {
    id: 'clusters',
    type: 'circle',
    source: 'airports',
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': colors.accent,
      'circle-radius': ['step', ['get', 'point_count'], 16, 50, 22, 250, 28],
      'circle-opacity': 0.65,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#ffffff',
    },
  };

  const clusterCountLayer: any = {
    id: 'cluster-count',
    type: 'symbol',
    source: 'airports',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': '{point_count}',
      'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
      'text-size': 11,
    },
    paint: {
      'text-color': '#ffffff',
    },
  };

  const unclusteredPointLayer: any = {
    id: 'unclustered-point',
    type: 'circle',
    source: 'airports',
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-color': colors.accent,
      'circle-radius': 5,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': 0.8,
    },
  };

  return (
    <>
      {backgroundAirports.length > 0 && (
        <Source
          id="airports"
          type="geojson"
          data={geojson as any}
          cluster={true}
          clusterMaxZoom={11}
          clusterRadius={45}
        >
          <Layer {...clusterLayer} />
          <Layer {...clusterCountLayer} />
          <Layer {...unclusteredPointLayer} />
        </Source>
      )}

      {origin && (
        <Marker
          longitude={origin.longitude}
          latitude={origin.latitude}
          anchor="bottom"
          onClick={(e: any) => {
            e.originalEvent.stopPropagation();
            onSelectAirport(origin);
          }}
        >
          <div className="flex flex-col items-center group cursor-pointer">
            <div className="bg-bg-confirmed border-2 border-text-confirmed text-text-confirmed px-2 py-0.5 rounded shadow text-[10px] font-bold whitespace-nowrap mb-1">
              {origin.iataCode}
            </div>
            <MapPin className="w-8 h-8 text-text-confirmed drop-shadow-md" />
          </div>
        </Marker>
      )}

      {destination && (
        <Marker
          longitude={destination.longitude}
          latitude={destination.latitude}
          anchor="bottom"
          onClick={(e: any) => {
            e.originalEvent.stopPropagation();
            onSelectAirport(destination);
          }}
        >
          <div className="flex flex-col items-center group cursor-pointer">
            <div className="bg-bg-cancelled border-2 border-text-cancelled text-text-cancelled px-2 py-0.5 rounded shadow text-[10px] font-bold whitespace-nowrap mb-1">
              {destination.iataCode}
            </div>
            <MapPin className="w-8 h-8 text-text-cancelled drop-shadow-md" />
          </div>
        </Marker>
      )}

      {stops.map((stop, idx) => (
        <Marker
          key={`${stop.iataCode}-${idx}`}
          longitude={stop.longitude}
          latitude={stop.latitude}
          anchor="bottom"
          onClick={(e: any) => {
            e.originalEvent.stopPropagation();
            onSelectAirport(stop);
          }}
        >
          <div className="flex flex-col items-center group cursor-pointer relative">
            <div className="absolute bottom-full mb-2 hidden group-hover:flex flex-col bg-card border border-card-border p-2.5 rounded-lg shadow-lg z-50 text-xs w-48 text-text-primary">
              <div className="font-bold truncate">{stop.name}</div>
              <div className="text-[10px] text-text-muted mt-0.5">IATA: {stop.iataCode}</div>
              {stop.layoverDuration && (
                <div className="mt-1 text-accent font-semibold">
                  Layover: {stop.layoverDuration}
                </div>
              )}
            </div>

            <div className="bg-bg-pending border-2 border-text-pending text-text-pending px-2 py-0.5 rounded shadow text-[10px] font-bold whitespace-nowrap mb-1">
              {stop.iataCode}
            </div>
            <MapPin className="w-7 h-7 text-text-pending drop-shadow-md" />
          </div>
        </Marker>
      ))}
    </>
  );
}
