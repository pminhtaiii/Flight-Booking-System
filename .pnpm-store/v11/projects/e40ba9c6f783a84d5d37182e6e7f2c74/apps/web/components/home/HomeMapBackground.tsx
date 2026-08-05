'use client';

import dynamic from 'next/dynamic';
import type { Airport } from '@shared/types';

type Props = {
  airports: Airport[];
};

const HomeMapBackgroundInner = dynamic(
  () => import('./HomeMapBackgroundInner').then((module) => module.HomeMapBackgroundInner),
  { loading: () => null, ssr: false },
);

export function HomeMapBackground({ airports }: Props): JSX.Element {
  return <HomeMapBackgroundInner airports={airports} />;
}
