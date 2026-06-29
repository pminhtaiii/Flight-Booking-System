# Project: Flight Booking System Monorepo

## Architecture

We use a monorepo setup:

- `apps/api`: NestJS backend. Domain-driven modules, controller -> service -> repository flow.
- `apps/web`: Next.js frontend (App Router). UI layer, uses NextAuth.js credentials provider to communicate with the NestJS API.
- `apps/agent`: Python/FastAPI Agent Service. Handles safety guardrails, LangChain LLM execution, and memory management.
- `packages/shared`: Shared TypeScript types and Zod validation schemas.

Data flow is described in `context/architecture.md`.

## Code Layout

- `apps/api/src/` - NestJS source
- `apps/web/app/` - Next.js App Router source
- `apps/agent/src/` - Python/FastAPI Agent Service source
- `packages/shared/src/` - Shared types/constants
- `prisma/` - Prisma schema and migrations (located in `apps/api/prisma/`)

## Milestones

| #   | Name                                        | Scope                                                                                                 | Dependencies | Status      |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------ | ----------- |
| M1  | Scaffold Monorepo & Shared Infrastructure   | Initialize root config, folders, tsconfigs, and linters. Set up layouts.                              | None         | DONE        |
| M2  | Database Schema & Health Endpoint           | Set up Prisma PostgreSQL User and AuditLog models. Expose health check endpoint.                      | M1           | DONE        |
| M3  | User Registration & PII-Safe Logging        | Implement registration API and UI, Zod schema validation, password hashing, and audit log.            | M2           | DONE        |
| M4  | User Login & Redis Rate-Limited Lockout     | Implement login API and UI, Redis rate-limiting (5 failures), and escalating lockout (1, 2, 4, 8m).   | M3           | DONE        |
| M5  | JWT Session Handshake & Protected Dashboard | Configure NextAuth.js, JWT session strategy, JwtAuthGuard, middleware redirects, and dashboard fetch. | M4           | DONE        |
| M6  | Polish, E2E Verification & Stress Testing   | Unified E2E flow pass, concurrency testing, and linting/type-checking.                                | M5           | DONE        |
| M7  | Chatbot Agent Service                       | Python/FastAPI service with JWT auth, safety guardrails, SSE streaming, memory, and persistence.      | M6           | IN_PROGRESS |

## Interface Contracts

### NestJS Backend ↔ Next.js Frontend

- `POST /auth/register`: `{ email, password }` -> `{ token, user: { id, email } }`
- `POST /auth/login`: `{ email, password }` -> `{ token, user: { id, email } }`
- `POST /auth/logout`: Headers: `Authorization: Bearer <token>` -> `{ success: true }`
- `GET /auth/me`: Headers: `Authorization: Bearer <token>` -> `{ id, email }`
- `GET /health`: JSON response `{ status: "ok" | "degraded" | "down", dependencies: { database: "up" | "down" } }`

### FastAPI Agent Service

- `POST /chat/stream`: Stream SSE response `{ token, done, error }` with JWT auth and guardrails.
- `GET /health`: JSON response `{ status: "ok" | "degraded" | "down", dependencies: { llm, nestjsApi, guardrails } }`
