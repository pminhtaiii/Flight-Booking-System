import { classifyMateriality } from './materiality-classifier';
import { ItineraryDiffResult, SegmentDiff, ConnectionDiff, SliceDiff } from './itinerary-diff';
import { NormalizedSegment } from './itinerary-normalizer';
import { MaterialDisruptionReason, MaterialBaseline } from '@shared/disruption-types';

describe('MaterialityClassifier', () => {
  const emptyDiff: ItineraryDiffResult = {
    segmentDiffs: [],
    connectionDiffs: [],
    sliceDiffs: [],
    isRoutingChanged: false,
    addedSegments: [],
    removedSegments: [],
    presentationSummary: {
      isRoutingChanged: false,
      hasStopsChanged: false,
      addedSegmentsCount: 0,
      removedSegmentsCount: 0,
      sliceSummaries: [],
    },
  };

  it('should be non-material if both diffs are empty', () => {
    const result = classifyMateriality({ ...emptyDiff }, { ...emptyDiff });
    expect(result).toEqual({
      isMaterial: false,
      reasons: [],
      baselines: [],
      rulesetVersion: 'disruption-v1',
    });
  });

  describe('Binary Rules', () => {
    it('should classify SEGMENT_REMOVED as material', () => {
      const diff: ItineraryDiffResult = {
        ...emptyDiff,
        removedSegments: [{ globalOrder: 0 } as unknown as NormalizedSegment],
      };
      const result = classifyMateriality(diff, diff);
      expect(result.isMaterial).toBe(true);
      expect(result.reasons).toContain(MaterialDisruptionReason.SEGMENT_REMOVED);
      expect(result.baselines).toContain(MaterialBaseline.INCREMENTAL);
      expect(result.baselines).toContain(MaterialBaseline.CUMULATIVE);
    });

    it('should classify SEGMENT_ADDED as material', () => {
      const diff: ItineraryDiffResult = {
        ...emptyDiff,
        addedSegments: [{ globalOrder: 0 } as unknown as NormalizedSegment],
      };
      const result = classifyMateriality(diff, diff);
      expect(result.isMaterial).toBe(true);
      expect(result.reasons).toContain(MaterialDisruptionReason.SEGMENT_ADDED);
    });

    it('should classify DEPARTURE_AIRPORT_CHANGED as material', () => {
      const diff: ItineraryDiffResult = {
        ...emptyDiff,
        segmentDiffs: [{ departureAirportChanged: true } as unknown as SegmentDiff],
      };
      const result = classifyMateriality(diff, diff);
      expect(result.isMaterial).toBe(true);
      expect(result.reasons).toContain(MaterialDisruptionReason.DEPARTURE_AIRPORT_CHANGED);
    });

    it('should classify ARRIVAL_AIRPORT_CHANGED as material', () => {
      const diff: ItineraryDiffResult = {
        ...emptyDiff,
        segmentDiffs: [{ arrivalAirportChanged: true } as unknown as SegmentDiff],
      };
      const result = classifyMateriality(diff, diff);
      expect(result.isMaterial).toBe(true);
      expect(result.reasons).toContain(MaterialDisruptionReason.ARRIVAL_AIRPORT_CHANGED);
    });

    it('should classify DEPARTURE_LOCAL_DATE_CHANGED as material', () => {
      const diff: ItineraryDiffResult = {
        ...emptyDiff,
        segmentDiffs: [{ departureLocalDateChanged: true } as unknown as SegmentDiff],
      };
      const result = classifyMateriality(diff, diff);
      expect(result.isMaterial).toBe(true);
      expect(result.reasons).toContain(MaterialDisruptionReason.DEPARTURE_LOCAL_DATE_CHANGED);
    });

    it('should classify ARRIVAL_LOCAL_DATE_CHANGED as material', () => {
      const diff: ItineraryDiffResult = {
        ...emptyDiff,
        segmentDiffs: [{ arrivalLocalDateChanged: true } as unknown as SegmentDiff],
      };
      const result = classifyMateriality(diff, diff);
      expect(result.isMaterial).toBe(true);
      expect(result.reasons).toContain(MaterialDisruptionReason.ARRIVAL_LOCAL_DATE_CHANGED);
    });

    it('should classify OVERNIGHT_CONNECTION_INTRODUCED as material', () => {
      const diff: ItineraryDiffResult = {
        ...emptyDiff,
        connectionDiffs: [{ isOvernightIntroduced: true } as unknown as ConnectionDiff],
      };
      const result = classifyMateriality(diff, diff);
      expect(result.isMaterial).toBe(true);
      expect(result.reasons).toContain(MaterialDisruptionReason.OVERNIGHT_CONNECTION_INTRODUCED);
    });

    it('should classify CONNECTION_BELOW_MCT as material', () => {
      const diff: ItineraryDiffResult = {
        ...emptyDiff,
        connectionDiffs: [{ isBelowMct: true } as unknown as ConnectionDiff],
      };
      const result = classifyMateriality(diff, diff);
      expect(result.isMaterial).toBe(true);
      expect(result.reasons).toContain(MaterialDisruptionReason.CONNECTION_BELOW_MCT);
    });

    it('should classify INVALID_CONNECTION_OVERLAP as material', () => {
      const diff: ItineraryDiffResult = {
        ...emptyDiff,
        connectionDiffs: [{ isOverlapping: true } as unknown as ConnectionDiff],
      };
      const result = classifyMateriality(diff, diff);
      expect(result.isMaterial).toBe(true);
      expect(result.reasons).toContain(MaterialDisruptionReason.INVALID_CONNECTION_OVERLAP);
    });

    it('should classify slice departure airport changes separately from arrival airport changes', () => {
      const departureOnlyDiff: ItineraryDiffResult = {
        ...emptyDiff,
        sliceDiffs: [
          { departureAirportChanged: true, arrivalAirportChanged: false } as unknown as SliceDiff,
        ],
      };
      const departureOnlyResult = classifyMateriality(departureOnlyDiff, departureOnlyDiff);
      expect(departureOnlyResult.isMaterial).toBe(true);
      expect(departureOnlyResult.reasons).toContain(
        MaterialDisruptionReason.DEPARTURE_AIRPORT_CHANGED,
      );
      expect(departureOnlyResult.reasons).not.toContain(
        MaterialDisruptionReason.ARRIVAL_AIRPORT_CHANGED,
      );

      const arrivalOnlyDiff: ItineraryDiffResult = {
        ...emptyDiff,
        sliceDiffs: [
          { departureAirportChanged: false, arrivalAirportChanged: true } as unknown as SliceDiff,
        ],
      };
      const arrivalOnlyResult = classifyMateriality(arrivalOnlyDiff, arrivalOnlyDiff);
      expect(arrivalOnlyResult.isMaterial).toBe(true);
      expect(arrivalOnlyResult.reasons).toContain(MaterialDisruptionReason.ARRIVAL_AIRPORT_CHANGED);
      expect(arrivalOnlyResult.reasons).not.toContain(
        MaterialDisruptionReason.DEPARTURE_AIRPORT_CHANGED,
      );
    });
  });

  describe('Threshold and Boundary Rules', () => {
    it('should evaluate DEPARTURE_MOVED_EARLIER strictly past 60 minutes', () => {
      // 59m earlier: non-material
      const diff59 = {
        ...emptyDiff,
        segmentDiffs: [{ departureTimeShiftMinutes: -59 } as unknown as SegmentDiff],
      };
      expect(classifyMateriality(diff59, diff59).isMaterial).toBe(false);

      // 60m earlier: non-material (exact threshold)
      const diff60 = {
        ...emptyDiff,
        segmentDiffs: [{ departureTimeShiftMinutes: -60 } as unknown as SegmentDiff],
      };
      expect(classifyMateriality(diff60, diff60).isMaterial).toBe(false);

      // 61m earlier: material
      const diff61 = {
        ...emptyDiff,
        segmentDiffs: [{ departureTimeShiftMinutes: -61 } as unknown as SegmentDiff],
      };
      const res61 = classifyMateriality(diff61, diff61);
      expect(res61.isMaterial).toBe(true);
      expect(res61.reasons).toContain(MaterialDisruptionReason.DEPARTURE_MOVED_EARLIER);
    });

    it('should evaluate DEPARTURE_MOVED_LATER strictly past 120 minutes', () => {
      // 119m later: non-material
      const diff119 = {
        ...emptyDiff,
        segmentDiffs: [{ departureTimeShiftMinutes: 119 } as unknown as SegmentDiff],
      };
      expect(classifyMateriality(diff119, diff119).isMaterial).toBe(false);

      // 120m later: non-material (exact threshold)
      const diff120 = {
        ...emptyDiff,
        segmentDiffs: [{ departureTimeShiftMinutes: 120 } as unknown as SegmentDiff],
      };
      expect(classifyMateriality(diff120, diff120).isMaterial).toBe(false);

      // 121m later: material
      const diff121 = {
        ...emptyDiff,
        segmentDiffs: [{ departureTimeShiftMinutes: 121 } as unknown as SegmentDiff],
      };
      const res121 = classifyMateriality(diff121, diff121);
      expect(res121.isMaterial).toBe(true);
      expect(res121.reasons).toContain(MaterialDisruptionReason.DEPARTURE_MOVED_LATER);
    });

    it('should evaluate FINAL_ARRIVAL_MOVED_EARLIER strictly past 60 minutes', () => {
      const diff60 = {
        ...emptyDiff,
        sliceDiffs: [{ finalArrivalShiftMinutes: -60 } as unknown as SliceDiff],
      };
      expect(classifyMateriality(diff60, diff60).isMaterial).toBe(false);

      const diff61 = {
        ...emptyDiff,
        sliceDiffs: [{ finalArrivalShiftMinutes: -61 } as unknown as SliceDiff],
      };
      const res = classifyMateriality(diff61, diff61);
      expect(res.isMaterial).toBe(true);
      expect(res.reasons).toContain(MaterialDisruptionReason.FINAL_ARRIVAL_MOVED_EARLIER);
    });

    it('should evaluate FINAL_ARRIVAL_MOVED_LATER strictly past 120 minutes', () => {
      const diff120 = {
        ...emptyDiff,
        sliceDiffs: [{ finalArrivalShiftMinutes: 120 } as unknown as SliceDiff],
      };
      expect(classifyMateriality(diff120, diff120).isMaterial).toBe(false);

      const diff121 = {
        ...emptyDiff,
        sliceDiffs: [{ finalArrivalShiftMinutes: 121 } as unknown as SliceDiff],
      };
      const res = classifyMateriality(diff121, diff121);
      expect(res.isMaterial).toBe(true);
      expect(res.reasons).toContain(MaterialDisruptionReason.FINAL_ARRIVAL_MOVED_LATER);
    });
  });

  describe('Incremental vs Cumulative Baselines', () => {
    it('should correctly flag when only cumulative drift is material', () => {
      // Incremental change is minor (e.g. +70m later departure, 70 <= 120)
      const incremental = {
        ...emptyDiff,
        segmentDiffs: [{ departureTimeShiftMinutes: 70 } as unknown as SegmentDiff],
      };
      // Cumulative change is major (e.g. two minor changes totalling +140m later, 140 > 120)
      const cumulative = {
        ...emptyDiff,
        segmentDiffs: [{ departureTimeShiftMinutes: 140 } as unknown as SegmentDiff],
      };

      const result = classifyMateriality(incremental, cumulative);

      expect(result.isMaterial).toBe(true);
      expect(result.baselines).toEqual([MaterialBaseline.CUMULATIVE]);
      expect(result.reasons).toContain(MaterialDisruptionReason.DEPARTURE_MOVED_LATER);
    });

    it('should correctly flag when only incremental is material (unlikely but possible or theoretically separate)', () => {
      const incremental = {
        ...emptyDiff,
        segmentDiffs: [{ departureTimeShiftMinutes: 130 } as unknown as SegmentDiff],
      };
      const cumulative = { ...emptyDiff };

      const result = classifyMateriality(incremental, cumulative);

      expect(result.isMaterial).toBe(true);
      expect(result.baselines).toEqual([MaterialBaseline.INCREMENTAL]);
    });
  });
});
