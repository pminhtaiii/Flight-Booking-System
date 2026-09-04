# Guardrail Data Model

No Prisma migration; reuse encrypted chat and private snapshots.

| Entity | Fields and validation | Lifecycle |
|---|---|---|
| AdmissionContext | opaque turn/trace IDs, internal principal, policy version; no tool authority | Input/history validation before routing |
| TurnCapabilities | turn binding, raw routing provenance, gate result, immutable allowed tool set | Sealed by trusted code after router/gate; no later expansion |
| LayerDecision | closed stage/layer keys, PASS/BLOCK, bounded reason enum, finite nonnegative durationMs | One per executed layer; skipped is distinct from PASS |
| PipelineDecision | PASS with typed approved value OR BLOCK with static response key | Impossible to consume rejected payload |
| ToolProjection | exact schema per six tools; forbid extra fields; separate private control/narration | Before model/state/event use |
| StreamState | bounded pending text and retained suffix, approved prefix length, OPEN/BLOCKED/CLOSED | Per turn only; EOF validates pending suffix |
| SecurityEvent | timestamp/level/service/trace_id/correlation_id/message, stage/layerName/decision/durationMs/policyVersion; restricted subjectRef/keyId | Payload-free sink; metrics omit all identifiers |
| CorpusCase | ID, suiteKind (detector/invariant), expectedStage/layer family, fixture, label, expected outcome, reached-stage marker, source/license/revision/hash, split/variant group | Reviewed immutable corpus |
| ScanResult | commit/tool/policy/corpus hashes, targets, counts, confusion matrix, errors/skips, coverage, findings, exit status | Sanitized immutable artifact; missing fields invalid |
| FindingException | fingerprint, owner, severity, reason, scope, compensating control, expiry <=30 days | Re-evaluated each run; no Critical/High release exception |

Turn transitions: RECEIVED -> INPUT_VALIDATED -> ROUTED -> CAPABILITIES_SEALED -> EXECUTING -> TOOL_VALIDATED (repeat) -> STREAMING -> CLOSED. A policy exception or violation -> BLOCKED -> cleanup -> CLOSED. Cancellation discards pending output. Audit failure never converts BLOCK to PASS. Tool transport necessarily executes before result validation, but consumer callbacks/state/model/public events receive only validated projections.

Use the bounded StreamState mapping and capability/corpus contracts in `contracts/guardrail-boundaries.md`. Generated summaries are candidate values until validation passes; rejected candidates are discarded, never persisted as quarantine content. Raw model output is turn-private until validated.
