'use client';

import { FormEvent, useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import styles from './auth-form.module.css';

type RegisterResponse = { message?: string };

export function RegisterForm(): JSX.Element {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError('');
    setIsSubmitting(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      const response = await fetch(`${apiUrl}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      if (!response.ok) {
        const data: RegisterResponse = await response.json().catch(() => ({}));
        setError(data.message || 'We could not create your account. Please try again.');
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

  return <form className={styles.form} onSubmit={handleSubmit} noValidate>{error ? <p className={styles.message} role="alert">{error}</p> : null}<div className={styles.field}><label className={styles.label} htmlFor="register-email">Email address</label><input className={styles.input} id="register-email" name="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></div><div className={styles.field}><label className={styles.label} htmlFor="register-password">Password</label><input aria-describedby="password-requirements" className={styles.input} id="register-password" name="password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></div><p className={styles.requirements} id="password-requirements">Use at least 8 characters including uppercase, lowercase, a number, and a special character.</p><button className={styles.submit} disabled={isSubmitting} type="submit">{isSubmitting ? 'Creating account…' : 'Create account'}</button></form>;
}
