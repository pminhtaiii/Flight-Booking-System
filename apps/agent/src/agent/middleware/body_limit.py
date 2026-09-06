from typing import Any, Callable

ERROR_DETAIL = "Request payload exceeds maximum allowed size of 64 KiB"
ERROR_BODY = b'{"detail": "Request payload exceeds maximum allowed size of 64 KiB"}'


class PayloadTooLargeError(Exception):
    """Raised when streaming request body exceeds max allowed bytes."""


class BodyLimitMiddleware:
    """
    Raw ASGI middleware enforcing strict request body size limits before JSON parsing.
    Protects against memory exhaustion and large unauthenticated payloads.
    """

    def __init__(self, app: Any, max_bytes: int = 65536) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(
        self,
        scope: dict[str, Any],
        receive: Callable[[], Any],
        send: Callable[[dict[str, Any]], Any],
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # 1. Inspect Content-Length header if present
        headers = scope.get("headers", [])
        content_length: int | None = None
        for raw_name, raw_value in headers:
            if raw_name.lower() == b"content-length":
                try:
                    content_length = int(raw_value.decode("latin-1").strip())
                except (ValueError, UnicodeDecodeError):
                    content_length = None
                break

        if content_length is not None and content_length > self.max_bytes:
            await self._send_413(send)
            return

        # 2. Wrap receive to streamingly count incoming bytes
        received_bytes = 0
        response_started = False

        async def custom_send(message: dict[str, Any]) -> None:
            nonlocal response_started
            if message.get("type") == "http.response.start":
                response_started = True
            await send(message)

        async def limited_receive() -> dict[str, Any]:
            nonlocal received_bytes
            message = await receive()
            if message.get("type") == "http.request":
                body = message.get("body", b"")
                received_bytes += len(body)
                if received_bytes > self.max_bytes:
                    raise PayloadTooLargeError()
            return message

        try:
            await self.app(scope, limited_receive, custom_send)
        except PayloadTooLargeError:
            if not response_started:
                await self._send_413(send)

    async def _send_413(self, send: Callable[[dict[str, Any]], Any]) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(ERROR_BODY)).encode("latin-1")),
                ],
            }
        )
        await send(
            {
                "type": "http.response.body",
                "body": ERROR_BODY,
                "more_body": False,
            }
        )


__all__ = ["BodyLimitMiddleware", "PayloadTooLargeError"]
