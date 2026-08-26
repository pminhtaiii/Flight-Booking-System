'use client';

import { useState, useEffect, useCallback } from 'react';
import { Clock, ChevronDown, ChevronUp, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ItineraryRevisionView } from '@shared/types/booking-management.types';
import { REASON_LABELS } from './DisruptionAlert';

type RevisionsResponse = {
  revisions?: ItineraryRevisionView[];
  items?: ItineraryRevisionView[];
  totalPages: number;
  total: number;
  page: number;
  limit: number;
};

type ItineraryRevisionHistoryProps = {
  bookingId: string;
};

export function ItineraryRevisionHistory({ bookingId }: ItineraryRevisionHistoryProps) {
  const [data, setData] = useState<RevisionsResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [expandedRevisionId, setExpandedRevisionId] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    if (!bookingId) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/booking-management/bookings/${bookingId}/revisions?page=${page}&limit=5`);
      if (response.ok) {
        const json: RevisionsResponse = await response.json();
        setData(json);
      }
    } catch (e) {
      // Fail silently to prevent UI crash
    } finally {
      setLoading(false);
    }
  }, [bookingId, page]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const toggleExpand = (revisionId: string) => {
    setExpandedRevisionId(prev => (prev === revisionId ? null : revisionId));
  };

  const revisionsList = data?.revisions ?? data?.items ?? [];

  if (!data || revisionsList.length === 0) {
    return null;
  }

  return (
    <div className="card space-y-6">
      <div className="flex items-center gap-2 pb-3 border-b border-card-border">
        <Clock className="h-5 w-5 text-accent" />
        <h3 className="font-bold text-text-primary text-base">Itinerary Revision History</h3>
      </div>

      <div className="relative border-l border-card-border pl-6 ml-3 space-y-6">
        {revisionsList.map((item: ItineraryRevisionView) => {
          const isExpanded = expandedRevisionId === item.revisionId;
          const observedDate = new Intl.DateTimeFormat('en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date(item.observedAt));

          return (
            <div key={item.revisionId} className="relative">
              {/* Timeline marker */}
              <span className="absolute -left-[31px] top-1.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-accent bg-background">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              </span>

              <div className="bg-bg-secondary/40 p-4 rounded-xl border border-card-border hover:border-accent/40 transition-colors">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="font-semibold text-sm text-text-primary">
                      Version {item.version}
                    </span>
                    <span className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
                      item.isMaterial 
                        ? 'bg-bg-cancelled text-text-cancelled border border-danger-border/30' 
                        : 'bg-bg-match-fair text-text-match-fair border border-color-text-match-fair/30'
                    }`}>
                      {item.isMaterial ? 'Material Change' : 'Minor Change'}
                    </span>
                  </div>
                  <span className="text-xs text-text-muted">{observedDate}</span>
                </div>

                {item.materialReasons && item.materialReasons.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-semibold text-text-secondary mb-1">Classification Reasons:</p>
                    <ul className="text-xs list-disc pl-4 space-y-1 text-text-secondary">
                      {item.materialReasons.map((reason) => (
                        <li key={reason}>{(REASON_LABELS as Record<string, string>)[reason] || reason}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Show/Hide details toggles */}
                <button
                  onClick={() => toggleExpand(item.revisionId)}
                  className="mt-3 flex items-center gap-1 text-xs text-accent font-semibold hover:underline focus:outline-none"
                >
                  {isExpanded ? (
                    <>
                      Hide segments <ChevronUp className="h-3 w-3" />
                    </>
                  ) : (
                    <>
                      View segments snapshot <ChevronDown className="h-3 w-3" />
                    </>
                  )}
                </button>

                {isExpanded && item.segments && item.segments.length > 0 && (
                  <div className="mt-4 pt-3 border-t border-card-border space-y-3">
                    <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">Itinerary segments in this version:</p>
                    {item.segments.map((segment, index) => (
                      <div key={index} className="bg-card p-3 rounded-lg border border-card-border text-xs space-y-1.5">
                        <div className="flex justify-between items-center font-semibold text-text-primary">
                          <span>{segment.airline?.name} {segment.flightNumber}</span>
                          {segment.sliceOrder !== undefined && (
                            <span className="text-text-muted font-normal text-[10px] bg-bg-secondary px-1.5 py-0.5 rounded">
                              Slice {segment.sliceOrder + 1}
                            </span>
                          )}
                        </div>
                        <div className="text-text-secondary">
                          {segment.departureAirport?.city} ({segment.departureAirport?.iataCode}) to {segment.arrivalAirport?.city} ({segment.arrivalAirport?.iataCode})
                        </div>
                        <div className="text-text-muted">
                          Departure: {new Date(segment.departureAt).toLocaleString('en-GB')}
                        </div>
                        <div className="text-text-muted">
                          Arrival: {new Date(segment.arrivalAt).toLocaleString('en-GB')}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination Controls */}
      {data.totalPages > 1 && (
        <div className="flex items-center justify-between pt-3 border-t border-card-border">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1 || loading}
            className="flex items-center gap-1 text-xs font-semibold text-text-secondary disabled:opacity-50"
          >
            <ChevronLeft className="h-4 w-4" /> Previous
          </button>
          <span className="text-xs text-text-secondary">
            Page {page} of {data.totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
            disabled={page === data.totalPages || loading}
            className="flex items-center gap-1 text-xs font-semibold text-text-secondary disabled:opacity-50"
          >
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
