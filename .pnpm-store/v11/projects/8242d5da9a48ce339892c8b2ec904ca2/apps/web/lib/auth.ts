import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }

        const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
        try {
          const res = await fetch(`${apiUrl}/api/auth/login`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              email: credentials.email,
              password: credentials.password,
            }),
          });

          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            if (res.status === 429 || data.code === 'auth_locked') {
              throw new Error(
                JSON.stringify({
                  code: 'auth_locked',
                  message: data.message || 'Too many failed attempts. Please wait.',
                  retryAfterSeconds: data.retryAfterSeconds || 60,
                }),
              );
            }
            throw new Error(data.message || 'Invalid email or password');
          }

          const data = await res.json();
          if (data && data.token) {
            return {
              id: data.user.id,
              email: data.user.email,
              accessToken: data.token,
            };
          }
          return null;
        } catch (error: unknown) {
          throw new Error((error as { message?: string })?.message || 'Authentication failed');
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.accessToken = (user as { accessToken?: string }).accessToken;
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (token) {
        (session as { accessToken?: unknown }).accessToken = token.accessToken;
        if (session.user) {
          (session.user as { id?: string }).id = token.id as string;
        }
      }
      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
  session: {
    strategy: 'jwt',
  },
  secret: process.env.NEXTAUTH_SECRET || 'nextauth_test_secret_12345',
};
