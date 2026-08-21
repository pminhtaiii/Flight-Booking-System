import logging
from typing import Optional

from agent.infrastructure.redis import get_redis_client

logger = logging.getLogger(__name__)


class SessionLockRepository:
    """
    Provides monotonic fenced leases backed by Redis.
    A fencing token is returned on successful acquire, and must be provided
    for refresh, release, and validation.
    """

    def __init__(self, prefix: str = "chat:session-lock:"):
        self.prefix = prefix

    def _lock_key(self, user_id: str, session_id: str) -> str:
        return f"{self.prefix}{user_id}:{session_id}"

    def _fence_key(self, user_id: str, session_id: str) -> str:
        return f"{self.prefix}fence:{user_id}:{session_id}"

    async def acquire_lock(
        self, user_id: str, session_id: str, req_id: str, ttl_ms: int = 10000
    ) -> Optional[int]:
        try:
            redis = get_redis_client()
        except RuntimeError:
            logger.warning("Redis client is not initialized.")
            return None

        script = """
        local lock_key = KEYS[1]
        local fencing_key = KEYS[2]
        local req_id = ARGV[1]
        local ttl = tonumber(ARGV[2])

        local current_owner = redis.call('HGET', lock_key, 'req_id')
        if current_owner and current_owner ~= req_id then
            return nil
        end

        local fence = redis.call('INCR', fencing_key)
        redis.call('HSET', lock_key, 'req_id', req_id, 'fence', fence)
        redis.call('PEXPIRE', lock_key, ttl)
        return fence
        """
        fence = await redis.eval(
            script,
            2,
            self._lock_key(user_id, session_id),
            self._fence_key(user_id, session_id),
            req_id,
            ttl_ms,
        )
        return int(fence) if fence is not None else None

    async def refresh_lock(
        self, user_id: str, session_id: str, req_id: str, fence: int, ttl_ms: int = 10000
    ) -> bool:
        try:
            redis = get_redis_client()
        except RuntimeError:
            return False

        script = """
        local lock_key = KEYS[1]
        local req_id = ARGV[1]
        local fence = tonumber(ARGV[2])
        local ttl = tonumber(ARGV[3])

        local current_owner = redis.call('HGET', lock_key, 'req_id')
        local current_fence = tonumber(redis.call('HGET', lock_key, 'fence'))

        if current_owner == req_id and current_fence == fence then
            redis.call('PEXPIRE', lock_key, ttl)
            return 1
        end
        return 0
        """
        res = await redis.eval(
            script, 1, self._lock_key(user_id, session_id), req_id, fence, ttl_ms
        )
        return bool(res)

    async def release_lock(self, user_id: str, session_id: str, req_id: str, fence: int) -> bool:
        try:
            redis = get_redis_client()
        except RuntimeError:
            return False

        script = """
        local lock_key = KEYS[1]
        local req_id = ARGV[1]
        local fence = tonumber(ARGV[2])

        local current_owner = redis.call('HGET', lock_key, 'req_id')
        local current_fence = tonumber(redis.call('HGET', lock_key, 'fence'))

        if current_owner == req_id and current_fence == fence then
            redis.call('DEL', lock_key)
            return 1
        end
        return 0
        """
        res = await redis.eval(script, 1, self._lock_key(user_id, session_id), req_id, fence)
        return bool(res)

    async def validate_fence(self, user_id: str, session_id: str, req_id: str, fence: int) -> bool:
        try:
            redis = get_redis_client()
        except RuntimeError:
            return False

        current_owner = await redis.hget(self._lock_key(user_id, session_id), "req_id")
        current_fence = await redis.hget(self._lock_key(user_id, session_id), "fence")

        if current_owner is None or current_fence is None:
            return False

        return current_owner == req_id and int(current_fence) == fence
