# Authenticated Map Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the approved map-veil home at protected `/home` for authenticated travelers while keeping `/` as the public landing page for everyone.

**Architecture:** The root Server Component always renders `LandingPage`. The `/home` Server Component validates `getServerSession(authOptions)` and redirects unauthenticated visitors to `/login`; its authenticated shell streams immediately and places an async airport-data Server Component inside Suspense.

**Tech Stack:** Next.js 14.2.3 App Router, React 18 Server Components and Suspense, NextAuth 4.24.7, MapLibre GL 5.24.0, react-map-gl 8.1.1, CSS Modules, Playwright 1.41.2.

## Global Constraints

- Preserve the current `LandingPage` exactly for signed-out visitors.
- The authenticated home contains no search fields or embedded chatbot; its sole primary action links to `/search`.
- The map is decorative and non-interactive: no panning, zooming, popups, keyboard control, or visible map controls.
- Fetch airport data in a Server Component and pass it to the client map as serializable props.
- Keep the hero and CTA usable before map loading and after airport, tile, or WebGL failure.
- New CSS uses named custom properties with OKLCH values; do not add hardcoded hex values or raw Tailwind color classes.
- Do not render fake recent-route or other fake personalized data.
- Do not expose currently missing `/dashboard` or `/profile` routes.
- Preserve unrelated dirty-worktree changes and stage only files named by each task.

## File Structure

- `apps/web/app/page.tsx`: public landing page only.
- `apps/web/app/home/page.tsx`: protected authenticated-home route.
- `apps/web/components/home/AuthenticatedHome.tsx`: semantic signed-in shell, navigation, greeting, hero copy, CTA, and Suspense boundary.
- `apps/web/components/home/authenticated-home.module.css`: map-veil tokens, fallback background, responsive layout, focus states, and decorative map positioning.
- `apps/web/components/home/HomeMapBackgroundData.tsx`: async Server Component that loads airport data.
- `apps/web/components/home/HomeMapBackground.tsx`: client-only dynamic import boundary and loading behavior.
- `apps/web/components/home/HomeMapBackgroundInner.tsx`: MapLibre canvas, GeoJSON source/layers, non-interactive configuration, and failure state.
- `apps/web/tests/authenticated-home.spec.ts`: signed-out preservation, authenticated launch flow, decorative map behavior, failure tolerance, and mobile assertions.
- `context/architecture.md`: session-aware root and map data flow.
- `context/progress-checker.md`: completed authenticated map-home status.

---

### Task 1: Public root and protected authenticated launch shell

**Files:**
- Create: `apps/web/tests/authenticated-home.spec.ts`
- Create: `apps/web/components/home/AuthenticatedHome.tsx`
- Create: `apps/web/components/home/authenticated-home.module.css`
- Modify: `apps/web/app/page.tsx`

**Interfaces:**
- Consumes: `authOptions` from `apps/web/lib/auth.ts`, `LandingPage`, and the existing `LogoutButton`.
- Produces: `AuthenticatedHome({ displayName?: string }): JSX.Element`; Task 2 inserts its map data boundary into this component.

- [ ] **Step 1: Write the failing route and responsive E2E tests**

Create `apps/web/tests/authenticated-home.spec.ts` with a unique-account helper and these initial cases:

```ts
import { expect, test, type BrowserContext, type Page, type APIRequestContext } from '@playwright/test';

async function registerAndOpenHome(
  page: Page,
  request: APIRequestContext,
  context: BrowserContext,
): Promise<void> {
  await request.post('http://127.0.0.1:3001/api/auth/test/reset-lockout', {
    data: { clearAll: true },
  });
  await context.clearCookies();
  const email = `home-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  await page.goto('/register');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('textbox', { name: 'Password' }).fill('Password123!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
}

test('preserves the public landing page for signed-out visitors', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Log in to explore' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Where would you like to go next?' })).toHaveCount(0);
});

