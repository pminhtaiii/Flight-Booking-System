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
- For testing and build/verification workflows (only read when implementing or testing): read `context/workflow.md`.

## Rules That Never Change

- Always use subagents while doing the implementation or code reviews to avoid context rot.
- Always use caveman to save tokens.
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
  - If the task is implementation, testing, or requires the TDD/E2E workflow: read `context/workflow.md`.
- **Sub-Agent Delegation**: Use specialized sub-agents whenever possible, especially when performing code implementation or code reviews, to optimize task distribution and avoid context bloating.

### E2E Testing Instructions
When the task involves writing, running, or verifying E2E tests:
1. **Locating E2E Tests**:
   - Backend NestJS API E2E tests reside in `apps/api/test/` (e.g., `*.e2e-spec.ts`).
   - Frontend Next.js Playwright UI tests reside in `apps/web/tests/` (e.g., `*.spec.ts`).
2. **Configuration**:
   - Backend E2E uses Jest, configured in `apps/api/test/jest-e2e.json`.
   - Frontend E2E uses Playwright, configured in `apps/web/tests/playwright.config.ts`.
3. **Running E2E Tests**:
   - Backend API E2E tests: run `npm run test:e2e --workspace=apps/api`
   - Frontend Playwright E2E tests: run `npx playwright test --config=apps/web/tests/playwright.config.ts`
4. **Mocking & Test Strategy**:
   - Follow the opaque-box verification strategies defined in [TEST_INFRA.md](file:///c:/Booking%20Systems/TEST_INFRA.md).
   - Use time acceleration (`POST /auth/test/reset-lockout` when `NODE_ENV === 'test'`) and database assertions.

<!-- SPECKIT START -->

Current implementation plan:
specs/001-db-init-auth-handshake/plan.md

<!-- SPECKIT END -->
