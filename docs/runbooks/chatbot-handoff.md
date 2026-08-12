# Chatbot Handoff Operations Runbook

Feature 17 operations contract. It does not establish that the full browser flow, privacy corpus, performance benchmarks, backup recovery, or irreversible cleanup has passed. See the [plan](../../specs/017-chatbot-backend-infrastructure/plan.md), [quickstart](../../specs/017-chatbot-backend-infrastructure/quickstart.md), and [architecture](../../context/architecture.md).

## 1. System topology and decision ownership

Production request flow:

```text
Browser / ChatWidget
  -> direct bearer-authenticated FastAPI SSE stream
     (or the retained same-origin Next.js SSE proxy during rollback)
  -> Redis quota admission, fenced session lease, and Trusted Search Snapshot
  -> LangGraph Router and read-only specialists
  -> service-authenticated NestJS gateway
  -> PostgreSQL/Prisma durable chat, handoff, projection, readiness, and intent state
  -> deterministic Duffel/Stripe boundaries only after a winning checkout claim
```

The browser renders versioned events but makes no booking decision. FastAPI owns JWT ingress checks, guardrails, quota admission, the per-turn graph, and session-fence enforcement. Redis is a control plane: it stores counters, leases, and the PII-free snapshot, including service-only offer bindings and attestation required for deterministic selection; it never stores conversation text. NestJS owns durable chat and every handoff/readiness/claim/consume decision through Prisma/PostgreSQL. Duffel and Stripe are called only by deterministic NestJS services, never by the LLM or a losing consumer.

For checkout, deterministic code validates the latest owner/session-bound snapshot and asks NestJS to issue a hash-only credential. FastAPI emits `ACTION_HANDOFF`; the browser POSTs the transient credential to `/checkout/handoff`; Next.js stores it in a short-lived HttpOnly/Secure/SameSite=Strict cookie and redirects to clean `/checkout/passengers`. NestJS resolves without consuming, readiness remains read-only, a claim is acquired before supplier work, and the final transaction creates one canonical BookingIntent and consumes the handoff. The older Next.js stream proxy remains a rollback path; it has not been permanently removed.

## 2. Feature flags and rollout order

| Capability                    | Configuration                                                                                                        | Safe state/relationship                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-agent Router            | Agent `FEATURE_FLAG_CHAT_MULTI_AGENT`; web `NEXT_PUBLIC_FEATURE_FLAG_CHAT_MULTI_AGENT`                               | Present as rollout/config vocabulary but not wired as runtime gates in the current implementation. Keep issuance off while validating routing; do not treat changing either value alone as a cutover.                                                                                                                      |
| Handoff acceptance            | API `FEATURE_FLAG_CHAT_HANDOFF_ACCEPT`; agent/web mirrors                                                            | The API flag gates resolve/readiness/consume policy and must be deployed before issuance. Agent/web values are currently config/exposure mirrors, not independent runtime enforcement.                                                                                                                                     |
| Handoff issuance              | API/agent `FEATURE_FLAG_CHAT_HANDOFF_ISSUE`                                                                          | Must be off unless ACCEPT is on in both relevant services.                                                                                                                                                                                                                                                                 |
| Direct streaming              | Web `NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM`; legacy web `NEXT_PUBLIC_ENABLE_DIRECT_AGENT_STREAM`; agent mirror | Either web variable currently enables direct transport because the legacy alias is OR'ed with the canonical flag. The agent value is not a transport gate. Set both web variables false for a reliable proxy rollback; enable only after deployed bearer-auth, strict CORS, trace, session-continuity, and browser checks. |
| Booking readiness             | API `FEATURE_FLAG_BOOKING_READINESS` and web counterpart                                                             | Must be on before a handoff may advance through canonical readiness/intent.                                                                                                                                                                                                                                                |
| Encrypted persistence/fencing | `CHAT_ENCRYPTION_KEY` and `FEATURE_FLAG_WRITE_FENCE`                                                                 | Keep encryption configured and fencing enforced before direct/multi-instance rollout. These are safety controls, not routine cohort toggles.                                                                                                                                                                               |

Safe rollout: deploy code and additive schema inert; verify Redis and encrypted persistence; enable API ACCEPT; deploy/validate multi-agent routing and web `ACTION_HANDOFF` support with ISSUE off; enable booking readiness; enable ISSUE for an internal cohort; enable direct transport last after auth/CORS/session tests. Because several mirror flags are not runtime-wired, verify behavior at the public boundary instead of relying on configuration display. Keep the proxy for the observation window.

