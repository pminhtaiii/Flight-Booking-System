import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONTRACT_PATH = resolve(__dirname, 'observability-contract.json');

test('observability contract exists and is valid JSON', () => {
  assert.ok(existsSync(CONTRACT_PATH), 'observability-contract.json must exist');
  const raw = readFileSync(CONTRACT_PATH, 'utf8');
  const contract = JSON.parse(raw);
  assert.equal(contract.version, '2026-09-13');
});

test('defines required metrics with strict bounded labels and buckets', () => {
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
  const metrics = contract.metrics;
  assert.ok(metrics, 'metrics section required');

  // 1. Decisions counter
  assert.ok(metrics.security_guardrail_decisions_total);
  assert.equal(metrics.security_guardrail_decisions_total.type, 'counter');
  assert.deepEqual(
    metrics.security_guardrail_decisions_total.labels.slice().sort(),
    ['decision', 'layer_key', 'stage'].sort()
  );
  assert.deepEqual(
    metrics.security_guardrail_decisions_total.allowed_stages.slice().sort(),
    ['input', 'tool', 'output'].sort()
  );
  assert.deepEqual(
    metrics.security_guardrail_decisions_total.allowed_decisions.slice().sort(),
    ['BLOCK', 'PASS', 'SKIP'].sort()
  );

  // 2. Latency histogram
  assert.ok(metrics.security_guardrail_latency_ms);
  assert.equal(metrics.security_guardrail_latency_ms.type, 'histogram');
  assert.deepEqual(
    metrics.security_guardrail_latency_ms.labels.slice().sort(),
    ['layer_key', 'stage'].sort()
  );
  assert.ok(Array.isArray(metrics.security_guardrail_latency_ms.buckets));
  assert.deepEqual(
    metrics.security_guardrail_latency_ms.buckets,
    [0.5, 1, 2, 5, 10, 25, 50, 100, 250]
  );

  // 3. Emitter errors counter
  assert.ok(metrics.security_emitter_errors_total);
  assert.equal(metrics.security_emitter_errors_total.type, 'counter');
  assert.deepEqual(
    metrics.security_emitter_errors_total.labels.slice().sort(),
    ['error_type', 'sink'].sort()
  );
});

test('enforces zero dynamic user payload / high-cardinality label invariants', () => {
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
  const forbidden = contract.label_constraints.forbidden_dynamic_labels;
  assert.ok(Array.isArray(forbidden), 'forbidden labels must be an array');
  const requiredForbidden = [
    'user_id',
    'userId',
    'prompt',
    'message',
    'content',
    'session_id',
    'sessionId',
    'token',
    'payload',
    'email',
    'ip_address'
  ];
  for (const label of requiredForbidden) {
    assert.ok(forbidden.includes(label), `Must forbid ${label} from metric labels`);
  }
  assert.ok(contract.label_constraints.max_label_cardinality <= 10);
  assert.equal(contract.label_constraints.disallow_arbitrary_labels, true);
});

test('defines strict event schema with pseudonymized subject ref and zero raw payloads', () => {
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
  const schema = contract.event_schema;
  assert.ok(schema, 'event_schema required');
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);

  const requiredFields = [
    'event_type',
    'timestamp_utc',
    'trace_id',
    'subject_ref',
    'stage',
    'layer_key',
    'decision',
    'latency_ms'
  ];
  for (const field of requiredFields) {
    assert.ok(schema.required.includes(field), `event_schema must require ${field}`);
  }

  assert.equal(
    schema.properties.subject_ref.pattern,
    '^hmac_sha256:[a-f0-9]{64}$'
  );

  // Assert forbidden payload fields are not allowed in schema properties
  const forbiddenProperties = ['prompt', 'payload', 'message', 'token', 'user_id', 'content'];
  for (const prop of forbiddenProperties) {
    assert.equal(
      schema.properties[prop],
      undefined,
      `event_schema must not define raw property ${prop}`
    );
  }
});

test('defines required alert rules with operational thresholds', () => {
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
  const alerts = contract.alert_rules;
  assert.ok(alerts, 'alert_rules section required');

  // Injection spike alert
  assert.ok(alerts.InjectionBlockRateSpike);
  assert.equal(alerts.InjectionBlockRateSpike.condition.threshold_multiplier, 5);

  // Latency breach alert
  assert.ok(alerts.GuardrailLatencyP95Breach);
  assert.equal(alerts.GuardrailLatencyP95Breach.condition.threshold_ms, 50);

  // Emitter drop alert
  assert.ok(alerts.TelemetryEmitterDropRateHigh);
  assert.equal(alerts.TelemetryEmitterDropRateHigh.condition.threshold_percent, 1.0);
});
