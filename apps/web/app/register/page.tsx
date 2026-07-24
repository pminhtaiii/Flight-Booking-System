import Link from 'next/link';
import { RegisterForm } from '@/components/auth/RegisterForm';
import styles from '@/components/auth/auth-form.module.css';

export default function RegisterPage(): JSX.Element {
  return (
    <main className={styles.registerShell}>
      <section className={styles.registerCard} aria-labelledby="register-title">
        <div className={styles.registerContent}>
          <Link className={styles.brand} href="/">wayfinder<span>°</span></Link>
          <div className={styles.registerCopy}>
            <p className={styles.registerKicker}>Wayfinder passport</p>
            <h1 className={styles.title} id="register-title">Your passport to better travel.</h1>
            <p className={styles.subtitle}>Begin with a travel profile shaped around you.</p>
            <RegisterForm />
            <p className={styles.footer}>Already have an account? <Link className={styles.footerLink} href="/login">Log in</Link></p>
          </div>
        </div>
        <aside className={styles.passportPanel} aria-hidden="true"><div className={styles.passportMarker} /><div className={styles.passportCard}><span>Departure: wherever</span><strong>The world feels closer from here.</strong><p>Personal travel intelligence, built around you.</p></div></aside>
      </section>
    </main>
  );
}
