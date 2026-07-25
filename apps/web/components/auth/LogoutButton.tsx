'use client';

import { signOut, useSession } from 'next-auth/react';

export function LogoutButton() {
  const { data: session } = useSession();

  const handleLogout = async () => {
    let apiUrl = process.env.NEXT_PUBLIC_API_URL;
    if (!apiUrl && process.env.NODE_ENV === 'development') {
      apiUrl = 'http://localhost:3001';
    }

    if (!apiUrl) {
      // eslint-disable-next-line no-console
      console.warn('API URL is missing. Skipping backend logout to prevent token leakage.');
      await signOut({ callbackUrl: '/login' });
      return;
    }

    const token = (session as { accessToken?: string })?.accessToken;
    if (token) {
      try {
        await fetch(`${apiUrl}/api/auth/logout`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Backend logout failed:', err);
      }
    }
    await signOut({ callbackUrl: '/login' });
  };

  return (
    <button onClick={handleLogout} className="btn-secondary">
      Sign Out
    </button>
  );
}
