"""Bounded upstream-body reader security tests (T024)."""

import json
from collections.abc import AsyncIterator
from unittest.mock import patch

import pytest

from agent.tools.nestjs_client import UpstreamBodyLimitError, read_bounded_json


class SyntheticResponse:
    def __init__(self, chunks: list[bytes], headers: dict[str, str] | None = None) -> None:
        self._chunks = chunks
        self.headers = headers or {}

    async def aiter_bytes(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            yield chunk


@pytest.mark.asyncio
async def test_bounded_reader_rejects_chunked_body_that_exceeds_limit() -> None:
    """Removing in-stream accounting would allow a chunked overflow past the JSON boundary."""
    body = json.dumps({"payload": "x" * 65_537}).encode("utf-8")
    response = SyntheticResponse([body[:32], body[32:]])

    with pytest.raises(UpstreamBodyLimitError):
        await read_bounded_json(response)


@pytest.mark.asyncio
async def test_bounded_reader_does_not_trust_a_false_content_length() -> None:
    """Removing byte accounting would let a false small header bypass the response bound."""
    body = json.dumps({"payload": "x" * 65_537}).encode("utf-8")
    response = SyntheticResponse([body], headers={"content-length": "1"})

    with pytest.raises(UpstreamBodyLimitError):
        await read_bounded_json(response)


@pytest.mark.asyncio
async def test_bounded_reader_rejects_decompressed_expansion() -> None:
    """Removing the decoded-byte bound would admit a compressed expansion bomb."""
    expanded_body = json.dumps({"payload": "x" * 65_537}).encode("utf-8")
    response = SyntheticResponse(
        [expanded_body],
        headers={"content-encoding": "gzip", "content-length": "128"},
    )

    with pytest.raises(UpstreamBodyLimitError):
        await read_bounded_json(response)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        b'{"a":{"b":{"c":{"d":{"e":{"f":1}}}}}}',
        (b"{" + b",".join(f'"k{i}":0'.encode() for i in range(501)) + b"}"),
    ],
)
async def test_bounded_reader_rejects_raw_structure_before_json_decode(body: bytes) -> None:
    """Depth and node overflows must never reach the recursive JSON decoder."""
    response = SyntheticResponse([body])

    with patch("agent.tools.nestjs_client.json.loads") as decode:
        with pytest.raises(UpstreamBodyLimitError):
            await read_bounded_json(response)

    decode.assert_not_called()


@pytest.mark.asyncio
async def test_bounded_reader_counts_only_structural_tokens_outside_json_strings() -> None:
    """Braces, brackets, commas, and escaped quotes in strings are not structure."""
    response = SyntheticResponse([b'{"note":"{ [ , \\" ] }","items":[1,2]}'])

    assert await read_bounded_json(response) == {"note": '{ [ , " ] }', "items": [1, 2]}


@pytest.mark.asyncio
async def test_bounded_reader_rejects_malformed_raw_structure_before_json_decode() -> None:
    """Unbalanced raw JSON fails closed without handing malformed nesting to the decoder."""
    response = SyntheticResponse([b'{"items":[1,2}'])

    with patch("agent.tools.nestjs_client.json.loads") as decode:
        with pytest.raises(UpstreamBodyLimitError):
            await read_bounded_json(response)

    decode.assert_not_called()
