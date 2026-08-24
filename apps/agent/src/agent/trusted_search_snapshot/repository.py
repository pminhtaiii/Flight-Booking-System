"""Atomic Redis persistence for owner-scoped trusted search snapshots."""

from datetime import datetime, timezone
from typing import Any

import redis.asyncio as redis
from pydantic import ValidationError

from agent.trusted_search_snapshot.models import SnapshotOwner, TrustedSearchSnapshot

_REPLACE_SNAPSHOT_LUA = """
local snapshot_key = KEYS[1]
local issued_key = KEYS[2]
local accepted_key = KEYS[3]
local incoming_json = ARGV[1]
local incoming_version = tonumber(ARGV[2])
local ttl_seconds = tonumber(ARGV[3])

if not incoming_version or incoming_version <= 0 or incoming_version ~= math.floor(incoming_version) then
  return 0
end

local existing_json = redis.call('GET', snapshot_key)
local existing_version = 0
if existing_json then
  local ok, existing = pcall(cjson.decode, existing_json)
  if not ok or type(existing) ~= 'table' or type(existing.snapshotVersion) ~= 'number'
    or existing.snapshotVersion <= 0 or existing.snapshotVersion ~= math.floor(existing.snapshotVersion) then
    return 0
  end
  existing_version = existing.snapshotVersion
end

local issued_raw = redis.call('GET', issued_key)
local issued_version = 0
if issued_raw then
  issued_version = tonumber(issued_raw)
  if not issued_version or issued_version <= 0 or issued_version ~= math.floor(issued_version) then
    return 0
  end
end

local accepted_raw = redis.call('GET', accepted_key)
local accepted_version = 0
if accepted_raw then
  accepted_version = tonumber(accepted_raw)
  if not accepted_version or accepted_version <= 0 or accepted_version ~= math.floor(accepted_version) then
    return 0
  end
end

local effective_accepted_version = math.max(existing_version, accepted_version)
if incoming_version <= effective_accepted_version then
  return 0
end
if issued_version > effective_accepted_version and incoming_version ~= issued_version then
  return 0
end

redis.call('SET', snapshot_key, incoming_json, 'EX', ttl_seconds)
redis.call('SET', issued_key, incoming_version, 'EX', ttl_seconds)
redis.call('SET', accepted_key, incoming_version, 'EX', ttl_seconds)
return 1
"""

_NEXT_VERSION_LUA = """
local snapshot_key = KEYS[1]
local issued_key = KEYS[2]
local accepted_key = KEYS[3]
local initial_ttl = tonumber(ARGV[1])

if not initial_ttl or initial_ttl <= 0 then
  return -4
end

local snapshot_version = 0
local snapshot_json = redis.call('GET', snapshot_key)
local counter_ttl = initial_ttl
if snapshot_json then
  local ok, snapshot = pcall(cjson.decode, snapshot_json)
  if not ok or type(snapshot) ~= 'table' or type(snapshot.snapshotVersion) ~= 'number'
    or snapshot.snapshotVersion <= 0 or snapshot.snapshotVersion ~= math.floor(snapshot.snapshotVersion) then
    return -2
  end
  snapshot_version = snapshot.snapshotVersion
  counter_ttl = redis.call('TTL', snapshot_key)
  if counter_ttl <= 0 then
    return -3
  end
end

local issued_raw = redis.call('GET', issued_key)
local issued_version = 0
if issued_raw then
  issued_version = tonumber(issued_raw)
  if not issued_version or issued_version <= 0 or issued_version ~= math.floor(issued_version) then
    return -1
  end
end

local accepted_raw = redis.call('GET', accepted_key)
local accepted_version = 0
if accepted_raw then
  accepted_version = tonumber(accepted_raw)
  if not accepted_version or accepted_version <= 0 or accepted_version ~= math.floor(accepted_version) then
    return -5
  end
end

if not snapshot_json then
  local issued_ttl = issued_raw and redis.call('TTL', issued_key) or 0
  local accepted_ttl = accepted_raw and redis.call('TTL', accepted_key) or 0
  if issued_raw and issued_ttl <= 0 then return -3 end
  if accepted_raw and accepted_ttl <= 0 then return -3 end
  if issued_ttl > 0 and accepted_ttl > 0 then
    counter_ttl = math.min(issued_ttl, accepted_ttl)
  elseif issued_ttl > 0 then
    counter_ttl = issued_ttl
  elseif accepted_ttl > 0 then
    counter_ttl = accepted_ttl
  end
end

local next_version = math.max(snapshot_version, issued_version, accepted_version) + 1
redis.call('SET', issued_key, next_version, 'EX', counter_ttl)
return next_version
"""

