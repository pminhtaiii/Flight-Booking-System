"""Shared DAST test configuration, fixtures, and in-memory test mocks."""

from __future__ import annotations

import json
import os
import secrets
import sys
import time
from pathlib import Path
from typing import Any

import jwt
import pytest
import redis.asyncio as redis

# Ensure repo root and apps/agent/src are in sys.path for test discovery and imports
_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

_AGENT_SRC = str(_REPO_ROOT / "apps" / "agent" / "src")
if _AGENT_SRC not in sys.path:
    sys.path.insert(0, _AGENT_SRC)


def pytest_configure(config: pytest.Config) -> None:
    """Ensure DAST environment variables are populated dynamically if not set."""
    os.environ.setdefault(
        "JWT_SECRET",
        os.environ.get("TEST_JWT_SECRET") or secrets.token_hex(32),
    )
    os.environ.setdefault(
        "AGENT_SERVICE_API_KEY",
        os.environ.get("TEST_AGENT_SERVICE_API_KEY") or secrets.token_hex(32),
    )
    os.environ.setdefault(
        "CLAIM_TOKEN_SECRET",
        os.environ.get("TEST_CLAIM_TOKEN_SECRET") or secrets.token_hex(32),
    )
    os.environ.setdefault(
        "NESTJS_API_URL",
        os.environ.get("TEST_NESTJS_API_URL") or "http://127.0.0.1:3001/api",
    )
    os.environ.setdefault("JWT_ISSUER", "booking-systems-api")
    os.environ.setdefault("JWT_AUDIENCE", "booking-systems-clients")
    os.environ.setdefault("CLAIM_TOKEN_TTL_SECONDS", "300")
    os.environ.setdefault("OUTPUT_GUARDRAIL_ENABLED", "false")


def make_jwt_token(
    user: dict[str, Any] | str | None = None,
    user_id: str | None = None,
    role: str = "USER",
    exp_offset: int = 3600,
    jti: str = "jti-synt-1",
    secret: str | None = None,
    issuer: str | None = None,
    audience: str | None = None,
) -> str:
    """Generate dynamic synthetic JWT for testing without static fixtures."""
    if isinstance(user, dict):
        uid = str(user.get("id") or user.get("sub") or "usr_synthetic_sec_001")
        sub = str(user.get("sub") or uid)
        email = user.get("email", f"{uid}@synthetic.test")
        name = user.get("name", "Synthetic User")
        role = user.get("role", role)
    elif isinstance(user, str):
        uid = user
        sub = user
        email = f"{uid}@security.test"
        name = "Security Test User"
    elif user_id:
        uid = user_id
        sub = user_id
        email = f"{uid}@security.test"
        name = "Security Test User"
    else:
        uid = "usr_synthetic_sec_001"
        sub = uid
        email = f"{uid}@security.test"
        name = "Security Test User"

    iss = issuer or os.environ.get("JWT_ISSUER", "booking-systems-api")
    aud = audience or os.environ.get("JWT_AUDIENCE", "booking-systems-clients")
    signing_secret = secret or os.environ.get("JWT_SECRET") or secrets.token_hex(32)

    payload = {
        "id": uid,
        "sub": sub,
        "email": email,
        "name": name,
        "role": role,
        "roles": [role],
        "jti": jti,
        "iss": iss,
        "aud": aud,
        "exp": int(time.time()) + exp_offset,
    }
    return jwt.encode(payload, signing_secret, algorithm="HS256")


