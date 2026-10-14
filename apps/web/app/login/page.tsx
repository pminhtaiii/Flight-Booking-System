import Link from 'next/link';
import { LoginForm } from '@/components/auth/LoginForm';
import styles from './login.module.css';

export default function LoginPage(): JSX.Element {
  return (
    <div className={styles.page}>
      {/* Background Pure CSS Atmospheric Viewport */}
      <div className={styles.backgroundViewport} aria-hidden="true">
        <div className={styles.glowTopRight} />
        <div className={styles.glowBottomLeft} />
      </div>

      {/* Top Global Bar */}
      <header className={styles.header}>
        <Link href="/" className={styles.brandLink}>
          <div className={styles.brandIconBox}>
            <svg viewBox="0 0 40 40" className={styles.brandIcon} fill="none" aria-hidden="true">
              <circle cx="20" cy="20" r="17" className={styles.compassCircle} />
              <path d="M20 5 L24 17 L35 20 L24 23 L20 35 L16 23 L5 20 L16 17 Z" className={styles.compassStar} />
              <circle cx="20" cy="20" r="2.5" className={styles.compassDot} />
            </svg>
          </div>
          <div className={styles.brandText}>
            <span className={styles.brandName}>Wayfinder</span>
            <span className={styles.brandDot} />
          </div>
        </Link>

        {/* Top Telemetry Status Chip */}
        <div className={styles.telemetryChip}>
          <span className={styles.telemetryLive}>
            <span className={styles.pulseDot}>
              <span className={styles.pulseDotPing} />
              <span className={styles.pulseDotStatic} />
            </span>
            ADS-B LIVE 1090MHz
          </span>
          <span className={styles.telemetryDivider}>|</span>
          <span className={styles.telemetryNode}>NODE US-WEST-01</span>
          <span className={styles.telemetryDivider}>|</span>
          <span className={styles.telemetryAccuracy}>99.8% GDS ACCURACY</span>
        </div>

        {/* Navigation Actions */}
        <div className={styles.headerActions}>
          <Link href="/" className={styles.headerLinkHome}>
            Home
          </Link>
        </div>
      </header>

      {/* Central Floating Glassmorphism Authentication Card */}
      <main className={styles.main}>
        <section className={styles.card} aria-labelledby="login-title">
          <div className={styles.cardHeader}>
            <svg viewBox="0 0 200 48" className={styles.cardLogoSvg} fill="none" aria-label="Wayfinder Logo">
              <defs>
                <linearGradient id="cardWfGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="var(--wf-primary-container)" />
                  <stop offset="100%" stopColor="var(--wf-secondary-container)" />
                </linearGradient>
                <linearGradient id="cardWfRing" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="var(--wf-primary-container)" stopOpacity="0.8" />
                  <stop offset="100%" stopColor="var(--wf-sky-glow)" stopOpacity="0.2" />
                </linearGradient>
              </defs>
              <g transform="translate(4, 4)">
                <circle cx="20" cy="20" r="18" stroke="url(#cardWfRing)" strokeWidth="2.5" fill="rgba(255,255,255,0.7)" />
                <path d="M20 5 L24 18 L34 20 L24 22 L20 35 L16 22 L6 20 L16 18 Z" fill="url(#cardWfGrad)" />
                <circle cx="20" cy="20" r="3" fill="var(--wf-surface-solid)" />
                <circle cx="20" cy="20" r="1.5" fill="var(--wf-primary-container)" />
              </g>
              <text x="56" y="29" fontFamily="'Outfit', sans-serif" fontWeight="700" fontSize="22" letterSpacing="-0.5" fill="var(--wf-on-surface)">
                Wayfinder
              </text>
              <circle cx="178" cy="24" r="2.5" fill="var(--wf-primary-container)" />
            </svg>
            <h1 className={styles.cardTitle} id="login-title">
              Welcome back
            </h1>
            <p className={styles.cardSubtitle}>
              Enter your credentials to access your account
            </p>
          </div>

          <LoginForm />

          <div className={styles.cardFooter}>
            <p className={styles.cardFooterText}>
              Don&apos;t have an enterprise account?{' '}
              <Link className={styles.cardFooterLink} href="/register">
                Create an account
              </Link>
            </p>
          </div>
        </section>
      </main>

      {/* Bottom Page Footer */}
      <footer className={styles.footer}>
        <div className={styles.footerTelemetry}>
          <span>© 2026 Wayfinder Aero Intelligence Inc.</span>
          <span>•</span>
          <span>FAA Telemetry Protocol v2.8</span>
        </div>
      </footer>
    </div>
  );
}