_DELETE_SNAPSHOT_LUA = """
local snapshot_key = KEYS[1]
local issued_key = KEYS[2]
local accepted_key = KEYS[3]

local snapshot_version = 0
local snapshot_json = redis.call('GET', snapshot_key)
local tombstone_ttl = 0
if snapshot_json then
  local ok, snapshot = pcall(cjson.decode, snapshot_json)
  if ok and type(snapshot) == 'table' and type(snapshot.snapshotVersion) == 'number'
    and snapshot.snapshotVersion > 0 and snapshot.snapshotVersion == math.floor(snapshot.snapshotVersion) then
    local snapshot_ttl = redis.call('TTL', snapshot_key)
    if snapshot_ttl > 0 then
      snapshot_version = snapshot.snapshotVersion
      tombstone_ttl = snapshot_ttl
    end
  end
end

local issued_raw = redis.call('GET', issued_key)
local issued_version = 0
local issued_ttl = 0
if issued_raw then
  issued_version = tonumber(issued_raw)
  issued_ttl = redis.call('TTL', issued_key)
  if not issued_version or issued_version <= 0 or issued_version ~= math.floor(issued_version) or issued_ttl <= 0 then
    redis.call('DEL', issued_key)
    issued_version = 0
    issued_ttl = 0
  end
end

local accepted_raw = redis.call('GET', accepted_key)
local accepted_version = 0
local accepted_ttl = 0
if accepted_raw then
  accepted_version = tonumber(accepted_raw)
  accepted_ttl = redis.call('TTL', accepted_key)
  if not accepted_version or accepted_version <= 0 or accepted_version ~= math.floor(accepted_version) or accepted_ttl <= 0 then
    redis.call('DEL', accepted_key)
    accepted_version = 0
    accepted_ttl = 0
  end
end

if tombstone_ttl <= 0 then
  if issued_ttl > 0 and accepted_ttl > 0 then
    tombstone_ttl = math.min(issued_ttl, accepted_ttl)
  elseif issued_ttl > 0 then
    tombstone_ttl = issued_ttl
  elseif accepted_ttl > 0 then
    tombstone_ttl = accepted_ttl
  end
end

local invalidated_version = math.max(snapshot_version, issued_version, accepted_version)
if invalidated_version > 0 and tombstone_ttl > 0 then
  redis.call('SET', accepted_key, invalidated_version, 'EX', tombstone_ttl)
end
redis.call('DEL', snapshot_key)
return 1
"""

_INITIAL_VERSION_TTL_SECONDS = 3600


