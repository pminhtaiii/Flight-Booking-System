import os
import pytest

# Set environment variables before importing any application code
os.environ["JWT_SECRET"] = "testsecret_must_be_at_least_32_bytes_long_for_security_reasons"
os.environ["NESTJS_API_URL"] = "http://localhost:3001/api"

@pytest.fixture(autouse=True)
def setup_env():
    # Keep variables set, but yield for test duration
    yield
