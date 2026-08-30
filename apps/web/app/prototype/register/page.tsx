import Link from 'next/link';
import styles from './register-prototype.module.css';

type Props = { searchParams: { variant?: string } };
type Variant = 'workspace' | 'passport' | 'precision';

function variantFrom(value: string | undefined): Variant {
  return value === 'passport' || value === 'precision' ? value : 'workspace';
}

export default function RegisterPrototypePage({ searchParams }: Props): JSX.Element {
  const variant = variantFrom(searchParams.variant);
  const copy =
    variant === 'passport'
      ? [
          'Your passport to better travel.',
          'Begin with a travel profile shaped around you.',
          'Create my passport',
        ]
      : variant === 'precision'
        ? ['Create your workspace.', 'A precise start to more effortless travel.', 'Create account']
        : [
            'Build your travel profile.',
            'Tell Wayfinder how you like to move through the world.',
            'Start workspace',
          ];
  return (
    <main className={`${styles.page} ${styles[variant]}`}>
      <p className={styles.note}>Prototype — no account is created · selected: {variant}</p>
      <section className={styles.panel}>
        <div className={styles.content}>
          <p className={styles.eyebrow}>
            {variant === 'passport'
              ? 'Wayfinder passport'
              : variant === 'precision'
                ? 'Member setup'
                : 'Travel workspace'}
          </p>
          <h1>{copy[0]}</h1>
          <p>{copy[1]}</p>
          <div className={styles.form}>
            <label>
              Email address
              <input placeholder="you@example.com" type="email" />
            </label>
            <label>
              Create password
              <input placeholder="At least 8 characters" type="password" />
            </label>
            <button type="button">{copy[2]}</button>
          </div>
          <small>
            Already a member? <span>Log in →</span>
          </small>
        </div>
        <div className={styles.visual} aria-hidden="true">
          <div className={styles.marker} />
          <div className={styles.info}>
            <b>
              {variant === 'precision'
                ? '01 / Account'
                : variant === 'passport'
                  ? 'Departure: wherever'
                  : 'Profile in progress'}
            </b>
            <strong>
              {variant === 'workspace'
                ? 'Your preferences become better routes.'
                : variant === 'passport'
                  ? 'The world feels closer from here.'
                  : 'A calm start, by design.'}
            </strong>
          </div>
        </div>
      </section>
      <nav className={styles.bar}>
        {(['workspace', 'passport', 'precision'] as Variant[]).map((item) => (
          <Link
            className={item === variant ? styles.active : styles.link}
            href={`/prototype/register?variant=${item}`}
            key={item}
          >
            {item}
          </Link>
        ))}
      </nav>
    </main>
  );
}
