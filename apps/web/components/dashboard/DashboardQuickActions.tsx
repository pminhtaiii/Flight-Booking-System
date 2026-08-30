import Link from 'next/link';
import { Calendar, History, Plane, User } from 'lucide-react';
import type { DashboardAction } from './dashboard-actions';

type DashboardQuickActionsProps = {
  actions: DashboardAction[];
};

const icons = {
  plane: Plane,
  calendar: Calendar,
  history: History,
  user: User,
} as const;

export function DashboardQuickActions({ actions }: DashboardQuickActionsProps): JSX.Element {
  return (
    <section aria-label="Quick Actions" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {actions.map((action) => {
        const Icon = icons[action.iconName];

        return (
          <Link
            key={action.id}
            href={action.href}
            className="card flex min-h-28 items-start gap-4 p-5 transition-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <Icon aria-hidden="true" className="h-6 w-6 shrink-0" />
            <span>
              <span className="block font-semibold">{action.label}</span>
              <span className="mt-1 block text-sm text-text-secondary">{action.description}</span>
            </span>
          </Link>
        );
      })}
    </section>
  );
}
