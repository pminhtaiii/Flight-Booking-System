---
description: Instructions for building the Flight Booking System
globs: *
alwaysApply: true
---

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

## Agent Operating Rules

### Critical Guidelines
- **Stop on Persistent Failure**: If the same problem persists after one corrective prompt — stop immediately, explain the situation, and ask the user for guidance.
- **Third-Party Libraries**: Before using any third-party library, load its installed skill first, then read `context/library-docs.md` for project-specific rules.