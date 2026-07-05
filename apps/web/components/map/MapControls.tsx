/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useMap } from 'react-map-gl/maplibre';
import { ZoomIn, ZoomOut, Maximize, Sun, Moon } from 'lucide-react';

type Props = {
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
};

export function MapControls({ isDarkMode, onToggleDarkMode }: Props) {
  const { current: map } = useMap();

  const handleZoomIn = () => {
    map?.zoomIn();
  };

  const handleZoomOut = () => {
    map?.zoomOut();
  };

  const handleFullscreen = () => {
    const container = map?.getContainer();
    if (!container) return;

    if (!document.fullscreenElement) {
      container.requestFullscreen().catch((err: any) => {
        // eslint-disable-next-line no-console
        console.error('[MapControls/Fullscreen]', err);
      });
    } else {
      document.exitFullscreen().catch((err: any) => {
        // eslint-disable-next-line no-console
        console.error('[MapControls/ExitFullscreen]', err);
      });
    }
  };

  return (
    <div className="absolute top-4 right-4 z-10 flex flex-col gap-2 bg-card p-2 rounded-lg border border-card-border shadow-md">
      <button
        onClick={handleZoomIn}
        className="p-2 rounded-md hover:bg-background transition text-text-primary focus:outline-none cursor-pointer"
        title="Zoom In"
        type="button"
      >
        <ZoomIn className="w-5 h-5" />
      </button>
      <button
        onClick={handleZoomOut}
        className="p-2 rounded-md hover:bg-background transition text-text-primary focus:outline-none cursor-pointer"
        title="Zoom Out"
        type="button"
      >
        <ZoomOut className="w-5 h-5" />
      </button>
      <button
        onClick={handleFullscreen}
        className="p-2 rounded-md hover:bg-background transition text-text-primary focus:outline-none cursor-pointer"
        title="Toggle Fullscreen"
        type="button"
      >
        <Maximize className="w-5 h-5" />
      </button>
      <div className="h-[1px] bg-card-border my-1" />
      <button
        onClick={onToggleDarkMode}
        className="p-2 rounded-md hover:bg-background transition text-text-primary focus:outline-none cursor-pointer"
        title={isDarkMode ? 'Switch to Light Map' : 'Switch to Dark Map'}
        type="button"
      >
        {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
      </button>
    </div>
  );
}
