import Link from 'next/link';
import styles from './landing-prototype.module.css';

type LandingVariant = 'copilot' | 'orbit' | 'itinerary';

type LandingPrototypeProps = {
  variant?: string;
};

const variantCopy: Record<LandingVariant, { eyebrow: string; title: string; description: string; label: string }> = {
  copilot: {
    eyebrow: 'Your intelligent travel desk',
    title: 'From “I need to go” to cleared for takeoff.',
    description: 'An AI-native flight experience that understands the trip behind the search — then makes the next best move feel obvious.',
    label: 'AI flight copilot',
  },
  orbit: {
    eyebrow: 'Travel, in its next era',
    title: 'The whole world, arranged around your time.',
    description: 'A cinematic, map-led booking experience that turns routes, preferences, and possibilities into one calm decision.',
    label: 'Orbit view',
  },
  itinerary: {
    eyebrow: 'Effortless by design',
    title: 'Your best trip is already taking shape.',
    description: 'A warm, editorial approach to intelligent travel — the system learns what matters and quietly handles the complexity.',
    label: 'Journey builder',
  },
};

function getVariant(variant: string | undefined): LandingVariant {
  if (variant === 'orbit' || variant === 'itinerary') {
    return variant;
  }

  return 'copilot';
}

export function LandingPrototype({ variant }: LandingPrototypeProps): JSX.Element {
  const selectedVariant = getVariant(variant);
  const copy = variantCopy[selectedVariant];

  return (
    <main className={`${styles.page} ${styles[selectedVariant]}`}>
      <p className={styles.prototype}>Prototype — disposable visual exploration, not production UI</p>
      <nav className={styles.nav} aria-label="Prototype navigation">
        <Link className={styles.brand} href="/prototype/landing">wayfinder<span>°</span></Link>
        <div className={styles.navActions}>
          <Link className={styles.login} href="/login">Log in</Link>
          <Link className={styles.signup} href="/register">Create account</Link>
        </div>
      </nav>

      <section className={styles.hero}>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p className={styles.description}>{copy.description}</p>
          <div className={styles.ctaRow}>
            <Link className={styles.primaryCta} href="/login">Log in to explore</Link>
            <Link className={styles.textCta} href="/register">New here? Create an account <span aria-hidden="true">→</span></Link>
          </div>
        </div>
        <div className={styles.visual} aria-label={`${copy.label} visual concept`}>
          {selectedVariant === 'copilot' && <CopilotVisual />}
          {selectedVariant === 'orbit' && <OrbitVisual />}
          {selectedVariant === 'itinerary' && <ItineraryVisual />}
        </div>
      </section>

      <section className={styles.trust} aria-label="Product capabilities">
        <p>Personalized flight intelligence</p><span>•</span><p>Decisions explained clearly</p><span>•</span><p>Booking stays dependable</p>
      </section>

      <div className={styles.variantBar} aria-label="Prototype variants">
        <span>Explore concepts</span>
        {(['copilot', 'orbit', 'itinerary'] as LandingVariant[]).map((item: LandingVariant) => (
          <Link className={item === selectedVariant ? styles.selected : styles.variantLink} href={`/prototype/landing?variant=${item}`} key={item}>
            {variantCopy[item].label}
          </Link>
        ))}
      </div>
    </main>
  );
}

function CopilotVisual(): JSX.Element {
  return <div className={styles.copilotVisual}><div className={styles.glow} /><div className={styles.assistantCard}><p><span>✦</span> Wayfinder knows you prefer</p><h2>Quiet departures<br />with fewer stops.</h2><div className={styles.route}><b>SGN</b><i>⟶</i><b>NRT</b></div><div className={styles.insight}><span>92% match</span><p>Best fit for your pace and preferences.</p></div></div><div className={styles.pulse}>Listening for what matters</div></div>;
}

function OrbitVisual(): JSX.Element {
  return <div className={styles.orbitVisual}><div className={styles.planet} /><div className={styles.orbitLine} /><div className={styles.orbitLineTwo} /><div className={`${styles.city} ${styles.cityOne}`}>Tokyo <small>09:45</small></div><div className={`${styles.city} ${styles.cityTwo}`}>Ho Chi Minh <small>07:10</small></div><div className={styles.mapCard}><p>Route clarity</p><strong>One effortless choice</strong><span>Non-stop · 5h 35m</span></div></div>;
}

function ItineraryVisual(): JSX.Element {
  return <div className={styles.itineraryVisual}><div className={styles.day}><span>08</span><p>Leave room for wonder</p><i>Departure day</i></div><div className={styles.ticket}><p>HO CHI MINH CITY <span>→</span> TOKYO</p><strong>07:10 — 14:45</strong><small>Your ideal morning departure</small></div><div className={styles.day}><span>12</span><p>Take the scenic route home</p><i>Return day</i></div></div>;
}
