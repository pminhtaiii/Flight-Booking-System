import Link from 'next/link';
import styles from './login-prototype.module.css';

type Props = { searchParams: { variant?: string } };
type Variant = 'glass' | 'copilot' | 'terminal' | 'editorial' | 'minimal' | 'workspace';

function selectedVariant(value: string | undefined): Variant {
  return value === 'copilot' || value === 'terminal' || value === 'editorial' || value === 'minimal' || value === 'workspace' ? value : 'glass';
}

export default function LoginPrototypePage({ searchParams }: Props): JSX.Element {
  const variant = selectedVariant(searchParams.variant);
  const copy = variant === 'editorial' ? ['Make room for the unexpected.', 'A considered beginning to your next escape.', 'Sign in and wander'] : variant === 'minimal' ? ['Private access.', 'Your travel details, kept beautifully simple.', 'Unlock Wayfinder'] : variant === 'workspace' ? ['Plan the next move.', 'Your routes, preferences, and travel intelligence in one place.', 'Open workspace'] : variant === 'glass' ? ['Welcome back.', 'Your next journey is waiting.', 'Continue to Wayfinder'] : variant === 'copilot' ? ['Where would you like to go next?', 'Your travel copilot is ready when you are.', 'Meet your copilot'] : ['Ready for departure.', 'Access your travel desk.', 'Enter terminal'];
  return <main className={`${styles.page} ${styles[variant]}`}><p className={styles.prototype}>Prototype — visual exploration only · selected: {variant}</p><section className={styles.shell}><div className={styles.brand}>wayfinder<span>°</span></div><div className={styles.content}><p className={styles.eyebrow}>{variant === 'terminal' ? 'Passenger access' : variant === 'copilot' ? 'Travel intelligence' : 'Private travel desk'}</p><h1>{copy[0]}</h1><p className={styles.subtitle}>{copy[1]}</p><div className={styles.form} aria-label="Prototype login form"><label>Email address<input placeholder="you@example.com" type="email" /></label><label>Password<input placeholder="••••••••" type="password" /></label><button type="button">{copy[2]}</button></div><p className={styles.footer}>New to Wayfinder? <span>Create an account →</span></p></div><div className={styles.art} aria-hidden="true"><div className={styles.orb} /><div className={styles.card}><span>{variant === 'terminal' ? 'SGN → NRT' : '✦ PERSONALIZED'}</span><strong>{variant === 'copilot' ? 'A quieter route, chosen for you.' : variant === 'terminal' ? 'Gate 07 · On time' : 'Travel, made clear.'}</strong></div></div></section><nav className={styles.switcher} aria-label="Prototype variants"><span>Compare</span>{(['glass','copilot','terminal'] as Variant[]).map((item) => <Link className={item === variant ? styles.active : styles.link} href={`/prototype/login?variant=${item}`} key={item}>{item}</Link>)}</nav></main>;
}
