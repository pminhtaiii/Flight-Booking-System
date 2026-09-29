---
description: Instructions for building the Flight Booking System
globs: *
alwaysApply: true
---

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

## Read Before Anything Else

Read only the context files relevant to the specific task:

- For general understanding or new features: read `context/project-overview.md`.
- For system layout, routing, database, and backend/frontend setup: read `context/architecture.md`.
- For linting, file structure, naming conventions, and code guidelines: read `context/code-standards.md`.
- For third-party library rules and configurations: read `context/library-docs.md`.
- For current progress status: read `context/progress-checker.md`.
- For development lifecycle and workflow steps: read `context/workflow.md`.
- For testing, E2E runner workflows, and pre-PR validation gates: read `context/testing.md`.

## Rules That Never Change

- Always use subagents while doing the implementation or code reviews to avoid context rot.
- Never use hardcoded hex values or raw Tailwind color classes.
- Update all relevant files in the `context/` folder (such as `context/architecture.md` and `context/progress-checker.md`) after completing any feature to ensure project documentation remains in sync with the codebase.
- Before any third party library — load its installed skill first, then read context/library-docs.md for project-specific rules.

## Agent Operating Rules

### Critical Guidelines

- **Stop on Persistent Failure**: If the same problem persists after one corrective prompt — stop immediately, explain the situation, and ask the user for guidance.
- **Third-Party Libraries**: Before using any third-party library, load its installed skill first, then read `context/library-docs.md` for project-specific rules.
- **Context Folder Access**: Avoid reading all files in the `context/` folder by default. Instead, selectively read only the files relevant to the current task to prevent context bloating:
  - If the task is about architecture, data flow, or NestJS/Next.js setup: read `context/architecture.md`.
  - If the task is about coding conventions, directories, or rules: read `context/code-standards.md`.
  - If the task requires using a third-party library: read `context/library-docs.md`.
  - If the task involves updating status/progress: read `context/progress-checker.md`.
  - If the task is a new feature or high-level request: read `context/project-overview.md`.
  - If the task is implementation or requires the TDD workflow: read `context/workflow.md`.
  - If the task involves testing, running E2E suites, or pre-PR validation gates: read `context/testing.md`.
- **Sub-Agent Delegation**: Use specialized sub-agents whenever possible, especially when performing code implementation or code reviews, to optimize task distribution and avoid context bloating.

### Local Development Startup

To run the full stack locally (Next.js frontend, NestJS backend, and Python agent service), follow these instructions:

1. **Docker Services**: Ensure Docker Desktop is active, then start PostgreSQL and Redis:
   ```bash
   docker compose up -d
   ```
2. **Database Setup**: Run migrations and seeding from the workspace root (or using local `prisma` package in `apps/api`):
   ```bash
   pnpm --filter @api/backend exec prisma migrate dev
   pnpm --filter @api/backend exec prisma db seed
   ```
3. **Shared Secrets (.env)**: Ensure both `apps/api/.env` and `apps/agent/.env` contain matching secret configuration variables:
   - `JWT_SECRET` (NextAuth token generation)
   - `AGENT_SERVICE_API_KEY` (Gateway protection)
   - `CLAIM_TOKEN_SECRET` (Agent user claim verification)
4. **Execution**: Start the development servers:
   - **Full Stack (Frontend & Backend concurrently)**: `pnpm dev`
   - **Next.js Frontend only (Port 3000)**: `pnpm --filter @web/frontend dev`
   - **NestJS Backend only (Port 3001)**: `pnpm --filter @api/backend dev`
   - **Python Agent only (Port 3002)**: `uv run uvicorn agent.main:app --port 3002 --app-dir src` inside `apps/agent/`

<!-- SPECKIT START -->
For additional context about technologies, project structure, shell commands,
and other important information, read the current plan at
specs/029-duffel-provider-narrowing/plan.md.
<!-- SPECKIT END -->
