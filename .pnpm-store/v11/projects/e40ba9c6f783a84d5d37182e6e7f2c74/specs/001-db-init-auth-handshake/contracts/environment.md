# Environment Contract

## API Environment

| Variable          | Required | Purpose                                                          |
| ----------------- | -------- | ---------------------------------------------------------------- |
| `DATABASE_URL`    | Yes      | PostgreSQL connection string for Prisma.                         |
| `REDIS_URL`       | Yes      | Redis connection string for rate limiting and lockout.           |
| `JWT_SECRET`      | Yes      | Signs backend JWT session tokens.                                |
| `NEXTAUTH_SECRET` | Yes      | Shared secret for frontend auth/session validation where needed. |
| `FRONTEND_ORIGIN` | Yes      | Allowed CORS origin for the Next.js app.                         |
| `NODE_ENV`        | Yes      | Runtime environment.                                             |

## Web Environment

| Variable              | Required | Purpose                          |
| --------------------- | -------- | -------------------------------- |
| `NEXT_PUBLIC_API_URL` | Yes      | Public URL for the NestJS API.   |
| `NEXTAUTH_SECRET`     | Yes      | NextAuth/Auth.js session secret. |
| `NEXTAUTH_URL`        | Yes      | Canonical frontend URL.          |

## Secret Rules

- Secrets are read from environment variables only.
- Do not commit `.env.local` files.
- Do not prefix secret values with `NEXT_PUBLIC_`.
- Logs and audit records must not include passwords, JWTs, raw IP addresses, or payment data.

## Local Default Ports

| Service     | Port |
| ----------- | ---- |
| Next.js web | 3000 |
| NestJS API  | 3001 |
| PostgreSQL  | 5432 |
| Redis       | 6379 |
