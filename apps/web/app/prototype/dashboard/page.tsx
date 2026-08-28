import { DashboardPrototype } from './DashboardPrototype';

interface PageProps {
  searchParams?: {
    variant?: string;
  };
}

export default function PrototypeDashboardPage({ searchParams }: PageProps): JSX.Element {
  const variant = searchParams?.variant;

  return <DashboardPrototype initialVariant={variant} />;
}
