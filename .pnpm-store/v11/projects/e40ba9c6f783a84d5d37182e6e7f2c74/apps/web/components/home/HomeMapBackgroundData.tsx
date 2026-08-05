import { getAllAirports } from '@/lib/airport-service';
import { HomeMapBackground } from './HomeMapBackground';

export async function HomeMapBackgroundData(): Promise<JSX.Element> {
  const airports = await getAllAirports();

  return <HomeMapBackground airports={airports} />;
}
