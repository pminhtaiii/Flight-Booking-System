import asyncio
import os
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest
import redis.asyncio as redis

from agent.repositories.chat_budget_repository import (
    BudgetExceededException,
    ChatBudgetRepository,
    RedisUnavailableException,
)


@pytest.fixture
async def redis_client():
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    client = redis.Redis.from_url(redis_url, decode_responses=True)
    try:
        await client.ping()
        yield client
    except (redis.ConnectionError, OSError):
        pytest.skip("Redis is not available")
    finally:
        await client.aclose()


@pytest.fixture
async def budget_repo(redis_client):
    return ChatBudgetRepository(redis_client)


@pytest.mark.asyncio
async def test_budget_admission(budget_repo, redis_client):
    user_id = "test_user_adm"
    window = "min_01"

    # Cleanup before test
    daily_key = f"chat:budget:{user_id}:{datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
    burst_key = f"chat:burst:{user_id}:{window}"
    await redis_client.delete(daily_key, burst_key)

    # Admit one request
    result = await budget_repo.admit_request(user_id, window, daily_limit=50, burst_limit=5)
    assert result is True

    # Check values
    daily = int(await redis_client.get(daily_key) or 0)
    burst = int(await redis_client.get(burst_key) or 0)
    assert daily == 1
    assert burst == 1


@pytest.mark.asyncio
async def test_burst_rejection(budget_repo, redis_client):
    user_id = "test_user_burst"
    window = "min_02"

    # Cleanup before test
    daily_key = f"chat:budget:{user_id}:{datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
    burst_key = f"chat:burst:{user_id}:{window}"
    await redis_client.delete(daily_key, burst_key)

    # Admit up to burst limit
    for _ in range(5):
        await budget_repo.admit_request(user_id, window, daily_limit=50, burst_limit=5)

    # The 6th request should be rejected
    with pytest.raises(BudgetExceededException) as exc:
        await budget_repo.admit_request(user_id, window, daily_limit=50, burst_limit=5)
    assert exc.value.reason == "burst_quota_exceeded"

    # Check values (should not be charged for rejected attempt)
    daily = int(await redis_client.get(daily_key) or 0)
    burst = int(await redis_client.get(burst_key) or 0)
    assert daily == 5
    assert burst == 5


@pytest.mark.asyncio
async def test_daily_rejection(budget_repo, redis_client):
    user_id = "test_user_daily"
    window = "min_03"

    daily_key = f"chat:budget:{user_id}:{datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
    burst_key = f"chat:burst:{user_id}:{window}"
    await redis_client.delete(daily_key, burst_key)

    # Admit up to daily limit (burst limit is higher for this test)
    for _ in range(5):
        await budget_repo.admit_request(user_id, window, daily_limit=5, burst_limit=10)

    # The 6th request should be rejected
    with pytest.raises(BudgetExceededException) as exc:
        await budget_repo.admit_request(user_id, window, daily_limit=5, burst_limit=10)
    assert exc.value.reason == "daily_quota_exceeded"

    daily = int(await redis_client.get(daily_key) or 0)
    burst = int(await redis_client.get(burst_key) or 0)
    assert daily == 5
    assert burst == 5


@pytest.mark.asyncio
async def test_concurrency(budget_repo, redis_client):
    user_id = "test_user_conc"
    window = "min_04"

    daily_key = f"chat:budget:{user_id}:{datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
    burst_key = f"chat:burst:{user_id}:{window}"
    await redis_client.delete(daily_key, burst_key)

    # 10 concurrent requests, but burst limit is 5
    async def make_request():
        try:
            return await budget_repo.admit_request(user_id, window, daily_limit=50, burst_limit=5)
        except BudgetExceededException:
            return False

    results = await asyncio.gather(*(make_request() for _ in range(10)))

    # Exactly 5 should succeed, 5 should fail
    successes = sum(1 for r in results if r is True)
    assert successes == 5

    daily = int(await redis_client.get(daily_key) or 0)
    burst = int(await redis_client.get(burst_key) or 0)
    assert daily == 5
    assert burst == 5


@pytest.mark.asyncio
async def test_redis_fail_closed():
    mock_redis = AsyncMock()
    mock_redis.eval.side_effect = redis.RedisError("Connection lost")
    repo = ChatBudgetRepository(mock_redis)

    with pytest.raises(RedisUnavailableException):
        await repo.admit_request("test_user_fail", "min_05", 50, 5)


@pytest.mark.asyncio
async def test_ttl_set(budget_repo, redis_client):
    user_id = "test_user_ttl"
    window = "min_06"

    daily_key = f"chat:budget:{user_id}:{datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
    burst_key = f"chat:burst:{user_id}:{window}"
    await redis_client.delete(daily_key, burst_key)

    await budget_repo.admit_request(user_id, window, daily_limit=50, burst_limit=5, burst_ttl=60)

    daily_ttl = await redis_client.ttl(daily_key)
    burst_ttl = await redis_client.ttl(burst_key)

    assert daily_ttl > 0
    assert burst_ttl > 0
    assert burst_ttl <= 60
