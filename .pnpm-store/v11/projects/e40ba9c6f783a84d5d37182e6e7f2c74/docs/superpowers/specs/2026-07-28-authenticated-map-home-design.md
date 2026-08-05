# Authenticated Map Home Design

**Date:** 2026-07-28

**Status:** Approved for implementation

**Selected direction:** A — Map veil

## Context

The public landing page already directs visitors to registration and login. After either flow succeeds, the application routes the user to `/home`. The root route remains the public landing experience for everyone, while authenticated travelers receive a distinct product home at `/home`.

The product already has an airport API, airport coordinate data, and MapLibre/react-map-gl dependencies. Earlier map components are present in repository history but not in the current source tree. This feature restores only the map capabilities needed for the authenticated home instead of restoring the full prior interactive map surface.

## Goal

Provide a protected authenticated home at `/home`: a calm, full-viewport launch surface that uses the airport map as atmosphere and sends the traveler to the chatbot-led flight search through one unmistakable action.

## Non-goals

- The home will not contain flight-search fields or embed the chatbot.
- The background map will not provide airport selection, panning, zooming, popups, or route planning.
- The feature will not change the signed-out landing page, login, registration, search, or booking flows.
- The first implementation will not display a fake recent route. A recent-route slot may be added later when a stable authenticated data contract exists.
- The feature will not restore unrelated historical map controls or destination-explorer behavior.

## Route and Session Behavior

`apps/web/app/page.tsx` always renders the existing `LandingPage`, including for authenticated visitors. `apps/web/app/home/page.tsx` is an async Server Component that reads the NextAuth session.

- When no valid session exists at `/home`, it redirects to `/login`.
- When a valid session exists at `/home`, it renders the authenticated home.
- Successful login and registration redirect to `/home`; `router.refresh()` keeps session-dependent data current.
- The authenticated home receives only the minimum display identity needed for a greeting. If no usable name is present, it renders a neutral greeting rather than exposing the email address.

## Visual Composition

The authenticated home occupies the full viewport.

1. A dark MapLibre world map fills the background.
2. A strong left-to-right gradient veil protects navigation and hero readability while leaving the right side of the map visible.
3. A lightweight top navigation contains the brand, Home (`/home`), Search Flights (`/search`), My Bookings (`/bookings`), and logout. It does not expose currently missing `/dashboard` or `/profile` routes.
4. The hero contains:
   - A restrained signed-in greeting.
   - The headline: “Where would you like to go next?”
   - Supporting copy that describes the chatbot as a travel copilot.
   - One primary “Plan a trip” link to `/search`.
5. Airport points are visible as low-contrast ambient markers. They never compete visually with the hero.

On mobile, the veil changes to a top-to-bottom treatment, the brand acts as the Home link, labels shorten to Search and Bookings, and the hero sits within a bounded readable area. The CTA remains visible without scrolling on common phone viewports.

## Components

### `AuthenticatedHome`

Server-compatible presentation component responsible for the signed-in shell, navigation, greeting, hero copy, and CTA. It does not fetch airport data or depend directly on MapLibre.

### `HomeMapBackgroundData`

Async Server Component rendered inside a Suspense boundary. It calls the existing `getAllAirports()` helper and passes the serializable airport array to the client map without delaying the authenticated hero shell.

### `HomeMapBackground`

Small client boundary loaded dynamically with server-side rendering disabled. It receives airport data through props and owns only the MapLibre canvas and non-interactive map configuration.

The component:

- Uses the installed `react-map-gl/maplibre` and `maplibre-gl` packages.
- Loads the dark OpenFreeMap style already selected by the project’s map architecture.
- Accepts `airports: Airport[]` from `HomeMapBackgroundData`; it performs no browser-side data fetch.
- Renders airport points through one clustered GeoJSON source. Cluster and individual-point circles remain low contrast and do not display numeric count labels.
- Disables drag, scroll zoom, double-click zoom, touch zoom/rotate, keyboard map controls, and visible map controls.
- Uses `aria-hidden="true"` because it is decorative; the hero communicates the meaningful action.
- Avoids route animation in the first production pass. Any future ambient animation must stop under `prefers-reduced-motion`.

### Styling

A colocated CSS Module owns the visual tokens and responsive composition. New styling uses named CSS custom properties with OKLCH values. It will not add hardcoded hex values or raw Tailwind color utilities.

## Data Flow

1. `/` renders the public landing page; `/home` reads the NextAuth session and requires authentication.
2. The authenticated HTML shell and `/search` link render immediately around a Suspense fallback.
3. `HomeMapBackgroundData` calls `GET /api/airports/all` through `getAllAirports()` on the server.
4. The resolved airport array is serialized into the client-only `HomeMapBackground` boundary.
5. Successful airport data becomes one GeoJSON feature collection rendered by MapLibre after hydration.
6. The data and map remain read-only; no booking, search, or AI request occurs on the home page.

## Loading and Failure Behavior

- The background area has a CSS geographic/atmospheric fallback before the MapLibre bundle loads.
- The CTA and navigation never wait for map initialization or airport data.
- An empty airport response renders the base map without markers.
- A tile or WebGL error marks the map unavailable, hides its canvas, and exposes the existing CSS fallback without a blocking error message.
- Expected failures are logged without including session tokens, email addresses, or other user data.

## Accessibility

- Navigation uses semantic landmarks and a visible current-page state.
- The headline is the page’s single `h1`.
- The primary CTA has a strong visible focus state and meets contrast requirements against the veil.
- Decorative map content is removed from the accessibility tree.
- The layout remains usable at 200% zoom and on narrow viewports.
- Motion is absent by default, so reduced-motion users receive the complete experience without a special degraded mode.

## Verification

Automated verification will cover:

- Signed-out `/` continues to render the current public landing page.
- Authenticated `/home` renders the authenticated map home, while `/` remains public for all visitors.
- “Plan a trip” navigates to `/search`.
- The authenticated shell remains usable when airport data is empty or the map cannot initialize.
- Mobile layout keeps the hero and CTA visible and readable.
- Web lint and TypeScript checks pass.
- A production build is attempted after focused checks.

Manual visual verification will confirm the selected map-veil composition at desktop and mobile widths.

## Documentation Updates

After implementation, update:

- `context/architecture.md` with the session-aware root route and authenticated-home map data flow.
- `context/progress-checker.md` with the completed authenticated map home.
- `context/workflow.md` only if the implementation introduces a new reusable verification command or workflow rule.

## Acceptance Criteria

1. Signed-out visitors see the existing public landing page unchanged.
2. Authenticated users arriving at `/home` see the new map-veil home, while `/` remains the public landing page.
3. The map fills the background but accepts no user interaction.
4. Hero text and navigation remain readable before, during, and after map loading.
5. The primary CTA always links to `/search`.
6. Airport or tile failures do not block navigation or the CTA.
7. The page is responsive, keyboard accessible, and respects project color rules.
8. No fake personalized trip data is rendered.
