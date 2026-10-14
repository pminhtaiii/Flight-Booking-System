'use client';

import { FormEvent, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Lock, Mail } from 'lucide-react';
import styles from './register-form.module.css';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function extractErrorMessage(response: Response): Promise<string> {
  const defaultMessage = 'We could not create your account. Please try again.';
  try {
    const rawData: unknown = await response.json();
    if (isRecord(rawData) && typeof rawData.message === 'string' && rawData.message.trim().length > 0) {
      return rawData.message;
    }
  } catch {
    // Fall back to default error message if response is non-JSON or cannot be read
  }
  return defaultMessage;
}

export function RegisterForm(): JSX.Element {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError('');
    setIsSubmitting(true);

    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      const response = await fetch(`${apiUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const errorMessage = await extractErrorMessage(response);
        setError(errorMessage);
        return;
      }

      const result = await signIn('credentials', { redirect: false, email, password });
      if (result?.error) {
        setError('Your account was created, but we could not sign you in. Please log in.');
        return;
      }

      router.push('/');
      router.refresh();
    } catch {
      setError('We could not create your account. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      {error ? (
        <div className={styles.errorAlert} role="alert">
          {error}
        </div>
      ) : null}

      <div className={styles.fieldGroup}>
        <label className={styles.label} htmlFor="register-email">
          Email Address
        </label>
        <div className={styles.inputWrapper}>
          <Mail className={styles.fieldIcon} aria-hidden="true" />
          <input
            className={styles.input}
            disabled={isSubmitting}
            id="register-email"
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
        <label className={styles.label} htmlFor="register-password">
          Password
        </label>
        <div className={styles.inputWrapper}>
          <Lock className={styles.fieldIcon} aria-hidden="true" />
          <input
            aria-describedby="password-requirements"
            className={`${styles.input} ${styles.passwordInput}`}
            disabled={isSubmitting}
            id="register-password"
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
            type="button"
          >
            {showPassword ? (
              <EyeOff className={styles.toggleIcon} aria-hidden="true" />
            ) : (
              <Eye className={styles.toggleIcon} aria-hidden="true" />
            )}
          </button>
        </div>
        <p className={styles.requirements} id="password-requirements">
          Use at least 8 characters including uppercase, lowercase, a number, and a special character.
        </p>
      </div>

      <div className={styles.submitWrapper}>
        <button
          className={styles.submit}
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </button>
      </div>

      <div className={styles.securityNote}>
        <Lock className={styles.securityIcon} aria-hidden="true" />
        <span>Secured with enterprise TLS encryption</span>
      </div>
    </form>
  );
}
