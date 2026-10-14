'use client';

import { FormEvent, useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Lock, Mail } from 'lucide-react';
import styles from './login-form.module.css';

type LockoutError = {
  code?: string;
  message?: string;
  retryAfterSeconds?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLockoutError(error: string): LockoutError | null {
  try {
    const parsed: unknown = JSON.parse(error);
    if (isRecord(parsed) && parsed.code === 'auth_locked') {
      const message = typeof parsed.message === 'string' ? parsed.message : undefined;
      const retryAfterSeconds =
        typeof parsed.retryAfterSeconds === 'number' ? parsed.retryAfterSeconds : undefined;
      return {
        code: 'auth_locked',
        message,
        retryAfterSeconds,
      };
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
  const [showPassword, setShowPassword] = useState(false);
  const [rememberDevice, setRememberDevice] = useState(true);
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
    if (lockoutSeconds > 0) return;
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
      {error ? (
        <div className={styles.errorAlert} role="alert">
          {error}
        </div>
      ) : null}

      <div className={styles.fieldGroup}>
        <label className={styles.label} htmlFor="login-email">
          Email Address
        </label>
        <div className={styles.inputWrapper}>
          <Mail className={styles.fieldIcon} aria-hidden="true" />
          <input
            className={styles.input}
            disabled={isSubmitting || isLocked}
            id="login-email"
            name="email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@company.com"
            required
            type="email"
            value={email}
          />
        </div>
      </div>

      <div className={styles.fieldGroup}>
        <label className={styles.label} htmlFor="login-password">
          Password
        </label>
        <div className={styles.inputWrapper}>
          <Lock className={styles.fieldIcon} aria-hidden="true" />
          <input
            className={`${styles.input} ${styles.passwordInput}`}
            disabled={isSubmitting || isLocked}
            id="login-password"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••••••"
            required
            type={showPassword ? 'text' : 'password'}
            value={password}
          />
          <button
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            className={styles.passwordToggle}
            onClick={() => setShowPassword((prev) => !prev)}
            tabIndex={-1}
            type="button"
          >
            {showPassword ? (
              <EyeOff className={styles.toggleIcon} aria-hidden="true" />
            ) : (
              <Eye className={styles.toggleIcon} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      <div className={styles.optionsRow}>
        <label className={styles.rememberLabel}>
          <input
            checked={rememberDevice}
            className={styles.checkbox}
            name="remember"
            onChange={(event) => setRememberDevice(event.target.checked)}
            type="checkbox"
          />
          <span>Remember this device</span>
        </label>
        <a className={styles.forgotLink} href="#">
          Forgot password?
        </a>
      </div>

      <div className={styles.submitWrapper}>
        <button
          className={styles.submit}
          disabled={isSubmitting || isLocked}
          type="submit"
        >
          {isLocked
            ? `Try again in ${lockoutSeconds}s`
            : isSubmitting
            ? 'Signing in…'
            : 'Sign in'}
        </button>
      </div>

      <div className={styles.securityNote}>
        <Lock className={styles.securityIcon} aria-hidden="true" />
        <span>Protected by enterprise end-to-end encryption</span>
      </div>
    </form>
  );
}
