"""Shared DAST test configuration and fixtures."""

import os
import secrets

import pytest
import redis.asyncio as redis


def pytest_configure(config):
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
