# Performance Validation & Resource Benchmark Evidence Report

**Feature**: 023-security-systems  
**Task**: T046 [US5] Resource Validation & Evidence Documentation  
**Status**: Verified & Passing against SC-004 targets  
**Date**: 2026-09-13  
**Harness / Test Driver**: [`apps/agent/tests/security/test_security_performance.py`](file:///c:/Booking%20Systems/apps/agent/tests/security/test_security_performance.py)  
**Authority**: `AGENTS.md`, [`specs/023-security-systems/tasks.md`](file:///c:/Booking%20Systems/specs/023-security-systems/tasks.md), [`specs/023-security-systems/plan.md`](file:///c:/Booking%20Systems/specs/023-security-systems/plan.md), [`contracts/guardrail-boundaries.md`](file:///c:/Booking%20Systems/contracts/guardrail-boundaries.md)

---

## 1. Executive Summary & Provisional SC-004 Targets

This document records empirical, reproducible performance benchmarks for the deterministic guardrail subsystems in [`apps/agent`](file:///c:/Booking%20Systems/apps/agent). All measurements are executed via the dedicated performance test suite [`apps/agent/tests/security/test_security_performance.py`](file:///c:/Booking%20Systems/apps/agent/tests/security/test_security_performance.py) under garbage-collection-isolated benchmark conditions.

The guardrail implementation satisfies all provisional SC-004 latency and resource ceilings:

| Metric Category | Target / Ceiling (p95) | Measured Value (p95) | Status | Margin |
|---|---|---|---|---|
| **Per-Layer Compute (Warm)** | $\le$ 1.0 ms | **0.01 ms – 0.28 ms** | **PASS** | 72.0% – 99.0% margin |
| **Total Turn Compute (Typical)** | $\le$ 10.0 ms | **1.33 ms** (p50: 0.71 ms) | **PASS** | 86.7% margin |
| **Hostile Near-Limit Inputs** | $\le$ 50.0 ms | **5.36 ms – 11.04 ms** | **PASS** | 77.9% – 89.3% margin |
| **Hostile Tool Outputs (451 nodes)** | $\le$ 50.0 ms | **27.41 ms** (p50: 15.57 ms) | **PASS** | 45.2% margin |
| **Excess-Depth Tool Rejection** | $\le$ 10.0 ms | **0.52 ms** | **PASS** | 94.8% margin |
| **Pathological ReDoS Stress** | $\le$ 50.0 ms | **0.85 ms – 6.70 ms** | **PASS** | 86.6% – 98.3% margin |
| **Stream Chunk Fragmentation** | $\le$ 50.0 ms | **7.31 ms** (p50: 3.82 ms) | **PASS** | 85.4% margin |
| **Active Token Compute** | $\le$ 1.0 ms | **0.05 ms** | **PASS** | 95.0% margin |
| **Active Turn Compute (Streaming)**| $\le$ 10.0 ms | **0.83 ms** | **PASS** | 91.7% margin |
| **Holdback Buffer Span** | $\le$ 512 scalars | **1.5 scalars** | **PASS** | 99.7% margin |
| **Peak Memory Growth (50 streams)**| $\le$ 15.0 MiB | **0.141 MiB** (144.23 KiB) | **PASS** | 99.1% margin |
| **Cold Initialization** | < 250.0 ms | **0.23 ms** | **PASS** | 99.9% margin |

---

## 2. Core Invariants

The security performance validation framework adheres to three non-negotiable operational principles:

1. **Zero Customer PII Invariant**:
   All benchmark fixtures utilize strictly synthetic, deterministic mock structures (e.g. `usr-bench-synthetic-999`, synthetic flight identifiers `FL-SYNTH-101`, and synthetic PII formats). Under no circumstances are live production traces, customer PII, or real Dufell/airline credentials ingested or processed.

2. **Metric Integrity (Compute vs. Holdback Wait Separation)**:
   Active guardrail CPU compute latency is strictly separated from streaming buffer holdback wait time. Buffer holdback latency arises from token inter-arrival delays (~20 ms per LLM chunk) while accumulating a safe lookahead inspection window (up to 512 scalars). Attribute holdback delay to provider streaming rate, not guardrail CPU bottleneck.

3. **Strict Algorithmic Threshold Enforcement**:
   **Never silently lower or relax threshold values when benchmarks fail.** Performance regressions indicate algorithmic bottlenecks (e.g. regex backtracking, unpruned recursive tree traversal, or unbounded normalization rounds). Remediate regressions through architectural optimization rather than modifying assertions.

---

## 3. Test Environment & Hardware Specification

Benchmarks were conducted on the reference local execution environment with CPU-bound thread isolation:

- **Operating System**: Windows 11 Pro (`Windows-10-10.0.26200-SP0`)
- **Platform Architecture**: `AMD64` (`x86_64`)
- **Processor**: `AMD64 Family 23 Model 24 Stepping 1, AuthenticAMD` (4 logical cores)
- **Python Runtime**: Python `3.11.15` (CPython, 64-bit)
- **Harness & Tooling**:
  - `pytest` `9.1.1`
  - `pytest-asyncio` `1.4.0` (auto mode)
  - `pluggy` `1.6.0`
  - `pytest-cov` `7.1.0`
- **Measurement Isolation & CI Tolerance**:
  Explicit garbage collection disabling (`gc.disable()`) and pre-measurement forced collection (`gc.collect()`) wrap all timing loops via `_benchmark_isolation()` to eliminate cyclic garbage collector interference during micro-benchmarks. High-resolution timestamps are captured via `time.perf_counter()`. Shared CI environments apply `CI_TOLERANCE = float(os.environ.get("PERF_TOLERANCE", "2.0" if os.environ.get("CI") else "1.0"))` to scale assertions against noisy-neighbor CPU scheduling jitter while preserving strict local performance rigor.

---

## 4. Measured Latency Distributions & Detailed Evidence

### 4.1 Cold vs. Warm Initialization

- **Cold Initialization**:
  Evaluates the cold-start cost of fresh regex compilation across all injection signatures, creation of [`create_production_registry()`](file:///c:/Booking%20Systems/apps/agent/src/agent/guardrails/registry.py), and instantiation of all 9 compulsory layers plus the streaming pipeline.
  - **Cold Init p95**: `0.23 ms` (ceiling < `250.0 ms`)

- **Warm Layer Execution**:
  Measured across 50 iterations with typical travel queries (e.g., *"I need to search for one-way flights from SFO to JFK on 2026-10-15 for 1 passenger in economy class"*):

| Layer Key | Family | p50 (ms) | p95 (ms) | p99 (ms) | Target p95 | Status |
|---|---|---|---|---|---|---|
| `input.length` | Input Validation | 0.02 | **0.05** | 0.08 | $\le$ 1.0 ms | **PASS** |
| `input.pii` | Input Validation | 0.04 | **0.07** | 0.79 | $\le$ 1.0 ms | **PASS** |
| `input.injection` | Input Validation | 0.19 | **0.28** | 0.30 | $\le$ 1.0 ms | **PASS** |
| `input.topic` | Input Validation | 0.04 | **0.05** | 0.14 | $\le$ 1.0 ms | **PASS** |
| `tool.pii` | Tool Output | 0.03 | **0.05** | 0.06 | $\le$ 1.0 ms | **PASS** |
| `tool.schema` | Tool Output | 0.03 | **0.08** | 0.10 | $\le$ 1.0 ms | **PASS** |
| `tool.size_structure` | Tool Output | 0.03 | **0.05** | 0.13 | $\le$ 1.0 ms | **PASS** |
| `tool.untrusted_content_injection` | Tool Output | 0.01 | **0.01** | 0.01 | $\le$ 1.0 ms | **PASS** |

- **Total Turn Compute (Warm)**:
  - **p50**: `0.71 ms`
  - **p95**: `1.33 ms` (target $\le$ `10.0 ms`)
  - **p99**: `2.96 ms`

---

### 4.2 Hostile & Near-Limit Input Payloads

Evaluates inputs operating right at or above the 8 KiB / 4,000 character limits, featuring intensive normalization, multi-byte sequences, and homoglyphs:

| Stress Fixture | Description / Character Count | Byte Size | p50 (ms) | p95 (ms) | p99 (ms) | Target p95 | Status |
|---|---|---|---|---|---|---|---|
| **CJK Sequences** | 2,800 CJK characters (`北京` $\times$ 1400) | 8,400 bytes | 7.35 | **11.04** | 11.38 | $\le$ 50.0 ms | **PASS** |
| **Cyrillic Homoglyphs** | 2,800 Cyrillic characters mapping to Latin | 5,600 bytes | 5.03 | **8.25** | 8.54 | $\le$ 50.0 ms | **PASS** |
| **Combining Diacritics** | 1,500 grave accented characters (`e\u0300`) | 3,000 bytes | 3.08 | **5.36** | 5.86 | $\le$ 50.0 ms | **PASS** |
| **Exact 8 KiB Boundary** | 2,730 CJK chars (8,190 B) + 2 ASCII chars | 8,192 bytes | 6.25 | **9.52** | 9.72 | $\le$ 50.0 ms | **PASS** |

All near-limit inputs complete well within the 50 ms budget without exceeding memory or recursion limits.

#### Exact Production Limit Boundaries (Character & Byte Validation)

Evaluates exact boundary transitions on [`LengthValidator`](file:///c:/Booking%20Systems/apps/agent/src/agent/guardrails/layers/input.py):

| Boundary Condition | Tested Payload Boundary | Expected Decision | Response Key | Measured p95 (ms) | Target p95 | Status |
|---|---|---|---|---|---|---|
| **Character Under Limit** | 3,999 ASCII characters | `PASS` | N/A | **0.037** | $\le$ 1.0 ms | **PASS** |
| **Character At Limit** | 4,000 ASCII characters | `PASS` | N/A | **0.020** | $\le$ 1.0 ms | **PASS** |
| **Character Over Limit** | 4,001 ASCII characters | `BLOCK` | `GUARDRAIL_INPUT_LENGTH` | **0.015** | $\le$ 1.0 ms | **PASS** |
| **Byte Under Limit** | 16,383 UTF-8 bytes | `PASS` | N/A | **0.022** | $\le$ 1.0 ms | **PASS** |
| **Byte At Limit** | 16,384 UTF-8 bytes | `PASS` | N/A | **0.020** | $\le$ 1.0 ms | **PASS** |
| **Byte Over Limit** | 16,385 UTF-8 bytes | `BLOCK` | `GUARDRAIL_INPUT_LENGTH` | **0.018** | $\le$ 1.0 ms | **PASS** |

---

### 4.3 Hostile & Near-Limit Tool Output Payloads

Evaluates complex JSON data structures emitted by backend tools (e.g. flight search results with multi-hop itineraries):

- **Near-Limit Valid Payload (45 Flight Offers)**:
  - Total structural nodes: **451 nodes** (45 items $\times$ 9 keys + 45 list items + root), nesting depth: 5 levels.
  - **p50**: `15.57 ms`
  - **p95**: `27.41 ms` (ceiling $\le$ `50.0 ms`)
  - **p99**: `34.23 ms`
  - **Decision**: `PASS`

- **Fast Fail-Closed Rejection on Excessive Depth**:
  - Payload exceeds depth ceiling (7 levels of nested dictionaries vs. maximum allowed 5).
  - Fast fail-closed rejection at [`SizeStructureValidator`](file:///c:/Booking%20Systems/apps/agent/src/agent/guardrails/layers/tool_output.py):
  - **p50**: `0.11 ms`
  - **p95**: `0.52 ms` (ceiling $\le$ `10.0 ms`)
  - **p99**: `0.52 ms`
  - **Decision**: `BLOCK` (`GUARDRAIL_TOOL_SIZE_STRUCTURE`)

---

### 4.4 Pathological Regex & ReDoS Resistance

Validates static ReDoS detection and backtracking resilience against 10,000-character repetitive sequences:

- **Static AST Pattern ReDoS Detection**:
  [`is_catastrophic_regex()`](file:///c:/Booking%20Systems/apps/agent/src/agent/guardrails/normalization.py) correctly flags known vulnerable patterns before execution:
  - `(a+)+$` $\rightarrow$ Flagged & Rejected
  - `(a|a)+$` $\rightarrow$ Flagged & Rejected
  - `(.*a){10}` $\rightarrow$ Flagged & Rejected
  - `(a+)*b` $\rightarrow$ Flagged & Rejected

- **Repetitive Stress Benchmarks across Compiled PII Regexes (10,000 chars)**:
  Input strings containing 10k spaces, 10k `A`s, 10k digit/space patterns, and repeated `api_key=` prefixes were passed to [`safe_regex_match()`](file:///c:/Booking%20Systems/apps/agent/src/agent/guardrails/normalization.py):

| Pattern Name | Tested Entity | p50 (ms) | p95 (ms) | p99 (ms) | Target p95 | Status |
|---|---|---|---|---|---|---|
| `passport` | Passport numbers | 0.56 | **0.85** | 0.87 | $\le$ 50.0 ms | **PASS** |
| `credential` | API Keys / Bearer Tokens | 1.46 | **1.60** | 1.61 | $\le$ 50.0 ms | **PASS** |
| `card` | Credit Card numbers (Luhn candidate) | 1.18 | **3.48** | 3.80 | $\le$ 50.0 ms | **PASS** |
| `phone` | International Phone numbers | 1.22 | **1.61** | 1.65 | $\le$ 50.0 ms | **PASS** |
| `email` | RFC 5322 Email addresses | 2.94 | **6.70** | 6.90 | $\le$ 50.0 ms | **PASS** |

Zero catastrophic backtracking or exponential time complexity observed.

---

### 4.5 Stream Chunk Fragmentation Stress

Simulates extreme network fragmentation by splitting multilingual text (CJK, Cyrillic, accented characters, and diacritics) into **158 individual 1-character token chunks**, preceded by 1 warmup iteration:

- **Chunk Count**: 158 tokens
- **Integrity Assertion**: `reconstructed == synthetic_stream_text` $\rightarrow$ **100% Match** (Zero dropped, corrupted, or reordered characters).
- **Latency Distribution**:
  - **p50**: `3.82 ms`
  - **p95**: `7.31 ms` (ceiling $\le$ `50.0 ms`)
  - **p99**: `7.87 ms`
- **Result**: **PASS**

---

### 4.6 Metric Decomposition: Active Compute vs. Buffer Holdback Wait

Separates CPU work from buffering delays across 25 benchmark turns (20 streaming tokens per turn):

#### Active Guardrail CPU Compute
- **Per-Token Compute**:
  - **p50**: `0.03 ms`
  - **p95**: `0.05 ms` (target $\le$ `1.0 ms`)
  - **p99**: `0.09 ms`
- **Total Turn Active Compute**:
  - **p50**: `0.54 ms`
  - **p95**: `0.83 ms` (target $\le$ `10.0 ms`)
  - **p99**: `1.27 ms`

#### Streaming Buffer Holdback Metrics
- **Holdback Inspection Span**:
  - **p50**: `0.0 scalars`
  - **p95**: `1.5 scalars` (bounded strictly to $\le$ `512 scalars`)
  - **p99**: `11.0 scalars`
- **Buffering Holdback Wait Time**:
  - **p50**: `0.0 ms`
  - **p95**: `20.0 ms` (correlated exactly to simulated 20 ms token delivery interval)
  - **p99**: `20.0 ms`

This demonstrates that active guardrail evaluation overhead per token is negligible (< 0.1 ms), with stream pacing dominated entirely by token generation speed.

---

### 4.7 Memory Growth & Concurrency Stress

Evaluates memory stability and concurrent execution across **50 simultaneous streams** via `asyncio.gather()`:

- **Concurrent Streams**: 50
- **Total Concurrency Duration**: `148.5 ms`
- **Effective Throughput**: **336.7 streams/sec**
- **Stream Latency Distribution**:
  - **p50**: `137.09 ms`
  - **p95**: `142.38 ms`
  - **p99**: `142.72 ms`
- **Memory Measurements (`tracemalloc`)**:
  - Baseline Memory: `0.00 KiB`
  - Peak Memory: `144.23 KiB`
  - **Peak Memory Delta**: **144.23 KiB** (`0.141 MiB`)
  - **Memory Ceiling**: $\le$ `15.0 MiB`
  - **Status**: **PASS** (Utilizes < 1% of allowable memory headroom)
- **Integrity**: 50/50 streams completed with exact output equality and zero leaked state.

---

## 5. Algorithmic Optimization & Bottleneck Prevention Architecture

The following engineering decisions maintain sub-millisecond execution speeds under load:

1. **Pre-Compiled Immutable Signatures**:
   All injection signatures and PII regular expressions are compiled at module load time into immutable tuples. No dynamic `re.compile()` occurs during request processing.
2. **Depth-First Short-Circuit Tree Traversal**:
   [`SizeStructureValidator`](file:///c:/Booking%20Systems/apps/agent/src/agent/guardrails/layers/tool_output.py) performs stack-based depth checks with immediate termination as soon as current depth exceeds 5, bypassing recursive object traversal for hostile payloads.
3. **Linear Unicode Normalization with Round Limits**:
   Normalizers enforce a strict maximum round counter (`MAX_NORMALIZATION_ROUNDS = 2`) and character count limits, preventing quadratic homoglyph expansion attacks.
4. **Sliding Scalar Ring Buffer**:
   [`ChunkBuffer`](file:///c:/Booking%20Systems/apps/agent/src/agent/streaming/chunk_buffer.py) operates with a bounded 512-scalar sliding window. Confirmed safe text preceding the holdback window is flushed immediately to downstream SSE clients.
5. **ASCII Fast-Path Ring Mapping**:
   [`ChunkBuffer._rebuild_mapping`](file:///c:/Booking%20Systems/apps/agent/src/agent/streaming/chunk_buffer.py) evaluates `raw.isascii()` to perform $O(1)$ range mapping, eliminating $O(N^2)$ repetitive `unicodedata.normalize` calls during 1-character token streaming.
6. **Direct Unicode-Compiled Combined Regex Engine**:
   [`InjectionSignatureEngine`](file:///c:/Booking%20Systems/apps/agent/src/agent/guardrails/layers/injection.py) compiles all 50+ signatures into a single ReDoS-safe combined regex with `re.IGNORECASE` (Unicode matching), scanning candidates directly to eliminate keyword pre-filter false negatives while ensuring Unicode whitespace separators (e.g. U+2028, U+2029) are recognized by `\s+`.

---

## 6. Verification Command

To reproduce this benchmark report locally from the repository root:

```powershell
$env:UV_CACHE_DIR = 'C:\Booking Systems\.t093-uv-cache'
$env:PYTHONPATH = "$PWD\tests\ci\python;$PWD\apps\agent\src"
uv run --package agent pytest apps/agent/tests/security/test_security_performance.py -s -v
```

**Observed Result**:
`7 passed in 2.92s` (Exit code `0`).
