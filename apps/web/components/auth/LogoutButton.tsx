"use client";

import { signOut, useSession } from "next-auth/react";

export function LogoutButton() {
  const { data: session } = useSession();

  const handleLogout = async () => {
    const token = (session as { accessToken?: string })?.accessToken;
    if (token) {
      try {
        const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
        await fetch(`${apiUrl}/api/auth/logout`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Backend logout failed:", err);
      }
    }
    await signOut({ callbackUrl: "/login" });
  };

  return (
    <button
      onClick={handleLogout}
      className="btn-secondary"
    >
      Sign Out
    </button>
  );
}
