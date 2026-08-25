from typing import Optional

import redis.asyncio as redis

_redis_client: Optional[redis.Redis] = None


async def init_redis(redis_url: str) -> None:
    global _redis_client
    if _redis_client is None:
        _redis_client = redis.from_url(redis_url, decode_responses=True)


async def close_redis() -> None:
    global _redis_client
    if _redis_client is not None:
        await _redis_client.aclose()
        _redis_client = None


def get_redis_client() -> redis.Redis:
    if _redis_client is None:
        raise RuntimeError("Redis client is not initialized. Call init_redis first.")
    return _redis_client
