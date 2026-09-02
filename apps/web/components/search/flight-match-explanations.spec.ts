import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Explanation } from '@shared/types';

import { formatExplanation } from './flight-match-explanations';

describe('formatExplanation', () => {
  it('formats a price below-median explanation', () => {
    const explanation: Explanation = {
      key: 'match.price.below_median',
      params: { percentDiff: 12 },
    };

    assert.equal(formatExplanation(explanation), '12% below median price');
  });

  it('formats at- and above-median price explanations', () => {
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

  it('formats airline preference explanations', () => {
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

  it('formats arrival window explanations', () => {
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

  it('formats stops preference and relative explanations', () => {
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

  it('formats cabin match explanations', () => {
    const explanations: Array<[Explanation, string]> = [
      [{ key: 'match.cabin.exact', params: {} }, 'Matches requested cabin'],
      [{ key: 'match.cabin.adjacent', params: {} }, 'Adjacent cabin class'],
      [{ key: 'match.cabin.mismatch', params: {} }, 'Cabin mismatch'],
    ];

    for (const [explanation, expected] of explanations) {
      assert.equal(formatExplanation(explanation), expected);
    }
  });

  it('formats departure window explanations', () => {
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

  it('formats baggage explanations', () => {
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

  it('formats duration explanations', () => {
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

  it('formats a blacklisted-airline constraint explanation', () => {
    const explanation: Explanation = {
      key: 'constraint.airline.blacklisted',
      params: { airline: 'Unsafe Air' },
    };

    assert.equal(formatExplanation(explanation), 'Blacklisted airline (Unsafe Air)');
  });
});
