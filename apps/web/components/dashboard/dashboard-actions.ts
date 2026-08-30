export type DashboardAction = {
  id: string;
  label: string;
  href: string;
  description: string;
  iconName: 'plane' | 'calendar' | 'history' | 'user';
};

const baseActions: DashboardAction[] = [
  {
    id: 'search',
    label: 'Search Flights',
    href: '/search',
    description: 'Find and compare real-time flight offers',
    iconName: 'plane',
  },
  {
    id: 'upcoming',
    label: 'Upcoming Trips',
    href: '/bookings?tab=upcoming',
    description: 'Manage and review confirmed itineraries',
    iconName: 'calendar',
  },
  {
    id: 'past',
    label: 'Past Bookings',
    href: '/bookings?tab=past',
    description: 'View flight history and past receipts',
    iconName: 'history',
  },
];

const profileAction: DashboardAction = {
  id: 'profile',
  label: 'Traveler Profile',
  href: '/profile',
  description: 'Manage travel documents and booking readiness',
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
