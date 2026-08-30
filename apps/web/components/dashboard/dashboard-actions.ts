export type DashboardAction = {
  id: string;
  label: string;
  href: string;
  description: string;
  iconName: 'plane' | 'calendar' | 'history' | 'user';
};

const baseActions: DashboardAction[] = [
  {
    id: 'search-flights',
    label: 'Search Flights',
    href: '/search',
    description: 'Find your next flight',
    iconName: 'plane',
  },
  {
    id: 'upcoming-trips',
    label: 'Upcoming Trips',
    href: '/bookings?tab=upcoming',
    description: 'View your upcoming bookings',
    iconName: 'calendar',
  },
  {
    id: 'past-bookings',
    label: 'Past Bookings',
    href: '/bookings?tab=past',
    description: 'Review your past bookings',
    iconName: 'history',
  },
];

const profileAction: DashboardAction = {
  id: 'traveler-profile',
  label: 'Traveler Profile',
  href: '/profile',
  description: 'Manage your traveler details',
  iconName: 'user',
};

export function buildDashboardActions(options?: {
  isBookingReadinessEnabled?: boolean;
}): DashboardAction[] {
  if (options?.isBookingReadinessEnabled !== true) {
    return [...baseActions];
  }

  return [...baseActions, profileAction];
}
