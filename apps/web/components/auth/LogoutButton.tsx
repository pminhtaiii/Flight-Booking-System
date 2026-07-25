'use client';

import { useState } from 'react';
import { signOut, useSession } from 'next-auth/react';

export function LogoutButton() {
  const { data: session } = useSession();
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const handleLogout = async () => {
    setLogoutError(null);
    const token = (session as { accessToken?: string })?.accessToken;

    try {
      const configRes = await fetch('/api/config');
      if (!configRes.ok) {
        throw new Error('Failed to load configuration');
      }
      const { apiUrl } = await configRes.json();

      if (!apiUrl || !token) {
        setLogoutError('We could not securely sign you out. Please try again.');
        return;
      }

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
