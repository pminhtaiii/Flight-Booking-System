import os
import pytest

# Set environment variables before importing any application code
os.environ["JWT_SECRET"] = "testsecret_must_be_at_least_32_bytes_long_for_security_reasons"
os.environ["NESTJS_API_URL"] = "http://localhost:3001/api"
os.environ["AGENT_SERVICE_API_KEY"] = "mock_agent_key"
os.environ["CLAIM_TOKEN_SECRET"] = "mock_claim_secret_must_be_long_enough_for_security"


@pytest.fixture(autouse=True)
def setup_env():
    # Keep variables set, but yield for test duration
    yield
