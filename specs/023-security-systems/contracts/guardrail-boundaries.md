# Boundary Contracts

Internal proposed contracts; public event authority remains `apps/agent/src/agent/chat_turn/events.py`.

## Interfaces

- `ChatController.stream(command) -> AsyncIterator[ChatTurnEvent]`: delegates only; no graph invocation or content checks.
- `GuardrailGateway.validate_input(context, message) -> PipelineDecision[ValidatedInput]`: required before graph/router/model and rejected-message persistence; inspect original plus bounded normalized copies.
- `GuardrailGateway.execute_tool(context, call, invoke) -> PipelineDecision[ValidatedToolResult]`: dispatch authority, bounded result structure/schema and minimized scanning before return. No raw callbacks/traces; existing backend ownership checks remain.
- `GuardrailGateway.stream_output(context, tokens) -> AsyncIterator[ApprovedChunk]`: yields approved text only; stop/discard pending text on violation/overflow/exception.
- `GuardrailLayer`: fixed key/stage/prerequisites and deterministic check. Registry uses code-defined factories, never eval or configured imports.

## Tool Capabilities

| Intent | Existing tool names |
|---|---|
| GENERAL | None |
| SEARCH, BOOKING_INQUIRY | search_flights, get_user_preferences, list_user_booking_summaries, get_booking_detail, check_booking_readiness |
| CHECKOUT | signal_checkout_intent |
| Unknown/missing | None |

Test actual registered names and inventory drift. Validate the whole call batch before invocation: any forbidden call denies the batch. Model intent does not grant ownership. Preserve checkout commitment, snapshot/attestation freshness and deterministic confirmation boundaries.

## Public Responses and Persistence

Preserve token/tool_call/tool_result/flight_results/ACTION_HANDOFF/ACTION_REQUIRED/done/error schemas. Project all public tool arguments/results; never serialize raw values. Input PII gives static removal guidance, injection a generic rephrase response, topic a travel redirect; lock exact copy/event mapping in fixtures before implementation.

After SSE headers are sent, retain `OUTPUT_GUARDRAIL_BLOCKED` and existing safe partial-message semantics; do not change HTTP status. Exclude signatures, rejected payloads and exceptions. Discard unsafe pending output; persist only approved assistant prefix. User content persists only after input validation through encrypted backend storage. Validated handoff credentials occur only in the dedicated authorized ACTION_HANDOFF channel, never narration/logs.

## Evidence

Complete versioned reports required even with zero findings. Missing/empty/invalid reports, timeout, auth failure, unexpected empty scope or crashes fail. ZAP 1 is failure, 3 execution error, 2 requires explicit finding evaluation rather than blanket success. Only change-detected not-applicable skips are allowed. Corpus scores and unauthorized-side-effect oracles are separate gates.

## Pre-Parse and Memory Boundaries

Raw request limits apply in ASGI ingress before JSON parsing; tool response limits apply during bounded upstream reads before JSON loading, including decompressed size. Missing, false or chunked Content-Length never bypasses the bound. Transport framing limits are not duplicated content policy. Loaded history/summaries are untrusted input and must pass the gateway before summarization, routing or model execution. Unsafe historical entries fail closed with safe reject/quarantine behavior.
## Convergence Decisions (Cycle 1)

These contracts resolve the first independent review and take precedence over earlier shorthand in these artifacts.

### Bounded streaming detection

T019/T020 define `tests/security/pii-policy.json` and matching code metadata. Supported normalized match widths: passport <=11 ASCII characters; card <=37 characters including separators; phone <=40; email <=254 ASCII characters with local part <=64; credential patterns <=512 Unicode scalar values. Each rule declares its maximum left/right lookaround; total match plus lookaround must fit a 512-scalar inspection span. Unsupported/non-ASCII email-like and overlong identifier candidates fail closed before candidate bytes are released; they are not truncated into an accepted token. No unbounded repetition or unbounded lookaround is allowed in output rules.

Retain at least 512 normalized scalars of undecided suffix plus the raw source region corresponding to them. Maintain a bounded original-to-normalized mapping, retaining incomplete Unicode normalization sequences across chunks. Limit total pending raw text to 8 KiB; if a candidate, normalization sequence or mapping cannot fit, terminate safely before emitting it. Candidate recognition and terminator rules are versioned in the policy and tested with boundary lookaround at every split. The guarantee covers the enumerated formats; semantic/private facts outside these formats are not claimed detectable by regex. Tests cover max-1/max/max+1, combining marks, compatibility expansion, adjacent identifiers, overlong candidates and EOF, asserting both raw and normalized forbidden values absent from unauthorized sinks.

### Capability sealing after routing