class TrustedSnapshotRepository:
    """Persist snapshots with a Lua compare-and-set version boundary."""

    def __init__(self, redis_client: redis.Redis) -> None:
        self.redis = redis_client

    def _get_key(self, user_id: str, chat_session_id: str) -> str:
        return f"chat:snapshot:{user_id}:{chat_session_id}"

    def _version_key(self, user_id: str, chat_session_id: str) -> str:
        return f"{self._get_key(user_id, chat_session_id)}:version"

    def _accepted_key(self, user_id: str, chat_session_id: str) -> str:
        return f"{self._get_key(user_id, chat_session_id)}:accepted"

    async def next_version(self, owner: SnapshotOwner) -> int:
        """Atomically allocate a version above the counter and stored snapshot."""

        snapshot_key = self._get_key(owner.user_id, owner.chat_session_id)
        issued_key = self._version_key(owner.user_id, owner.chat_session_id)
        accepted_key = self._accepted_key(owner.user_id, owner.chat_session_id)

        eval_method = getattr(self.redis, "eval", None)
        if not callable(eval_method):
            raise ValueError("Trusted snapshot version allocation requires Redis Lua support")
        try:
            result = await eval_method(
                _NEXT_VERSION_LUA,
                3,
                snapshot_key,
                issued_key,
                accepted_key,
                _INITIAL_VERSION_TTL_SECONDS,
            )
        except NotImplementedError as error:
            raise ValueError(
                "Trusted snapshot version allocation requires Redis Lua support"
            ) from error
        if isinstance(result, (list, tuple)):
            result = result[0] if result else 0
        try:
            res_val = int(result)
        except (TypeError, ValueError):
            res_val = 0
        if res_val > 0:
            return res_val
        raise ValueError(self._next_version_error(res_val))

    async def save_snapshot(self, snapshot: TrustedSearchSnapshot, max_ttl: int = 3600) -> bool:
        """Atomically save a strictly newer unexpired snapshot, if any."""

        if isinstance(max_ttl, bool) or not isinstance(max_ttl, int) or max_ttl <= 0:
            return False

        remaining_seconds = int((snapshot.expiresAt - datetime.now(timezone.utc)).total_seconds())
        if remaining_seconds <= 0:
            return False

        ttl_seconds = min(remaining_seconds, max_ttl)
        snapshot_key = self._get_key(snapshot.userId, snapshot.sessionId)
        issued_key = self._version_key(snapshot.userId, snapshot.sessionId)
        accepted_key = self._accepted_key(snapshot.userId, snapshot.sessionId)
        payload = snapshot.model_dump_json()

        eval_method = getattr(self.redis, "eval", None)
        if not callable(eval_method):
            return False
        try:
            result = await eval_method(
                _REPLACE_SNAPSHOT_LUA,
                3,
                snapshot_key,
                issued_key,
                accepted_key,
                payload,
                snapshot.snapshotVersion,
                ttl_seconds,
            )
        except NotImplementedError:
            return False
        if isinstance(result, (list, tuple)):
            result = result[0] if result else 0
        try:
            return int(result) == 1
        except (TypeError, ValueError):
            return False

    async def get_snapshot(
        self, user_id: str, chat_session_id: str
    ) -> TrustedSearchSnapshot | None:
        """Load only valid, unexpired data bound to the requested owner scope."""

        data = await self.redis.get(self._get_key(user_id, chat_session_id))
        if not data:
            return None

        try:
            snapshot = TrustedSearchSnapshot.model_validate_json(self._decode_redis_value(data))
        except (TypeError, ValueError, ValidationError):
            return None

        if (
            snapshot.userId != user_id
            or snapshot.sessionId != chat_session_id
            or snapshot.expiresAt <= datetime.now(timezone.utc)
        ):
            return None
        return snapshot

    async def delete_snapshot(self, user_id: str, chat_session_id: str) -> None:
        """Atomically remove payload and invalidate every outstanding issuance."""

        snapshot_key = self._get_key(user_id, chat_session_id)
        issued_key = self._version_key(user_id, chat_session_id)
        accepted_key = self._accepted_key(user_id, chat_session_id)
        eval_method = getattr(self.redis, "eval", None)
        if not callable(eval_method):
            raise ValueError("Trusted snapshot deletion requires Redis Lua support")
        try:
            await eval_method(_DELETE_SNAPSHOT_LUA, 3, snapshot_key, issued_key, accepted_key)
        except NotImplementedError as error:
            raise ValueError("Trusted snapshot deletion requires Redis Lua support") from error

    @staticmethod
    def _decode_redis_value(value: str | bytes | Any) -> str:
        if isinstance(value, bytes):
            return value.decode("utf-8")
        if isinstance(value, str):
            return value
        raise TypeError("Redis snapshot payload must be text")

    @staticmethod
    def _next_version_error(result: int) -> str:
        errors = {
            -1: "Trusted snapshot version counter is malformed",
            -2: "Stored trusted snapshot is malformed",
            -3: "Stored trusted snapshot has no positive TTL",
            -4: "Trusted snapshot version TTL is invalid",
        }
        return errors.get(result, "Trusted snapshot version allocation failed")
