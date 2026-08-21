# Chat Turn Runner and Event Contract

## Runner

```python
class ChatTurnRunner:
    async def run(
        self,
        command: ChatTurnCommand,
    ) -> AsyncIterator[ChatTurnEvent]: ...
```

The runner owns the durable turn lifecycle; it accepts no HTTP response or SSE transport object.

## Event union

`ChatTurnEvent` is a strict Pydantic discriminated union with `extra="forbid"` over these unchanged wire event names:

- `token`
- `tool_call`
- `tool_result`
- `flight_results`
- `ACTION_HANDOFF`
- `ACTION_REQUIRED`
- `done`
- `error`

Existing payload keys and ordering remain golden-tested. The handoff credential is permitted only at `ACTION_HANDOFF.handoffToken`.

## Failure ordering

```text
failure detected
→ persist permitted safe partial turn
→ finalize/close output guardrails
→ release owned session lease and resources
→ yield terminal error event if transport remains connected
```

Disconnect or process shutdown calls runner cancellation/closure and waits for this finalization; the SSE adapter performs no domain cleanup.

## Transport adapter

The FastAPI adapter owns request/header parsing, pre-stream admission and HTTP errors, disconnect detection, runner closure, and SSE encoding. Pre-stream failures remain HTTP failures; established-stream failures remain typed `error` events.
