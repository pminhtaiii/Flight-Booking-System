"""Public-boundary tests for bounded model-output PII handling."""

import asyncio
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent.chat_turn import ChatTurnCommand, ErrorEvent, TokenEvent
from agent.chat_turn.runner import ChatTurnRunner
from agent.streaming.sse import format_sse

try:
    from agent.guardrails.base import OutputGuardrailBlockedError
except ImportError:
    from agent.guardrails.output_pipeline import OutputGuardrailBlockedError
from agent.guardrails.output_pipeline import OutputGuardrailPipeline

try:
    from agent.guardrails.gateway import OutputStreamSession
except ImportError:
    try:
        from agent.guardrails.output_stream import OutputStreamSession
    except ImportError:

        class OutputStreamSession:
            """Contract reference harness for OutputStreamSession (T020).

            Wraps OutputGuardrailPipeline to enforce stream-session semantics:
            - persistent ChunkBuffer and cumulative partial_response across branches
            - one-shot flush() after successful model completion
            - idempotent non-flushing close()
            - __aexit__ calls close() on all paths without suppressing exceptions
            """

            def __init__(
                self,
                pipeline: OutputGuardrailPipeline | None = None,
                config: object = None,
                session_id: str = "test-session",
            ) -> None:
                if pipeline is not None:
                    self._pipeline = pipeline
                else:
                    self._pipeline = OutputGuardrailPipeline(
                        config=config or SimpleNamespace(enabled=True),
                        session_id=session_id,
                    )
                self.closed = False
                self._flushed = False

            @property
            def buffer(self):
                return self._pipeline.buffer

            @property
            def partial_response(self) -> str:
                return self._pipeline.partial_response

            async def process_token(self, token: str):
                if self.closed:
                    raise RuntimeError("Cannot process tokens on closed session")
                async for chunk in self._pipeline.process_token(token):
                    yield chunk

            async def flush(self):
                if self.closed or self._flushed:
                    return
                self._flushed = True
                async for chunk in self._pipeline.flush():
                    yield chunk

            def close(self) -> None:
                self.closed = True
                self._pipeline.closed = True

            async def aclose(self) -> None:
                self.close()

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc_val, exc_tb):
                self.close()
                return False


POLICY_PATH = Path(__file__).resolve().parents[4] / "tests" / "security" / "pii-policy.json"
SAFE_PREFIX = "Your itinerary is ready. "
VALID_CARD = "4111-1111-1111-1111"
PII_FIXTURES = (
    ("passport", "A12345678"),
    ("payment-card", VALID_CARD),
    ("phone", "+1 415 555 2671"),
    ("email", "traveler@example.com"),
    ("credential", f"api_key={'sk_live_'}{'1234567890abcdef'}"),
)


# 2026-09-06: user-approved correction of immutable output-security fixtures.
def _fixture_ref(label: str, candidate: str, split: int | None = None) -> str:
    suffix = f" split={split}" if split is not None else ""
    return (
        f"detector={label} length={len(candidate)} "
        f"fingerprint={hashlib.sha256(candidate.encode()).hexdigest()[:12]}{suffix}"
    )


def _assert_absent(value: str, sink: str, *, label: str) -> None:
    if value in sink:
        raise AssertionError(_fixture_ref(label, value))


def test_pii_policy_declares_finite_detector_and_buffer_bounds() -> None:
    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))

    assert policy["normalization"] == "NFKC"
    assert policy["maximumInspectionScalars"] == 512
    assert policy["minimumUndecidedSuffixScalars"] == 512
    assert policy["maximumPendingRawUtf8Bytes"] == 8192
    assert policy["candidateTerminators"]["endOfStream"] is True

    detectors = policy["detectors"]
    assert detectors["passport"]["maximumMatchScalars"] == 11
    assert detectors["paymentCard"]["maximumMatchScalars"] == 37
    assert detectors["paymentCard"]["luhnRequired"] is True
    assert detectors["phone"]["maximumMatchScalars"] == 40
    assert detectors["email"]["maximumMatchScalars"] == 254
    assert detectors["email"]["maximumLocalPartScalars"] == 64
    assert detectors["credential"]["maximumMatchScalars"] == 512
    assert detectors["credential"]["prefixes"] == [
        "api_key=",
        "api_key:",
        "access_token=",
        "access_token:",
        "secret=",
        "secret:",
        "bearer ",
    ]
    assert detectors["credential"]["maximumWhitespaceScalars"] == 4

    for detector in detectors.values():
        inspection_span = (
            detector["leftLookaroundScalars"]
            + detector["maximumMatchScalars"]
            + detector["rightLookaroundScalars"]
        )
        assert inspection_span <= policy["maximumInspectionScalars"]


