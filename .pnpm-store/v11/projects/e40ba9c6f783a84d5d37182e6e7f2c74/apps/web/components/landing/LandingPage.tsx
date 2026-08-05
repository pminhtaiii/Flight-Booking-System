import Link from 'next/link';
import styles from './landing-page.module.css';

export function LandingPage(): JSX.Element {
  return (
    <main className={styles.page}>
      <nav className={styles.navigation} aria-label="Primary navigation">
        <Link className={styles.brand} href="/">
          wayfinder<span>°</span>
        </Link>
        <div className={styles.navigationActions}>
          <Link className={styles.loginLink} href="/login">Log in</Link>
          <Link className={styles.registerLink} href="/register">Create account</Link>
        </div>
      </nav>

      <section className={styles.hero} aria-labelledby="landing-title">
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Your intelligent travel desk</p>
          <h1 id="landing-title">From “I need to go” to cleared for takeoff.</h1>
          <p className={styles.description}>
            An AI-native flight experience that understands the trip behind the search — then makes the next best move feel obvious.
          </p>
          <div className={styles.heroActions}>
            <Link className={styles.primaryAction} href="/login">Log in to explore</Link>
            <Link className={styles.secondaryAction} href="/register">New here? Create an account <span aria-hidden="true">→</span></Link>
          </div>
        </div>

        <div className={styles.visual} aria-hidden="true">
          <div className={styles.visualGlow} />
          <div className={styles.assistantCard}>
            <p><span>✦</span> Wayfinder knows you prefer</p>
            <h2>Quiet departures<br />with fewer stops.</h2>
            <div className={styles.route}><b>SGN</b><span>⟶</span><b>NRT</b></div>
            <div className={styles.insight}>
              <strong>92% match</strong>
              <p>Best fit for your pace and preferences.</p>
            </div>
          </div>
          <p className={styles.visualCaption}>Listening for what matters</p>
        </div>
      </section>

      <section className={styles.reassurance} aria-label="Wayfinder principles">
        <p>Personalized flight intelligence</p><span aria-hidden="true">•</span><p>Decisions explained clearly</p><span aria-hidden="true">•</span><p>Booking stays dependable</p>
      </section>
    </main>
  );
}
