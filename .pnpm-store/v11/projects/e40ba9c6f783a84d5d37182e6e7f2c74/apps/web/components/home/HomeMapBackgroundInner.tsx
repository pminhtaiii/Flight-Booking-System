'use client';

import { useMemo, useState } from 'react';
import maplibregl from 'maplibre-gl';
import Map, { Layer, Source } from 'react-map-gl/maplibre';
import type { FeatureCollection, Point } from 'geojson';
import type { Airport } from '@shared/types';
import 'maplibre-gl/dist/maplibre-gl.css';
import styles from './authenticated-home.module.css';

type AirportPointProperties = Pick<Airport, 'iataCode' | 'name' | 'city' | 'country'>;

type Props = {
  airports: Airport[];
};

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';

export function HomeMapBackgroundInner({ airports }: Props): JSX.Element {
  const [failed, setFailed] = useState(false);
  const airportPoints = useMemo<FeatureCollection<Point, AirportPointProperties>>(
    () => ({
      type: 'FeatureCollection',
      features: airports.map((airport) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [airport.longitude, airport.latitude],
        },
        properties: {
          iataCode: airport.iataCode,
          name: airport.name,
          city: airport.city,
          country: airport.country,
        },
      })),
    }),
    [airports],
  );

  return (
    <>
      {failed ? null : (
        <div data-testid="home-map" aria-hidden="true">
          <Map
            mapLib={maplibregl}
            mapStyle={MAP_STYLE}
            initialViewState={{ longitude: 10, latitude: 20, zoom: 1.4 }}
            interactive={false}
            attributionControl={false}
            dragPan={false}
            dragRotate={false}
            scrollZoom={false}
            boxZoom={false}
            doubleClickZoom={false}
            touchZoomRotate={false}
            keyboard={false}
            onError={() => {
              // eslint-disable-next-line no-console
              console.error('[home-map] Map rendering failed');
              setFailed(true);
            }}
            style={{ width: '100%', height: '100%' }}
          >
            <Source id="home-airports" type="geojson" data={airportPoints} cluster clusterRadius={34} clusterMaxZoom={7}>
              <Layer
                id="home-airport-clusters"
                type="circle"
                filter={['has', 'point_count']}
                paint={{
                  'circle-color': 'rgba(135, 206, 235, 0.24)',
                  'circle-radius': 12,
                  'circle-opacity': 0.56,
                }}
              />
              <Layer
                id="home-airport-points"
                type="circle"
                filter={['!', ['has', 'point_count']]}
                paint={{
                  'circle-color': 'rgb(180, 225, 242)',
                  'circle-radius': 3,
                  'circle-opacity': 0.48,
                }}
              />
            </Source>
          </Map>
        </div>
      )}
      <aside className={styles.mapAttribution} aria-label="Map attribution">
        <a href="https://openfreemap.org/">OpenFreeMap</a> © <a href="https://openmaptiles.org/">OpenMapTiles</a>{' '}
        Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>.
      </aside>
    </>
  );
}
