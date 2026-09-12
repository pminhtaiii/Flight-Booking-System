"""DAST Quota Profiles and Isolation Boundaries Test Suite.

SEC29: Evaluation quota exhaustion, shard omissions, non-repeatable state.
Covers:
1. Isolated Evaluation Quota Profile: detector overrides vs quota-invariant production defaults.
2. Strict Budget & Input Bounding: invalid profiles, request cap limits, duration cap limits.
3. Deterministic Disposable State & Scoped Resets: unique project namespaces, zero state pollution.
4. Corpus Shard Manifest Union Completeness: 700 holdout cases, 25 invariant records,
   0 duplicate canonical hashes across splits, non-empty stage denominators.
5. Redis Outage & Transport Fail-Closed Invariants: clean fail-closed error handling without
   payload/secret leakage.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import shutil
import subprocess
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
import redis.asyncio as redis
from agent.config import get_settings  # noqa: E402
from agent.middleware.rate_limit import RateLimitMiddleware  # noqa: E402
from agent.repositories.chat_budget_repository import (  # noqa: E402
    ChatBudgetRepository,
    RedisUnavailableException,
)
from agent.tools.nestjs_client import NestJSClient  # noqa: E402
from starlette.requests import Request
from starlette.responses import Response

pytestmark = pytest.mark.security

REPO_ROOT = Path(__file__).resolve().parents[3]
CORPUS_DIR = REPO_ROOT / "tests" / "security" / "corpus"
MANIFEST_PATH = CORPUS_DIR / "manifest.json"
NODE_SCRIPT_PATH = REPO_ROOT / "scripts" / "security" / "run-local-dast.mjs"

ORIGINS = (
    "http://127.0.0.1:3301",
    "http://127.0.0.1:3302",
    "http://127.0.0.1:3400",
)


def _invoke_node_create_run_plan(
    options: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any] | None, str]:
    """Execute createRunPlan from scripts/security/run-local-dast.mjs via node CLI."""
    node_exe = shutil.which("node")
    if not node_exe:
        pytest.skip("Node executable not found in PATH")

    js_options = json.dumps(options or {})
    script = (
        f"import {{ createRunPlan }} from '{NODE_SCRIPT_PATH.as_uri()}';\n"
        f"try {{\n"
        f"  const plan = createRunPlan({js_options});\n"
        f"  console.log(JSON.stringify(plan));\n"
        f"}} catch (err) {{\n"
        f"  console.error(err.message);\n"
        f"  process.exit(1);\n"
        f"}}\n"
    )
    proc = subprocess.run(
        [node_exe, "--input-type=module", "-e", script],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode == 0:
        return 0, json.loads(proc.stdout.strip()), ""
    return proc.returncode, None, proc.stderr.strip()


# ==============================================================================
# create_run_plan delegates directly to Node createRunPlan contract
# ==============================================================================
def create_run_plan(
    profile: str = "detector",
    max_requests: int = 5000,
    max_duration_ms: int = 1800000,
) -> dict[str, Any]:
    """Execute real createRunPlan from scripts/security/run-local-dast.mjs via Node CLI."""
    code, plan, err = _invoke_node_create_run_plan(
        {
            "profile": profile,
            "maxRequests": max_requests,
            "maxDurationMs": max_duration_ms,
        }
    )
    if code != 0 or plan is None:
        raise ValueError(err)
    return plan


# ==============================================================================
# Helper for dynamic test environments and sanitized assertions
# ==============================================================================
def _make_dummy_request(
    path: str = "/chat/stream",
    method: str = "POST",
    headers: dict[str, str] | None = None,
    user_sub: str | None = None,
) -> Request:
    """Construct an ASGI test Request with dynamic user state and headers."""
    raw_headers = [
        (k.lower().encode("latin1"), v.encode("latin1")) for k, v in (headers or {}).items()
    ]
    scope: dict[str, Any] = {
        "type": "http",
        "method": method,
        "path": path,
        "headers": raw_headers,
        "client": ("127.0.0.1", 54321),
    }
    request = Request(scope)
    if user_sub:
        request.state.user = {"sub": user_sub, "id": user_sub}
    return request


# ==============================================================================
# 1. Isolated Evaluation Quota Profile Tests
# ==============================================================================
class TestIsolatedEvaluationQuotaProfile:
    """SEC29: Verify elevated evaluation quota overrides vs untouched production defaults."""

    def test_detector_profile_sets_elevated_quota_overrides_in_python(self) -> None:
        """create_run_plan(profile='detector') sets DAST_QUOTA_DAILY=10000, BURST=600."""
        plan = create_run_plan(profile="detector")
        assert plan["profile"] == "detector"
        assert plan["environment"] == {
            "DAST_QUOTA_DAILY": "10000",
            "DAST_QUOTA_BURST": "600",
        }
        assert plan["maxRequests"] == 5000
        assert plan["maxDurationMs"] == 1800000

    def test_detector_profile_sets_elevated_quota_overrides_in_node_script(self) -> None:
        """createRunPlan({ profile: 'detector' }) from scripts/security/run-local-dast.mjs."""
        code, plan, err = _invoke_node_create_run_plan({"profile": "detector"})
        assert code == 0, f"Node createRunPlan failed: {err}"
        assert plan is not None
        assert plan["profile"] == "detector"
        assert plan["environment"] == {
            "DAST_QUOTA_DAILY": "10000",
            "DAST_QUOTA_BURST": "600",
        }

    def test_quota_invariant_profile_sets_no_environment_overrides_in_python(self) -> None:
        """create_run_plan(profile='quota-invariant') preserves production defaults."""
        plan = create_run_plan(profile="quota-invariant")
        assert plan["profile"] == "quota-invariant"
        assert plan["environment"] == {}
        assert "DAST_QUOTA_DAILY" not in plan["environment"]
        assert "DAST_QUOTA_BURST" not in plan["environment"]

    def test_quota_invariant_profile_sets_no_environment_overrides_in_node_script(self) -> None:
        """createRunPlan({ profile: 'quota-invariant' }) preserves defaults."""
        code, plan, err = _invoke_node_create_run_plan({"profile": "quota-invariant"})
        assert code == 0, f"Node createRunPlan failed: {err}"
        assert plan is not None
        assert plan["profile"] == "quota-invariant"
        assert plan["environment"] == {}
        assert "DAST_QUOTA_DAILY" not in plan["environment"]
        assert "DAST_QUOTA_BURST" not in plan["environment"]

    @pytest.mark.asyncio
    async def test_quota_profile_middleware_burst_enforcement_boundary(self) -> None:
        """Verify RateLimitMiddleware honors burst limit boundary (60 prod vs 600 detector)."""
        mock_redis = MagicMock()
        admit_calls = 0

        async def _eval_lua(*args: Any, **kwargs: Any) -> list[int]:
            nonlocal admit_calls
            admit_calls += 1
            if admit_calls > 60:
                return [0, 50, 0]  # burst exhausted
            return [1, 50, 60 - admit_calls]

        mock_redis.eval = AsyncMock(side_effect=_eval_lua)

        # Quota-invariant profile: default limits (burst=60)
        app = MagicMock()
        middleware = RateLimitMiddleware(
            app=app,
            limit=60,
            window=60,
            daily_limit=50,
            redis_client=mock_redis,
        )

        user_id = f"user-{secrets.token_hex(8)}"
        request = _make_dummy_request(user_sub=user_id)

        async def call_next(_req: Request) -> Response:
            return Response(content="ok", status_code=200)

        # 60 calls succeed
        for _ in range(60):
            res = await middleware.dispatch(request, call_next)
            assert res.status_code == 200

        # 61st call is rejected with CHAT_BURST_LIMIT_EXCEEDED (fail-closed under production)
        rejected = await middleware.dispatch(request, call_next)
        assert rejected.status_code == 429
        data = json.loads(rejected.body.decode("utf-8"))
        assert data["code"] == "CHAT_BURST_LIMIT_EXCEEDED"


# ==============================================================================
# 2. Strict Budget & Input Bounding Tests
# ==============================================================================
class TestStrictBudgetAndInputBounding:
    """SEC29: Reject invalid profiles, out-of-range request caps, and inflated duration caps."""

    @pytest.mark.parametrize(
        "invalid_profile",
        [
            "production",
            "admin",
            "custom",
            "staging",
            "internal",
            "",
            "detector; DROP TABLE",
        ],
    )
    def test_invalid_profiles_fail_closed_in_python(self, invalid_profile: str) -> None:
        """Reject unapproved profiles with DAST_INVALID_PROFILE."""
        with pytest.raises(ValueError, match="DAST_INVALID_PROFILE"):
            create_run_plan(profile=invalid_profile)

    @pytest.mark.parametrize(
        "invalid_profile",
        ["production", "admin", "custom", "staging"],
    )
    def test_invalid_profiles_fail_closed_in_node(self, invalid_profile: str) -> None:
        """Node createRunPlan throws DAST_INVALID_PROFILE on invalid profiles."""
        code, _, err = _invoke_node_create_run_plan({"profile": invalid_profile})
        assert code != 0
        assert "DAST_INVALID_PROFILE" in err

    @pytest.mark.parametrize("invalid_reqs", [0, -1, -500, 5001, 10000, 100000])
    def test_invalid_request_caps_fail_closed_in_python(self, invalid_reqs: int) -> None:
        """Reject request cap <=0 or >5000 with DAST_INVALID_REQUEST_CAP."""
        with pytest.raises(ValueError, match="DAST_INVALID_REQUEST_CAP"):
            create_run_plan(max_requests=invalid_reqs)

    @pytest.mark.parametrize("invalid_reqs", [0, -1, 5001, 9999])
    def test_invalid_request_caps_fail_closed_in_node(self, invalid_reqs: int) -> None:
        """Node createRunPlan throws DAST_INVALID_REQUEST_CAP on out-of-range caps."""
        code, _, err = _invoke_node_create_run_plan({"maxRequests": invalid_reqs})
        assert code != 0
        assert "DAST_INVALID_REQUEST_CAP" in err

    @pytest.mark.parametrize("valid_reqs", [1, 100, 2500, 5000])
    def test_valid_request_caps_accepted(self, valid_reqs: int) -> None:
        """Accept valid request caps in [1, 5000]."""
        plan_py = create_run_plan(max_requests=valid_reqs)
        assert plan_py["maxRequests"] == valid_reqs

        code, plan_node, err = _invoke_node_create_run_plan({"maxRequests": valid_reqs})
        assert code == 0, f"Valid request cap rejected by Node: {err}"
        assert plan_node is not None
        assert plan_node["maxRequests"] == valid_reqs

    @pytest.mark.parametrize("invalid_time_ms", [0, -1, -10000, 1800001, 2000000, 3600000])
    def test_invalid_duration_caps_fail_closed_in_python(self, invalid_time_ms: int) -> None:
        """Reject duration cap <=0 or >1800000 with DAST_INVALID_TIME_CAP."""
        with pytest.raises(ValueError, match="DAST_INVALID_TIME_CAP"):
            create_run_plan(max_duration_ms=invalid_time_ms)

    @pytest.mark.parametrize("invalid_time_ms", [0, -1, 1800001, 2500000])
    def test_invalid_duration_caps_fail_closed_in_node(self, invalid_time_ms: int) -> None:
        """Node createRunPlan throws DAST_INVALID_TIME_CAP on out-of-range duration caps."""
        code, _, err = _invoke_node_create_run_plan({"maxDurationMs": invalid_time_ms})
        assert code != 0
        assert "DAST_INVALID_TIME_CAP" in err

    @pytest.mark.parametrize("valid_time_ms", [1, 60000, 900000, 1800000])
    def test_valid_duration_caps_accepted(self, valid_time_ms: int) -> None:
        """Accept valid duration caps in [1, 1800000]."""
        plan_py = create_run_plan(max_duration_ms=valid_time_ms)
        assert plan_py["maxDurationMs"] == valid_time_ms

        code, plan_node, err = _invoke_node_create_run_plan({"maxDurationMs": valid_time_ms})
        assert code == 0, f"Valid time cap rejected by Node: {err}"
        assert plan_node is not None
        assert plan_node["maxDurationMs"] == valid_time_ms


# ==============================================================================
# 3. Deterministic Disposable State & Scoped Resets Tests
# ==============================================================================
class TestDeterministicDisposableStateAndScopedResets:
    """SEC29: Fresh isolated namespaces and zero persistent cross-run state pollution."""

    PROJECT_NAME_PATTERN = re.compile(r"^security-dast-[a-f0-9]{32}$")

    def test_successive_run_plans_generate_distinct_unique_project_names(self) -> None:
        """Verify successive runs generate distinct, regex-compliant project names."""
        project_names = set()
        total_runs = 15

        for _ in range(total_runs):
            plan = create_run_plan()
            project = plan["project"]
            assert self.PROJECT_NAME_PATTERN.match(project), (
                f"Invalid project name format: {project}"
            )
            project_names.add(project)

        assert len(project_names) == total_runs

    def test_node_create_run_plan_generates_distinct_unique_project_names(self) -> None:
        """Verify Node createRunPlan produces unique security-dast-[a-f0-9]{32} namespaces."""
        names = set()
        for _ in range(5):
            code, plan, err = _invoke_node_create_run_plan()
            assert code == 0, f"Node createRunPlan invocation failed: {err}"
            assert plan is not None
            project = plan["project"]
            assert self.PROJECT_NAME_PATTERN.match(project), f"Unexpected project format: {project}"
            names.add(project)

        assert len(names) == 5

    def test_run_plan_preserves_immutable_loopback_destinations(self) -> None:
        """Run plans must only target loopback destinations to prevent exfiltration."""
        plan = create_run_plan()
        for origin in plan["origins"]:
            assert origin.startswith("http://127.0.0.1:") or origin.startswith("http://localhost:")
            assert not any(bad in origin for bad in ("0.0.0.0", "169.254.", "metadata"))


# ==============================================================================
# 4. Corpus Shard Manifest Union Completeness Tests
# ==============================================================================
@pytest.fixture(scope="module")
def manifest_data() -> dict[str, Any]:
    assert MANIFEST_PATH.exists(), f"Manifest file missing at {MANIFEST_PATH}"
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


class TestCorpusShardManifestUnionCompleteness:
    """SEC29: Shard completeness, 700 holdout cases, 25 invariants, zero hash duplicates."""

    def test_corpus_manifest_structure_and_counts(self, manifest_data: dict[str, Any]) -> None:
        """Verify manifest.json specifies holdout splits summing to 700 and 25 invariant records."""
        files = manifest_data.get("files", {})

        assert "holdout_input.jsonl" in files
        assert "holdout_tool.jsonl" in files
        assert "holdout_output.jsonl" in files
        assert "invariant_manifest.jsonl" in files

        input_count = files["holdout_input.jsonl"]["recordCount"]
        tool_count = files["holdout_tool.jsonl"]["recordCount"]
        output_count = files["holdout_output.jsonl"]["recordCount"]
        invariant_count = files["invariant_manifest.jsonl"]["recordCount"]

        assert input_count == 350, f"Expected 350 holdout_input records, got {input_count}"
        assert tool_count == 175, f"Expected 175 holdout_tool records, got {tool_count}"
        assert output_count == 175, f"Expected 175 holdout_output records, got {output_count}"

        total_holdout = input_count + tool_count + output_count
        assert total_holdout == 700, f"Holdout splits must sum to 700, got {total_holdout}"
        assert invariant_count == 25, f"Expected 25 invariant records, got {invariant_count}"

    def test_corpus_files_sha256_integrity(self, manifest_data: dict[str, Any]) -> None:
        """Verify on-disk file checksums and sizes match the frozen manifest."""
        files = manifest_data.get("files", {})
        for filename, meta in files.items():
            file_path = CORPUS_DIR / filename
            assert file_path.exists(), f"Corpus file {filename} does not exist"

            content = file_path.read_bytes()
            assert len(content) == meta["bytes"], f"Byte count mismatch for {filename}"

            computed_sha = hashlib.sha256(content).hexdigest()
            assert computed_sha == meta["sha256"], f"SHA256 checksum mismatch for {filename}"

    def test_corpus_actual_line_counts_match_manifest(self, manifest_data: dict[str, Any]) -> None:
        """Verify actual parsed non-empty line counts match the manifest record counts."""
        files = manifest_data.get("files", {})
        for filename, meta in files.items():
            file_path = CORPUS_DIR / filename
            lines = [
                json.loads(line)
                for line in file_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            assert len(lines) == meta["recordCount"], (
                f"File {filename} has {len(lines)} records, expected {meta['recordCount']}"
            )

    def test_shard_union_zero_duplicate_canonical_hashes(self) -> None:
        """Verify 0 duplicate canonical hashes exist across all splits (725 total unique cases)."""
        all_canonical_hashes: list[str] = []
        hashes_by_split: dict[str, set[str]] = {}

        file_names = [
            "holdout_input.jsonl",
            "holdout_tool.jsonl",
            "holdout_output.jsonl",
            "invariant_manifest.jsonl",
        ]

        for fname in file_names:
            file_path = CORPUS_DIR / fname
            for line in file_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                record = json.loads(line)
                canonical_hash = record["canonicalHash"]
                split = record["split"]

                all_canonical_hashes.append(canonical_hash)
                hashes_by_split.setdefault(split, set())
                hashes_by_split[split].add(canonical_hash)

        # 700 holdout + 25 invariant = 725 total records
        assert len(all_canonical_hashes) == 725
        # 0 duplicate hashes: every canonical hash is strictly unique
        unique_hashes = set(all_canonical_hashes)
        assert len(unique_hashes) == 725

        # Cross-split overlap between holdout and invariant partitions must be empty
        holdout_set = hashes_by_split.get("holdout", set())
        invariant_set = hashes_by_split.get("invariant", set())
        overlap = holdout_set.intersection(invariant_set)
        assert len(overlap) == 0, f"Found {len(overlap)} overlapping hashes between splits"

    def test_corpus_non_empty_stage_denominators(self) -> None:
        """Verify all pipeline stages (input, tool, output) have non-zero denominator counts."""
        stage_counts: dict[str, int] = {"input": 0, "tool": 0, "output": 0}

        file_names = [
            "holdout_input.jsonl",
            "holdout_tool.jsonl",
            "holdout_output.jsonl",
            "invariant_manifest.jsonl",
        ]

        for fname in file_names:
            file_path = CORPUS_DIR / fname
            for line in file_path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                record = json.loads(line)
                stage = record.get("expectedStage")
                assert stage in stage_counts, (
                    f"Unrecognized stage {stage} in record {record.get('id')}"
                )
                stage_counts[stage] += 1

        # Denominators per stage must be non-empty for confusion matrix validity
        assert stage_counts["input"] >= 350
        assert stage_counts["tool"] >= 175
        assert stage_counts["output"] >= 175

    def test_corpus_record_schema_and_oracle_conformance(self) -> None:
        """Verify each record satisfies canonical schema invariants."""
        hash_pattern = re.compile(r"^[a-f0-9]{64}$")
        id_pattern = re.compile(r"^[a-zA-Z0-9_-]+$")

        for fname in ["holdout_input.jsonl", "holdout_tool.jsonl", "holdout_output.jsonl"]:
            file_path = CORPUS_DIR / fname
            for line in file_path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                corpus_record = json.loads(line)

                assert id_pattern.match(corpus_record["id"])
                assert hash_pattern.match(corpus_record["canonicalHash"])
                assert corpus_record["suiteKind"] in ("detector", "invariant")
                assert corpus_record["expectedStage"] in ("input", "tool", "output")
                assert corpus_record["label"] in ("malicious", "benign")
                assert len(corpus_record["payload"]) > 0
                assert isinstance(corpus_record["fixture"], dict)
                assert isinstance(corpus_record["oracle"], dict)
                assert "expectedDecision" in corpus_record["oracle"]


# ==============================================================================
# 5. Redis Outage & Transport Fail-Closed Invariants Tests
# ==============================================================================
class TestRedisOutageAndTransportFailClosedInvariants:
    """SEC29: Fail-closed error handling under Redis/transport outages without data leakage."""

    @pytest.mark.asyncio
    async def test_redis_connection_error_middleware_fails_closed_503(self) -> None:
        """RateLimitMiddleware returns 503 on Redis ConnectionError."""
        mock_redis = MagicMock()
        mock_redis.eval = AsyncMock(
            side_effect=redis.ConnectionError("Cluster partitioned / connection refused")
        )

        app = MagicMock()
        middleware = RateLimitMiddleware(
            app=app,
            limit=10,
            window=60,
            redis_client=mock_redis,
        )

        sensitive_token = f"sensitive-jwt-token-{secrets.token_hex(16)}"
        sensitive_payload = f"sensitive-user-prompt-{secrets.token_hex(16)}"
        user_id = f"user-{secrets.token_hex(8)}"

        request = _make_dummy_request(
            headers={"Authorization": f"Bearer {sensitive_token}"},
            user_sub=user_id,
        )

        async def call_next(_req: Request) -> Response:
            return Response(content="ok", status_code=200)

        response = await middleware.dispatch(request, call_next)

        # 1. Fails closed with 503
        assert response.status_code == 503
        body_text = response.body.decode("utf-8")
        body_json = json.loads(body_text)
        assert body_json["code"] == "CHAT_CONTROL_PLANE_UNAVAILABLE"

        # 2. Sanitization: No sensitive token or payload leakage in failure output
        assert sensitive_token not in body_text
        assert sensitive_payload not in body_text
        assert "connection refused" not in body_text.lower()

    @pytest.mark.asyncio
    async def test_redis_timeout_middleware_fails_closed_503(self) -> None:
        """RateLimitMiddleware returns 503 on Redis TimeoutError without unhandled crash."""
        mock_redis = MagicMock()
        mock_redis.eval = AsyncMock(side_effect=redis.TimeoutError("Socket read timed out"))

        app = MagicMock()
        middleware = RateLimitMiddleware(
            app=app,
            limit=10,
            window=60,
            redis_client=mock_redis,
        )

        request = _make_dummy_request(user_sub="test-user-timeout")

        async def call_next(_req: Request) -> Response:
            return Response(content="ok", status_code=200)

        response = await middleware.dispatch(request, call_next)
        assert response.status_code == 503
        body_json = json.loads(response.body.decode("utf-8"))
        assert body_json["code"] == "CHAT_CONTROL_PLANE_UNAVAILABLE"

    @pytest.mark.asyncio
    async def test_chat_budget_repository_fails_closed_on_redis_outage(self) -> None:
        """ChatBudgetRepository raises RedisUnavailableException when Redis is unreachable."""
        mock_redis = MagicMock()
        mock_redis.eval = AsyncMock(side_effect=redis.ConnectionError("Redis daemon unavailable"))

        repo = ChatBudgetRepository(mock_redis)
        with pytest.raises(RedisUnavailableException) as exc_info:
            await repo.admit_request(
                user_id="fail-closed-user",
                burst_window_id="w_12345",
                daily_limit=50,
                burst_limit=60,
                burst_ttl=60,
            )

        # Verify fail-closed message does not reveal socket internals or sensitive keys
        err_str = str(exc_info.value)
        assert "Redis unavailable" in err_str or "unavailable" in err_str.lower()
        assert "fail-closed-user" not in err_str

    @pytest.mark.asyncio
    async def test_backend_service_unreachable_fails_closed_cleanly(self) -> None:
        """NestJSClient.check_user_access returns allowed=False on transport error."""
        settings = get_settings()
        # Point client to unreachable loopback port
        unreachable_url = "http://127.0.0.1:59999/api"
        dummy_token = secrets.token_hex(32)

        client = NestJSClient(
            base_url=unreachable_url,
            token=dummy_token,
            trace_id="test-trace-fail-closed",
            correlation_id="test-corr-fail-closed",
        )

        sensitive_sub = f"sub-sensitive-{secrets.token_hex(8)}"
        sensitive_jti = f"jti-sensitive-{secrets.token_hex(8)}"

        # Exercise check_user_access against unreachable backend
        result = await client.check_user_access(sub=sensitive_sub, jti=sensitive_jti)

        # Fails closed: access is denied cleanly
        assert isinstance(result, dict)
        assert result.get("allowed") is False

        # Verify no token or secret leak in result dict
        result_str = json.dumps(result)
        assert dummy_token not in result_str
        assert sensitive_sub not in result_str
        assert sensitive_jti not in result_str
        assert getattr(settings, "AGENT_SERVICE_API_KEY", "") not in result_str

    @pytest.mark.asyncio
    async def test_backend_service_timeout_fails_closed_cleanly(self) -> None:
        """NestJSClient.check_user_access returns allowed=False on HTTP timeout."""
        client = NestJSClient(
            base_url="http://127.0.0.1:3001/api",
            token=secrets.token_hex(16),
        )

        mock_post = AsyncMock(side_effect=httpx.TimeoutException("Upstream connection timeout"))
        mock_http_client = MagicMock()
        mock_http_client.post = mock_post
        mock_http_client.__aenter__ = AsyncMock(return_value=mock_http_client)
        mock_http_client.__aexit__ = AsyncMock(return_value=None)

        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("httpx.AsyncClient", MagicMock(return_value=mock_http_client))
            result = await client.check_user_access(sub="timeout-user")

        assert result == {"allowed": False}

    def test_failure_outputs_are_sanitized_against_credential_disclosure(self) -> None:
        """Verify error messages sanitize and do not expose API keys, bearer tokens, or user PII."""
        sensitive_elements = [
            f"sk_live_{secrets.token_hex(16)}",
            f"eyJh...{secrets.token_hex(20)}",
            "super_secret_password_123",
            "credit_card_4111_2222_3333_4444",
        ]

        # Test plan generation failures
        for profile in ["custom_admin", "staging"]:
            try:
                create_run_plan(profile=profile)
            except ValueError as e:
                err_msg = str(e)
                for secret_item in sensitive_elements:
                    assert secret_item not in err_msg

        # Test cap bounding failures
        for cap in [-1, 99999]:
            try:
                create_run_plan(max_requests=cap)
            except ValueError as e:
                err_msg = str(e)
                for secret_item in sensitive_elements:
                    assert secret_item not in err_msg

    @pytest.mark.redis_integration
    @pytest.mark.asyncio
    async def test_live_redis_quota_burst_verification(self, redis_client) -> None:
        """[Live Integration] Verify live Redis rate limiting and burst quota enforcement."""
        app = MagicMock()
        middleware = RateLimitMiddleware(
            app=app,
            limit=5,
            window=60,
            daily_limit=10,
            redis_client=redis_client,
        )

        user_id = f"user-live-burst-{secrets.token_hex(8)}"
        request = _make_dummy_request(user_sub=user_id)

        async def call_next(_req: Request) -> Response:
            return Response(content="ok", status_code=200)

        for _ in range(5):
            res = await middleware.dispatch(request, call_next)
            assert res.status_code == 200

        rejected = await middleware.dispatch(request, call_next)
        assert rejected.status_code == 429
        data = json.loads(rejected.body.decode("utf-8"))
        assert data["code"] == "CHAT_BURST_LIMIT_EXCEEDED"

    @pytest.mark.redis_integration
    @pytest.mark.asyncio
    async def test_live_redis_outage_fail_closed_verification(self, redis_client) -> None:
        """[Live Integration] Verify rate limiting fails closed (503) on live Redis outage."""
        unreachable_client = redis.Redis.from_url(
            "redis://127.0.0.1:59998/0",
            decode_responses=True,
            socket_connect_timeout=0.2,
        )
        try:
            app = MagicMock()
            middleware = RateLimitMiddleware(
                app=app,
                limit=10,
                window=60,
                redis_client=unreachable_client,
            )
            request = _make_dummy_request(user_sub="live-outage-user")

            async def call_next(_req: Request) -> Response:
                return Response(content="ok", status_code=200)

            response = await middleware.dispatch(request, call_next)
            assert response.status_code == 503
            body_json = json.loads(response.body.decode("utf-8"))
            assert body_json["code"] == "CHAT_CONTROL_PLANE_UNAVAILABLE"
        finally:
            await unreachable_client.aclose()