Invalid or unsafe combinations:

- `ISSUE=true` with `ACCEPT=false` is invalid and must fail configuration/startup or force issuance off.
- ISSUE with readiness unavailable, encrypted persistence unavailable, or fencing disabled is unsafe.
- Direct transport without an exact production origin, bearer authentication, or session-continuity verification is unsafe.
- Removing the proxy before T101 approval, or removing plaintext columns before T102 approval, is invalid.

Rollback: disable ISSUE first. Preserve ACCEPT for already-issued unexpired credentials when the incident policy permits; otherwise return the stable disabled error. Disable multi-agent routing if needed, then switch the browser from direct transport to the proxy. Do not delete ChatHandoff, encryption envelopes, BookingAgentProjection, migration, backup, or recovery data during routine rollback.

## 3. Health checks and dependency failures

| Failure                                | Expected behavior                                                                                           | Retry/side-effect policy                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Redis unavailable                      | Chat control plane reports unhealthy and fails closed before inference.                                     | Retry after Redis recovery; no model, durable chat, handoff, supplier, or payment work.                              |
| NestJS unavailable                     | Access/session/memory/handoff calls fail closed; no stream work that depends on durable ownership proceeds. | Retry after health recovery; no supplier/payment side effects.                                                       |
| PostgreSQL unavailable                 | NestJS readiness is unhealthy; durable chat, handoff, claim, and consume operations fail.                   | Retry only after database recovery and canonical-state inspection; do not infer success.                             |
| Model or guardrail unavailable         | Fail closed with the stable safe availability/error path.                                                   | Retryable after dependency recovery; no tool, handoff, supplier, or payment work.                                    |
| Supplier boundary unavailable          | Issue/resolve remain supplier-free. A winning consume attempt times out/cancels within its claim lease.     | Inspect/release or recover only the matching claim; never call a supplier inside a DB transaction or charge payment. |
| Direct-stream CORS/auth failure        | Reject the direct request.                                                                                  | Correct exact origin/bearer configuration or revert to proxy; never loosen CORS or log tokens.                       |
| Bootstrap timeout/failure              | Do not set the handoff cookie or claim navigation success.                                                  | Retry the POST after dependency recovery; no readiness, supplier, payment, or intent side effect.                    |
| Readiness failure                      | Return the canonical correction/error result without consuming.                                             | Correct profile/inline data or refresh stale state; no supplier/payment/booking side effect.                         |
| Claim refresh lost/worker disconnected | Cancel work, reject stale finalization, and hold takeover until the recovery boundary.                      | Inspect canonical consume/intent state before bounded retry; losers perform zero supplier/payment calls.             |
| Final transaction rollback             | No successful consume or canonical intent may be reported.                                                  | Inspect claim, handoff, and intent state before retry; do not duplicate supplier/payment work.                       |

Failures that protect authentication, quota, fencing, ownership, token integrity, or privacy fail closed. Temporary dependency failures are retryable only after health and canonical state are known. At most one consumer creates the canonical intent; losing consumers return stable errors and create zero supplier/payment side effects.

## 4. Dashboards and alerts

The operational dashboard must include:

- Redis health/readiness and error/latency;
- quota accepted, denied, and error counts; quota-bypass invariant failures; burst and daily rejection;
- session-lock acquisition, refresh loss, takeover, and fencing failure; active streams;
- Router intent, confidence bucket, latency, and malformed output;
- tool outcomes and latency;
- Trusted Search Snapshot hit, miss, replace, and expire;
- handoff issue, resolve, replay, foreign-owner, expired, stale, claim, and consume outcomes/latency;
- bootstrap outcomes and direct-versus-proxy transport;
- time to first safe token.

Alert on Redis health failure; any quota-bypass invariant failure; error rate above 2x baseline for five minutes; malformed-output spike; cross-owner handoff spike; any token-integrity or privacy-corpus failure; handoff resolve/consume p95 above 300 ms; and first-safe-token p95 regression. Only the error-rate window and handoff latency have specification-defined numeric thresholds. Configure all spike/regression thresholds per environment and label them operator-configured.

Current coverage is partial: NestJS emits intent and handoff create/resolve/consume/replay telemetry; FastAPI emits allowlisted quota, Router, tool, snapshot-read, and handoff-action telemetry. Treat the complete dashboard list as the required contract. T097 adds maintained assertions; T098 records measured p95/count evidence. Do not claim those gates from this runbook alone.

