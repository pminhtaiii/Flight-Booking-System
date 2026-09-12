import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Explanation } from '@shared/types';

import { formatExplanation } from './flight-match-explanations';

// Testing runtime malformation requires bypassing Explanation compile-time typing because the server boundary or external data may supply unexpected runtime shapes.
function assertExplanationFallback(explanation: unknown, expected: string): void {
  const result = formatExplanation(explanation as Explanation);
  assert.equal(result, expected);
  assert.equal(result.includes('undefined'), false);
  assert.equal(result.includes('NaN'), false);
  assert.equal(result.includes('[object Object]'), false);
}

describe('formatExplanation', (): void => {
  it('falls back for an unknown runtime explanation key', (): void => {
    const explanation = {
      key: 'match.unknown.runtime_key',
      params: {},
    };

    assertExplanationFallback(explanation, 'Match criterion');
  });

  it('falls back to Match criterion for object prototype property names as explanation keys', (): void => {
    const prototypeKeys = ['toString', 'valueOf', 'constructor', '__proto__', 'isPrototypeOf'];
    for (const key of prototypeKeys) {
      const explanation = { key, params: {} };
      assertExplanationFallback(explanation, 'Match criterion');
    }
  });

  it('uses the price fallback for unusable runtime percentage parameters', (): void => {
    const testCases: Array<[unknown, string]> = [
      [{ key: 'match.price.below_median' }, 'Below median price'],
      [{ key: 'match.price.below_median', params: null }, 'Below median price'],
      [{ key: 'match.price.below_median', params: 'invalid' }, 'Below median price'],
      [{ key: 'match.price.below_median', params: { percentDiff: '12' } }, 'Below median price'],
      [{ key: 'match.price.below_median', params: { percentDiff: Number.NaN } }, 'Below median price'],
      [{ key: 'match.price.above_median', params: { percentDiff: Number.POSITIVE_INFINITY } }, 'Above median price'],
    ];

    testCases.forEach(([explanation, expected]: [unknown, string]): void => {
      assertExplanationFallback(explanation, expected);
    });
  });

  it('uses the airline fallback for unusable runtime airline parameters', (): void => {
    const testCases: Array<[unknown, string]> = [
      [{ key: 'match.airline.preferred', params: {} }, 'Matches preferred airline'],
      [{ key: 'match.airline.preferred', params: { airline: '' } }, 'Matches preferred airline'],
      [{ key: 'match.airline.preferred', params: { airline: 42 } }, 'Matches preferred airline'],
      [{ key: 'constraint.airline.blacklisted', params: { airline: {} } }, 'Blacklisted airline'],
    ];

    testCases.forEach(([explanation, expected]: [unknown, string]): void => {
      assertExplanationFallback(explanation, expected);
    });
  });

  it('sanitizes preferred airline text without entity encoding and strips HTML tags', (): void => {
    const plainExplanation: Explanation = {
      key: 'match.airline.preferred',
      params: { airline: "Sky's Limit & Oceanic Air" },
    };

    assert.equal(
      formatExplanation(plainExplanation),
      "Matches preferred airline (Sky's Limit & Oceanic Air)",
    );

    const strippedExplanation: Explanation = {
      key: 'match.airline.preferred',
      params: { airline: '<img src=x onerror=alert(1)>' },
    };

    assert.equal(
      formatExplanation(strippedExplanation),
      'Matches preferred airline',
    );
  });

  it('uses the schedule fallback for unusable runtime window bounds', (): void => {
    const testCases: Array<[unknown, string]> = [
      [{ key: 'match.arrival.in_window' }, 'Arrives within preferred window'],
      [{ key: 'match.arrival.in_window', params: null }, 'Arrives within preferred window'],
      [{ key: 'match.arrival.in_window', params: 'invalid' }, 'Arrives within preferred window'],
      [{ key: 'match.arrival.in_window', params: { windowStart: '', windowEnd: 10 } }, 'Arrives within preferred window'],
      [
        {
          key: 'match.arrival.in_window',
          params: { windowStart: Number.NaN, windowEnd: Number.POSITIVE_INFINITY },
        },
        'Arrives within preferred window',
      ],
      [{ key: 'match.departure.in_window', params: { windowStart: {}, windowEnd: 10 } }, 'Departs within preferred window'],
      [{ key: 'match.departure.in_window', params: { windowStart: 8, windowEnd: false } }, 'Departs within preferred window'],
    ];

    testCases.forEach(([explanation, expected]: [unknown, string]): void => {
      assertExplanationFallback(explanation, expected);
    });
  });

  it('formats schedule window as plain text without entity encoding', (): void => {
    const explanation: Explanation = {
      key: 'match.arrival.in_window',
      params: { windowStart: 8, windowEnd: 10 },
    };

    const result = formatExplanation(explanation);
    assert.equal(result, 'Arrives within preferred window (8:00–10:00)');
    assert.doesNotMatch(result, /&#39;|&amp;|&quot;|&lt;|&gt;/);
  });

  it('uses the stops fallback for unusable runtime stop parameters', (): void => {
    const testCases: Array<[unknown, string]> = [
      [{ key: 'match.stops.within_preference' }, 'Within preferred stops'],
      [{ key: 'match.stops.within_preference', params: null }, 'Within preferred stops'],
      [{ key: 'match.stops.within_preference', params: 'invalid' }, 'Within preferred stops'],
      [{ key: 'match.stops.within_preference', params: { stops: -1 } }, 'Within preferred stops'],
      [{ key: 'match.stops.within_preference', params: { stops: 1.5 } }, 'Within preferred stops'],
      [{ key: 'match.stops.exceeds_preference', params: { stops: 2 } }, 'Exceeds preferred stops'],
      [{ key: 'match.stops.exceeds_preference', params: { stops: 2, maxStops: -1 } }, 'Exceeds preferred stops'],
      [{ key: 'match.stops.exceeds_preference', params: { stops: 2, maxStops: '1' } }, 'Exceeds preferred stops'],
      [{ key: 'match.stops.exceeds_preference', params: { stops: '2', maxStops: 1 } }, 'Exceeds preferred stops'],
      [{ key: 'match.stops.relative', params: { stops: Number.NaN } }, 'Flight with stops'],
      [{ key: 'match.stops.relative', params: { stops: {} } }, 'Flight with stops'],
    ];

    testCases.forEach(([explanation, expected]: [unknown, string]): void => {
      assertExplanationFallback(explanation, expected);
    });
  });

  it('formats a price below-median explanation', (): void => {
    const explanation: Explanation = {
      key: 'match.price.below_median',
      params: { percentDiff: 12 },
    };

    assert.equal(formatExplanation(explanation), '12% below median price');
  });

  it('formats at- and above-median price explanations', (): void => {
    const explanations: Array<[Explanation, string]> = [
      [
        { key: 'match.price.at_median', params: {} },
        'At median price',
      ],
      [
        { key: 'match.price.above_median', params: { percentDiff: 8 } },
        '8% above median price',
      ],
    ];

    for (const [explanation, expected] of explanations) {
      assert.equal(formatExplanation(explanation), expected);
    }
  });

  it('formats airline preference explanations', (): void => {
    const explanations: Array<[Explanation, string]> = [
      [
        { key: 'match.airline.preferred', params: { airline: 'SkyJet' } },
        'Matches preferred airline (SkyJet)',
      ],
      [{ key: 'match.airline.neutral', params: {} }, 'Standard airline match'],
    ];

    for (const [explanation, expected] of explanations) {
      assert.equal(formatExplanation(explanation), expected);
    }
  });

  it('formats arrival window explanations', (): void => {
    const explanations: Array<[Explanation, string]> = [
      [
        {
          key: 'match.arrival.in_window',
          params: { windowStart: '8', windowEnd: 11 },
        },
        'Arrives within preferred window (8:00–11:00)',
      ],
      [
        { key: 'match.arrival.near_window', params: {} },
        'Arrives near preferred window',
      ],
      [
        { key: 'match.arrival.outside_window', params: {} },
        'Arrives outside preferred window',
      ],
    ];

    for (const [explanation, expected] of explanations) {
      assert.equal(formatExplanation(explanation), expected);
    }
  });

  it('formats stops preference and relative explanations', (): void => {
    const explanations: Array<[Explanation, string]> = [
      [
        { key: 'match.stops.within_preference', params: { stops: 1 } },
        'Within preferred stops (1 stops)',
      ],
      [
        {
          key: 'match.stops.exceeds_preference',
          params: { stops: 2, maxStops: 1 },
        },
        'Exceeds preferred stops (2 stops, max 1)',
      ],
      [{ key: 'match.stops.relative', params: { stops: 0 } }, 'Direct flight'],
      [{ key: 'match.stops.relative', params: { stops: 3 } }, '3 stops'],
    ];

    for (const [explanation, expected] of explanations) {
      assert.equal(formatExplanation(explanation), expected);
    }
  });

  it('formats cabin match explanations', (): void => {
    const explanations: Array<[Explanation, string]> = [
      [{ key: 'match.cabin.exact', params: {} }, 'Matches requested cabin'],
      [{ key: 'match.cabin.adjacent', params: {} }, 'Adjacent cabin class'],
      [{ key: 'match.cabin.mismatch', params: {} }, 'Cabin mismatch'],
    ];

    for (const [explanation, expected] of explanations) {
      assert.equal(formatExplanation(explanation), expected);
    }
  });

  it('formats departure window explanations', (): void => {
    const explanations: Array<[Explanation, string]> = [
      [
        {
          key: 'match.departure.in_window',
          params: { windowStart: 6, windowEnd: '9' },
        },
        'Departs within preferred window (6:00–9:00)',
      ],
      [
        { key: 'match.departure.near_window', params: {} },
        'Departs near preferred window',
      ],
      [
        { key: 'match.departure.outside_window', params: {} },
        'Departs outside preferred window',
      ],
    ];

    for (const [explanation, expected] of explanations) {
      assert.equal(formatExplanation(explanation), expected);
    }
  });

  it('formats baggage explanations', (): void => {
    const explanations: Array<[Explanation, string]> = [
      [
        { key: 'match.baggage.checked_included', params: {} },
        'Checked bag included',
      ],
      [
        { key: 'match.baggage.checked_missing', params: {} },
        'Checked bag not included',
      ],
      [{ key: 'match.baggage.not_required', params: {} }, 'No baggage requirement'],
    ];

    for (const [explanation, expected] of explanations) {
      assert.equal(formatExplanation(explanation), expected);
    }
  });

  it('formats duration explanations', (): void => {
    const explanations: Array<[Explanation, string]> = [
      [
        { key: 'match.duration.below_median', params: {} },
        'Shorter than median duration',
      ],
      [{ key: 'match.duration.at_median', params: {} }, 'Median duration'],
      [
        { key: 'match.duration.above_median', params: {} },
        'Longer than median duration',
      ],
    ];

    for (const [explanation, expected] of explanations) {
      assert.equal(formatExplanation(explanation), expected);
    }
  });

  it('formats a blacklisted-airline constraint explanation', (): void => {
    const explanation: Explanation = {
      key: 'constraint.airline.blacklisted',
      params: { airline: 'Unsafe Air' },
    };

    assert.equal(formatExplanation(explanation), 'Blacklisted airline (Unsafe Air)');
  });
});