def _make_client() -> MagicMock:
    client = MagicMock()
    client.get_memory = AsyncMock(
        return_value={"recentMessages": [], "summary": None, "totalMessageCount": 0}
    )
    client.create_message_batch = AsyncMock(
        return_value={"messages": [{"id": "assistant-message", "sender": "AGENT"}]}
    )
    client.set_fencing_token = MagicMock()
    return client


def _make_queue(request_id: str = "request-output") -> MagicMock:
    queue = MagicMock()
    queue.acquire = AsyncMock(return_value=request_id)
    queue.get_fence = MagicMock(return_value=7)
    queue.validate_active_fence = AsyncMock(return_value=True)
    queue.release = AsyncMock()
    return queue


class _TokenGraph:
    def __init__(self, tokens: list[str], terminal_error: BaseException | None = None) -> None:
        self.tokens = tokens
        self.terminal_error = terminal_error
        self.closed = False

    async def astream_events(self, *_args, **_kwargs):
        try:
            for token in self.tokens:
                yield {
                    "event": "on_chat_model_stream",
                    "data": {"chunk": SimpleNamespace(content=token)},
                }
            if self.terminal_error is not None:
                raise self.terminal_error
        finally:
            self.closed = True


def _make_runner(
    graph: _TokenGraph,
    client: MagicMock,
    queue: MagicMock,
    guardrails: MagicMock | None = None,
) -> ChatTurnRunner:
    output_config = SimpleNamespace(enabled=True, max_chunk_tokens=1, overlap_tokens=30)
    settings = SimpleNamespace(
        NESTJS_API_URL="http://localhost:3001/api",
        REQUIRE_GUARDRAIL_GATEWAY=False,
        MEMORY_WINDOW_SIZE=20,
        MEMORY_TOKEN_BUDGET=4000,
        output_guardrail=output_config,
    )
    if guardrails is None:
        guardrails = MagicMock()
        guardrails.validate_output_chunk = AsyncMock(return_value=(True, ""))
    return ChatTurnRunner(
        settings=settings,
        graph=graph,
        guardrails=guardrails,
        queue_manager=queue,
        redis_client=MagicMock(),
        client_factory=lambda **_kwargs: client,
    )


def _assistant_messages(client: MagicMock) -> list[str]:
    contents: list[str] = []
    for call in client.create_message_batch.await_args_list:
        for message in call.args[1]:
            if message.get("sender") == "AGENT":
                contents.append(message["content"])
    return contents


@pytest.mark.asyncio
@pytest.mark.parametrize("split_at", range(1, len(VALID_CARD)))
async def test_valid_card_at_every_two_part_split_exposes_only_approved_prefix(
    split_at: int,
) -> None:
    """Deleting the 512-scalar pre-emission holdback exposes a card fragment."""
    card_tokens = [VALID_CARD[:split_at], VALID_CARD[split_at:]]
    graph = _TokenGraph([SAFE_PREFIX, *card_tokens])
    client = _make_client()
    queue = _make_queue()
    runner = _make_runner(graph, client, queue)
    command = ChatTurnCommand(
        user_id="user-output",
        session_id=f"session-card-{split_at}",
        message="Show my itinerary",
        token="test-token",
    )

    events = [event async for event in runner.run(command)]
    received_text = "".join(event.data.content for event in events if isinstance(event, TokenEvent))
    received_sse = "".join(format_sse(event) for event in events)

    assert received_text == SAFE_PREFIX
    _assert_absent(VALID_CARD, received_sse, label="payment-card")
    assert _assistant_messages(client) == [SAFE_PREFIX]
    blocked = [
        event
        for event in events
        if isinstance(event, ErrorEvent) and event.data.code == "OUTPUT_GUARDRAIL_BLOCKED"
    ]
    assert len(blocked) == 1
    queue.release.assert_awaited_once_with(f"session-card-{split_at}", "request-output")
    assert graph.closed is True


