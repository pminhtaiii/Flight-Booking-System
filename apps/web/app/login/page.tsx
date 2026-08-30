import Link from 'next/link';
import { LoginForm } from '@/components/auth/LoginForm';
import styles from '@/components/auth/auth-form.module.css';

export default function LoginPage(): JSX.Element {
  return (
    <main className={styles.shell}>
      <section className={styles.card} aria-labelledby="login-title">
        <div className={styles.loginPanel}>
          <Link className={styles.brand} href="/">
            wayfinder<span>°</span>
          </Link>
          <div className={styles.loginContent}>
            <p className={styles.kicker}>Flight workspace</p>
            <h1 className={styles.title} id="login-title">
              Plan the next move.
            </h1>
            <p className={styles.subtitle}>
              Your routes, preferences, and travel intelligence in one place.
            </p>
            <LoginForm />
            <p className={styles.footer}>
              New to Wayfinder?{' '}
              <Link className={styles.footerLink} href="/register">
                Create an account
              </Link>
            </p>
          </div>
        </div>
        <aside className={styles.workspacePanel} aria-hidden="true">
          <div className={styles.workspaceOrb} />
          <div className={styles.workspaceCard}>
            <span>Live route board</span>
            <strong>Three trips, one clear view.</strong>
            <p>Personalized planning, always in context.</p>
          </div>
        </aside>
      </section>
    </main>
  );
}