Create an AdmissionContext (authenticated principal, turn/trace IDs, policy version, no tool authority) for input/history validation. After routing and the deterministic checkout gate, create one immutable TurnCapabilities object bound to that turn and derived solely by trusted code. Preserve raw routing provenance separately from the effective route; a fallback must not erase whether the classifier result was invalid.

| Routing provenance / gate | Sealed tools |
|---|---|
| Valid GENERAL | Empty |
| Valid SEARCH or BOOKING_INQUIRY | Existing travel set |
| Valid non-checkout result with low confidence, explicitly normalized to SEARCH by trusted policy | Travel set; record low_confidence provenance |
| Valid CHECKOUT and all commitment/snapshot/selection gates pass | signal_checkout_intent only |
| Valid CHECKOUT downgraded by deterministic gate | Travel set, no checkout signal; record checkout_downgrade |
| Malformed/unknown classifier result, exception, missing provenance or invalid effective route | Empty, safe static clarification; changes old silent SEARCH authority |
| Trusted FEATURE_FLAG_CHAT_MULTI_AGENT=false | Explicit travel set; record single_agent policy, no checkout signal |

After sealing, neither graph state, model tool calls nor subsequent route transitions can expand authority. Each model node binds the intersection of its own tools and the sealed set; final-answer nodes have no tools. A checkout-to-travel transition cannot add travel tools to a signal-only turn. Dispatcher checks the entire call batch against sealed capability, and backend identity/ownership checks remain independent. Test all rows, state/provenance forgery and later-node transitions.

### Stage-local corpus and oracles

Each detector case declares expectedStage (input/tool/output), expectedLayerFamily, malicious/benign label, delivery fixture and deterministic PASS/BLOCK oracle. Minimum holdout allocation is input 100 malicious/250 benign, tool 50/125, output 50/125: 200/500 total. Report aggregate plus each stage; thresholds remain TPR >=95% and FPR <=2%. Nonzero small denominators alone are insufficient; minimum allocations are enforced by corpus validation.

Input cases use authenticated valid envelopes; tool cases use a benign input and permitted call with a local provider supplying the candidate; output cases use benign input/tools and a local model supplying candidate tokens. Capture a payload-free reached-stage marker, tied to case and turn, before scoring. An upstream block, auth/quota error, timeout or missing marker makes the run incomplete; it never counts as that stage's TP or changes its fixed denominator. Genuine detector bypass counts FN. Authorization, framing/resource-limit, quota, and side-effect cases form a separate invariant suite with 100% required expected outcomes; do not mix them into detector confusion matrices. Pipeline short-circuiting is valid within the expected stage. An unexpected earlier layer may block, but report the layer and verify paired per-layer controls independently.

### Quotas, isolation and repeatability

The detector-corpus profile uses isolated service configuration with CHAT_QUOTA_DAILY=10000 and CHAT_QUOTA_BURST=600 (60-second window), preserving enforcement code. The 5 requests/sec limit is a ceiling; schedule below all other inventoried admission limits. No changes to production defaults or bypass endpoint. A separate quota-invariant profile uses actual default settings and proves burst/daily exhaustion and Redis fail-closed behavior. Reset the disposable database/Redis namespace, users, sessions, stub scripts and counters between complete runs; never delete shared state. Unexpected 429 invalidates detector evaluation.

Budget discovery/auth/setup traffic as well as probes. If coverage exceeds the 5000-request/30-minute cap, use a fixed manifest of disjoint shards, each with the same bounds and profiles. Union reports must cover all required cases/routes exactly once (except explicit replay replicates); missing shards fail. Repeated corpus runs compare semantic outcomes and counts, not timestamps, random IDs, latency samples or ZAP alert order.

### Memory, generated summaries and model callbacks

All model invocations, including summarization and final answer, use a trusted gateway integration. Keep instructions in fixed trusted system content; put loaded messages/summaries in a lower-trust user/tool data envelope, never interpolate them into SystemMessage. Validate both the bounded loaded records and the newly generated summary before persistence or future model use. On unsafe summary, discard it and retain only previously validated memory; on unsafe loaded history, fail the current turn with static clarification. Do not persist a quarantine copy of rejected text; any quarantine marker is metadata-only. Distinguish content-policy rejection from existing transient summarizer failures.

Install callback/tracing policy before any model dispatch: disable payload capture for raw input/output/message and exception fields, allow only fixed metadata and approved gateway outputs. Apply to main, router, final-answer and summary model paths. Raw model chunks may exist only inside the turn's private validation buffer/collector; never publish them to external traces, durable graph checkpoints, next-model requests, or persistence. Sanitize non-streamed AIMessage content before graph-state publication and validate again before reuse; unvalidated tool-call metadata remains private until typed dispatch checks. Test synthetic output/summary canaries across callbacks, traces, state export, subsequent model input, logs and stores, including errors and cancellation.
