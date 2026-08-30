import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDashboardActions } from './dashboard-actions';

test('buildDashboardActions omits Traveler Profile when readiness is disabled', () => {
  const actions = buildDashboardActions({ isBookingReadinessEnabled: false });

  assert.deepEqual(
    actions.map(({ label, href }) => ({ label, href })),
    [
      { label: 'Search Flights', href: '/search' },
      { label: 'Upcoming Trips', href: '/bookings?tab=upcoming' },
      { label: 'Past Bookings', href: '/bookings?tab=past' },
    ],
  );
});

test('buildDashboardActions appends Traveler Profile when readiness is enabled', () => {
  const actions = buildDashboardActions({ isBookingReadinessEnabled: true });

  assert.deepEqual(
    actions.map(({ label, href }) => ({ label, href })),
    [
      { label: 'Search Flights', href: '/search' },
      { label: 'Upcoming Trips', href: '/bookings?tab=upcoming' },
      { label: 'Past Bookings', href: '/bookings?tab=past' },
      { label: 'Traveler Profile', href: '/profile' },
    ],
  );
});

test('every enabled dashboard action has the fields required for rendering', () => {
  for (const readinessEnabled of [false, true]) {
    const actions = buildDashboardActions({
      isBookingReadinessEnabled: readinessEnabled,
    });

    for (const action of actions) {
      assert.ok(action.label);
      assert.ok(action.description);
      // Corrected with user approval: GOAL.md defines the public field as iconName.
      assert.ok(action.iconName);
      assert.ok(action.href);
    }
  }
});
