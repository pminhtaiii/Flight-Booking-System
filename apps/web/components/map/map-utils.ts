import greatCircle from '@turf/great-circle';
import { point } from '@turf/helpers';

/**
 * Calculates a great-circle arc between two points.
 * Coordinates should be in [longitude, latitude] format.
 */
export function calculateGreatCircleArc(
  origin: [number, number],
  destination: [number, number]
) {
  const startPoint = point(origin);
  const endPoint = point(destination);
  return greatCircle(startPoint, endPoint);
}

/**
 * Calculates bounding box coordinates to fit a list of coordinates on the map.
 * Each coordinate should be in [longitude, latitude] format.
 */
export function getMapBounds(coordinates: [number, number][]): [[number, number], [number, number]] | null {
  if (coordinates.length === 0) return null;
  let minLng = coordinates[0][0];
  let minLat = coordinates[0][1];
  let maxLng = coordinates[0][0];
  let maxLat = coordinates[0][1];

  for (const [lng, lat] of coordinates) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  // Handle case where all coordinates are identical
  if (minLng === maxLng && minLat === maxLat) {
    return [
      [minLng - 0.05, minLat - 0.05],
      [maxLng + 0.05, maxLat + 0.05],
    ];
  }

  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

/**
 * Retrieves a CSS variable theme color dynamically at runtime.
 * Falls back to a default value if not in browser or variable is not found.
 */
export function getThemeColor(variableName: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
  return val || fallback;
}