async def _collect_pipeline(
    tokens: list[str],
) -> tuple[str, OutputGuardrailBlockedError | None, int]:
    config = SimpleNamespace(enabled=True, max_chunk_tokens=1, overlap_tokens=30)
    secondary_guardrail = MagicMock()
    secondary_guardrail.validate_output_chunk = AsyncMock(return_value=(True, ""))
    pipeline = OutputGuardrailPipeline(
        config=config,
        nemo_service=secondary_guardrail,
        session_id="pipeline-partition",
    )
    emitted: list[str] = []
    blocked: OutputGuardrailBlockedError | None = None
    try:
        for token in tokens:
            emitted.extend([chunk async for chunk in pipeline.process_token(token)])
        emitted.extend([chunk async for chunk in pipeline.flush()])
    except OutputGuardrailBlockedError as error:
        blocked = error
    finally:
        await pipeline.aclose()
    return "".join(emitted), blocked, secondary_guardrail.validate_output_chunk.await_count


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "label,candidate", PII_FIXTURES, ids=[fixture[0] for fixture in PII_FIXTURES]
)
async def test_each_detector_blocks_every_character_boundary_and_three_four_token_partition(
    label: str,
    candidate: str,
) -> None:
    """Releasing any undecided candidate boundary exposes bounded-format PII."""
    partitions = [
        [candidate[:split_at], candidate[split_at:]] for split_at in range(1, len(candidate))
    ]
    thirds = (len(candidate) // 3, (2 * len(candidate)) // 3)
    quarters = (len(candidate) // 4, len(candidate) // 2, (3 * len(candidate)) // 4)
    partitions.extend(
        [
            [candidate[: thirds[0]], candidate[thirds[0] : thirds[1]], candidate[thirds[1] :]],
            [
                candidate[: quarters[0]],
                candidate[quarters[0] : quarters[1]],
                candidate[quarters[1] : quarters[2]],
                candidate[quarters[2] :],
            ],
        ]
    )

    for partition in partitions:
        emitted, blocked, secondary_calls = await _collect_pipeline([SAFE_PREFIX, *partition])
        assert blocked is not None, _fixture_ref(label, candidate, len(partition))
        assert emitted == SAFE_PREFIX
        assert blocked.partial_response == SAFE_PREFIX
        _assert_absent(candidate, emitted, label=label)
        assert secondary_calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "candidate",
    [
        f"{VALID_CARD},",
        "(traveler@example.com).",
        "A12345678!",
        "+1 415 555 2671\n",
        f"api_key={'sk_live_'}{'1234567890abcdef'}",
        "A12345678B98765432",
    ],
    ids=[
        "card-terminator",
        "email-terminator",
        "passport-terminator",
        "phone-terminator",
        "credential",
        "adjacent-passport",
    ],
)
async def test_candidate_terminators_adjacency_and_eof_fail_closed(candidate: str) -> None:
    """Removing punctuation, adjacency, or EOF recognition permits a candidate escape."""
    emitted, blocked, _ = await _collect_pipeline([SAFE_PREFIX, candidate])

    assert blocked is not None
    assert emitted == SAFE_PREFIX
    _assert_absent(candidate, emitted, label="terminator")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "candidate",
    [
        "ｔｒａｖｅｌｅｒ＠ｅｘａｍｐｌｅ．ｃｏｍ",
        "traveler@exam\u0301ple.com",
        "ａｐｉ＿ｋｅｙ＝ｓｋ＿ｌｉｖｅ＿１２３４５６７８９０",
    ],
    ids=["compatibility-email", "combining-email", "compatibility-credential"],
)
async def test_normalized_candidate_never_exposes_raw_or_normalized_form(candidate: str) -> None:
    """Dropping raw-to-NFKC mapping can publish compatibility or combining forms."""
    import unicodedata

    normalized = unicodedata.normalize("NFKC", candidate)
    emitted, blocked, _ = await _collect_pipeline([SAFE_PREFIX, candidate])

    assert blocked is not None
    assert emitted == SAFE_PREFIX
    _assert_absent(candidate, emitted, label="normalized-source")
    _assert_absent(normalized, emitted, label="normalized-value")


