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

Read in this exact order before any implementation:

1. context/project-overview.md
2. context/architecture.md
3. context/code-standards.md
4. context/library-docs.md
5. context/progress-tracker.md
6. context/workflow.md

## Rules That Never Change

- Always use subagents while doing the implementation or code reviews to avoid context rot.
- Always use caveman to save tokens.
- Never use hardcoded hex values or raw Tailwind color classes.
- Update progress-tracker.md after every feature.
- Before any third party library — load its installed skill first, then read context/library-docs.md for project-specific rules.

## Agent Operating Rules

### Critical Guidelines
- **Stop on Persistent Failure**: If the same problem persists after one corrective prompt — stop immediately, explain the situation, and ask the user for guidance.
- **Third-Party Libraries**: Before using any third-party library, load its installed skill first, then read `context/library-docs.md` for project-specific rules.
- **Context Folder Access**: Read all files in the `context/` folder *except* for `ui_rules.md` and `workflow.md` by default. Only read `workflow.md` when implementing code or dealing with things that need to be tested via unit or integration tests.
- **Sub-Agent Delegation**: Use specialized sub-agents whenever possible, especially when performing code implementation or code reviews, to optimize task distribution and avoid context bloating.

<!-- SPECKIT START -->
Current implementation plan:
specs/001-db-init-auth-handshake/plan.md
<!-- SPECKIT END -->