class InMemRedis:
    """In-memory Async Redis mock simulating hashes, keys, ttls, and eval scripts."""

    def __init__(self) -> None:
        self.hashes: dict[str, dict[str, str]] = {}
        self.strings: dict[str, str] = {}
        self.ttls: dict[str, int] = {}
        self._clock: int = 0

    async def hget(self, name: str, key: str) -> str | None:
        return self.hashes.get(name, {}).get(key)

    async def hset(self, name: str, *args: Any, **kwargs: Any) -> int:
        if name not in self.hashes:
            self.hashes[name] = {}
        mapping: dict[str, Any] = {}
        if len(args) == 1 and isinstance(args[0], dict):
            mapping = args[0]
        elif len(args) % 2 == 0:
            for i in range(0, len(args), 2):
                mapping[args[i]] = args[i + 1]
        mapping.update(kwargs)
        for k, v in mapping.items():
            self.hashes[name][str(k)] = str(v)
        return len(mapping)

    async def get(self, key: str) -> str | None:
        return self.strings.get(key)

    async def set(self, key: str, value: str | int, ex: int | None = None) -> bool:
        self.strings[key] = str(value)
        if ex is not None:
            self.ttls[key] = int(ex)
        return True

    async def delete(self, *keys: str) -> int:
        count = 0
        for k in keys:
            if k in self.strings:
                del self.strings[k]
                count += 1
            if k in self.hashes:
                del self.hashes[k]
                count += 1
        return count

    async def ttl(self, key: str) -> int:
        return self.ttls.get(key, -1)

    async def ping(self) -> bool:
        return True

    async def aclose(self) -> None:
        pass

    async def close(self) -> None:
        pass

    async def eval(self, script: str, num_keys: int, *args: Any) -> Any:
        # Fencing and locks
        if "fencing_key" in script and "PEXPIRE" in script:
            lock_key, fence_key = args[0], args[1]
            req_id = str(args[2])
            ttl = int(args[3])

            current = self.hashes.get(lock_key, {})
            current_owner = current.get("req_id")
            if current_owner and current_owner != req_id:
                return None

            current_fence = int(self.strings.get(fence_key, 0)) + 1
            self.strings[fence_key] = str(current_fence)

            if lock_key not in self.hashes:
                self.hashes[lock_key] = {}
            self.hashes[lock_key]["req_id"] = req_id
            self.hashes[lock_key]["fence"] = str(current_fence)
            self.ttls[lock_key] = ttl // 1000
            return current_fence

        if "refresh_lock" in script or ("current_fence == fence" in script and "DEL" not in script):
            lock_key = args[0]
            req_id = str(args[1])
            fence = str(args[2])
            current = self.hashes.get(lock_key, {})
            if current.get("req_id") == req_id and str(current.get("fence")) == fence:
                return 1
            return 0

        if "DEL" in script and "lock_key" in script:
            lock_key = args[0]
            req_id = str(args[1])
            fence = str(args[2])
            current = self.hashes.get(lock_key, {})
            if current.get("req_id") == req_id and str(current.get("fence")) == fence:
                self.hashes.pop(lock_key, None)
                return 1
            return 0

        if "initial_ttl" in script or "snapshot_key" in script:
            snapshot_key, issued_key, accepted_key = args[0], args[1], args[2]
            op_args = args[3:]
            if len(op_args) == 1:
                snap_val = self.strings.get(snapshot_key)
                s_ver = 0
                if snap_val:
                    s_ver = json.loads(snap_val).get("snapshotVersion", 0)
                i_ver = int(self.strings.get(issued_key, 0))
                a_ver = int(self.strings.get(accepted_key, 0))
                nxt = max(s_ver, i_ver, a_ver) + 1
                self.strings[issued_key] = str(nxt)
                return nxt

            if len(op_args) == 3:
                incoming_json, incoming_version, _ttl_sec = op_args
                inc_v = int(incoming_version)
                snap_val = self.strings.get(snapshot_key)
                s_ver = 0
                if snap_val:
                    s_ver = json.loads(snap_val).get("snapshotVersion", 0)
                a_ver = int(self.strings.get(accepted_key, 0))
                eff = max(s_ver, a_ver)
                if inc_v <= eff:
                    return 0
                self.strings[snapshot_key] = incoming_json
                self.strings[issued_key] = str(inc_v)
                self.strings[accepted_key] = str(inc_v)
                return 1

            if len(op_args) == 0:
                self.strings.pop(snapshot_key, None)
                return 1

        if "fencing_key" in script:
            return 1

        return 1


@pytest.fixture
async def redis_client():
    """Provide real connected Redis client or skip test if unavailable."""
    redis_url = os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0")
    client = redis.Redis.from_url(redis_url, decode_responses=True)
    try:
        await client.ping()
        yield client
    except (redis.ConnectionError, OSError):
        pytest.skip("Redis is not available")
    finally:
        await client.aclose()