## 5. Key and secret rotation

Never expose values in source, examples, logs, dashboards, tickets, or commands captured for evidence. Verify using health, controlled non-financial requests, counts, and version/status metadata only.

| Class                    | Where/current support                                                                                                      | Rotation, old credentials, verification, rollback                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chat access JWT          | `JWT_SECRET` in NestJS and FastAPI deployment config; no verified key ID/ring                                              | Add dual verification or drain/re-authenticate first. Deploy verifier before signer, retain the old secret for the authentication grace period, verify canonical claims/revocation, then retire it. Roll back signer and verifier together.                              |
| NextAuth web session JWT | `NEXTAUTH_SECRET` in the Next.js deployment; distinct from the chat-access JWT secret and without a verified key ring      | Add overlap support or expire/re-authenticate web sessions. Verify sign-in, session decode, and embedded backend access-token handling without printing either token. Roll back the web signer/verifier together while the previous secret is still controlled.          |
| Selection attestation    | Runtime `ATTESTATION_SECRET`; `sel_v1_`; no ring                                                                           | Disable ISSUE and let old attestations expire, or deploy multi-key verification first. Verify a fresh signed search without logging the attestation. Restore the prior verifier only within the approved grace window.                                                   |
| Handoff token            | Runtime `CHAT_HANDOFF_SECRET`; v1 token/row key version, but verifier accepts current v1 only                              | Disable ISSUE and drain/honor active credentials per policy, or add overlap before rotation. Verify fresh issue/resolve using counts only. Roll back the secret while old credentials are still within the controlled window.                                            |
| Claim token              | `CLAIM_TOKEN_SECRET` in agent signer and NestJS validator; no key ID/ring                                                  | Drain service-auth traffic or add dual validation; rotate both sides in a coordinated deploy. Verify a safe gateway request. Roll back both sides together.                                                                                                              |
| Chat encryption          | `CHAT_ENCRYPTION_KEY`; envelopes record v1, but runtime decrypt supports only v1                                           | Do not replace in place. First add key-ring reads and active-key writes, backfill/re-encrypt with recovery and backup evidence, retain old keys through all ciphertext/backup retention, then retire. Roll back to the prior active key/read ring if verification fails. |
| Service API key          | `AGENT_SERVICE_API_KEY` in FastAPI and NestJS deployment config; no verified dual acceptance                               | Drain or implement overlap, rotate validator before caller, verify one service-auth request, then retire old key. Roll back both endpoints together.                                                                                                                     |
| Supplier/payment         | `DUFFEL_ACCESS_TOKEN`, `DUFFEL_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` in NestJS/provider config | Follow provider overlap/revocation procedures. Verify health/signature or sandbox-only calls without creating a booking, order, capture, or refund. Restore the prior provider credential only if it remains valid and incident policy permits.                          |

Configuration drift currently blocks a reliable rotation rehearsal: runtime attestation reads `ATTESTATION_SECRET` while `apps/api/.env.example` advertises `CHAT_ATTESTATION_KEY`; runtime handoff reads `CHAT_HANDOFF_SECRET`, which the example omits; and the NestJS environment schema is incomplete. Correct and test this drift before rotating.

## 6. Encrypted chat retention and backups

ChatMessage content and ChatSession-derived titles use record-bound AES-256-GCM envelopes; key material remains outside PostgreSQL and its backups. Legacy plaintext columns remain during the reversible dual-read/write observation period. A ciphertext backfill must be restart-safe, cover messages and titles, verify decrypt equivalence, and preserve the recovery export until cleanup approval.

Maintain an inventory of primary database copies, replicas, snapshots, logical exports, off-site backups, recovery exports, encryption-key versions, and their retention windows. Test restore plus authorized decrypt/reencrypt without printing content or secrets. Record counts/status only. Retention and deletion durations are not yet evidenced; operators must use the approved organizational policy and must not invent a period in this document.

Reversible observation means additive encrypted fields, verified twins, retained legacy readers/data, and a tested rollback. Plaintext-column deletion is irreversible cleanup. T102 must not run without separate explicit approval, live dual-read/write evidence, complete message/title backfill, database/backup inventory, recovery export and rehearsal, legacy-reader shutdown, and final privacy scans. Routine rollback or retention work never authorizes T102.

