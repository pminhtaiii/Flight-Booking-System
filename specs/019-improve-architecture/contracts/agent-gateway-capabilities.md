# Agent Gateway Capability Contracts

Existing `/api/agent-gateway/...` paths, guards, status codes, and safe response bodies remain compatible while ownership moves to these modules:

| Capability               | Owns                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| Attested Flight Search   | Legacy-compatible search, V2 attested search, mapping, selection attestation, privacy-safe audit |
| Agent Booking Readiness  | Readiness evaluation projection and observability                                                |
| Safe Booking Read        | Summary/detail two-tier projection and temporarily retained legacy endpoint                      |
| Traveler Preferences     | Allowlisted preference projection                                                                |
| Agent Chat (Chat module) | Access/revocation, session/message/memory persistence, fencing, deletion                         |

## Audit contract

Tool audit records contain only allowlisted tool name, outcome, duration, response size, and sanitized trace/correlation identifiers. Raw request DTOs, session IDs, offer IDs, PII, tokens, provider payloads, and payment data are forbidden.

## Compatibility contract

- The six approved Python tool names do not change.
- No write-capable LLM tool is introduced.
- Booking summary/detail projections retain their two-tier privacy restrictions.
- The legacy broad booking endpoint is not treated as an approved tool and is not silently deleted in this refactor; it remains a separately tracked compatibility/deprecation concern.
- Chat route wire paths remain stable even though their controller/service ownership moves into `ChatModule`.

## Module dependency rule

Tool controllers inject capability-local services only. Shared agent authentication guards live in a narrow exported auth module. The broad `AgentGatewayService` is deleted only after every endpoint has migrated and the compatibility E2E suites pass.
