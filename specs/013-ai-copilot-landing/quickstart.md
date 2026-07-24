# Quickstart: Validate the AI Copilot Landing Page

1. Start the frontend from the repository root:

   ```powershell
   pnpm --filter @web/frontend dev
   ```

2. Open `http://localhost:3000/` at a desktop-sized viewport.

3. Confirm the Wayfinder hero communicates AI-guided flight travel, Log in is prominent, and Create account is available.

4. Resize to 375px wide. Confirm that the hero stacks, neither action is clipped, and no horizontal scrollbar appears.

5. Tab through the page. Confirm both authentication actions receive visible focus and activate their existing destinations.

6. Run:

   ```powershell
   pnpm --filter @web/frontend typecheck
   ```

   Expected: the command exits successfully.
