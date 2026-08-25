"""Fail closed when CI Python processes attempt non-loopback networking."""

from __future__ import annotations

import socket

_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "0.0.0.0"})
_ORIGINAL_CONNECT = socket.socket.connect
_ORIGINAL_CREATE_CONNECTION = socket.create_connection


def _blocked(destination: object) -> RuntimeError:
    return RuntimeError(
        "[ci-network-guard] Blocked outbound connection to "
        f"{destination!r}. Only loopback hosts (localhost, 127.0.0.1, ::1, "
        "0.0.0.0) and Unix sockets are allowed in CI."
    )


def _is_allowed(destination: object) -> bool:
    if isinstance(destination, (str, bytes, bytearray)):
        return True  # Unix-domain socket path.
    if not isinstance(destination, tuple) or not destination:
        return False
    host = destination[0]
    return isinstance(host, str) and host.strip().strip("[]").lower() in _LOOPBACK_HOSTS


def _guarded_connect(self: socket.socket, address: object) -> object:
    if not _is_allowed(address):
        raise _blocked(address)
    return _ORIGINAL_CONNECT(self, address)


def _guarded_create_connection(
    address: object,
    timeout=socket._GLOBAL_DEFAULT_TIMEOUT,
    source_address=None,
    *,
    all_errors: bool = False,
) -> socket.socket:
    if not _is_allowed(address):
        raise _blocked(address)
    return _ORIGINAL_CREATE_CONNECTION(address, timeout, source_address, all_errors=all_errors)


socket.socket.connect = _guarded_connect
socket.create_connection = _guarded_create_connection
