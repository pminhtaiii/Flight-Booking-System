import Link from 'next/link';
import styles from '@/app/dashboard/dashboard.module.css';

type DashboardShellProps = {
  user: {
    name?: string | null;
    email?: string | null;
  };
  showProfileNavigation?: boolean;
  children: React.ReactNode;
};

const navigationItems = [
  { href: '/dashboard', label: 'Overview', shortLabel: 'Home' },
  { href: '/search', label: 'Search flights', shortLabel: 'Search' },
  { href: '/bookings', label: 'My bookings', shortLabel: 'Bookings' },
] as const;

export function DashboardShell({
  user,
  showProfileNavigation = false,
  children,
}: DashboardShellProps): JSX.Element {
  const displayName = user.name?.trim() || user.email?.trim() || 'Traveler';
  const avatarLabel = displayName.charAt(0).toLocaleUpperCase();
  const visibleNavigationItems = showProfileNavigation
    ? [...navigationItems, { href: '/profile', label: 'Traveler profile', shortLabel: 'Profile' }]
    : navigationItems;

  return (
    <div className={styles.dashboardRoot}>
      <aside className={styles.sidebar} aria-label="Dashboard navigation">
        <Link className={styles.sidebarBrand} href="/dashboard">
          <span className={styles.brandMark} aria-hidden="true">
            W
          </span>
          <span>Wayfinder</span>
        </Link>
        <nav className={styles.sidebarNav}>
          {visibleNavigationItems.map((item) => (
            <Link
              key={item.href}
              className={`${styles.sidebarLink} ${item.href === '/dashboard' ? styles.sidebarLinkCurrent : ''}`}
              href={item.href}
              aria-current={item.href === '/dashboard' ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>

      <div className={styles.contentFrame}>
        <header className={styles.header}>
          <div className={styles.headerContext}>
            <p className={styles.headerSubtitle}>Travel overview</p>
            <h1 className={styles.headerTitle}>Dashboard</h1>
          </div>
          <div className={styles.userBadge} aria-label={`Signed in as ${displayName}`}>
            <span className={styles.userAvatar} aria-hidden="true">
              {avatarLabel}
            </span>
            <span className={styles.userDetails}>
              <span className={styles.userName}>{displayName}</span>
              {user.name?.trim() && user.email?.trim() ? (
                <span className={styles.userEmail}>{user.email}</span>
              ) : null}
            </span>
          </div>
        </header>

        <main id="main-content" className={styles.main}>
          {children}
        </main>
      </div>

      <nav className={styles.mobileNav} aria-label="Mobile dashboard navigation">
        {visibleNavigationItems.map((item) => (
          <Link
            key={item.href}
            className={`${styles.mobileNavLink} ${item.href === '/dashboard' ? styles.mobileNavLinkCurrent : ''}`}
            href={item.href}
            aria-current={item.href === '/dashboard' ? 'page' : undefined}
          >
            {item.shortLabel}
          </Link>
        ))}
      </nav>
    </div>
  );
}
