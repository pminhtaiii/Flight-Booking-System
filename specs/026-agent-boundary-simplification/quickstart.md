# Quickstart: Validate Agent Boundary Simplification

## Evidence destination

When implementation starts, save command, timestamp, commit SHA, exit code, and concise output for both pre-change and post-change runs under `specs/026-agent-boundary-simplification/verification/` (for example `api-baseline.md`, `agent-baseline.md`, `api-final.md`, and `agent-final.md`). This directory is planned runtime evidence and is not created by the planning phase.

## Static boundaries

```powershell
rg -n "agent-gateway" apps/api/src/chat
rg -n "@/chat/chat-message-crypto.service|GuardrailRegistry|create_production_registry|OutputPIILayer|InputGuardrailPipeline|ToolOutputGuardrailPipeline" apps/api apps/agent
rg -n "OutputGuardrailPipeline\(" apps/agent/src/agent --glob "*.py"
rg -n "OutputGuardrailPipeline|OutputGuardrailBlockedError" apps/agent/src/agent --glob "*.py" --glob "!**/guardrails/gateway.py" --glob "!**/guardrails/output_pipeline.py" --glob "!**/guardrails/base.py"
rg -n "^(async )?def (deterministic_pii_match|_is_output_guardrail_disabled|approved_model_content)" apps/agent/src/agent --glob "*.py"
```

Expected: no gateway import under `chat`, no old crypto or removed-symbol callers, production pipeline construction only inside the gateway, zero external class/block-error imports from `output_pipeline.py`, and exactly one definition of each PII utility in `pii.py`. External `payload_free_config` imports from `output_pipeline.py` are retained and are not census failures.

## Record the P1 API baseline and verify P1 independently

Before changing source, run the existing focused unit and API baseline:

```powershell
Push-Location apps/api
& '.\node_modules\.bin\jest.CMD' --runInBand `
  src/chat/agent-chat.controller.spec.ts `
  src/chat/agent-chat-access.service.spec.ts `
  src/chat/chat-message-crypto.service.spec.ts `
  src/agent-gateway/attested-flight-search/attested-flight-search.service.spec.ts `
  src/agent-gateway/attested-flight-search/attested-flight-search.persistence.spec.ts
& '.\node_modules\.bin\jest.CMD' --runInBand --config test/jest-e2e.json `
  test/agent-chat-gateway.e2e-spec.ts `
  test/agent-gateway.e2e-spec.ts `
  test/chat.e2e-spec.ts `
  test/chat-plaintext-cleanup.e2e-spec.ts `
  test/chat-privacy-corpus.e2e-spec.ts `
  test/negative-privacy-audit.e2e-spec.ts `
  test/phase11d-cryptographic-audit.e2e-spec.ts `
  test/phase11e-continuous-reliability.e2e-spec.ts `
  test/privacy-and-telemetry-audit.e2e-spec.ts `
  test/rollback-matrix.e2e-spec.ts
Pop-Location
pnpm exec eslint "apps/api/**/*.ts" "packages/shared/**/*.ts" --max-warnings 0
pnpm --filter @shared/types test
pnpm --filter @api/backend exec tsc -p tsconfig.json --noEmit
pnpm --filter @api/backend build
```

After implementation, run the same commands with the three moved unit-test paths under `src/agent-gateway/agent-chat/` and `src/common/`.

Expected: identical routes, guards, statuses, payloads, encryption fixtures, and wrong-key/version/AAD failures; `ChatModule` exports only `ChatService`; attested flight search no longer imports `ChatModule` for crypto.

## Verify P2 independently

```powershell
$env:UV_CACHE_DIR = "C:\Booking Systems\.t093-uv-cache"
uv run --package agent ruff check apps/agent
uv run --package agent ruff format --check apps/agent
$env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"
uv run --package agent pytest apps/agent/tests/security/test_gateway.py apps/agent/tests/security/test_input_layers.py apps/agent/tests/security/test_tool_layers.py apps/agent/tests/security/test_output_stream.py apps/agent/tests/test_output_pipeline.py apps/agent/tests/test_chat_turn_runner.py apps/agent/tests/test_sse.py
```

Expected: invalid composition raises; raw extra-field PII wins; one stream session spans all branches, flushes once, and has idempotent non-flushing close with stable `guardrails.base.OutputGuardrailBlockedError`. Both matcher and disabled predicate are imported from `pii.py`; there are no duplicate definitions/import cycles, lint passes, and every disabled-config shape works for batch and streaming. For ingress PII, spies prove one gateway call after length/health but before quota, zero `get_redis_client`/budget calls, and exactly one `error` event with code `GUARDRAIL_BLOCKED`, message `Your message contains protected personal information and cannot be processed.`, and `partialMessageId: null`. Unhealthy gateway retains its 503 precedence; with a healthy gateway, PII wins over Redis failure. Non-PII decisions are passed into the controller and are not revalidated.

Then run the complete agent gate:

```powershell
uv run --package agent pytest apps/agent/tests -m "not redis_integration"
git diff -- apps/api/prisma
```

Expected: the full suite passes and there is no Prisma schema/migration change.
