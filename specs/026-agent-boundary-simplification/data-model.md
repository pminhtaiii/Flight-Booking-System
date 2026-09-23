# Data Model: Agent Boundary Simplification

This feature changes ownership and orchestration only. It introduces **no persistent entity, column, table, relation, migration, cache-key format, or retention change**.

## Preserved data contracts

### Encrypted chat message

- Fields remain `ciphertext`, `nonce`, `authTag`, and `keyVersion`.
- `CHAT_ENCRYPTION_KEY`, algorithms, single-version handling, and associated authenticated data remain unchanged.
- Malformed fields, wrong version/key, and AAD mismatch retain current errors.
- The structure is not converted to the unrelated colon-delimited `EncryptionService` format.

### Guardrail values

- `AdmissionContext` and accepted `ValidatedInput` keep their current fields; accepted content remains raw, without new post-validation normalization.
- `TurnCapabilities` keeps sealed tool authority; `ValidatedToolResult` is produced only after all applicable fixed layers pass.
- `ApprovedChunk` is emitted only after existing bounded lookaround approval; undecided cross-token suffixes remain buffered.

## Runtime relationships

```text
AgentGatewayModule -> AgentChatModule -> ChatModule -> ChatService
ChatModule -----------------------> ChatMessageCryptoModule
AttestedFlightSearchModule -------> ChatMessageCryptoModule

GuardrailGateway
├── fixed input tuple
├── fixed tool tuple
└── creates OutputStreamSession per turn
    └── owns exactly one OutputGuardrailPipeline
```

## State transitions

```text
module load/lifespan -> idempotent get-or-create -> GuardrailGateway()
    -> construct production layers -> assert exact types/order/unique keys/prerequisites -> ready
    -> invalid composition -> constructor raises -> startup abort

test -> GuardrailGateway(_input_layers=..., _tool_layers=...)
    -> same assertions; no recovery through is_healthy()

SSE ingress -> auth/access -> transport length guard -> gateway existence/type/health
    -> unavailable/degraded -> existing 503; no validation or Redis/quota
    -> healthy -> build AdmissionContext -> validate_input exactly once
        -> PII -> GUARDRAIL_INPUT_PII -> exact legacy error/GUARDRAIL_BLOCKED event
                 -> immediate return; zero Redis/quota calls
        -> other decision -> retain decision/validated_data -> existing Redis/quota admission
                 -> ChatController.stream(command, admission_decision=decision)
                 -> controller does not revalidate; existing non-PII mapping remains

raw tool result -> schema check -> named PII scan over original raw value
    -> schema + PII block -> GUARDRAIL_TOOL_PII
    -> schema-only block -> GUARDRAIL_TOOL_SCHEMA

turn -> async with gateway.stream_output(context, config=..., session_id=...) as stream
    -> create one pipeline
    -> branch 1/2/3 calls stream.process_token(token) against shared buffer
    -> successful completion calls stream.flush() exactly once
    -> close() is idempotent and never flushes
    -> __aexit__ always calls close()
    -> block re-raises guardrails.base.OutputGuardrailBlockedError unchanged
    -> _finalize_cleanup / normal / block / early / cancel / error preserve:
       persist approved partial response -> close exactly once effectively -> release lease
```

`is_healthy()` observes only post-construction runtime readiness of the already validated tuples and gateway dependencies. It does not convert constructor failure into a degraded object.
