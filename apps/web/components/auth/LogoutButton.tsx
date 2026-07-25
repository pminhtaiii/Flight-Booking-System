'use client';

import { useState } from 'react';
import { signOut, useSession } from 'next-auth/react';

export function LogoutButton() {
  const { data: session } = useSession();
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const handleLogout = async () => {
    setLogoutError(null);
    const apiUrl = typeof window !== 'undefined' && (window as unknown as { __MOCK_MISSING_API_URL__?: boolean }).__MOCK_MISSING_API_URL__
      ? undefined
      : process.env.NEXT_PUBLIC_API_URL;

    const token = (session as { accessToken?: string })?.accessToken;
    if (!apiUrl || !token) {
      setLogoutError('We could not securely sign you out. Please try again.');
      return;
    }

    try {
      const response = await fetch(`${apiUrl}/api/auth/logout`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) {
        throw new Error(`Backend logout failed with status ${response.status}`);
      }
      await signOut({ callbackUrl: '/login' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Backend logout failed:', err);
      setLogoutError('We could not securely sign you out. Please try again.');
    }
  };

  return (
    <div>
      {logoutError ? <p role="alert">{logoutError}</p> : null}
      <button onClick={handleLogout} className="btn-secondary">
        Sign Out
      </button>
    </div>
  );
}
