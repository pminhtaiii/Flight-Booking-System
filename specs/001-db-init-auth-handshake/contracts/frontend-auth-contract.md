# Frontend Auth Contract

## Pages

### `/register`

- Shows email and password fields.
- Validates email format and password policy before submit where practical.
- Calls the backend registration endpoint through the frontend auth/session layer.
- On success, stores the JWT-backed session and redirects to `/dashboard`.
- On failure, shows human-readable errors only.

### `/login`

- Shows email and password fields.
- Calls the backend login endpoint through the frontend auth/session layer.
- On success, stores the JWT-backed session and redirects to `/dashboard`.
- Invalid credentials show `Invalid email or password`.
- Lockout responses show a temporary lockout message with the wait duration.
- Authenticated users are redirected to `/dashboard`.

### `/dashboard`

- Requires an authenticated session.
- Sends the backend JWT to `GET /auth/me`.
- Renders a minimal authenticated dashboard state proving the handshake.
- Unauthenticated users are redirected to `/login`.

## Session Shape

The frontend session must contain enough data to call protected backend endpoints:

```json
{
  "user": {
    "id": "user-id",
    "email": "traveler@example.com"
  },
  "accessToken": "jwt",
  "expiresAt": "2026-06-25T00:00:00.000Z"
}
```

## Request Rules

- All protected backend calls include `Authorization: Bearer <accessToken>`.
- Client components do not call external services directly.
- Server Components fetch protected data through the NestJS backend.
- Raw backend errors are mapped to friendly UI messages.

## Redirect Rules

- Logged-out user visiting `/dashboard` -> `/login`.
- Logged-in user visiting `/login` or `/register` -> `/dashboard`.
- Expired session -> `/login` with a session-expired message.
- Logout -> clear session, call backend logout when possible, then redirect to `/login`.

## UI Rules

- Use Inter from `next/font/google` in the root layout.
- Use project theme tokens rather than raw Tailwind color classes.
- Auth forms use project button/input/card conventions.
- No visible implementation instructions, shortcut explanations, or raw technical error messages appear in the UI.
