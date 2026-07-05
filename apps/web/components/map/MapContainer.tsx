'use client';

import dynamic from 'next/dynamic';

export const MapContainer = dynamic(
  () => import('./MapContainerInner'),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full min-h-[350px] rounded-2xl border border-card-border bg-card flex flex-col items-center justify-center gap-3 p-8 animate-pulse shadow-sm">
        <div className="w-10 h-10 border-4 border-accent border-t-transparent rounded-full animate-spin" />
        <p className="text-sm font-medium text-text-secondary">Loading Interactive Map...</p>
      </div>
    ),
  }
);