test('shows the authenticated launch surface and routes to search', async ({ page, request, context }) => {
  await registerAndOpenHome(page, request, context);
  await expect(page.getByRole('heading', { name: 'Where would you like to go next?' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Plan a trip' })).toHaveAttribute('href', '/search');
  await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Profile' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Plan a trip' }).click();
  await expect(page).toHaveURL(/\/search$/);
});

test('keeps the primary action visible on a narrow phone viewport', async ({ page, request, context }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await registerAndOpenHome(page, request, context);
  const cta = page.getByRole('link', { name: 'Plan a trip' });
  await expect(cta).toBeVisible();
  const box = await cta.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.y ?? 780) + (box?.height ?? 0)).toBeLessThanOrEqual(780);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
```

- [ ] **Step 2: Run the focused test to confirm the authenticated cases fail**

Run from `apps/web`:

```powershell
pnpm exec playwright test tests/authenticated-home.spec.ts --config=tests/playwright.config.ts --project=chromium
```

Expected: the signed-out case passes; authenticated cases fail because `/` still renders `LandingPage`.

- [ ] **Step 3: Implement the session branch and minimal authenticated shell**

Change `apps/web/app/page.tsx` to read the configured session and preserve the public branch:

```tsx
import { getServerSession } from 'next-auth';
import { AuthenticatedHome } from '@/components/home/AuthenticatedHome';
import { LandingPage } from '@/components/landing/LandingPage';
import { authOptions } from '@/lib/auth';

export default async function IndexPage(): Promise<JSX.Element> {
  const session = await getServerSession(authOptions);
  if (!session) return <LandingPage />;
  return <AuthenticatedHome displayName={session.user?.name ?? undefined} />;
}
```

Implement `AuthenticatedHome.tsx` as a Server Component with semantic `<header>`, `<nav aria-label="Primary navigation">`, and `<main>`. Use the brand as the Home link, links to `/search` and `/bookings`, `LogoutButton`, one `h1`, and a CTA whose accessible name is exactly `Plan a trip`. Render `Welcome back` when `displayName` is absent; never fall back to the email address.

In `authenticated-home.module.css`, define named OKLCH tokens on `.page`, a full-viewport atmospheric fallback, a left-to-right `.veil`, readable hero width, focus-visible outlines, and a mobile breakpoint that changes the veil to top-to-bottom and shortens navigation labels through visually hidden/full-label spans rather than JavaScript.

- [ ] **Step 4: Run the focused tests and type-check**

```powershell
pnpm exec playwright test tests/authenticated-home.spec.ts --config=tests/playwright.config.ts --project=chromium
pnpm typecheck
```

Expected: three Playwright tests pass and TypeScript exits successfully.

- [ ] **Step 5: Commit only the shell task**

```powershell
git add apps/web/app/page.tsx apps/web/components/home/AuthenticatedHome.tsx apps/web/components/home/authenticated-home.module.css apps/web/tests/authenticated-home.spec.ts
git commit -m "feat(web): add authenticated home launch surface"
```

---

### Task 2: Server-loaded decorative airport map

**Files:**
- Create: `apps/web/components/home/HomeMapBackgroundData.tsx`
- Create: `apps/web/components/home/HomeMapBackground.tsx`
- Create: `apps/web/components/home/HomeMapBackgroundInner.tsx`
- Modify: `apps/web/components/home/AuthenticatedHome.tsx`
- Modify: `apps/web/components/home/authenticated-home.module.css`
- Modify: `apps/web/tests/authenticated-home.spec.ts`

**Interfaces:**
- Consumes: `getAllAirports(): Promise<Airport[]>` from `apps/web/lib/airport-service.ts` and `Airport` from `@shared/types`.
- Produces: `HomeMapBackgroundData(): Promise<JSX.Element>` and `HomeMapBackground({ airports }: { airports: Airport[] }): JSX.Element`.

- [ ] **Step 1: Add failing decorative-map and failure-tolerance assertions**

Extend the authenticated test file with:

```ts
test('renders the airport map as a non-interactive decorative layer', async ({ page, request, context }) => {
  await registerAndOpenHome(page, request, context);
  const map = page.getByTestId('home-map');
  await expect(map).toBeVisible();
  await expect(map).toHaveAttribute('aria-hidden', 'true');
  expect(await map.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
  await expect(page.locator('.maplibregl-ctrl')).toHaveCount(0);
});

test('keeps the launch action usable when map tiles fail', async ({ page, request, context }) => {
  await page.route('https://tiles.openfreemap.org/**', (route) => route.abort());
  await registerAndOpenHome(page, request, context);
  await expect(page.getByRole('heading', { name: 'Where would you like to go next?' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Plan a trip' })).toBeVisible();
});
```

- [ ] **Step 2: Run only the new map tests and confirm they fail**

```powershell
pnpm exec playwright test tests/authenticated-home.spec.ts --config=tests/playwright.config.ts --project=chromium --grep "airport map|tiles fail"
```

Expected: the decorative-map test fails because `data-testid="home-map"` does not exist.

- [ ] **Step 3: Implement the server data boundary and dynamic client canvas**

Implement `HomeMapBackgroundData.tsx` as an async Server Component:

```tsx
import { HomeMapBackground } from './HomeMapBackground';
import { getAllAirports } from '@/lib/airport-service';

export async function HomeMapBackgroundData(): Promise<JSX.Element> {
  const airports = await getAllAirports();
  return <HomeMapBackground airports={airports} />;
}
```

Implement `HomeMapBackground.tsx` as a client dynamic boundary with `ssr: false`, a `null` loading render, and a typed `airports: Airport[]` prop. The loader imports `HomeMapBackgroundInner`.

Implement `HomeMapBackgroundInner.tsx` with:

```tsx
'use client';

import { useMemo, useState } from 'react';
import maplibregl from 'maplibre-gl';
import Map, { Layer, Source } from 'react-map-gl/maplibre';
import type { FeatureCollection, Point } from 'geojson';
import type { Airport } from '@shared/types';
import 'maplibre-gl/dist/maplibre-gl.css';

type AirportPointProperties = Pick<Airport, 'iataCode' | 'name' | 'city' | 'country'>;
type Props = { airports: Airport[] };
```

Build a memoized `FeatureCollection<Point, AirportPointProperties>`. Render `Map` with the dark OpenFreeMap style, world-scale initial view, `interactive={false}`, `attributionControl={false}`, and all gesture/keyboard flags disabled explicitly. Add one clustered `Source`, a low-opacity cluster-circle `Layer`, and a lower-radius individual-point `Layer`; omit cluster count labels. Use MapLibre-compatible `rgb(...)`/`rgba(...)` paint strings rather than hex literals because MapLibre layer paint cannot consume CSS custom properties directly.

Wrap the map in `<div data-testid="home-map" aria-hidden="true">`. On `Map` error, log only the constant message `[home-map] Map rendering failed`, set a local failed flag, and return `null` so the CSS fallback remains visible.

In `AuthenticatedHome.tsx`, place `<HomeMapBackgroundData />` behind the content inside `<Suspense fallback={null}>`. In the CSS module, make the map layer absolute, inset to the viewport, below the veil, and `pointer-events: none`.

- [ ] **Step 4: Run focused tests, lint the touched sources, and type-check**

```powershell
pnpm exec playwright test tests/authenticated-home.spec.ts --config=tests/playwright.config.ts --project=chromium
pnpm typecheck
pnpm exec eslint app/page.tsx components/home/*.tsx tests/authenticated-home.spec.ts --max-warnings 0
```

Expected: all authenticated-home tests pass; TypeScript and ESLint exit successfully.

- [ ] **Step 5: Commit only the map task**

```powershell
git add apps/web/components/home/HomeMapBackgroundData.tsx apps/web/components/home/HomeMapBackground.tsx apps/web/components/home/HomeMapBackgroundInner.tsx apps/web/components/home/AuthenticatedHome.tsx apps/web/components/home/authenticated-home.module.css apps/web/tests/authenticated-home.spec.ts
git commit -m "feat(web): add ambient airport map background"
```

---

### Task 3: Documentation sync and production verification

**Files:**
- Modify: `context/architecture.md`
- Modify: `context/progress-checker.md`
- Verify: all files from Tasks 1 and 2

**Interfaces:**
- Consumes: the completed session-aware root and map components.
- Produces: synchronized project context and a verified production build.

- [ ] **Step 1: Update architecture documentation with the delivered data flow**

Add an `Authenticated Home` subsection to `context/architecture.md` containing this exact flow:

```text
GET / → getServerSession(authOptions)
  ├─ no session → existing public LandingPage
  └─ valid session → AuthenticatedHome shell + Suspense fallback
       └─ HomeMapBackgroundData (Server Component) → GET /api/airports/all
            └─ serialized Airport[] → dynamic HomeMapBackground client canvas
```

Document that the CTA links to `/search`, the map is decorative/non-interactive, and airport/tile/WebGL failures leave the shell usable.

- [ ] **Step 2: Record completion in the progress tracker**

Add a completed feature entry to `context/progress-checker.md`:

```markdown
### [x] Feature: Authenticated Map Home

- [x] Session-aware `/` preserves the signed-out landing page
- [x] Map-veil launch surface routes travelers to chatbot flight search
- [x] Server-loaded airport data feeds a non-interactive MapLibre background
- [x] Responsive, failure-tolerant, and accessible verification
```

- [ ] **Step 3: Run the complete focused verification sequence**

From `apps/web`:

```powershell
pnpm typecheck
pnpm exec eslint app/page.tsx components/home/*.tsx tests/authenticated-home.spec.ts --max-warnings 0
pnpm exec playwright test tests/authenticated-home.spec.ts --config=tests/playwright.config.ts --project=chromium
pnpm build
```

Expected: all commands exit with code 0. If the production build reports an external tile-network warning, confirm it does not fail compilation; runtime tile failures are covered by the fallback test.

- [ ] **Step 4: Perform the visual acceptance check**

At 1440×900 and 360×780, verify:

```text
- Map fills the viewport and remains visually subordinate to the veil.
- Navigation, h1, supporting copy, and CTA are readable without waiting for map tiles.
- CTA is above the fold and keyboard focus is clearly visible.
- No horizontal overflow, map controls, broken-route links, or fake recent trip appears.
```

- [ ] **Step 5: Commit synchronized documentation**

```powershell
git add context/architecture.md context/progress-checker.md
git commit -m "docs: document authenticated map home"
```
