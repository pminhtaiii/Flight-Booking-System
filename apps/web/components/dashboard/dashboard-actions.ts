export type DashboardAction = {
  label: string;
  description: string;
  icon: string;
  href: string;
};

export type BuildDashboardActionsOptions = {
  isBookingReadinessEnabled?: boolean;
};

export function buildDashboardActions(options?: BuildDashboardActionsOptions): DashboardAction[] {
  const actions: DashboardAction[] = [
    {
      label: 'Search Flights',
      description: 'Search and book available flights across routes',
      icon: 'search',
      href: '/search',
    },
    {
      label: 'Upcoming Trips',
      description: 'Review schedules, check-in, and manage upcoming bookings',
      icon: 'calendar',
      href: '/bookings?tab=upcoming',
    },
    {
      label: 'Past Bookings',
      description: 'Access receipts and review past travel history',
      icon: 'history',
      href: '/bookings?tab=past',
    },
  ];

  if (options?.isBookingReadinessEnabled) {
    actions.push({
      label: 'Traveler Profile',
      description: 'Update personal details, preferences, and documents',
      icon: 'user',
      href: '/profile',
    });
  }

  return actions;
}
