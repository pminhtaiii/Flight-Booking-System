'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { registerSchema } from '@shared/auth/registration.schema';

export function RegisterForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [loading, setLoading] = useState(false);

  const checks = {
    length: password.length >= 8 && password.length <= 128,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    digit: /\d/.test(password),
    special: /[^a-zA-Z0-9]/.test(password),
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});

    // Zod Schema Validation
    const validationResult = registerSchema.safeParse({ email, password });
    if (!validationResult.success) {
      const errors: { email?: string; password?: string } = {};
      validationResult.error.errors.forEach((err) => {
        if (err.path[0] === 'email') {
          errors.email = err.message;
        } else if (err.path[0] === 'password') {
          errors.password = err.message;
        }
      });
      setFieldErrors(errors);
      setError('Please fix the validation errors before submitting.');
      return;
    }

    setLoading(true);

    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
      const res = await fetch(`${apiUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        if (res.status === 409) {
          setError('An account with this email address is already registered.');
        } else {
          const data = await res.json().catch(() => ({}));
          setError(data.message || 'Registration failed');
        }
      } else {
        // Auto-login on success
        const loginRes = await signIn('credentials', {
          redirect: false,
          email,
          password,
        });

        if (loginRes?.error) {
          setError(loginRes.error);
        } else {
          router.push('/dashboard');
          router.refresh();
        }
      }
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {error && (
        <div className="error-message text-danger-foreground text-sm font-medium" role="alert">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-text-primary">Email</label>
        <input
          type="email"
          name="email"
          className={`form-input ${fieldErrors.email ? 'border-danger-border focus:border-danger-border focus:shadow-none' : ''}`}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
        />
        {fieldErrors.email && (
          <span className="text-xs text-danger-foreground">{fieldErrors.email}</span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-text-primary">Password</label>
        <input
          type="password"
          name="password"
          className={`form-input ${fieldErrors.password ? 'border-danger-border focus:border-danger-border focus:shadow-none' : ''}`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          required
        />
        {fieldErrors.password && (
          <span className="text-xs text-danger-foreground">{fieldErrors.password}</span>
        )}

        <div className="flex flex-col gap-1 text-xs mt-2 border border-secondary-border rounded-lg p-2.5 bg-card">
          <p className="text-text-secondary font-medium mb-1">Password Requirements:</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
            <div
              className={`flex items-center gap-1.5 ${checks.length ? 'text-text-confirmed' : 'text-text-secondary'}`}
            >
              <span>{checks.length ? '✓' : '•'}</span>
              <span>8-128 characters</span>
            </div>
            <div
              className={`flex items-center gap-1.5 ${checks.uppercase ? 'text-text-confirmed' : 'text-text-secondary'}`}
            >
              <span>{checks.uppercase ? '✓' : '•'}</span>
              <span>One uppercase letter</span>
            </div>
            <div
              className={`flex items-center gap-1.5 ${checks.lowercase ? 'text-text-confirmed' : 'text-text-secondary'}`}
            >
              <span>{checks.lowercase ? '✓' : '•'}</span>
              <span>One lowercase letter</span>
            </div>
            <div
              className={`flex items-center gap-1.5 ${checks.digit ? 'text-text-confirmed' : 'text-text-secondary'}`}
            >
              <span>{checks.digit ? '✓' : '•'}</span>
              <span>One digit</span>
            </div>
            <div
              className={`flex items-center gap-1.5 ${checks.special ? 'text-text-confirmed' : 'text-text-secondary'}`}
            >
              <span>{checks.special ? '✓' : '•'}</span>
              <span>One special character</span>
            </div>
          </div>
        </div>
      </div>

      <button type="submit" className="btn-primary w-full mt-2" disabled={loading}>
        {loading ? 'Registering...' : 'Register'}
      </button>
    </form>
  );
}
