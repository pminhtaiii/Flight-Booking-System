# Security Toolchain Specifications and Procedures

**Feature**: 023-security-systems  
**Task**: T003  
**Status**: Active Specification  
**Date**: 2026-09-04  
**Authority**: `specs/023-security-systems/plan.md`, `tests/security/toolchain.json`

---

## 1. Overview

This document defines the verified security scanner toolchain for the Flight Booking System. To ensure deterministic, reproducible, and verifiable security audits across local development and GitHub Actions CI, all scanner binaries, container images, rulesets, and database freshness constraints are pinned in [`tests/security/toolchain.json`](file:///c:/Booking%20Systems/tests/security/toolchain.json).

---

## 2. Pinned Toolchain Matrix

| Tool | Capability | Pinned Version / Digest | Output Schema | License | Freshness Constraint |
|---|---|---|---|---|---|
| **Semgrep** | SAST (Agent, API, Web) | CLI `1.88.0` | SARIF v2.1.0 | LGPL-2.1 / Community | Pinned ruleset tags |
| **OWASP ZAP** | DAST (REST API & Web) | `zaproxy/zap-stable:2.15.0@sha256:2d184081c7ff8be2ad7500599a0d4c82c3cfa5d95b542013fbe40d346ffc0303` | SARIF v2.1.0 / JSON | Apache-2.0 | Engine release build |
| **Gitleaks** | Secret Detection | `v8.18.4` | JSON | MIT | Pinned release binary |
| **pip-audit** | Python SCA (Agent) | CLI `2.7.3` | JSON | Apache-2.0 | Max advisory age 24h |
| **pnpm audit** | Node.js SCA (API, Web) | CLI `9.0.0+` | JSON | MIT | Live registry query |
| **pytest-cov** | Code Coverage Verification | `pytest-cov>=5.0.0` | XML / Terminal | MIT | In-repo test run |

---

## 3. Verified Invocation Commands

### 3.1 Semgrep (SAST)
- **Engine**: Semgrep CLI v1.88.0
- **Rule Packages**: `p/default`, `p/owasp-top-ten`, `p/security-audit`, `p/secrets`
- **Invocation (Command Line / CI)**:
  ```bash
  semgrep scan \
    --config p/default \
    --config p/owasp-top-ten \
    --config p/security-audit \
    --config p/secrets \
    --sarif \
    --output semgrep-report.sarif \
    --error \
    apps/agent apps/api apps/web packages/shared
  ```
- **Exit Code Semantics**:
  - `0`: Scan complete, zero blocking findings.
  - `1`: Syntax / execution error.
  - `2`: Blocking security findings detected (`--error` flag enforces exit code 2 on ERROR-level findings).

### 3.2 OWASP ZAP (DAST)
- **Container Digest**: `zaproxy/zap-stable:2.15.0@sha256:2d184081c7ff8be2ad7500599a0d4c82c3cfa5d95b542013fbe40d346ffc0303`
- **Invocation (API Automation)**:
  ```bash
  docker run --rm \
    -v "${PWD}/tests/security/zap:/zap/wrk/:rw" \
    -t zaproxy/zap-stable:2.15.0@sha256:2d184081c7ff8be2ad7500599a0d4c82c3cfa5d95b542013fbe40d346ffc0303 \
    zap-api-scan.py \
    -t http://host.docker.internal:3001/api/docs-json \
    -f openapi \
    -J zap-report.json \
    -r zap-report.html \
    -l LOW \
    --hook=/zap/wrk/zap-hooks.py
  ```
- **Exit Code Semantics**:
  - `0`: Scan passed successfully with no findings above threshold.
  - `1`: At least one FAIL or WARNING finding identified.
  - `2`: User configuration error or invalid CLI parameters.
  - `3`: Execution / network crash (e.g. target unreachable).

### 3.3 Gitleaks (Secret Detection)
- **Version**: Binary / GitHub Action `v8.18.4`
- **Invocation**:
  ```bash
  gitleaks detect \
    --source . \
    --verbose \
    --report-format json \
    --report-path gitleaks-report.json \
    --redact
  ```
- **Exit Code Semantics**:
  - `0`: Clean git history and workspace.
  - `1`: Unredacted secrets or credentials detected.

### 3.4 pip-audit (Python Dependency SCA)
- **CLI Version**: `2.7.3`
- **Vulnerability Data Source**: PyPI Advisory Database via PyPA OSV API.
- **Invocation**:
  ```bash
  uv run --package agent pip-audit \
    --format json \
    --output pip-audit-report.json \
    --cache-dir .pip-audit-cache
  ```
- **Advisory Freshness**:
  - The `--cache-dir` TTL must not exceed 24 hours (`maxAdvisoryAgeHours: 24`).
  - Stale caches (>24h) trigger cache invalidation and a re-fetch from PyPA.
- **Exit Code Semantics**:
  - `0`: Zero known vulnerabilities in installed Python packages.
  - `1`: Known vulnerability detected matching CVSS/advisory criteria.

### 3.5 pnpm audit (Node.js Dependency SCA)
- **CLI Version**: `9.0.0+`
- **Invocation**:
  ```bash
  pnpm audit --audit-level moderate --json > pnpm-audit-report.json
  ```
- **Advisory Freshness**:
  - Runs with live network queries against the npm security advisory database (`registry.npmjs.org`).
  - Cached offline states are rejected in CI pipelines.
- **Exit Code Semantics**:
  - `0`: Zero vulnerabilities meeting or exceeding `moderate` severity.
  - `Non-zero`: Vulnerable dependency identified in lockfile dependency tree.

### 3.6 pytest-cov (Guardrail Test Coverage)
- **Version**: `pytest-cov>=5.0.0`
- **Invocation**:
  ```bash
  uv run --package agent pytest apps/agent/tests \
    --cov=agent.guardrails \
    --cov=agent.chat_turn \
    --cov=agent.streaming \
    --cov=agent.tools \
    --cov=agent.sanitization \
    --cov-branch \
    --cov-report=term-missing \
    --cov-report=xml:tests/security/coverage.xml \
    --cov-fail-under=95
  ```
- **Threshold Policy**:
  - Statement coverage $\ge 95.0\%$.
  - Branch coverage $\ge 90.0\%$.

---

## 4. Expected Output Schemas

### 4.1 SARIF (Static Analysis Results Interchange Format)
Used by **Semgrep** and **OWASP ZAP**. Conforms to OASIS standard SARIF v2.1.0 (`https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html`).

```json
{
  "$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
  "version": "2.1.0",
  "runs": [
    {
      "tool": {
        "driver": {
          "name": "Semgrep",
          "semanticVersion": "1.88.0",
          "rules": [
            {
              "id": "security.injection.pattern",
              "shortDescription": { "text": "Potential SQL or Prompt Injection vector" },
              "defaultConfiguration": { "level": "error" }
            }
          ]
        }
      },
      "results": [
        {
          "ruleId": "security.injection.pattern",
          "level": "error",
          "message": { "text": "Unescaped parameter passed to execution context." },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": { "uri": "apps/agent/src/agent/streaming/sse.py" },
                "region": { "startLine": 118, "startColumn": 9 }
              }
            }
          ]
        }
      ]
    }
  ]
}
```

### 4.2 Gitleaks Output Schema (JSON)
```json
[
  {
    "Description": "Generic API Key or Secret",
    "StartLine": 45,
    "EndLine": 45,
    "StartColumn": 12,
    "EndColumn": 52,
    "Match": "REDACTED",
    "Secret": "REDACTED",
    "File": "apps/agent/.env.example",
    "Commit": "0000000000000000000000000000000000000000",
    "Author": "developer",
    "Email": "dev@example.com",
    "Date": "2026-09-04T00:00:00Z",
    "Message": "Initial commit",
    "RuleID": "generic-api-key",
    "Fingerprint": "c20ad4d76fe97759aa27a0c99bff6710"
  }
]
```

### 4.3 pip-audit Output Schema (JSON)
```json
{
  "dependencies": [
    {
      "name": "cryptography",
      "version": "41.0.0",
      "vulns": [
        {
          "id": "PYSEC-2023-123",
          "fix_versions": ["41.0.5"],
          "description": "Vulnerability description"
        }
      ]
    }
  ]
}
```

### 4.4 pnpm audit Output Schema (JSON)
```json
{
  "actions": [],
  "advisories": {},
  "muted": [],
  "metadata": {
    "vulnerabilities": {
      "info": 0,
      "low": 0,
      "moderate": 0,
      "high": 0,
      "critical": 0
    },
    "dependencies": 1240,
    "devDependencies": 320,
    "optionalDependencies": 0,
    "totalDependencies": 1560
  }
}
```

---

## 5. Licensing Constraints and Compliance

1. **Semgrep**:
   - The CLI engine is licensed under **GNU LGPL v2.1**.
   - Public rule packs (`p/default`, `p/owasp-top-ten`, `p/security-audit`, `p/secrets`) are accessed under the Semgrep Registry Terms.
   - Proprietary "Semgrep Pro" features (cross-file taint analysis requiring paid cloud accounts) are **NOT required** and **NOT included** in the open-source CI pipeline.
2. **OWASP ZAP**:
   - Licensed under the **Apache License 2.0**. Full permissive commercial and internal use.
3. **Gitleaks**:
   - Licensed under the **MIT License**. Permissive use.
4. **pip-audit**:
   - Developed by Trail of Bits under the **Apache License 2.0**.
5. **pnpm**:
   - Licensed under the **MIT License**.
6. **pytest-cov**:
   - Licensed under the **MIT License**.

---

## 6. Advisory Database Freshness Parameters

| Scanner | Feed Source | Freshness Rule | Failure Handling |
|---|---|---|---|
| `pip-audit` | PyPI Advisory DB (OSV) | Cached advisory database $\le 24\text{h}$ old | If fetch fails, scan aborts with code 1; does not proceed with stale cache in CI. |
| `pnpm audit` | npm Advisory DB | Live API check per CI run | Registry timeouts fail closed to prevent merging vulnerable code. |
| `Semgrep` | GitHub / Semgrep Registry | Rulesets pinned to immutable commit/release tags | Avoids unvetted rule drift breaking CI builds. |
| `Gitleaks` | Static pattern rules | Rules pinned with engine version `v8.18.4` | Custom `.gitleaks.toml` rules version-controlled in repository. |

---

## 7. Update Procedures

When upgrading scanner versions, image digests, or rule packages:

1. **Check Release Notes & Advisory Logs**:
   - Review upstream changelog for breaking changes or modified CLI flags.
2. **Retrieve SHA-256 Digests**:
   - For container images (e.g. ZAP), inspect the remote digest using:
     ```bash
     docker pull zaproxy/zap-stable:<new-tag>
     docker inspect --format='{{index .RepoDigests 0}}' zaproxy/zap-stable:<new-tag>
     ```
3. **Update Configuration**:
   - Edit [`tests/security/toolchain.json`](file:///c:/Booking%20Systems/tests/security/toolchain.json) with updated versions, digests, and rule hashes.
   - If Python or Node dependencies change, update `apps/agent/pyproject.toml` or root `package.json`.
4. **Verify Locally**:
   - Run the local invocation command for the updated scanner.
   - Confirm output schema conforms to SARIF or expected JSON structure.
5. **Update Documentation**:
   - Update version numbers and rationale in this document.
6. **Submit Changes via PR**:
   - Ensure the updated scanner passes the `ci-status` workflow in GitHub Actions.