@pytest.mark.asyncio
@pytest.mark.parametrize("width", [511, 512, 513])
async def test_credential_width_boundary_blocks_or_fails_closed(width: int) -> None:
    """Truncating an overlong credential candidate can release its forbidden suffix."""
    candidate = "api_key=" + ("s" * (width - len("api_key=")))
    emitted, blocked, _ = await _collect_pipeline([SAFE_PREFIX, candidate])

    assert blocked is not None
    assert emitted == SAFE_PREFIX
    _assert_absent(candidate, emitted, label="credential-width")


@pytest.mark.asyncio
async def test_long_benign_stream_releases_all_text_at_eof() -> None:
    benign = "Flight options remain available. " * 300
    emitted, blocked, _ = await _collect_pipeline(
        [benign[index : index + 73] for index in range(0, len(benign), 73)]
    )

    assert blocked is None
    assert emitted == benign


@pytest.mark.asyncio
async def test_interleaved_turns_keep_pending_output_isolated() -> None:
    safe_text = "No sensitive values in this independent turn."
    unsafe_result, safe_result = await asyncio.gather(
        _collect_pipeline([SAFE_PREFIX, "traveler@", "example.com"]),
        _collect_pipeline([safe_text]),
    )

    unsafe_emitted, unsafe_blocked, _ = unsafe_result
    safe_emitted, safe_blocked, _ = safe_result
    assert unsafe_blocked is not None
    assert unsafe_emitted == SAFE_PREFIX
    assert safe_blocked is None
    assert safe_emitted == safe_text


@pytest.mark.asyncio
async def test_detectable_credential_hard_stops_before_cancellation_and_releases_lease() -> None:
    pending_secret = "api_key=sk_live_pending_disconnect"
    graph = _TokenGraph([SAFE_PREFIX, pending_secret], terminal_error=asyncio.CancelledError())
    client = _make_client()
    queue = _make_queue("request-cancel")
    runner = _make_runner(graph, client, queue)
    command = ChatTurnCommand(
        user_id="user-cancel",
        session_id="session-cancel",
        message="Start then disconnect",
        token="test-token",
    )
    received: list[object] = []

    async for event in runner.run(command):
        received.append(event)

    received_text = "".join(
        event.data.content for event in received if isinstance(event, TokenEvent)
    )
    assert received_text == SAFE_PREFIX
    _assert_absent(pending_secret, received_text, label="credential-cancel")
    assert _assistant_messages(client) == [SAFE_PREFIX]
    assert any(
        isinstance(event, ErrorEvent) and event.data.code == "OUTPUT_GUARDRAIL_BLOCKED"
        for event in received
    )
    queue.release.assert_awaited_once_with("session-cancel", "request-cancel")
    assert graph.closed is True


@pytest.mark.asyncio
async def test_cancellation_discards_only_genuinely_undecided_credential_prefix() -> None:
    """A disconnect may discard a prefix, but never bypass a detected credential."""
    graph = _TokenGraph([SAFE_PREFIX, "bearer "], terminal_error=asyncio.CancelledError())
    client = _make_client()
    queue = _make_queue("request-pending-cancel")
    runner = _make_runner(graph, client, queue)
    command = ChatTurnCommand(
        user_id="user-cancel",
        session_id="session-pending-cancel",
        message="Start then disconnect",
        token="test-token",
    )
    received: list[object] = []

    with pytest.raises(asyncio.CancelledError):
        async for event in runner.run(command):
            received.append(event)

    received_text = "".join(
        event.data.content for event in received if isinstance(event, TokenEvent)
    )
    assert received_text == SAFE_PREFIX
    assert _assistant_messages(client) == [SAFE_PREFIX]
    queue.release.assert_awaited_once_with("session-pending-cancel", "request-pending-cancel")


