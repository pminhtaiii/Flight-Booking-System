# AI Copilot Landing Page Implementation Plan

**Branch**: `feature/ai-copilot-landing` | **Date**: 2026-07-23 | **Spec**: [spec.md](./spec.md)

## Summary

Replace the blank root page with the approved AI Flight Copilot landing experience. Keep the page presentation-only: it reuses `/login` and `/register` as links and makes no request to the backend, supplier, booking, payment, or AI systems.

## Technical Context

**Language/Version**: TypeScript with strict compiler settings

**Primary Dependencies**: Next.js App Router and React; no new dependency

**Storage**: N/A

**Testing**: Frontend typecheck plus a focused browser verification of the public root route at desktop and mobile widths

**Target Platform**: Modern desktop and mobile browsers

**Project Type**: Next.js frontend within a monorepo

**Performance Goals**: The public page loads without a network data dependency and displays both authentication actions in the initial viewport on a typical laptop viewport.

**Constraints**: Do not restore removed legacy components or global styles; do not hardcode hex values or use raw Tailwind colors; do not introduce a backend call; use semantic links and keyboard-visible focus styles.

**Scale/Scope**: One public route and one co-located presentational component/style module; no API, data model, or authentication changes.

## Constitution Check

_GATE: Passed._

- **Flight-First Architecture**: The page promotes flight travel only and does not add hotels, restaurants, or other trip steps.
- **Deterministic Transaction Boundary**: AI is described as advisory; no AI participates in a transaction.
- **API Budget Discipline**: The page makes no supplier request.
- **Observability & Operational Visibility**: No service boundary or runtime workflow changes.
- **Incremental Delivery**: The root page is a separately testable, deployable presentation slice.

## Project Structure

```text
apps/web/
├── app/
│   ├── page.tsx                              # Root route; composes the landing presentation
│   └── landing/
│       ├── LandingPage.tsx                   # Presentation-only AI Copilot hero and actions
│       └── landing-page.module.css           # Scoped responsive visual tokens and styles
└── tests/
    └── landing-page.spec.ts                  # Focused public-route browser checks, if the Playwright harness is restored

specs/013-ai-copilot-landing/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── contracts/ui.md
├── quickstart.md
└── tasks.md
```

**Structure Decision**: Keep the page shell minimal and move the visual implementation into one focused component plus CSS module. This works independently of the deleted global stylesheet and avoids rebuilding unrelated layout infrastructure.

## Implementation Phases

### Phase 1: Public landing presentation

1. Add the root-page presentation component with Wayfinder brand, Copilot hero copy, product reassurance, and existing `/login` and `/register` routes.
2. Add scoped CSS custom-property tokens, responsive layout, accessible focus styling, and the Copilot visual card.
3. Compose the component from `app/page.tsx`; keep it a server-rendered page and introduce no client state or fetch.

### Phase 2: Verification and documentation

1. Verify the public root route at 1440px and 375px widths, including keyboard access to both actions and zero horizontal scroll.
2. Run the frontend typecheck and production build if the existing workspace state permits it.
3. Update architecture and progress documentation to record the new presentation-only entry page.

## Complexity Tracking

No constitutional violation or additional complexity requires justification.
