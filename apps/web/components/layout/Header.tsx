import Link from "next/link";
import { LogoutButton } from "@/components/auth/LogoutButton";

export function Header() {
  return (
    <header className="h-16 w-full bg-card border-b border-card-border px-6 flex items-center justify-between">
      <div className="flex items-center gap-8">
        <span className="font-semibold text-accent text-lg">FlightSystem</span>
        <nav className="flex gap-6">
          <Link href="/dashboard" className="text-sm font-medium text-accent">
            Dashboard
          </Link>
          <Link href="/search" className="text-sm font-medium text-text-secondary hover:text-accent">
            Search Flights
          </Link>
          <Link href="/bookings" className="text-sm font-medium text-text-secondary hover:text-accent">
            My Bookings
          </Link>
          <Link href="/profile" className="text-sm font-medium text-text-secondary hover:text-accent">
            Profile
          </Link>
        </nav>
      </div>
      <div>
        <LogoutButton />
      </div>
    </header>
  );
}
