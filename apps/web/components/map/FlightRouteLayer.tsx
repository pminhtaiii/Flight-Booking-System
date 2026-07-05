/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useMemo, useState, useEffect } from 'react';
import { Source, Layer } from 'react-map-gl/maplibre';
import { Airport } from '@shared/types';
import { calculateGreatCircleArc, getThemeColor } from './map-utils';

type Props = {
  origin?: Airport | null;
  destination?: Airport | null;
  stops?: Airport[];
  preview?: boolean;
};

export function FlightRouteLayer({ origin, destination, stops = [], preview = false }: Props) {
  const [routeColor, setRouteColor] = useState('#7C5CFC');
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    setRouteColor(getThemeColor('--color-accent', '#7C5CFC'));
  }, []);

  useEffect(() => {
    if (preview) {
      setProgress(1);
      return;
    }

    setProgress(0);
    let start: number | null = null;
    const duration = 1200; // 1.2s progressive drawing animation

    const animate = (timestamp: number) => {
      if (!start) start = timestamp;
      const elapsed = timestamp - start;
      const currentProgress = Math.min(elapsed / duration, 1);
      setProgress(currentProgress);

      if (currentProgress < 1) {
        requestAnimationFrame(animate);
      }
    };

    const animFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animFrame);
  }, [origin?.iataCode, destination?.iataCode, preview]);

  const geojson = useMemo(() => {
    if (!origin || !destination) return null;

    const points = [origin, ...stops, destination];
    const features: any[] = [];

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];

      try {
        const arc = calculateGreatCircleArc(
          [p1.longitude, p1.latitude],
          [p2.longitude, p2.latitude]
        );

        if (preview || progress >= 1) {
          features.push(arc);
        } else {
          const coords = arc.geometry.coordinates;
          const targetCount = Math.max(2, Math.floor(coords.length * progress));
          const slicedCoords = coords.slice(0, targetCount);

          features.push({
            ...arc,
            geometry: {
              ...arc.geometry,
              coordinates: slicedCoords,
            },
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[FlightRouteLayer/calculateArc]', err);
      }
    }

    return {
      type: 'FeatureCollection',
      features,
    };
  }, [origin, destination, stops, preview, progress]);

  if (!geojson) return null;

  const routeLayerStyle: any = {
    id: preview ? 'flight-route-preview' : 'flight-route',
    type: 'line',
    paint: {
      'line-color': routeColor,
      'line-width': preview ? 2.5 : 3.5,
      'line-opacity': preview ? 0.6 : 0.85,
      ...(preview ? { 'line-dasharray': [3, 2] } : {}),
    },
    layout: {
      'line-join': 'round',
      'line-cap': 'round',
    },
  };

  return (
    <Source id="route-source" type="geojson" data={geojson as any}>
      <Layer {...routeLayerStyle} />
    </Source>
  );
}
