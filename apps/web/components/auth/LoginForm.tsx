"use client";

import { useState, useEffect } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [lockoutTime, setLockoutTime] = useState(0);

  useEffect(() => {
    if (lockoutTime <= 0) return;
    const timer = setInterval(() => {
      setLockoutTime((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [lockoutTime]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await signIn("credentials", {
        redirect: false,
        email,
        password,
      });

      if (res?.error) {
        try {
          const parsed = JSON.parse(res.error);
          if (parsed.code === "auth_locked") {
            setError(parsed.message || "Too many login attempts. Please wait.");
            setLockoutTime(parsed.retryAfterSeconds || 60);
            return;
          }
        } catch {
          // Keep standard fallback
        }
        setError("Invalid email or password");
      } else {
        router.push("/dashboard");
        router.refresh();
      }
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  const isLocked = lockoutTime > 0;

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
          className="form-input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          disabled={isLocked}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-text-primary">Password</label>
        <input
          type="password"
          name="password"
          className="form-input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          required
          disabled={isLocked}
        />
      </div>
      <button
        type="submit"
        className="btn-primary w-full mt-2"
        disabled={loading || isLocked}
      >
        {isLocked
          ? `Please wait (${lockoutTime}s)`
          : loading
          ? "Signing in..."
          : "Sign In"}
      </button>
    </form>
  );
}
