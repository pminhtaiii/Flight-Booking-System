'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from './dashboard-prototype.module.css';

export type DashboardVariant = 'glassmorphic' | 'command' | 'zenith';

interface DashboardPrototypeProps {
  initialVariant?: string;
}

const variants: { key: DashboardVariant; label: string }[] = [
  { key: 'glassmorphic', label: '1 — Stitch Screen 69ae01 (Atmospheric Depth)' },
  { key: 'command', label: '2 — Flightdeck Executive' },
  { key: 'zenith', label: '3 — Zenith Minimalist' },
];

export function DashboardPrototype({
  initialVariant = 'glassmorphic',
}: DashboardPrototypeProps): JSX.Element {
  const router = useRouter();
  const validVariant: DashboardVariant =
    initialVariant === 'command' || initialVariant === 'zenith' ? initialVariant : 'glassmorphic';

  const currentIndex = variants.findIndex((v) => v.key === validVariant);

  const switchVariant = (newVariant: DashboardVariant) => {
    router.replace(`/prototype/dashboard?variant=${newVariant}`);
  };

  const cycleNext = () => {
    const nextIdx = (currentIndex + 1) % variants.length;
    switchVariant(variants[nextIdx].key);
  };

  const cyclePrev = () => {
    const prevIdx = (currentIndex - 1 + variants.length) % variants.length;
    switchVariant(variants[prevIdx].key);
  };

  return (
    <div className={styles.pageWrapper}>
      {/* Prototype Banner */}
      <div className={styles.prototypeBanner}>
        Wayfinder Dashboard Prototype · Stitch Screen: 69ae01acbacf · {variants[currentIndex].label}
      </div>

      {/* SideNavBar Shared Component */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarLogo}>✦</div>
          <div>
            <h1 className={styles.sidebarTitle}>Wayfinder</h1>
            <p className={styles.sidebarSubtitle}>Intelligent Travel Desk</p>
          </div>
        </div>

        <nav className={styles.sidebarNav}>
          <Link className={`${styles.navItem} ${styles.navItemActive}`} href="/prototype/dashboard">
            <span>🏠</span>
            <span>Dashboard</span>
          </Link>
          <Link className={styles.navItem} href="/search">
            <span>✈️</span>
            <span>Search Flights</span>
          </Link>
          <Link className={styles.navItem} href="/bookings">
            <span>📅</span>
            <span>My Bookings</span>
          </Link>
          <Link className={styles.navItem} href="/prototype/chat">
            <span>🛡️</span>
            <span>Disruption Center</span>
          </Link>
          <Link className={styles.navItem} href="/profile">
            <span>⚙️</span>
            <span>Settings</span>
          </Link>
        </nav>
      </aside>

      {/* Main Content Area */}
      <main className={styles.mainContent}>
        {/* TopNavBar Shared Component */}
        <header className={styles.topNav}>
          <div className={styles.searchWrap}>
            <span className={styles.searchIcon}>🔍</span>
            <input
              className={styles.searchInput}
              placeholder="Search flights, bookings, destinations..."
              type="text"
            />
          </div>

          <div className={styles.topActions}>
            <button className={styles.iconBtn} aria-label="Notifications">
              🔔
              <span className={styles.notifDot} />
            </button>
            <div className={styles.avatar} title="Alex Morgan">
              AM
            </div>
          </div>
        </header>

        {/* Dashboard Body Content */}
        <div className={styles.dashboardContainer}>
          {/* 1. Hero Welcome */}
          <section className={styles.heroSection}>
            <div>
              <h1 className={styles.heroHeadline}>
                Find Your Way. <span className={styles.gradientText}>Do More.</span>
              </h1>
              <p className={styles.heroSubtitle}>
                Your intelligent travel desk is ready. You have <strong>2 upcoming flights</strong>{' '}
                and 1 trip pending confirmation.
              </p>
            </div>

            {/* Quick Search Glass Card */}
            <div className={`${styles.glassCard} ${styles.quickSearchBox}`}>
              <div className={styles.searchField}>
                <span className={styles.fieldIcon}>🛫</span>
                <input
                  className={styles.fieldInput}
                  defaultValue="SGN (Ho Chi Minh)"
                  placeholder="Origin"
                />
              </div>
              <div className={styles.searchField}>
                <span className={styles.fieldIcon}>🛬</span>
                <input
                  className={styles.fieldInput}
                  defaultValue="HND (Tokyo Haneda)"
                  placeholder="Destination"
                />
              </div>
              <div className={styles.searchField}>
                <span className={styles.fieldIcon}>📅</span>
                <input className={styles.fieldInput} type="date" defaultValue="2026-09-15" />
              </div>
              <button className={styles.searchSubmitBtn}>
                <span>🔍</span> Search Flights
              </button>
            </div>
          </section>

          {/* 2. Stats & 3. Quick Actions Grid (Top Split) */}
          <div className={styles.topSplitGrid}>
            {/* Stats (2x2) */}
            <section className={styles.stats2x2}>
              <div className={`${styles.glassCard} ${styles.statCard}`}>
                <div className={styles.statTop}>
                  <span>Total Bookings</span>
                  <span>📦</span>
                </div>
                <div className={styles.statNumber}>14</div>
                <div className={styles.statDelta}>
                  <span>▲</span> +2 this month
                </div>
              </div>

              <div className={`${styles.glassCard} ${styles.statCard}`}>
                <div className={styles.statTop}>
                  <span>Upcoming</span>
                  <span>✈️</span>
                </div>
                <div className={styles.statNumber}>2</div>
                <p style={{ fontSize: '12px', color: '#41474f', marginTop: '4px' }}>
                  Next: SGN → HND in 4 days
                </p>
              </div>

              <div className={`${styles.glassCard} ${styles.statCard}`}>
                <div className={styles.statTop}>
                  <span>Completed</span>
                  <span>✅</span>
                </div>
                <div className={styles.statNumber}>11</div>
                <p style={{ fontSize: '12px', color: '#41474f', marginTop: '4px' }}>
                  Across 6 countries
                </p>
              </div>

              <div className={`${styles.glassCard} ${styles.statCard}`}>
                <div className={styles.shieldGlow} />
                <div className={styles.statTop} style={{ position: 'relative', zIndex: 2 }}>
                  <span>Disruption Shield</span>
                  <span>🛡️</span>
                </div>
                <div className={styles.statNumber} style={{ position: 'relative', zIndex: 2 }}>
                  100%
                </div>
                <p className={styles.statDelta} style={{ position: 'relative', zIndex: 2 }}>
                  Active / Protected
                </p>
              </div>
            </section>

            {/* Quick Actions (2x2) */}
            <section className={styles.quickActions2x2}>
              <Link
                className={`${styles.glassCard} ${styles.glassHover} ${styles.actionTile}`}
                href="/search"
              >
                <div className={`${styles.actionIconBubble} ${styles.iconPrimary}`}>🔍</div>
                <span className={styles.actionTitle}>Search Flights</span>
              </Link>

              <Link
                className={`${styles.glassCard} ${styles.glassHover} ${styles.actionTile}`}
                href="/bookings"
              >
                <div className={`${styles.actionIconBubble} ${styles.iconSecondary}`}>📋</div>
                <span className={styles.actionTitle}>Manage Itinerary</span>
              </Link>

              <Link
                className={`${styles.glassCard} ${styles.glassHover} ${styles.actionTile}`}
                href="/prototype/chat"
              >
                <div className={`${styles.actionIconBubble} ${styles.iconTertiary}`}>✦</div>
                <span className={styles.actionTitle}>AI Travel Assistant</span>
              </Link>

              <Link
                className={`${styles.glassCard} ${styles.glassHover} ${styles.actionTile}`}
                href="/prototype/chat"
              >
                <div className={`${styles.actionIconBubble} ${styles.iconError}`}>⚠️</div>
                <span className={styles.actionTitle}>Disruption Center</span>
              </Link>
            </section>
          </div>

          {/* 4. Bottom Split: Timeline & Insights */}
          <div className={styles.bottomSplitGrid}>
            {/* Timeline */}
            <section className={`${styles.glassCard} ${styles.timelineCard}`}>
              <div className={styles.cardHeader}>
                <span>Recent Activity</span>
                <Link
                  href="/bookings"
                  style={{ fontSize: '13px', color: '#0051d5', textDecoration: 'none' }}
                >
                  All bookings →
                </Link>
              </div>

              <div className={styles.timelineItem}>
                <div className={styles.timelineRoute}>
                  <span>SGN</span>
                  <span style={{ color: '#94a3b8' }}>⟶</span>
                  <span>HND</span>
                  <span className={styles.flightPill}>VN 300</span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span className={`${styles.statusPill} ${styles.statusConfirmed}`}>
                    Confirmed
                  </span>
                  <div style={{ fontSize: '11px', color: '#41474f', marginTop: '2px' }}>
                    Departs in 4 days
                  </div>
                </div>
              </div>

              <div className={styles.timelineItem}>
                <div className={styles.timelineRoute}>
                  <span>HAN</span>
                  <span style={{ color: '#94a3b8' }}>⟶</span>
                  <span>DAD</span>
                  <span className={styles.flightPill}>VN 165</span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span className={`${styles.statusPill} ${styles.statusCompleted}`}>
                    Completed
                  </span>
                  <div style={{ fontSize: '11px', color: '#41474f', marginTop: '2px' }}>
                    Aug 18, 2026
                  </div>
                </div>
              </div>

              <div className={styles.timelineItem}>
                <div className={styles.timelineRoute}>
                  <span>SGN</span>
                  <span style={{ color: '#94a3b8' }}>⟶</span>
                  <span>SIN</span>
                  <span className={styles.flightPill}>SQ 178</span>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span className={`${styles.statusPill} ${styles.statusCancelled}`}>
                    Cancelled
                  </span>
                  <div style={{ fontSize: '11px', color: '#41474f', marginTop: '2px' }}>
                    Refund Settled
                  </div>
                </div>
              </div>
            </section>

            {/* Insights Column */}
            <section className={styles.insightsColumn}>
              <div className={`${styles.glassCard} ${styles.insightCard}`}>
                <span className={styles.insightTag}>✦ AI Route Match</span>
                <h3 className={styles.insightHeading}>Tokyo Autumn Fares Dropped 18%</h3>
                <p className={styles.insightBody}>
                  Fares for SGN → HND are currently 18% lower for October departures matching your
                  morning flight preference.
                </p>
              </div>

              <div className={`${styles.glassCard} ${styles.insightCard}`}>
                <span className={styles.insightTag}>💺 Seat Recommendation</span>
                <h3 className={styles.insightHeading}>Window Seat 14A Available</h3>
                <p className={styles.insightBody}>
                  Your preferred window seat just opened up on flight VN 300. You can select it
                  directly from your booking management page.
                </p>
              </div>
            </section>
          </div>
        </div>
      </main>

      {/* Floating Variant Switcher */}
      <nav className={styles.prototypeSwitcher} aria-label="Prototype switcher">
        <button className={styles.switcherBtn} onClick={cyclePrev} aria-label="Previous variant">
          ←
        </button>
        <span className={styles.switcherLabel}>Variant: {variants[currentIndex].label}</span>
        <button className={styles.switcherBtn} onClick={cycleNext} aria-label="Next variant">
          →
        </button>
      </nav>
    </div>
  );
}
