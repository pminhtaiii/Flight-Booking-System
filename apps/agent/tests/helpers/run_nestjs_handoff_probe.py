"""Exercise the real NestJS handoff boundary without emitting request data."""

import asyncio
import json
import sys

import httpx

from agent.tools.nestjs_client import NestJSClient


async def _run() -> None:
    request = json.load(sys.stdin)
    client = NestJSClient(
        base_url=request["baseUrl"],
        token=request["token"],
        trace_id=request["traceId"],
        correlation_id=request["correlationId"],
    )
    await client.create_handoff(
        attestation=request["attestation"],
        offer_index=request["offerIndex"],
    )


def main() -> int:
    try:
        asyncio.run(_run())
    except httpx.HTTPStatusError as error:
        sys.stdout.write('{"ok":false,"error":"handoff_http_failed"}')
        return max(2, min(125, error.response.status_code // 10))
    except Exception:  # noqa: BLE001
        sys.stdout.write('{"ok":false,"error":"handoff_request_failed"}')
        return 1
    sys.stdout.write('{"ok":true}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
