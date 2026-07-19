# Phase 4: Checkout Loading Escalation (Frontend)

- [ ] T018 [P] [US5] Generate client-side UUID v4 on confirm payment click and pass it in payload in [checkout/page.tsx](apps/web/app/checkout/page.tsx)
- [ ] T019 [US1] Build `CheckoutLoadingEscalation` component implementing all 4 timed phases (stepper, reassurance, escape hatch, auto-redirect) in [CheckoutLoadingEscalation.tsx](apps/web/components/checkout/CheckoutLoadingEscalation.tsx)
- [ ] T020 [US1] Register `beforeunload` event handler and programmatically unregister it prior to programmatic redirects in [checkout/page.tsx](apps/web/app/checkout/page.tsx)
