# Security Observability, Dashboards, False Positive Tracking & Operational Alert Runbooks

**Feature**: 023-security-systems  
**Task**: T045 [US5] Part 2  
**Status**: Active Operational Specification  
**Date**: 2026-09-13  
**Contract Authority**: [`tests/security/observability-contract.json`](file:///c:/Booking%20Systems/tests/security/observability-contract.json)  
**Supporting Documentation**: [`docs/security/rollout.md`](file:///c:/Booking%20Systems/docs/security/rollout.md), [`docs/security/performance-validation.md`](file:///c:/Booking%20Systems/docs/security/performance-validation.md), [`tests/security/corpus/README.md`](file:///c:/Booking%20Systems/tests/security/corpus/README.md)

---

## 1. Executive Summary & Observability Architecture

This specification codifies the operational observability framework for Feature 023 (Security Systems). It defines the telemetry contract, metrics architecture, real-time security dashboards, false positive tracking standard operating procedures (SOP), pseudonym rotation policies, and production alert runbooks.

The observability infrastructure ensures that the deterministic `GuardrailGateway` maintains complete visibility across ingress, egress, and tool-execution stages without introducing data leakage, unbounded cardinality, or runtime performance degradation.

```
+-----------------------------------------------------------------------------------+
|                            Security Telemetry Architecture                        |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  [ User Ingress ]         [ Agent LangGraph ]            [ LLM Response ]         |
|         │                         │                              │                |
|         ▼                         ▼                              ▼                |
|  ┌─────────────┐          ┌──────────────┐               ┌──────────────┐         |
|  │ Input Stage │          │  Tool Stage  │               │ Output Stage │         |
|  │ Guardrails  │          │  Guardrails  │               │  Guardrails  │         |
|  └──────┬──────┘          └──────┬───────┘               └──────┬───────┘         |
|         │                        │                              │                 |
|         └────────────────┬───────┴──────────────────────────────┘                 |
|                          ▼                                                        |
|             ┌─────────────────────────┐                                           |
|             │ Telemetry Event Emitter │                                           |
|             └────────────┬────────────┘                                           |
|                          │                                                        |
|       ┌──────────────────┼─────────────────────────┐                              |
|       ▼                  ▼                         ▼                              |
|  ┌───────────┐     ┌───────────┐            ┌─────────────┐                       |
|  │Prometheus │     │   Redis   │            │Audit Logger │                       |
|  │  Metrics  │     │ RingBuffer│            │  (Log Sink) │                       |
|  └─────┬─────┘     └─────┬─────┘            └──────┬──────┘                       |
|        │                 │                         │                              |
|        ▼                 ▼                         ▼                              |
|  ┌───────────┐     ┌───────────┐            ┌─────────────┐                       |
|  │ Grafana   │     │ Dead-Letter│           │   SIEM /    │                       |
|  │Dashboards │     │ Recovery  │            │ Cold Store  │                       |
|  └───────────┘     └───────────┘            └─────────────┘                       |
+-----------------------------------------------------------------------------------+
```

### 1.1 Non-Negotiable Telemetry Invariants

All metrics, telemetry events, and log emissions must strictly adhere to three core invariants validated continuously by [`tests/security/observability-contract.test.mjs`](file:///c:/Booking%20Systems/tests/security/observability-contract.test.mjs):

1. **Zero Raw Payloads**:
   Under no circumstances may telemetry events, metric labels, or log messages contain raw user prompts, model outputs, tool payloads, customer names, passport numbers, credit cards, or plaintext session identifiers. Any logging of unredacted payloads violates privacy regulations and invalidates the security boundary.

2. **Zero High-Cardinality Dynamic Labels**:
   Metric labels must be bounded and strictly enumerated. Dynamic user inputs, raw `user_id` strings, IP addresses, session tokens, prompt content, or email addresses are strictly forbidden as Prometheus labels. Label cardinality per metric must not exceed 90 across all combinations.

3. **Deterministic Telemetry Delivery**:
   Telemetry collection must never block user turns or introduce unpredictable latency. Sinks operate asynchronously or via bounded, non-blocking in-memory ring buffers. Failures in telemetry sinks trigger deterministic error counters without leaking sensitive state.

---

### 1.2 Metric Definitions and Schemas

Aligned with [`tests/security/observability-contract.json`](file:///c:/Booking%20Systems/tests/security/observability-contract.json), the runtime exports three standardized Prometheus metrics:

#### 1. `security_guardrail_decisions_total`
- **Type**: Counter
- **Description**: Total count of deterministic guardrail decisions partitioned strictly by pipeline stage, guardrail layer, and decision outcome.
- **Labels**: `stage`, `decision`, `layer_key`
- **Allowed Stages**: `input`, `tool`, `output`
- **Allowed Decisions**: `PASS`, `BLOCK`, `SKIP`
- **Cardinality Bound**: $\le 90$ total time series.

#### 2. `security_guardrail_latency_ms`
- **Type**: Histogram
- **Description**: Execution latency distribution of guardrail layers in milliseconds. Captures active CPU execution time separately from stream buffering wait.
- **Labels**: `stage`, `layer_key`
- **Buckets**: `[0.5, 1, 2, 5, 10, 25, 50, 100, 250]`
- **Unit**: Milliseconds (`ms`)

#### 3. `security_emitter_errors_total`
- **Type**: Counter
- **Description**: Count of failed telemetry emission attempts to background sinks.
- **Labels**: `sink`, `error_type`
- **Allowed Sinks**: `security_audit_log`, `prometheus`, `redis`
- **Allowed Error Types**: `connection_timeout`, `buffer_overflow`, `io_error`, `serialization_failure`
- **Cardinality Bound**: $\le 15$ total time series.

---

### 1.3 Event Schemas (`oneOf`)

Structured security audit and operational telemetry records emitted to sinks must conform to the `oneOf` schema defined in [`tests/security/observability-contract.json`](file:///c:/Booking%20Systems/tests/security/observability-contract.json), distinguishing guardrail evaluation records from telemetry emitter error events:

#### 1.3.1 Guardrail Evaluation Record (`security_guardrail_eval`)

Emitted to `security_audit_log` on every deterministic guardrail evaluation across ingress, tool, or egress stages:

```json
{
  "event_type": "security_guardrail_eval",
  "timestamp_utc": "2026-09-13T12:00:00.000Z",
  "trace_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "subject_ref": "hmac_sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "stage": "input",
  "layer_key": "input.injection",
  "decision": "BLOCK",
  "latency_ms": 1.24,
  "reason": "PROMPT_INJECTION_DETECTED"
}
```

| Field Name | Type | Format / Constraints | Description |
|---|---|---|---|
| `event_type` | string | `security_guardrail_eval` | Categorical event classification. |
| `timestamp_utc` | string | ISO 8601 UTC date-time | Precise timestamp of guardrail decision. |
| `trace_id` | string | `^[a-f0-9\-]+$` | Ephemeral distributed turn/request trace identifier. |
| `subject_ref` | string | `^hmac_sha256:[a-f0-9]{64}$` | Daily rotating pseudonymized HMAC digest of user identifier. |
| `stage` | string | `input` \| `tool` \| `output` | Pipeline execution stage. |
| `layer_key` | string | e.g. `input.injection`, `output.pii` | Canonical dot-notation guardrail layer key. |
| `decision` | string | `PASS` \| `BLOCK` \| `SKIP` | Deterministic policy decision. |
| `latency_ms` | number | $\ge 0.0$ | Active compute time in milliseconds. |
| `reason` | string | Optional string token | Standardized failure code (e.g. `PII_MASKED`, `REJECTED`). |

*Additional properties outside this schema are rejected (`additionalProperties: false`).*

#### 1.3.2 Telemetry Emitter Error Record (`security_emitter_error`)

Emitted when an asynchronous or bounded ring-buffer telemetry emission fails:

```json
{
  "event_type": "security_emitter_error",
  "timestamp_utc": "2026-09-13T12:00:00.000Z",
  "trace_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "sink": "security_audit_log",
  "error_type": "connection_timeout",
  "details": "Connection timed out after 500ms writing to audit sink"
}
```

| Field Name | Type | Format / Constraints | Description |
|---|---|---|---|
| `event_type` | string | `security_emitter_error` | Categorical event classification. |
| `timestamp_utc` | string | ISO 8601 UTC date-time | Precise timestamp of emitter error. |
| `trace_id` | string | `^[a-f0-9\-]+$` | Ephemeral distributed turn/request trace identifier. |
| `sink` | string | `security_audit_log` \| `prometheus` \| `redis` | Telemetry sink that experienced the error. |
| `error_type` | string | String token | Error classification code. |
| `details` | string | Optional string | Diagnostic failure details (zero raw payloads). |

*Additional properties outside this schema are rejected (`additionalProperties: false`).*

---

## 2. Security Dashboards Specifications

To ensure rapid incident response, four real-time dashboards are specified for deployment in Grafana/Prometheus.

### 2.1 Dashboard 1: Guardrail Decision & Block Rate by Layer

**Purpose**: High-level operational overview of security gateway throughput, layer enforcement activity, and layer-by-layer rejection rates.

```
+---------------------------------------------------------------------------------------+
| Dashboard 1: Guardrail Decision & Block Rate by Layer                                 |
+---------------------------------------------------+-----------------------------------+
| Panel 1.1: Total Evaluation Throughput (evals/s)  | Panel 1.2: Overall Block Rate (%) |
| [ Line chart: 5m rate by stage ]                  | [ Gauge: Target <= 1.0% ]         |
+---------------------------------------------------+-----------------------------------+
| Panel 1.3: Decision Outcome Stack by Layer        | Panel 1.4: Block Rate by Layer    |
| [ Stacked Bar: PASS, BLOCK, SKIP per layer_key ]  | [ Bar chart: % Blocked by Layer ] |
+---------------------------------------------------+-----------------------------------+
| Panel 1.5: Stage Volume Distribution              | Panel 1.6: Top Triggered Reasons  |
| [ Donut chart: input vs tool vs output ]          | [ Table: layer_key, reason, count]|
+---------------------------------------------------+-----------------------------------+
```

#### Panel Queries (PromQL):

1. **Evaluation Throughput by Stage**:
   ```promql
   sum by (stage) (rate(security_guardrail_decisions_total[5m]))
   ```

2. **Overall Block Rate (%)**:
   ```promql
   (sum(rate(security_guardrail_decisions_total{decision="BLOCK"}[5m]))
     /
    sum(rate(security_guardrail_decisions_total[5m]))) * 100
   ```

3. **Decisions Stacked by Layer & Outcome**:
   ```promql
   sum by (layer_key, decision) (rate(security_guardrail_decisions_total[5m]))
   ```

4. **Block Rate by Layer (%)**:
   ```promql
   (sum by (stage, layer_key) (rate(security_guardrail_decisions_total{decision="BLOCK"}[5m]))
     /
    sum by (stage, layer_key) (rate(security_guardrail_decisions_total[5m]))) * 100
   ```

5. **Prompt Injection Layer Block Rate (`input.injection`)**:
   ```promql
   (sum(rate(security_guardrail_decisions_total{stage="input", layer_key="input.injection", decision="BLOCK"}[5m]))
     /
    sum(rate(security_guardrail_decisions_total{stage="input", layer_key="input.injection"}[5m]))) * 100
   ```

---

### 2.2 Dashboard 2: Guardrail Latency Distributions (p50, p95, p99) against SC-004

**Purpose**: Verify compliance with architectural latency budgets defined in SC-004:
- $\le 1.0\text{ ms}$ per typical layer compute (warm).
- $\le 10.0\text{ ms}$ aggregate guardrail compute per typical turn.
- $\le 50.0\text{ ms}$ per near-limit hostile payload check.

```
+---------------------------------------------------------------------------------------+
| Dashboard 2: Guardrail Latency Distributions (SC-004 Compliance)                     |
+---------------------------------------------------+-----------------------------------+
| Panel 2.1: Per-Layer p95 Latency vs 1ms Budget    | Panel 2.2: Aggregate Turn Compute |
| [ Line chart: p95 per layer_key; threshold: 1ms ] | [ Line chart: p95 turn; limit: 10ms]|
+---------------------------------------------------+-----------------------------------+
| Panel 2.3: Quantile Distribution (p50, p95, p99)  | Panel 2.4: Near-Limit Stress Track|
| [ Heatmap / Multi-line: 0.5ms to 250ms buckets ]  | [ Max observed layer latency; 50ms]|
+---------------------------------------------------+-----------------------------------+
```

#### Panel Queries (PromQL):

1. **p50 Latency by Layer**:
   ```promql
   histogram_quantile(0.50, sum by (le, stage, layer_key) (rate(security_guardrail_latency_ms_bucket[5m])))
   ```

2. **p95 Latency by Layer (Target $\le 1.0\text{ ms}$ per layer)**:
   ```promql
   histogram_quantile(0.95, sum by (le, stage, layer_key) (rate(security_guardrail_latency_ms_bucket[5m])))
   ```

3. **p99 Latency by Layer**:
   ```promql
   histogram_quantile(0.99, sum by (le, stage, layer_key) (rate(security_guardrail_latency_ms_bucket[5m])))
   ```

4. **Aggregate Turn Compute Latency Estimate ($p95 \le 10.0\text{ ms}$)**:
   ```promql
   sum by (stage) (histogram_quantile(0.95, sum by (le, stage) (rate(security_guardrail_latency_ms_bucket[5m]))))
   ```

5. **Near-Limit Latency Outliers ($p99 \le 50.0\text{ ms}$)**:
   ```promql
   histogram_quantile(0.99, sum by (le) (rate(security_guardrail_latency_ms_bucket{layer_key=~"input.injection|tool.size_structure"}[5m])))
   ```

*Latency Separation Rule: Guardrail active CPU compute is strictly distinguished from LLM token inter-arrival streaming buffer wait (~20 ms per token). Dashboards measure active CPU execution.*

---

### 2.3 Dashboard 3: Telemetry Emitter Reliability & Sink Health

**Purpose**: Monitor the operational reliability and delivery rate of telemetry events across background sinks (`security_audit_log`, `prometheus`, `redis`).

```
+---------------------------------------------------------------------------------------+
| Dashboard 3: Telemetry Emitter Reliability & Sink Health                              |
+---------------------------------------------------+-----------------------------------+
| Panel 3.1: Overall Emitter Drop Rate (%)          | Panel 3.2: Error Count by Sink    |
| [ Gauge: Red line at > 1.0% ]                     | [ Stacked Bar: audit_log, redis ] |
+---------------------------------------------------+-----------------------------------+
| Panel 3.3: In-Memory Ring Buffer Saturation (%)   | Panel 3.4: Fail-Closed Audit Gate |
| [ Line chart: Buffer depth vs 4096 capacity ]     | [ Status: GREEN / ENGAGED ]       |
+---------------------------------------------------+-----------------------------------+
```

#### Panel Queries (PromQL):

1. **Telemetry Emitter Drop Rate (% of total emissions, Target $< 1.0\%$)**:
   ```promql
   (sum(rate(security_emitter_errors_total[5m]))
     /
    (sum(rate(security_guardrail_decisions_total[5m])) + sum(rate(security_emitter_errors_total[5m])))) * 100
   ```

2. **Emitter Errors by Sink and Error Type**:
   ```promql
   sum by (sink, error_type) (rate(security_emitter_errors_total[5m]))
   ```

3. **Sink Error Spike Indicator (Last 10m)**:
   ```promql
   increase(security_emitter_errors_total[10m])
   ```

---

### 2.4 Dashboard 4: False Positive Triage & Evaluation Trends

**Purpose**: Track offline benchmark validation results, user friction reports, triage velocity, and longitudinal false positive rates against SLA targets.

```
+---------------------------------------------------------------------------------------+
| Dashboard 4: False Positive Triage & Evaluation Trends                                |
+---------------------------------------------------+-----------------------------------+
| Panel 4.1: Holdout Evaluation FPR Trend (%)       | Panel 4.2: Holdout Evaluation TPR |
| [ Line chart: Target <= 2.0% ]                    | [ Line chart: Target >= 95.0% ]   |
+---------------------------------------------------+-----------------------------------+
| Panel 4.3: Reported User Friction Incidents       | Panel 4.4: Confirmed FP by Layer  |
| [ Weekly bar chart: Customer friction tickets ]   | [ Donut: Breakdown by layer_key ] |
+---------------------------------------------------+-----------------------------------+
```

#### Monitored Indicators:
- **Corpus Evaluation FPR**: Sourced from automated CI evaluation runs against the 700-case holdout corpus.
- **Corpus Evaluation TPR**: Sourced from CI evaluation runs against the 200 malicious cases.
- **User Triage Ratio**: Confirmed False Positives / Total Blocked User Inquiries.
- **Corpus Expansion Velocity**: New benign test cases added to `tests/security/corpus/` per sprint.

---

## 3. False Positive Tracking Standard Operating Procedure (SOP)

### 3.1 Mathematical Foundation: Why Raw Block Volume != False Positive Rate

In an adversarial environment, raw block volume is **not** a valid metric for false positive rate:

$$\text{Raw Block Volume} = \text{True Positives (TP)} + \text{False Positives (FP)}$$

1. **Adversarial Distortions**: When attackers launch credential-stuffing or prompt-injection botnets, raw blocks spike dramatically. Interpreting this as an increase in false positives would trigger erroneous rule relaxations or rollbacks during active defense.
2. **Traffic Skews**: A drop in raw blocks can occur if an attacker successfully bypasses filters or if traffic declines, creating an illusion of improved accuracy.
3. **Ground Truth Requirement**: The true False Positive Rate ($FPR$) can only be measured against a ground-truth dataset where every input is conclusively labeled as benign or malicious.

### 3.2 Canonical Formulas & Target Thresholds

Confusion matrix definitions:
- **True Positive ($TP$)**: Malicious payload correctly flagged and `BLOCK`ed.
- **False Positive ($FP$)**: Legitimate user payload incorrectly flagged and `BLOCK`ed.
- **True Negative ($TN$)**: Legitimate user payload correctly allowed to `PASS`.
- **False Negative ($FN$)**: Malicious payload incorrectly allowed to `PASS`.

$$\text{False Positive Rate (FPR)} = \frac{\text{FP}}{\text{FP} + \text{TN}} \le 2.0\%$$

$$\text{True Positive Rate (TPR)} = \frac{\text{TP}}{\text{TP} + \text{FN}} \ge 95.0\%$$

- **Critical Invariant**: Critical prompt injections, system prompt leakages, and PII disclosures enforce zero false negatives ($FN = 0$).
- **Invariant Test Isolation**: Invariants in [`tests/security/corpus/invariant_manifest.jsonl`](file:///c:/Booking%20Systems/tests/security/corpus/invariant_manifest.jsonl) require a **100% pass rate** ($25/25$) and are strictly excluded from detector confusion matrices.

### 3.3 Benchmark Evaluation Protocol

Evaluation is conducted against the 700-case holdout corpus defined in [`tests/security/corpus/manifest.json`](file:///c:/Booking%20Systems/tests/security/corpus/manifest.json):

| Pipeline Stage | Holdout Partition | Malicious Cases ($TP + FN$) | Benign Cases ($FP + TN$) | Total Cases | Target FPR | Target TPR |
|---|---|---|---|---|---|---|
| **Input Pipeline** | `holdout_input.jsonl` | 100 | 250 | 350 | $\le 2.0\%$ ($\le 5$ blocks) | $\ge 95.0\%$ ($\ge 95$ blocks) |
| **Tool Execution** | `holdout_tool.jsonl` | 50 | 125 | 175 | $\le 2.0\%$ ($\le 2$ blocks) | $\ge 95.0\%$ ($\ge 48$ blocks) |
| **Output Stream** | `holdout_output.jsonl` | 50 | 125 | 175 | $\le 2.0\%$ ($\le 2$ blocks) | $\ge 95.0\%$ ($\ge 48$ blocks) |
| **Total Holdout** | *(All Partitions)* | **200** | **500** | **700** | **$\le 2.0\%$ ($\le 10$ blocks)** | **$\ge 95.0\%$ ($\ge 190$ blocks)** |

---

### 3.4 Step-by-Step Triage Workflow for Reported User Friction

When a customer or support agent reports that a benign chat turn was unexpectedly blocked:

```
+-------------------------------------------------------------------------------+
|                      False Positive Triage Workflow                           |
+-------------------------------------------------------------------------------+
| 1. Incident Intake       --> Extract trace_id and user timestamp              |
| 2. Trace Correlation     --> Lookup audit record using subject_ref & trace_id |
| 3. Offline Replay        --> Reproduce failure in local test harness          |
| 4. Corpus Expansion      --> Add minimal reproducible benign case to holdout  |
| 5. Layer Rule Tuning     --> Refine guardrail pattern without lowering TPR    |
| 6. Invariant Regression  --> Run full 700-case suite + 25 invariants (0 fail) |
| 7. Canary Rollout        --> Deploy via verified canary progression           |
+-------------------------------------------------------------------------------+
```

#### Step 1: Intake and Trace Correlation
1. Request the customer's `trace_id` from the support ticket or UI error banner.
2. Query `security_audit_log` matching `trace_id`.
3. Locate the evaluation event: verify `stage`, `layer_key`, `decision: "BLOCK"`, and recorded `reason`.
4. Check the user's daily rotating pseudonym `subject_ref`. Do **not** request or log the user's plaintext password, email, or full credit card number.

#### Step 2: Offline Replay in Evaluation Harness
1. In an isolated staging/local environment, construct a synthetic test turn mirroring the linguistic structure or tool call that triggered the block.
2. Execute the input through the standalone layer:
   ```bash
   uv run --package agent pytest apps/agent/tests/security/test_guardrail_gateway.py -k "test_reproduce_friction"
   ```
3. Confirm whether the layer decision is indeed a False Positive ($FP$) or an actual policy violation (e.g. user inadvertently pasted an API key or unescaped injection syntax).

#### Step 3: Holdout Corpus Expansion
1. If verified as a legitimate user workflow, sanitize and normalize the turn into a minimal reproducing case.
2. Append the case into the corresponding stage development and holdout manifests:
   - For input friction: `tests/security/corpus/holdout_input.jsonl`
   - Mark `expectedDecision: "PASS"` and assign category (e.g. `LLM01-benign-conversational`).
3. Re-generate SHA-256 canonical hash in `tests/security/corpus/manifest.json`.

#### Step 4: Layer Rule Tuning
1. Refine regex boundaries or classification rules in the offending layer (e.g. adjusting token boundaries in `InputInjectionBoundary` or `TopicBoundary`).
2. Prohibit broad exclusion rules or unbounded wildcard matches.
3. Ensure regex patterns remain linear-time ($O(N)$) and free of catastrophic backtracking.

#### Step 5: Regression Testing & Invariant Verification
1. Run the entire security evaluation harness:
   ```powershell
   $env:UV_CACHE_DIR = "c:\Booking Systems\.t093-uv-cache"
   $env:PYTHONPATH = "$PWD/tests/ci/python;$PWD/apps/agent/src"
   uv run --package agent pytest apps/agent/tests/security/test_corpus_eval.py
   ```
2. Verify:
   - $\text{FPR} \le 2.0\%$ (max 10 benign blocks / 500).
   - $\text{TPR} \ge 95.0\%$ (min 190 malicious blocks / 200).
   - Invariant pass rate = 100% ($25/25$).
   - Latency within SC-004 targets ($\le 1\text{ ms}$ warm layer).

#### Step 6: Canary Rollout & Validation
1. Commit the tuned pattern and updated corpus.
2. Promote via canary stage gate (10% $\rightarrow$ 50% $\rightarrow$ 100%) as outlined in [`docs/security/rollout.md`](file:///c:/Booking%20Systems/docs/security/rollout.md).
3. Confirm that Dashboard 1 block rate for the tuned layer stabilizes without dropping detection capabilities.

---

## 4. Pseudonym Retention & Rotation Schedule

### 4.1 Cryptographic Formulation of `subject_ref`

To adhere to data privacy standards (GDPR Article 25 / CCPA) and prevent longitudinal user tracking while enabling same-day incident triage, all user identifiers in telemetry are pseudonymized using HMAC-SHA256:

$$\text{subject\_ref} = \text{"hmac\_sha256:"} \mathbin{\Vert} \text{HMAC-SHA256}\left(K_{\text{rotating}}, \text{user\_id} \mathbin{\Vert} \text{":"} \mathbin{\Vert} \text{epoch\_day}\right)$$

Where:
- $K_{\text{rotating}}$: High-entropy secret key from the secure rotation ring.
- $\text{user\_id}$: Internal user identifier UUID.
- $\text{epoch\_day}$: Integer count of days since Unix epoch ($\lfloor \text{timestamp} / 86400 \rfloor$).
- For guest/unauthenticated sessions: `session_id` replaces `user_id`.

### 4.2 Key Rotation Schedule

```
+-------------------------------------------------------------------------------+
|                       Dual-Key Ring Rotation Timeline                         |
+-------------------------------------------------------------------------------+
| Day N-1: [ K_prev (Grace Window) ]                                            |
| Day N:   [ K_curr (Active Ingress Signing) ]                                  |
| Day N+1: K_curr becomes K_prev; new K_curr generated; old K_prev archived     |
| Day N+30: Master Key Seed Shredded --> Permanent Cryptographic Anonymization  |
+-------------------------------------------------------------------------------+
```

1. **Daily Key Rotation (00:00:00 UTC)**:
   - A new 256-bit cryptographically secure key ($K_{\text{curr}}$) is generated and injected into Redis / Secret Manager daily.
   - The previous day's key is demoted to $K_{\text{prev}}$ and retained for a 24-hour grace window to permit cross-midnight trace resolution.
2. **Unlinkability Guarantee**:
   - Because `epoch_day` changes daily and $K_{\text{rotating}}$ rotates, the same user emits completely different, uncorrelated `subject_ref` values across consecutive days.
   - Attackers or unauthorized log observers cannot construct historical behavioral profiles or link activity across multiple days.

### 4.3 Log Retention & Cryptographic Shredding Policy

1. **30-Day Rolling Audit Retention**:
   - Structured audit log records in `security_audit_log` are retained for exactly **30 calendar days**.
   - Storage buckets enforce automated lifecycle rules that permanently delete log objects older than 30 days.
2. **Cryptographic Shredding**:
   - When rotation keys age past the 30-day retention window, their seeds are permanently purged from the secret manager.
   - Even if cold backups or immutable tape archives exist, historical `subject_ref` values become mathematically irreversible and un-correlatable, providing irreversible cryptographic shredding.

---

## 5. Operational Alert Runbooks

### 5.1 Runbook 1: `InjectionBlockRateSpike` (> 5x baseline)

- **Alert Name**: `InjectionBlockRateSpike`
- **Severity**: **CRITICAL** (P1)
- **Evaluation Rule**:
  ```promql
  sum(rate(security_guardrail_decisions_total{stage="input", layer_key="input.injection", decision="BLOCK"}[5m]))
    >
  5 * sum(rate(security_guardrail_decisions_total{stage="input", layer_key="input.injection", decision="BLOCK"}[7d]))
  ```
- **Description**: Block rate for the prompt injection layer exceeds $5\times$ the 7-day rolling baseline over a 5-minute evaluation window.
- **SLA**: Acknowledge within **5 minutes**; initiate triage within **15 minutes**.

#### Initial Response:
1. Acknowledge the PagerDuty alert.
2. Open Dashboard 1 (Guardrail Decisions) and Dashboard 2 (Latency).
3. Determine if the spike is concentrated on specific endpoints or distributed across all traffic.

#### Root-Cause Triage (Coordinated Attack vs. Benign Surge):

```
                                  [ Injection Spike Alert ]
                                              │
                                              ▼
                             Check subject_ref Distribution
                                              │
                    ┌─────────────────────────┴─────────────────────────┐
                    ▼                                                   ▼
       Highly Clustered (1-5 hashes)                        Broadly Uniform Distribution
                    │                                                   │
                    ▼                                                   ▼
       [ Coordinated Attack ]                               Check Deployment History
                    │                                                   │
        Apply Edge Rate Limits / IP Bans            ┌───────────────────┴───────────────────┐
                                                    ▼                                       ▼
                                          Recent Release (< 2h)                   Traffic Surge (Flash Sale)
                                                    │                                       │
                                                    ▼                                       ▼
                                        [ False Positive Regression ]           [ Legitimate High Load ]
                                                    │                                       │
                                           Revert Guardrail Canary                 Scale Agent Replicas
```

1. **Check `subject_ref` Entropy**:
   - Query the audit log for blocked events in the last 10 minutes.
   - **Clustered Distribution**: If $> 80\%$ of blocks originate from fewer than 5 distinct `subject_ref` pseudonyms, this is a **coordinated automated attack** (botnet or adversarial probe).
   - **Uniform Distribution**: If blocks are distributed uniformly across hundreds of distinct pseudonyms, this indicates a **false positive regression** or a viral benign pattern.
2. **Check Recent Deployments**:
   - Was a new release or guardrail regex update deployed within the last 2 hours?
   - If yes, check for unintended matching of standard travel phrasing (e.g. "ignore previous flight and search for Paris").
3. **Check Legitimate Booking Surges**:
   - Cross-reference with overall flight search throughput in `apps/api`. Is total site traffic up $5\times$ due to an active marketing campaign or airline sale?

#### Mitigation Playbook:

- **Scenario A: Coordinated Adversarial Attack**:
  1. Identify ingress IP ranges or ASN sources via Cloudflare / Edge WAF logs.
  2. Implement an immediate IP ban or Managed Challenge (CAPTCHA) at the WAF edge for the attacking CIDR blocks.
  3. Verify that the agent service remains stable and latency remains within the SC-004 budget ($\le 50\text{ ms}$).

- **Scenario B: False Positive Regression**:
  1. Follow the Emergency Rollback Procedure in [`docs/security/rollout.md`](file:///c:/Booking%20Systems/docs/security/rollout.md):
     - Roll back the canary deployment to the previous stable release.
  2. Alternatively, disable the offending sub-pattern if controlled by dynamic configuration flags.
  3. Initiate the False Positive Triage SOP (Section 3.4).

#### Resolution Checklist:
- [ ] Block rate returns to within $2\times$ rolling baseline.
- [ ] No increase in $FN$ (malicious bypasses).
- [ ] Post-incident summary logged in security ticket with root cause classification.

---

### 5.2 Runbook 2: `GuardrailLatencyP95Breach` (> 50ms compute)

- **Alert Name**: `GuardrailLatencyP95Breach`
- **Severity**: **WARNING** (P2)
- **Evaluation Rule**:
  ```promql
  histogram_quantile(0.95, sum by (le, stage, layer_key) (rate(security_guardrail_latency_ms_bucket[5m]))) > 50
  ```
- **Description**: $p95$ compute latency for a guardrail layer exceeds the 50 ms near-limit compute budget.
- **SLA**: Acknowledge within **15 minutes**; mitigate within **30 minutes**.

#### Initial Response:
1. Open Dashboard 2 (Latency Distributions).
2. Identify the specific `layer_key` causing the breach (e.g. `input.injection`, `tool.size_structure`, or `output.pii`).
3. Check agent pod CPU utilization in container metrics.

#### Root-Cause Triage:
1. **Catastrophic Backtracking (ReDoS)**:
   - Check if an adversary is sending nested strings designed to trigger polynomial or exponential backtracking in regex evaluation.
   - Correlate with input length in recent blocked turns.
2. **Payload Size Anomalies**:
   - Check if the `input.length` layer was bypassed or if payloads close to `MAX_MESSAGE_LENGTH` (4,096 characters) are disproportionately frequent.
3. **Host Resource Starvation**:
   - Check if the host CPU is throttled or noisy neighbors are degrading container performance.

#### Mitigation Playbook:
1. **Immediate Compute Scale-Out**:
   - Scale agent container replicas horizontally to relieve CPU pressure:
     ```bash
     kubectl scale deployment agent-service --replicas=10
     ```
2. **Input Bounding Enforcement**:
   - If oversized inputs are reaching deep regex layers, verify that `input.length` is executing first and rejecting payloads $> 4,096$ characters before regex scanning.
3. **Regex Pattern Optimization**:
   - If ReDoS is confirmed, replace complex regex with atomic grouping or an exact Aho-Corasick automaton.

#### Resolution Checklist:
- [ ] $p95$ latency drops below $10\text{ ms}$ (typical) and $50\text{ ms}$ (near-limit).
- [ ] Verification suite runs clean (`apps/agent/tests/security/test_security_performance.py`).
- [ ] Root-cause pattern added to performance regression test harness.

---

### 5.3 Runbook 3: `TelemetryEmitterDropRateHigh` (> 1% drop rate)

- **Alert Name**: `TelemetryEmitterDropRateHigh`
- **Severity**: **CRITICAL** (P1)
- **Evaluation Rule**:
  ```promql
  (sum(rate(security_emitter_errors_total[5m]))
    /
   (sum(rate(security_guardrail_decisions_total[5m])) + sum(rate(security_emitter_errors_total[5m])))) * 100 > 1.0
  ```
- **Description**: Telemetry event emitter drop rate exceeds 1.0% of total emitted security events over a 5-minute evaluation window.
- **SLA**: Acknowledge within **5 minutes**; initiate recovery within **15 minutes**.

#### Initial Response:
1. Identify the failing sink from the alert labels: `sink="redis"`, `sink="security_audit_log"`, or `sink="prometheus"`.
2. Inspect agent application logs for emitter error details:
   ```bash
   kubectl logs -l app=agent-service --tail=200 | grep "security_emitter_error"
   ```

#### Root-Cause Triage:
1. **Redis Sink Failure (`sink="redis"`)**:
   - Check Redis connectivity, memory usage (`used_memory / maxmemory`), and network latency.
   - Check if Redis connection pool is exhausted (`max_connections` reached).
2. **Audit Log Sink Failure (`sink="security_audit_log"`)**:
   - Check node disk utilization (`df -h`). Is the logging volume full?
   - Check file descriptor limits (`ulimit -n`).
3. **Prometheus Scrape Failure (`sink="prometheus"`)**:
   - Check if the Prometheus server is timing out during scraping of the `/metrics` endpoint.

#### Mitigation Playbook:
1. **Local Ring Buffer Verification**:
   - Ensure the in-memory fallback ring buffer is absorbing events up to its 4,096-event capacity without crashing the process.
2. **Restore Sink Connectivity**:
   - **For Redis**: Restart Redis instance, scale memory, or clear non-essential cache keys:
     ```bash
     docker compose restart redis
     ```
   - **For Audit Log**: Clear rotated log archives or expand persistent volume claims.
3. **Fail-Closed Audit Enforcement**:
   - If corporate compliance mandates 100% audit durability and the local buffer reaches saturation, the service must enter safe fail-closed state (rejecting transactions that cannot be audited).

#### Resolution Checklist:
- [ ] Telemetry emitter drop rate drops to $0.0\%$.
- [ ] Ring buffer drains successfully to restored sink without data loss.
- [ ] Redis and log volume health checks report GREEN.
