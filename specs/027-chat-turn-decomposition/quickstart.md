# Quickstart: Validate Chat Turn Decomposition

Run from repository root in PowerShell with dependencies already installed. The isolated tests use fakes and need no live LLM or Redis. See [internal contracts](./contracts/chat-turn-internal.md) for expected event order.

## Focused steps

```powershell
$env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
uv run --package agent pytest apps/agent/tests/test_chat_turn_events.py apps/agent/tests/test_tool_result_resolver.py apps/agent/tests/test_chat_turn_interpreter.py
uv run --package agent pytest apps/agent/tests/test_conversation_memory.py apps/agent/tests/test_memory.py
uv run --package agent pytest apps/agent/tests/test_chat_admission.py apps/agent/tests/test_sse.py apps/agent/tests/test_chat_controller.py
uv run --package agent pytest apps/agent/tests/test_chat_turn_runner.py apps/agent/tests/test_sse_integration.py apps/agent/tests/characterization/test_sse_characterization.py
```

The three new test files named above are created during implementation. Expected: exit code 0; synthetic graph events preserve ToolResultEvent plus specialized follow-ups, all model-output branches are guardrail-scanned, and blocked input consumes no quota.

## Final gate

```powershell
$env:UV_CACHE_DIR = "$PWD/.t093-uv-cache"
uv run --package agent ruff check apps/agent
uv run --package agent ruff format --check apps/agent
uv run --package agent pytest apps/agent/tests -m "not redis_integration"
rg -n 'format_sse' apps/agent/src/agent/chat_turn/events.py
rg -n 'on_tool_end|on_chain_end|resolver.resolve' apps/agent/src/agent/chat_turn
```

Expected: Ruff and pytest exit 0. The first ripgrep returns no match (exit 1); the second is a manual census proving the validated `tools` chain-end hook invokes the resolver while `on_tool_end` remains timing-only. Confirm no endpoint/event payload, dependency, or persistence diff.
