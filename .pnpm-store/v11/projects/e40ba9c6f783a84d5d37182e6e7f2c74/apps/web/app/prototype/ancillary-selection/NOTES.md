# Split ancillary UI prototype

Question: should seats and baggage be separate destinations during checkout, and which page structure makes that feel clear without hiding the running total? The approved visual direction uses USD seat tiers: blue standard, green preferred, deeper green extra legroom, orange front cabin, and neutral unavailable.

The read-only prototype lives at `/prototype/ancillary-selection`:

- `?variant=A` — cabin studio: service switcher above the working surface; persistent detailed total.
- `?variant=B` — focused journey: one full-service page at a time; compact total at the end.
- `?variant=C` — travel wallet: two destination cards in a persistent navigation rail.

Within every variant, use `?service=seats` or `?service=baggage` to make the two services independently linkable. Seat and bag interactions are in-memory visual experiments only; nothing is sent to an API or saved.

Decision pending: record the preferred structure (or a combination) here, then delete the other variants and the development switcher before production implementation.
