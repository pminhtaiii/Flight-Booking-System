# Research: AI Copilot Landing Page

## Decision: Use a self-contained presentation component

**Rationale**: The legacy global stylesheet and previous UI components were deliberately removed. A page-local component and CSS module preserve the approved direction without recreating the old layer.

**Alternatives considered**: Restoring the prior header/global CSS was rejected because it would conflict with the current UI reset.

## Decision: Keep the page server-rendered and link-only

**Rationale**: The landing page only directs visitors to existing authentication routes. It has no interactive state or data dependency, so it should not create a client-side fetch or backend integration.

**Alternatives considered**: An embedded flight-search form was rejected because the approved design uses authentication as the primary conversion and a search flow would broaden scope.

## Decision: Test the public behavior, not component internals

**Rationale**: Verification should assert that the root route renders its core message and navigation destinations at desktop and mobile widths.

**Alternatives considered**: Styling implementation tests were rejected because they would be coupled to the visual structure rather than user-visible behavior.
