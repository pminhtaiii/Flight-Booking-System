import { LandingPrototype } from './LandingPrototype';

type LandingPrototypePageProps = {
  searchParams: { variant?: string };
};

export default function LandingPrototypePage({ searchParams }: LandingPrototypePageProps): JSX.Element {
  return <LandingPrototype variant={searchParams.variant} />;
}