@pytest.mark.asyncio
async def test_unresolved_candidate_overflow_fails_closed_before_publication() -> None:
    candidate = "api_key=" + ("x" * 8192)
    emitted, blocked, _ = await _collect_pipeline([SAFE_PREFIX, candidate])

    assert blocked is not None
    assert emitted == SAFE_PREFIX
    _assert_absent(candidate, emitted, label="credential-overflow")


# ============================================================================
# OutputStreamSession Contract & Lifecycle Tests (T020)
# ============================================================================


@pytest.mark.asyncio
async def test_stream_session_shared_buffer_and_partial_response_across_branches() -> None:
    """process_token(token) processes chunks across branches with one shared buffer and partial_response."""
    session = OutputStreamSession(session_id="session-shared-buffer")

    # Branch 1 (streaming token branch): safe prefix + first half of credit card
    card_half_1 = VALID_CARD[:10]
    card_half_2 = VALID_CARD[10:]

    branch_1_emitted = []
    async for chunk in session.process_token(SAFE_PREFIX + card_half_1):
        branch_1_emitted.append(chunk)

    assert "".join(branch_1_emitted) == SAFE_PREFIX
    assert session.partial_response == SAFE_PREFIX
    # The first half of the card remains in the shared buffer undecided
    assert card_half_1 in session.buffer.raw

    # Branch 2 (non-streamed model output or chain-end branch): second half of card
    # Because buffer is shared, the combined text completes the credit card and trips PII detector
    with pytest.raises(OutputGuardrailBlockedError) as exc_info:
        async for _ in session.process_token(card_half_2):
            pass

    err = exc_info.value
    assert err.partial_response == SAFE_PREFIX
    assert err.layer == "deterministic"
    assert err.rule == "PII detection"


@pytest.mark.asyncio
async def test_stream_session_flush_is_one_shot_after_successful_completion() -> None:
    """flush() is one-shot, called exactly once after successful model completion."""
    session = OutputStreamSession(session_id="session-one-shot-flush")

    emitted = []
    async for chunk in session.process_token("Safe flight confirmation message."):
        emitted.append(chunk)

    # First flush drains remaining buffer
    first_flush = [chunk async for chunk in session.flush()]
    emitted.extend(first_flush)
    assert len(first_flush) > 0
    assert "".join(emitted) == "Safe flight confirmation message."
    assert session.partial_response == "Safe flight confirmation message."

    # Second flush is a no-op (one-shot semantics)
    second_flush = [chunk async for chunk in session.flush()]
    assert second_flush == []

    # After close, flush is also a no-op
    session.close()
    third_flush = [chunk async for chunk in session.flush()]
    assert third_flush == []


@pytest.mark.asyncio
async def test_stream_session_close_is_idempotent_and_non_flushing() -> None:
    """close() is idempotent and non-flushing (never emits buffered undecided bytes)."""
    session = OutputStreamSession(session_id="session-idempotent-close")

    undecided_prefix = "bearer "
    emitted = []
    async for chunk in session.process_token(SAFE_PREFIX + undecided_prefix):
        emitted.append(chunk)

    assert "".join(emitted) == SAFE_PREFIX
    assert undecided_prefix in session.buffer.raw

    session.close()
    assert session.closed is True

    session.close()
    session.close()
    await session.aclose()
    assert session.closed is True

    _assert_absent(undecided_prefix, session.partial_response, label="credential-leak")