## 7. CORS and direct-stream troubleshooting

FastAPI parses `FRONTEND_URL` as a comma-separated list of exact allowed origins, accepts only `POST`/`OPTIONS`, and allowlists bearer/content/trace headers. Browser requests use `Authorization: Bearer ...`; `allow_credentials=False` means browser cookies are not the direct-stream credential. `X-Trace-Id` and `X-Correlation-Id` must be independently generated opaque values in the exact `chat_<32 lowercase hex>` format.

Check scheme, host, and port exactly. Common failures are `localhost` versus `127.0.0.1`, HTTP versus HTTPS, a production hostname absent from the allowlist, missing/expired bearer JWT, or a public agent URL pointing at the API/web service. Compare a direct request to FastAPI `/chat/stream` with the same-origin `POST /api/chat/stream` proxy path. A direct-only failure with a healthy proxy localizes CORS/public-agent/auth configuration; both failing suggests shared auth/NestJS/Redis/model health.

To revert safely, set both the canonical web direct flag and `NEXT_PUBLIC_ENABLE_DIRECT_AGENT_STREAM` false, deploy, confirm requests use the proxy, verify opaque-header filtering and legacy `ACTION_REQUIRED` pass-through, and leave durable handoff/encryption/projection state intact. Never use wildcard origins, enable credentialed CORS as a shortcut, place tokens in query strings, or log authorization/bootstrap bodies.

## 8. Claim and handoff recovery

- **Expired handoff:** return the stable expiry error and require a fresh signed search/selection; do not extend the row in place.
- **Replayed/consumed handoff:** return the stable consumed/replay result and inspect the linked canonical intent; do not create another.
- **Foreign-owner handoff:** use the same safe not-found behavior and raise the cross-owner metric without exposing either owner.
- **Stale attestation/offer:** require a fresh signed search; issue/resolve performs no supplier work.
- **Failed claim refresh or worker disconnect:** cancel, reject stale finalization, wait through `claimRecoverAfter`, and inspect canonical state before takeover.
- **Supplier timeout:** keep the hard deadline below the remaining claim lease; release only a matching safe claim or allow bounded recovery hold.
- **Transaction rollback:** verify whether the canonical intent/consume committed before retry; never infer success from a supplier response alone.
- **Session deleted during handoff:** deleted-session checks block later resolve/final consume. Contain active checkout, verify no canonical intent proceeded, and follow the deletion gap below.

Safety invariant: one claim winner may reach required supplier validation and at most one consumer creates the canonical intent. All losing, replayed, stale, foreign, or expired consumers produce stable errors and zero supplier/payment side effects.

## 9. Session deletion and revocation

`ChatSession` deletion is a soft delete (`deletedAt`). Ordinary future reads/writes are denied, and resolve/final consume re-check the active stored session. Consumed handoff-to-intent audit linkage remains until the approved audit/transaction retention period. Eventual encrypted-content cleanup must follow the approved retention policy and key/backup inventory.

Current limitation: `deleteSession` does not explicitly revoke active handoff/claim rows and does not erase message/title ciphertext. During deletion, disable ISSUE/ACCEPT for the affected rollout if required, stop active work, inspect privileged deterministic state without copying credentials/IDs into tickets, verify subsequent session access and handoff finalization are denied, verify no supplier/payment side effect occurred, and record only opaque evidence. Retention cleanup and automatic row revocation require separate implementation/verification; do not claim them today.

## 10. Privacy rules and operator closeout

Chat message content, summaries, handoff credentials or hashes, local/provider offer IDs, database IDs, PNRs, passenger/contact/passport data, payment data, and raw tool payloads must never appear in logs, traces, metrics, audits, URLs, browser storage, or user-facing text. Use opaque trace and correlation IDs only. Do not paste sensitive values into incident channels while troubleshooting.

Known release gaps prevent an absolute privacy-completion claim: crypto fallback logging can include message/session identifiers and raw decrypt errors; claim-token logging can include a user identifier; protected audit columns retain identifiers required by existing audit linkage. Fix and validate these surfaces in the privacy gate before claiming full compliance.

Before rollout or incident closure, record flag state, dependency health, direct/proxy mode, safe aggregate handoff/claim/intent outcomes, and unresolved limitations. T093's continuous real browser-to-consume Playwright flow remains separately in progress and unconfirmed; T097-T100 evidence remains pending; T101 and T102 remain separately approval-gated.
