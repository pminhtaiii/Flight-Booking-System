'use client';

import { FormEvent, useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import styles from './auth-form.module.css';

type LockoutError = {
  code?: string;
  message?: string;
  retryAfterSeconds?: number;
};

function parseLockoutError(error: string): LockoutError | null {
  try {
    const parsed: unknown = JSON.parse(error);
    if (typeof parsed === 'object' && parsed !== null && (parsed as LockoutError).code === 'auth_locked') {
      return parsed as LockoutError;
    }
  } catch {
    // Credential failures are normally a plain message.
  }

  return null;
}

export function LoginForm(): JSX.Element {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lockoutSeconds, setLockoutSeconds] = useState(0);

  useEffect(() => {
    if (lockoutSeconds <= 0) return;

    const timer = window.setInterval(() => {
      setLockoutSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [lockoutSeconds]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError('');
    setIsSubmitting(true);

    try {
      const result = await signIn('credentials', { redirect: false, email, password });
      if (result?.error) {
        const lockout = parseLockoutError(result.error);
        if (lockout) {
          setError(lockout.message ?? 'Too many login attempts. Please wait before trying again.');
          setLockoutSeconds(lockout.retryAfterSeconds ?? 60);
          return;
        }

        setError('Invalid email or password.');
        return;
      }

      router.push('/');
      router.refresh();
    } catch {
      setError('We could not sign you in. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const isLocked = lockoutSeconds > 0;

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      {error ? <p className={styles.message} role="alert">{error}</p> : null}
      <div className={styles.field}>
        <label className={styles.label} htmlFor="login-email">Email address</label>
        <input className={styles.input} disabled={isLocked} id="login-email" name="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="login-password">Password</label>
        <input className={styles.input} disabled={isLocked} id="login-password" name="password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
      </div>
      <button className={styles.submit} disabled={isSubmitting || isLocked} type="submit">
        {isLocked ? `Try again in ${lockoutSeconds}s` : isSubmitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
