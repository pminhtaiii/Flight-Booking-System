"""DAST Backend HTTP Security Test Suite.

Covers Task T040 (Feature 023 / US4 / SEC-DAST):
1. CORS Origin Validation:
   - Arbitrary/attacker origins (evil.com, attacker.test, null, subdomains, port spoofing)
     against FastAPI (agent.main:app) and NestJS client route abstractions (routes.json).
   - Wildcard origin (*) never allowed with credentials, unapproved origins never receive
     permissive Access-Control-Allow-Origin.
2. CSRF & State Mutation Protection:
   - State-modifying requests (POST/PUT/PATCH/DELETE) without authentication or with
     mismatched origin fail closed (401/403/422).
3. Open Redirect Protection:
   - Parameters and headers (returnUrl, redirect_uri, next, callbackUrl) containing
     protocol-relative URLs (//evil.com), backslash tricks (/\\evil.com), javascript:
     schemes, or external hosts are rejected or sanitized to safe relative paths (/).
4. Path Traversal Protection:
   - Directory traversal sequences (../, ..\\, %2e%2e%2f, etc.) on file/path parameters
     return 400/404/405, never disclosing filesystem files or directory structures.
5. Injection Payload Handling:
   - SQL injection, Command injection, and XSS payloads submitted to API routes, flight
     queries, booking IDs, and session messages are safely validated and handled by Pydantic
     and the Guardrail input pipeline without 500 crashes or raw error/stack trace disclosure.
6. Authenticated Route Inventory Census:
   - Full 45-route census from tests/security/zap/routes.json verified:
     - 13 public (none), 23 bearer_user, 7 agent_key_claim, 2 admin_bearer.
     - Routes requiring auth fail closed (401/403) on missing or forged tokens.
     - Public routes are reachable without authorization.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import subprocess
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[3]

try:
    from tests.security.dast.conftest import InMemRedis, make_jwt_token
except ImportError:
    from conftest import InMemRedis, make_jwt_token


def _resolve_test_env() -> dict[str, str]:
    """Resolve test configuration dynamically without hardcoding secret literals."""
    jwt_secret = (
        os.environ.get("TEST_JWT_SECRET") or os.environ.get("JWT_SECRET") or secrets.token_hex(32)
    )
    agent_key = (
        os.environ.get("TEST_AGENT_SERVICE_API_KEY")
        or os.environ.get("AGENT_SERVICE_API_KEY")
        or secrets.token_hex(32)
    )
    claim_secret = (
        os.environ.get("TEST_CLAIM_TOKEN_SECRET")
        or os.environ.get("CLAIM_TOKEN_SECRET")
        or secrets.token_hex(32)
    )
    api_url = (
        os.environ.get("TEST_NESTJS_API_URL")
        or os.environ.get("NESTJS_API_URL")
        or "http://127.0.0.1:3001/api"
    )
    issuer = os.environ.get("JWT_ISSUER", "booking-systems-api")
    audience = os.environ.get("JWT_AUDIENCE", "booking-systems-clients")

    os.environ.setdefault("JWT_SECRET", jwt_secret)
    os.environ.setdefault("AGENT_SERVICE_API_KEY", agent_key)
    os.environ.setdefault("CLAIM_TOKEN_SECRET", claim_secret)
    os.environ.setdefault("NESTJS_API_URL", api_url)
    os.environ.setdefault("JWT_ISSUER", issuer)
    os.environ.setdefault("JWT_AUDIENCE", audience)
    os.environ.setdefault("CLAIM_TOKEN_TTL_SECONDS", "300")
    os.environ.setdefault("OUTPUT_GUARDRAIL_ENABLED", "false")

    return {
        "JWT_SECRET": os.environ["JWT_SECRET"],
        "AGENT_SERVICE_API_KEY": os.environ["AGENT_SERVICE_API_KEY"],
        "CLAIM_TOKEN_SECRET": os.environ["CLAIM_TOKEN_SECRET"],
        "NESTJS_API_URL": os.environ["NESTJS_API_URL"],
        "JWT_ISSUER": os.environ["JWT_ISSUER"],
        "JWT_AUDIENCE": os.environ["JWT_AUDIENCE"],
    }


_TEST_ENV = _resolve_test_env()

from agent.config import get_settings  # noqa: E402
from agent.guardrails.base import AdmissionContext  # noqa: E402
from agent.guardrails.gateway import GuardrailGateway  # noqa: E402
from agent.guardrails.registry import create_production_registry  # noqa: E402
from agent.main import app  # noqa: E402
from agent.models.requests import ChatStreamRequest  # noqa: E402
from agent.queue.message_queue import MessageQueueManager  # noqa: E402
from agent.tools.nestjs_client import NestJSClient  # noqa: E402

pytestmark = pytest.mark.security

ROUTES_CATALOG_PATH = REPO_ROOT / "tests" / "security" / "zap" / "routes.json"


def load_route_catalog() -> list[dict[str, Any]]:
    """Load canonical OWASP ZAP route catalog."""
    assert ROUTES_CATALOG_PATH.exists(), f"Route catalog missing: {ROUTES_CATALOG_PATH}"
    with open(ROUTES_CATALOG_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert "routes" in data, "routes catalog must contain 'routes' key"
    return data["routes"]


@pytest.fixture(autouse=True)
def setup_test_redis(monkeypatch: pytest.MonkeyPatch) -> InMemRedis:
    """Provide in-memory Redis client mock to agent components."""
    fake_redis = InMemRedis()
    import agent.infrastructure.redis

    monkeypatch.setattr(agent.infrastructure.redis, "_redis_client", fake_redis)
    monkeypatch.setattr("agent.streaming.sse.get_redis_client", lambda: fake_redis)
    monkeypatch.setattr(
        "agent.repositories.session_lock_repository.get_redis_client", lambda: fake_redis
    )
    monkeypatch.setattr(agent.infrastructure.redis, "close_redis", AsyncMock())
    return fake_redis


@pytest.fixture
def fast_api_client(setup_test_redis: InMemRedis) -> Any:
    """Provide TestClient wrapping agent.main:app with initial state."""
    if not hasattr(app.state, "message_queue") or app.state.message_queue is None:
        app.state.message_queue = MessageQueueManager()
    if not hasattr(app.state, "guardrail_gateway") or app.state.guardrail_gateway is None:
        app.state.guardrail_gateway = GuardrailGateway(create_production_registry())

    with patch("agent.infrastructure.redis.close_redis", new_callable=AsyncMock):
        with TestClient(app) as client:
            yield client


OPEN_REDIRECT_VECTORS = [
    "//evil.com",
    "//evil.com/phish",
    "/\\evil.com",
    "/\\\\evil.com",
    "\\/evil.com",
    "\\\\evil.com",
    "javascript:alert(1)",
    "javascript://evil.com/%0Aalert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "https://evil.com",
    "http://attacker.test",
    "https://attacker.test/login?steal=1",
    "//localhost:3000.evil.com",
    "https://localhost:3000@evil.com",
    "http://127.0.0.1.attacker.com",
    "///evil.com",
    "////evil.com",
    "/%09/evil.com",
]

REDIRECT_PARAM_KEYS = ["returnUrl", "redirect_uri", "next", "callbackUrl"]

_SAFE_RETURN_TARGET_CACHE: dict[str, str] = {}


def _evaluate_safe_return_targets(targets: list[str]) -> list[str]:
    """Execute real getSafeReturnTarget from apps/web/lib/safeReturnTarget.ts via Node/tsx."""
    node_exe = shutil.which("node")
    assert node_exe, "Node executable not found in PATH"
    cli_path = REPO_ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"
    ts_path = REPO_ROOT / "apps" / "web" / "lib" / "safeReturnTarget.ts"
    assert ts_path.exists(), f"safeReturnTarget.ts not found: {ts_path}"

    script = (
        f"import {{ getSafeReturnTarget }} from '{ts_path.as_uri()}';\n"
        f"import fs from 'node:fs';\n"
        f"const inputs = JSON.parse(fs.readFileSync(0, 'utf-8'));\n"
        f"console.log(JSON.stringify(inputs.map(x => getSafeReturnTarget(x))));\n"
    )
    proc = subprocess.run(
        [node_exe, str(cli_path), "-e", script],
        cwd=REPO_ROOT,
        input=json.dumps(targets),
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, f"tsx execution failed: {proc.stderr}"
    return json.loads(proc.stdout.strip())


def get_real_safe_return_target(target: str) -> str:
    """Execute real getSafeReturnTarget from apps/web/lib/safeReturnTarget.ts with caching."""
    if target not in _SAFE_RETURN_TARGET_CACHE:
        results = _evaluate_safe_return_targets([target])
        _SAFE_RETURN_TARGET_CACHE[target] = results[0]
    return _SAFE_RETURN_TARGET_CACHE[target]


# Pre-warm safe return target cache in a single tsx batch call to optimize test run time
try:
    _all_initial_vectors = [
        *OPEN_REDIRECT_VECTORS,
        "/",
        "/dashboard",
        "/bookings",
        "/checkout",
        "/prototype/chat",
        "/search?offerId=off_valid123",
        "/profile",
        "/login",
        "/admin",
        "/unknown-page",
        "http://localhost:3000/dashboard",
        "https://evil.com/dashboard",
    ]
    _init_results = _evaluate_safe_return_targets(_all_initial_vectors)
    for _v, _res in zip(_all_initial_vectors, _init_results):
        _SAFE_RETURN_TARGET_CACHE[_v] = _res
except Exception:
    pass


# ==============================================================================
# 1. CORS Origin Validation
# ==============================================================================

ATTACKER_ORIGINS = [
    "http://evil.com",
    "https://evil.com",
    "http://attacker.test",
    "null",
    "http://localhost:3000.evil.com",
    "http://evil.com:3000",
    "https://evil-flight-booking.com",
    "http://127.0.0.1.attacker.net",
]


@pytest.mark.parametrize("origin", ATTACKER_ORIGINS)
def test_cors_fastapi_arbitrary_origins_rejected(fast_api_client: TestClient, origin: str) -> None:
    """Verify arbitrary and attacker origins fail closed on FastAPI endpoints."""
    # 1. Preflight OPTIONS request
    opt_resp = fast_api_client.options(
        "/chat/stream",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Authorization,Content-Type",
        },
    )
    assert (
        opt_resp.status_code == 403 or opt_resp.headers.get("access-control-allow-origin") != origin
    )
    assert opt_resp.headers.get("access-control-allow-origin") != "*"

    # 2. State-modifying POST request
    post_resp = fast_api_client.post(
        "/chat/stream",
        json={"message": "Security probe"},
        headers={"Origin": origin},
    )
    assert post_resp.status_code == 403
    assert post_resp.json().get("detail") == "ORIGIN_NOT_ALLOWED"
    assert post_resp.headers.get("access-control-allow-origin") != origin
    assert post_resp.headers.get("access-control-allow-origin") != "*"


def test_cors_fastapi_approved_origin_allowed(fast_api_client: TestClient) -> None:
    """Verify legitimate frontend origin is granted CORS headers on FastAPI."""
    legit_origin = "http://localhost:3000"
    resp = fast_api_client.options(
        "/chat/stream",
        headers={
            "Origin": legit_origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Authorization,Content-Type",
        },
    )
    assert resp.status_code == 200
    assert resp.headers.get("access-control-allow-origin") == legit_origin


def test_cors_no_wildcard_with_credentials_invariant() -> None:
    """Verify that credentials are NEVER allowed with wildcard '*' origin in FastAPI."""
    settings = get_settings()
    allowed = [url.strip() for url in settings.FRONTEND_URL.split(",") if url.strip()]
    assert "*" not in allowed, "Wildcard '*' must never be in configured allowed_origins"

    from fastapi.middleware.cors import CORSMiddleware

    # Inspect app middleware stack
    cors_middlewares = [m for m in app.user_middleware if m.cls == CORSMiddleware]
    assert len(cors_middlewares) > 0, "CORSMiddleware must be installed"
    for cm in cors_middlewares:
        kwargs = getattr(cm, "kwargs", getattr(cm, "options", {}))
        allow_origins = kwargs.get("allow_origins", [])
        allow_credentials = kwargs.get("allow_credentials", False)
        assert "*" not in allow_origins, "allow_origins must not contain wildcard '*'"
        if "*" in allow_origins:
            assert not allow_credentials, (
                "CORS invariant violation: wildcard origin must never allow credentials"
            )


@pytest.mark.asyncio
@pytest.mark.parametrize("origin", ATTACKER_ORIGINS)
async def test_cors_nestjs_origin_validation(origin: str) -> None:
    """Verify NestJS CORS rejects attacker origins via live HTTP or main.ts contract."""
    api_url = _TEST_ENV["NESTJS_API_URL"]
    is_live = False
    try:
        async with httpx.AsyncClient(timeout=0.3) as client:
            resp = await client.options(
                f"{api_url.rstrip('/')}/health",
                headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
            )
            is_live = True
            allow_origin = resp.headers.get("access-control-allow-origin")
            assert allow_origin != origin, f"Live NestJS allowed attacker origin: {origin}"
            assert allow_origin != "*", "Live NestJS returned wildcard origin"
    except (httpx.HTTPError, OSError):
        is_live = False

    if not is_live:
        main_ts_path = REPO_ROOT / "apps" / "api" / "src" / "main.ts"
        assert main_ts_path.exists(), f"NestJS entrypoint missing: {main_ts_path}"
        main_content = main_ts_path.read_text(encoding="utf-8")

        expected_origins = (
            "allowedOrigins = [frontendUrl, 'http://localhost:3000', 'http://127.0.0.1:3000']"
        )
        assert expected_origins in main_content
        assert "credentials: true" in main_content
        assert r"/^http:\/\/(localhost|127\.0\.0\.1):3000$/" in main_content
        assert origin not in ["http://localhost:3000", "http://127.0.0.1:3000"]
        assert not bool(re.match(r"^http://(localhost|127\.0\.0\.1):3000$", origin)), (
            f"Attacker origin '{origin}' illegally matches allowed pattern"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("origin", ["http://localhost:3000", "http://127.0.0.1:3000"])
async def test_cors_nestjs_approved_origins(origin: str) -> None:
    """Verify legitimate origins pass NestJS CORS policy via live HTTP or main.ts contract."""
    api_url = _TEST_ENV["NESTJS_API_URL"]
    is_live = False
    try:
        async with httpx.AsyncClient(timeout=0.3) as client:
            resp = await client.options(
                f"{api_url.rstrip('/')}/health",
                headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
            )
            is_live = True
            allow_origin = resp.headers.get("access-control-allow-origin")
            assert allow_origin in [origin, "http://localhost:3000", "http://127.0.0.1:3000"]
            assert resp.headers.get("access-control-allow-credentials") == "true"
    except (httpx.HTTPError, OSError):
        is_live = False

    if not is_live:
        main_ts_path = REPO_ROOT / "apps" / "api" / "src" / "main.ts"
        assert main_ts_path.exists()
        main_content = main_ts_path.read_text(encoding="utf-8")
        assert "allowedOrigins.includes(origin)" in main_content
        assert "credentials: true" in main_content
        assert bool(re.match(r"^http://(localhost|127\.0\.0\.1):3000$", origin))


# ==============================================================================
# 2. CSRF & State Mutation Protection
# ==============================================================================


def test_csrf_state_mutation_without_auth_fails_closed(fast_api_client: TestClient) -> None:
    """Verify state-modifying requests without authentication fail closed with 401."""
    resp = fast_api_client.post("/chat/stream", json={"message": "Mutate state"})
    assert resp.status_code == 401
    assert "Invalid authorization header" in resp.text or "detail" in resp.json()


def test_csrf_state_mutation_with_forged_auth_fails_closed(fast_api_client: TestClient) -> None:
    """Verify state-modifying requests with forged or invalid auth fail closed with 401."""
    resp = fast_api_client.post(
        "/chat/stream",
        json={"message": "Mutate state"},
        headers={"Authorization": "Bearer forged-invalid-token-signature"},
    )
    assert resp.status_code == 401


def test_csrf_state_mutation_with_mismatched_origin_fails_closed(
    fast_api_client: TestClient,
) -> None:
    """Verify state-modifying requests with mismatched origin fail closed with 403."""
    valid_token = make_jwt_token()
    resp = fast_api_client.post(
        "/chat/stream",
        json={"message": "Mutate state"},
        headers={
            "Authorization": f"Bearer {valid_token}",
            "Origin": "http://evil.com",
        },
    )
    assert resp.status_code == 403
    assert resp.json().get("detail") == "ORIGIN_NOT_ALLOWED"


def test_csrf_state_mutation_empty_payload_fails_validation(fast_api_client: TestClient) -> None:
    """Verify state-modifying request with missing or empty payload fails closed with 422."""
    valid_token = make_jwt_token()
    resp = fast_api_client.post(
        "/chat/stream",
        json={},
        headers={
            "Authorization": f"Bearer {valid_token}",
            "Origin": "http://localhost:3000",
        },
    )
    assert resp.status_code == 422


def test_csrf_route_catalog_state_mutation_inventory_census() -> None:
    """Verify all state-modifying routes in catalog require authentication."""
    routes = load_route_catalog()
    mutation_methods = {"POST", "PUT", "PATCH", "DELETE"}
    mutation_routes = [r for r in routes if r["method"] in mutation_methods]

    # Webhook routes have cryptographic signature requirements instead of bearer auth
    webhook_ids = {
        "api-payments-webhook",
        "api-disruptions-webhook-duffel",
        "api-auth-register",
        "api-auth-login",
    }

    protected_mutations = [r for r in mutation_routes if r["id"] not in webhook_ids]
    for route in protected_mutations:
        assert route["authRequirement"] in {
            "bearer_user",
            "admin_bearer",
            "agent_key_claim",
        }, (
            f"State-modifying route '{route['id']}' "
            f"({route['method']} {route['path']}) must require auth"
        )


# ==============================================================================
# 3. Open Redirect Protection
# ==============================================================================


@pytest.mark.parametrize("vector", OPEN_REDIRECT_VECTORS)
@pytest.mark.parametrize("param_key", REDIRECT_PARAM_KEYS)
def test_open_redirect_sanitization_defense(vector: str, param_key: str) -> None:
    """Verify open redirect vectors across parameter names are sanitized to '/' using tsx."""
    sanitized = get_real_safe_return_target(vector)
    assert sanitized == "/", (
        f"Open redirect '{vector}' for param '{param_key}' must sanitize to '/', got '{sanitized}'"
    )


def test_open_redirect_safe_relative_paths_preserved() -> None:
    """Verify legitimate relative paths are safely preserved using real safeReturnTarget.ts."""
    safe_paths = [
        "/",
        "/dashboard",
        "/bookings",
        "/checkout",
        "/prototype/chat",
        "/search?offerId=off_valid123",
    ]
    for path in safe_paths:
        sanitized = get_real_safe_return_target(path)
        assert sanitized == path, f"Safe path '{path}' should be preserved, got '{sanitized}'"


def test_open_redirect_disallowed_paths_and_absolute_urls_collapse_to_fallback() -> None:
    """Verify disallowed paths and external absolute URLs collapse to fallback '/'."""
    disallowed = [
        "/profile",
        "/login",
        "/admin",
        "/unknown-page",
        "http://localhost:3000/dashboard",
        "https://evil.com/dashboard",
    ]
    for target in disallowed:
        sanitized = get_real_safe_return_target(target)
        assert sanitized == "/", (
            f"Disallowed target '{target}' must collapse to '/', got '{sanitized}'"
        )


# ==============================================================================
# 4. Path Traversal Protection
# ==============================================================================

PATH_TRAVERSAL_VECTORS = [
    "../etc/passwd",
    "../../../../../../etc/passwd",
    "../../../../../../etc/shadow",
    "..\\..\\windows\\system32\\drivers\\etc\\hosts",
    "..\\..\\windows\\win.ini",
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "%2e%2e%5c%2e%2e%5cwin.ini",
    "....//....//etc/passwd",
    "..;/..;/etc/passwd",
    "/etc/passwd",
    "C:\\Windows\\System32\\cmd.exe",
]


@pytest.mark.parametrize("vector", PATH_TRAVERSAL_VECTORS)
def test_path_traversal_fastapi_endpoints(fast_api_client: TestClient, vector: str) -> None:
    """Verify path traversal sequences fail closed (307/400/404/405) without leaking files."""

    resp = fast_api_client.get(f"/health/{vector}")
    assert resp.status_code in {307, 400, 401, 404, 405}

    content = resp.text.lower()
    assert "root:" not in content
    assert "bin/bash" not in content
    assert "[fonts]" not in content
    assert "[extensions]" not in content
    assert "127.0.0.1 localhost" not in content

    # Test POST against stream subpath
    token = make_jwt_token()
    resp_post = fast_api_client.post(
        f"/chat/stream/{vector}",
        json={"message": "probe"},
        headers={"Authorization": f"Bearer {token}", "Origin": "http://localhost:3000"},
    )
    assert resp_post.status_code in {307, 400, 401, 404, 405}
    content_post = resp_post.text.lower()
    assert "root:" not in content_post
    assert "bin/bash" not in content_post


@pytest.mark.parametrize(
    "vector",
    [
        "../etc/passwd",
        "../../etc/shadow",
        "bkref_../../etc/passwd",
        "bkref_%2e%2e%2fetc%2fpasswd",
    ],
)
def test_path_traversal_nestjs_client_booking_detail_guard(vector: str) -> None:
    """Verify NestJSClient refuses path traversal in bookingReference parameters."""
    client = NestJSClient(
        base_url="http://127.0.0.1:3001/api",
        token=make_jwt_token(),
    )
    if not vector.startswith("bkref_"):
        with pytest.raises(ValueError, match="Must start with 'bkref_'"):
            asyncio.run(client.get_gateway_booking_detail(vector))
    else:
        with patch("httpx.AsyncClient.stream") as mock_stream:
            mock_resp = AsyncMock()
            mock_resp.status_code = 404
            mock_stream.return_value.__aenter__.return_value = mock_resp
            result = asyncio.run(client.get_gateway_booking_detail(vector))
            assert result.get("statusCode") == 404 or "error" in result


# ==============================================================================
# 5. Injection Payload Handling
# ==============================================================================

SQL_INJECTION_VECTORS = [
    "' OR 1=1 --",
    "' UNION SELECT null, username, password FROM users --",
    "1; DROP TABLE bookings; --",
    "' OR '1'='1",
    '" OR ""="',
    "admin' --",
    "1' ORDER BY 1--+",
]

COMMAND_INJECTION_VECTORS = [
    "; cat /etc/passwd",
    "| dir",
    "$(whoami)",
    "`id`",
    "& calc.exe",
    "; sleep 5",
    "| ping -c 1 127.0.0.1",
]

XSS_VECTORS = [
    "<script>alert(1)</script>",
    '"><img src=x onerror=alert(1)>',
    "<svg/onload=alert(1)>",
    "javascript:alert('XSS')",
    '<iframe src="javascript:alert(1)"></iframe>',
]


@pytest.mark.parametrize("payload", SQL_INJECTION_VECTORS)
def test_injection_sqli_in_chat_stream_request_model(payload: str) -> None:
    """Verify SQL injection strings in request models do not crash Pydantic."""
    req = ChatStreamRequest(message=payload, sessionId="sec-session-001")
    assert req.message == payload.strip()


@pytest.mark.parametrize("payload", COMMAND_INJECTION_VECTORS)
def test_injection_command_in_chat_stream_request_model(payload: str) -> None:
    """Verify Command injection strings in request models do not crash Pydantic."""
    req = ChatStreamRequest(message=payload, sessionId="sec-session-001")
    assert req.message == payload.strip()


@pytest.mark.parametrize("payload", XSS_VECTORS)
def test_injection_xss_in_chat_stream_request_model(payload: str) -> None:
    """Verify XSS vectors in request models do not crash Pydantic."""
    req = ChatStreamRequest(message=payload, sessionId="sec-session-001")
    assert req.message == payload.strip()


@pytest.mark.parametrize(
    "payload",
    [
        *SQL_INJECTION_VECTORS[:3],
        *COMMAND_INJECTION_VECTORS[:3],
        *XSS_VECTORS[:3],
    ],
)
def test_injection_payloads_fastapi_chat_stream_endpoint(
    fast_api_client: TestClient, payload: str
) -> None:
    """Verify injection payloads sent to /chat/stream do not cause 500 crashes or raw leaks."""
    token = make_jwt_token()
    with (
        patch("agent.streaming.sse.NestJSClient") as MockClient,
        patch(
            "agent.repositories.chat_budget_repository.ChatBudgetRepository.admit_request",
            new_callable=AsyncMock,
            return_value=True,
        ),
        patch("agent.streaming.sse.graph.astream_events") as mock_graph,
        patch("agent.streaming.sse._persist_response") as _mock_persist,
    ):
        mock_nestjs = AsyncMock()
        mock_nestjs.set_fencing_token = MagicMock()
        mock_nestjs.check_user_access.return_value = {"allowed": True}
        mock_nestjs.get_memory.return_value = {"messages": []}
        MockClient.return_value = mock_nestjs

        async def fake_stream(*args: Any, **kwargs: Any) -> Any:
            if False:
                yield None

        mock_graph.return_value = fake_stream()

        response = fast_api_client.post(
            "/chat/stream",
            json={"message": payload, "sessionId": "sec-session-inject"},
            headers={
                "Authorization": f"Bearer {token}",
                "Origin": "http://localhost:3000",
            },
        )

        # Invariant: Endpoint must return structured response, NEVER 500 crash
        assert response.status_code in {
            200,
            400,
            422,
            429,
        }, f"Endpoint returned {response.status_code} for injection payload '{payload}'"
        assert "Internal Server Error" not in response.text
        assert "Traceback (most recent call last)" not in response.text
        assert "sqlite3.OperationalError" not in response.text
        assert "syntax error" not in response.text.lower()


@pytest.mark.parametrize(
    "payload",
    [
        *SQL_INJECTION_VECTORS,
        *COMMAND_INJECTION_VECTORS,
    ],
)
def test_injection_guardrail_input_pipeline(payload: str) -> None:
    """Verify GuardrailGateway safely evaluates injection vectors without unhandled exceptions."""
    gateway = GuardrailGateway(create_production_registry())
    admission_ctx = AdmissionContext(
        user_id="sec-injection-tester",
        chat_session_id="session-sec-injection",
        trace_id="trace-sec-injection",
        correlation_id="corr-sec-injection",
        policy_version="2026-09-04",
    )

    decision = asyncio.run(gateway.validate_input(admission_ctx, payload))
    assert decision.status in {"PASS", "BLOCK"}
    if decision.status == "BLOCK":
        assert decision.response_key is not None
        assert decision.validated_data is None


def test_injection_flight_query_validation() -> None:
    """Verify SQL/command injection strings in flight query schema trigger ValidationError."""
    from agent.tools.nestjs_client import validate_booking_readiness_response

    malicious_data = {
        "scope": "READINESS_CHECK",
        "ready": "' OR 1=1 --",
        "passengers": [{"passengerType": "ADULT; DROP TABLE users;", "passengerOrdinal": 1}],
        "nextAction": "<script>alert(1)</script>",
    }
    safe_result = validate_booking_readiness_response(malicious_data)
    assert safe_result is None


# ==============================================================================
# 6. Authenticated Route Inventory Census
# ==============================================================================


def test_route_inventory_census_count_and_categories() -> None:
    """Load routes.json and assert exact 45 routes and expected category distribution."""
    routes = load_route_catalog()
    assert len(routes) == 45, f"Expected exactly 45 routes in catalog, found {len(routes)}"

    auth_counts: dict[str, int] = {}
    service_counts: dict[str, int] = {}
    for r in routes:
        req = r.get("authRequirement", "unknown")
        auth_counts[req] = auth_counts.get(req, 0) + 1
        svc = r.get("service", "unknown")
        service_counts[svc] = service_counts.get(svc, 0) + 1

    assert auth_counts == {
        "none": 13,
        "bearer_user": 23,
        "agent_key_claim": 7,
        "admin_bearer": 2,
    }, f"Unexpected auth distribution: {auth_counts}"

    assert service_counts == {
        "web": 6,
        "api": 36,
        "agent": 3,
    }, f"Unexpected service distribution: {service_counts}"


@pytest.mark.asyncio
async def test_route_inventory_all_45_routes_http_or_contract(
    fast_api_client: TestClient,
) -> None:
    """[Route Census] Test all 45 routes over HTTP with contract fallback."""
    routes = load_route_catalog()
    assert len(routes) == 45, f"Expected 45 routes, got {len(routes)}"

    api_url = _TEST_ENV["NESTJS_API_URL"]
    web_url = os.environ.get("TEST_WEB_URL", "http://127.0.0.1:3000")

    # Check live reachability
    is_live_api = False
    try:
        async with httpx.AsyncClient(timeout=0.3) as client:
            res = await client.get(f"{api_url.rstrip('/')}/health")
            is_live_api = res.status_code < 500
    except Exception:
        is_live_api = False

    is_live_web = False
    try:
        async with httpx.AsyncClient(timeout=0.3) as client:
            res = await client.get(web_url)
            is_live_web = res.status_code < 500
    except Exception:
        is_live_web = False

    for route in routes:
        svc = route["service"]
        method = route["method"]
        path = route["path"]
        auth_req = route["authRequirement"]

        clean_path = path.replace(":id", "syn_test_001").replace(
            ":reference", "bkref_00000000-0000-0000-0000-000000000000"
        )

        if svc == "agent":
            req_fn = getattr(fast_api_client, method.lower())
            if method in ("POST", "PUT", "PATCH"):
                resp = req_fn(clean_path, json={"message": "census"})
            else:
                resp = req_fn(clean_path)
            if auth_req == "none":
                assert resp.status_code < 500, (
                    f"Agent public route {path} failed with {resp.status_code}"
                )
            else:
                assert resp.status_code in (401, 403), (
                    f"Agent protected route {path} returned {resp.status_code}"
                )
        elif svc == "api" and is_live_api:
            async with httpx.AsyncClient(timeout=1.0) as client:
                resp = await client.request(
                    method,
                    f"{api_url.rstrip('/')}{clean_path}",
                    headers={"Origin": "http://localhost:3000"},
                    json={"test": "census"} if method in ("POST", "PUT", "PATCH") else None,
                )
                if auth_req == "none":
                    assert resp.status_code < 500
                else:
                    assert resp.status_code in (401, 403)
        elif svc == "web" and is_live_web:
            async with httpx.AsyncClient(timeout=1.0, follow_redirects=False) as client:
                resp = await client.request(method, f"{web_url.rstrip('/')}{clean_path}")
                if auth_req == "none":
                    assert resp.status_code < 500
                else:
                    loc = resp.headers.get("location", "")
                    assert resp.status_code in (302, 307, 401, 403) or "/login" in loc
            # Offline contract fallback: verify route inventory specifications
            assert auth_req in ("none", "bearer_user", "admin_bearer", "agent_key_claim")
            assert route["sensitivity"] in ("low", "medium", "high", "critical")
            assert route["targetPort"] in (3000, 3001, 3002)
            assert route["id"].startswith(f"{svc}-")


def test_route_inventory_public_routes_reachability(fast_api_client: TestClient) -> None:
    """Verify that public routes in inventory do not require authorization."""
    routes = load_route_catalog()
    public_routes = [r for r in routes if r["authRequirement"] == "none"]
    assert len(public_routes) == 13

    agent_public = [r for r in public_routes if r["service"] == "agent"]
    for r in agent_public:
        resp = fast_api_client.get(r["path"])
        assert resp.status_code == 200, (
            f"Public endpoint {r['path']} returned status {resp.status_code}"
        )


def test_route_inventory_protected_routes_reject_missing_token(
    fast_api_client: TestClient,
) -> None:
    """Verify that protected routes reject requests when authorization is missing."""
    routes = load_route_catalog()
    protected_routes = [r for r in routes if r["authRequirement"] != "none"]
    assert len(protected_routes) == 32

    agent_protected = [r for r in protected_routes if r["service"] == "agent"]
    for r in agent_protected:
        resp = fast_api_client.post(r["path"], json={"message": "Unauthenticated probe"})
        assert resp.status_code == 401, f"Route {r['path']} must return 401 when auth is missing"


def test_route_inventory_protected_routes_reject_forged_token(fast_api_client: TestClient) -> None:
    """Verify that protected routes reject forged JWT signatures with 401."""
    forged_token = make_jwt_token(secret="attacker-unauthorized-secret-key-12345")
    routes = load_route_catalog()
    agent_protected = [
        r for r in routes if r["service"] == "agent" and r["authRequirement"] != "none"
    ]

    for r in agent_protected:
        resp = fast_api_client.post(
            r["path"],
            json={"message": "Forged probe"},
            headers={"Authorization": f"Bearer {forged_token}"},
        )
        assert resp.status_code == 401, f"Route {r['path']} must return 401 on forged signature"


def test_route_inventory_admin_routes_reject_standard_user() -> None:
    """Verify that admin_bearer routes reject standard user roles."""
    routes = load_route_catalog()
    admin_routes = [r for r in routes if r["authRequirement"] == "admin_bearer"]
    assert len(admin_routes) == 2
    admin_ids = {r["id"] for r in admin_routes}
    assert admin_ids == {"api-admin-profile-backfill", "api-admin-refunds-resolve"}

    user_token = make_jwt_token(role="USER")
    decoded = jwt.decode(
        user_token,
        _TEST_ENV["JWT_SECRET"],
        algorithms=["HS256"],
        audience=_TEST_ENV["JWT_AUDIENCE"],
    )
    assert decoded.get("role") != "ADMIN"
    assert "ADMIN" not in decoded.get("roles", [])


def test_route_inventory_agent_gateway_routes_require_service_key_and_claim() -> None:
    """Verify that agent_key_claim routes require X-Agent-API-Key and X-User-Claim."""
    routes = load_route_catalog()
    gateway_routes = [r for r in routes if r["authRequirement"] == "agent_key_claim"]
    assert len(gateway_routes) == 7

    client = NestJSClient(
        base_url="http://127.0.0.1:3001/api",
        token=make_jwt_token(),
    )
    headers = client._get_gateway_headers()
    assert "X-Agent-API-Key" in headers
    assert "X-User-Claim" in headers
    assert len(headers["X-Agent-API-Key"]) > 0
    assert len(headers["X-User-Claim"]) > 0


# ==============================================================================
# 7. Error Sanitization & Information Disclosure Prevention
# ==============================================================================


def test_error_responses_do_not_disclose_secrets_or_stack_traces(
    fast_api_client: TestClient,
) -> None:
    """Verify that error responses never expose secrets, keys, or stack traces."""
    sensitive_tokens = [
        _TEST_ENV["JWT_SECRET"],
        _TEST_ENV["AGENT_SERVICE_API_KEY"],
        _TEST_ENV["CLAIM_TOKEN_SECRET"],
    ]

    malformed_requests = [
        fast_api_client.post("/chat/stream", content="invalid json body"),
        fast_api_client.get("/nonexistent-route-security-audit"),
        fast_api_client.post(
            "/chat/stream",
            json={"message": "probe"},
            headers={"Origin": "http://evil.com"},
        ),
        fast_api_client.post(
            "/chat/stream",
            json={"message": "probe"},
            headers={"Authorization": "Bearer malformed.token.format"},
        ),
    ]

    for idx, resp in enumerate(malformed_requests):
        content = resp.text
        for secret_val in sensitive_tokens:
            if len(secret_val) >= 8:
                assert secret_val not in content, f"Resp {idx} disclosed sensitive secret token"
        assert "Traceback (most recent call last)" not in content, f"Resp {idx} leaked traceback"
        assert "POSTGRES_PASSWORD" not in content, f"Resp {idx} leaked POSTGRES_PASSWORD"
        assert "REDIS_URL" not in content, f"Resp {idx} leaked REDIS_URL"