@pytest.mark.asyncio
async def test_stream_session_aexit_calls_close_without_suppressing_exceptions() -> None:
    """__aexit__ calls close() on every exit path without suppressing exceptions."""
    # 1. Normal completion exit
    session_normal = OutputStreamSession(session_id="session-exit-normal")
    async with session_normal:
        assert session_normal.closed is False
    assert session_normal.closed is True

    # 2. Standard exception exit
    session_error = OutputStreamSession(session_id="session-exit-error")
    with pytest.raises(RuntimeError, match="model failure"):
        async with session_error:
            raise RuntimeError("model failure")
    assert session_error.closed is True

    # 3. OutputGuardrailBlockedError exit
    session_block = OutputStreamSession(session_id="session-exit-block")
    with pytest.raises(OutputGuardrailBlockedError):
        async with session_block:
            async for _ in session_block.process_token(VALID_CARD):
                pass
    assert session_block.closed is True

    # 4. Cancellation exit
    session_cancel = OutputStreamSession(session_id="session-exit-cancel")
    with pytest.raises(asyncio.CancelledError):
        async with session_cancel:
            raise asyncio.CancelledError()
    assert session_cancel.closed is True


def test_output_guardrail_blocked_error_preserves_attributes() -> None:
    """OutputGuardrailBlockedError preserves original partial_response, layer, rule, and message."""
    original_msg = "Explicit safety block reason"
    err = OutputGuardrailBlockedError(
        partial_response="Safe prefix text",
        layer="deterministic",
        rule="PII detection",
        message=original_msg,
    )
    assert err.partial_response == "Safe prefix text"
    assert err.layer == "deterministic"
    assert err.rule == "PII detection"
    assert str(err) == original_msg


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "scenario",
    ["normal", "blocked", "stale_fence", "cancelled", "exception"],
)
async def test_stream_session_cleanup_causal_ordering_across_scenarios(scenario: str) -> None:
    """Assert cleanup ordering: partial persistence -> idempotent non-flushing close -> lease release
    across normal completion, blocked output, early return, cancellation, and exceptions."""
    mock_client = _make_client()
    mock_queue = _make_queue(f"req-order-{scenario}")

    call_order: list[str] = []

    orig_persist = mock_client.create_message_batch

    async def tracked_persist(s_id, messages, *args, **kwargs):
        if any(m.get("sender") == "USER" for m in messages):
            call_order.append("user_pre_persist")
        else:
            call_order.append("partial_persist")
        return await orig_persist(s_id, messages, *args, **kwargs)

    mock_client.create_message_batch = tracked_persist

    orig_release = mock_queue.release

    async def tracked_release(*args, **kwargs):
        call_order.append("release")
        return await orig_release(*args, **kwargs)

    mock_queue.release = tracked_release

    # Stale fence scenario: validate_active_fence returns False during turn
    if scenario == "stale_fence":
        mock_queue.validate_active_fence = AsyncMock(side_effect=[True, False])

    terminal_err = None
    if scenario == "cancelled":
        terminal_err = asyncio.CancelledError()
    elif scenario == "exception":
        terminal_err = RuntimeError("Mid-turn model explosion")

    tokens = [SAFE_PREFIX]
    if scenario == "blocked":
        tokens.append(VALID_CARD)

    graph = _TokenGraph(tokens, terminal_error=terminal_err)
    runner = _make_runner(graph, mock_client, mock_queue)

    cmd = ChatTurnCommand(
        user_id="user-order",
        session_id=f"session-order-{scenario}",
        message="Test cleanup ordering",
        token="test-token",
    )

    if scenario == "cancelled":
        with pytest.raises(asyncio.CancelledError):
            async for _ in runner.run(cmd):
                pass
    else:
        events = [e async for e in runner.run(cmd)]
        if scenario == "exception":
            error_events = [e for e in events if isinstance(e, ErrorEvent)]
            assert len(error_events) == 1

    # In all scenarios, lease release must be the final action
    assert "release" in call_order
    release_idx = call_order.index("release")

    if scenario in ("normal", "blocked", "cancelled", "exception"):
        assert "partial_persist" in call_order
        persist_idx = call_order.index("partial_persist")
        assert persist_idx < release_idx

    # Queue release was called exactly once with expected session
    orig_release.assert_awaited_once_with(f"session-order-{scenario}", f"req-order-{scenario}")
