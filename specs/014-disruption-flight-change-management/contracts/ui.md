# UI Contract: Disruption & Flight-Change Management

The repository currently lacks the booking/detail/admin pages described by earlier completed-feature documents. This contract applies after the implementation gate restores the protected booking UI foundation.

## Data and rendering boundary

- Initial booking detail, history, list badge, and admin queue reads are Server Component reads through one typed server-only Nest API client.
- Protected reads use the NextAuth Nest access token and `cache: 'no-store'`.
- The browser never calls Duffel and never reimplements matching/materiality rules.
- Acknowledge/accept/admin actions are narrow client mutation boundaries; success refreshes canonical server state.
- Backend ownership/RBAC is authoritative. Client role gating is presentation only.
- Feature 14 adds no SSE/WebSocket channel. Revisit/manual refresh and post-mutation refresh show the latest state.

## Booking detail states

### No active disruption

- Render current itinerary from latest revision when it exists; otherwise original snapshot.
- Material and non-material revisions remain available in history.
- Do not render an urgent banner for a non-material revision.

### DETECTED

- Render an accessible alert with material reasons in plain language.
- Show “what changed just now” and cumulative difference from original as separate sections.
- Show current itinerary as primary; original values appear only in comparison context.
- Provide `I understand` and `Accept current itinerary` actions.
- Existing cancellation action remains independently visible/eligible.

### ACKNOWLEDGED

- Preserve the change summary and current itinerary.
- Indicate awareness was recorded without implying acceptance.
- Keep `Accept current itinerary` available.

### RESOLVED

- Remove urgent alert treatment but retain a resolved summary/reason and history.
- A later material revision returns to DETECTED presentation.

### Stale command

- On HTTP 409, discard optimistic assumptions, refresh detail, and announce that a newer airline change must be reviewed.
- Never apply the stale action to the newer revision automatically.

## Revision history

- Newest first with explicit observed timestamp, material/minor label, reasons, incremental summary, and expandable current segment list.
- Paginate rather than loading all revisions.
- Never show raw webhook JSON, internal error text, passenger/contact details, or supplier secrets.

## Booking list

- Compact non-color-only badge for `DETECTED` or `ACKNOWLEDGED`.
- Badge links to booking detail and names the required action.
- Resolved/minor history does not dominate the card.

## Admin disruption surface

- Separate panels/filters for active aged disruptions, attention-flagged bookings, failed Duffel events, and data-quality gaps.
- Failed event rows show safe code/attempt/time/correlation only and offer audited retry.
- Manual resolve requires active revision review and a non-empty safe note.
- Clearing attention is separate from resolving traveller disruption state.

## Accessibility and responsive behavior

- Use semantic alert/status regions; urgent new state should be announced without stealing focus.
- Reasons use icon/text in addition to semantic color.
- All actions have visible focus, disabled/pending state, and duplicate-click protection.
- Diff content collapses into stacked old/current cards at narrow widths; no horizontal page overflow at 375 px.
- Use semantic design tokens for critical, warning, neutral, success, border, surface, and focus colors. Do not introduce hardcoded hex values or raw Tailwind color utilities.
- Motion respects reduced-motion preferences.
