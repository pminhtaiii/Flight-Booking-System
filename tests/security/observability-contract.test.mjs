import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONTRACT_PATH = resolve(__dirname, 'observability-contract.json');
assert.ok(existsSync(CONTRACT_PATH), 'observability-contract.json must exist');
const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));

test('observability contract exists and is valid JSON', () => {
  assert.equal(contract.version, '2026-09-13');
  assert.equal(contract.$schema, 'https://json-schema.org/draft/2020-12/schema');
});

test('defines required metrics with strict bounded labels and buckets', () => {
  const metrics = contract.metrics;
  assert.ok(metrics, 'metrics section required');

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

  assert.ok(metrics.security_emitter_errors_total);
  assert.equal(metrics.security_emitter_errors_total.type, 'counter');
  assert.deepEqual(
    metrics.security_emitter_errors_total.labels.slice().sort(),
    ['error_type', 'sink'].sort()
  );
});

test('enforces zero dynamic user payload / high-cardinality label invariants', () => {
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
  const schema = contract.event_schema;
  assert.ok(schema, 'event_schema required');
  assert.ok(Array.isArray(schema.oneOf), 'event_schema must use oneOf');
  assert.equal(schema.oneOf.length, 2);

  const evalSchema = schema.oneOf.find(
    (branch) => branch.properties?.event_type?.enum?.includes('security_guardrail_eval')
  );
  const errorSchema = schema.oneOf.find(
    (branch) => branch.properties?.event_type?.enum?.includes('security_emitter_error')
  );

  assert.ok(evalSchema, 'must define security_guardrail_eval branch');
  assert.ok(errorSchema, 'must define security_emitter_error branch');

  assert.equal(evalSchema.type, 'object');
  assert.equal(evalSchema.additionalProperties, false);
  const requiredEvalFields = [
    'event_type',
    'timestamp_utc',
    'trace_id',
    'subject_ref',
    'stage',
    'layer_key',
    'decision',
    'latency_ms'
  ];
  for (const field of requiredEvalFields) {
    assert.ok(evalSchema.required.includes(field), `evalSchema must require ${field}`);
  }
  assert.deepEqual(evalSchema.properties.event_type.enum, ['security_guardrail_eval']);
  assert.equal(evalSchema.properties.subject_ref.pattern, '^hmac_sha256:[a-f0-9]{64}$');
  assert.deepEqual(evalSchema.properties.stage.enum, ['input', 'tool', 'output']);
  assert.deepEqual(evalSchema.properties.decision.enum, ['PASS', 'BLOCK', 'SKIP']);
  assert.equal(evalSchema.properties.latency_ms.minimum, 0);

  assert.equal(errorSchema.type, 'object');
  assert.equal(errorSchema.additionalProperties, false);
  const requiredErrorFields = [
    'event_type',
    'timestamp_utc',
    'trace_id',
    'sink',
    'error_type'
  ];
  for (const field of requiredErrorFields) {
    assert.ok(errorSchema.required.includes(field), `errorSchema must require ${field}`);
  }
  assert.deepEqual(errorSchema.properties.event_type.enum, ['security_emitter_error']);
  assert.deepEqual(errorSchema.properties.sink.enum, ['security_audit_log', 'prometheus', 'redis']);
  assert.equal(errorSchema.properties.details.type, 'string');

  const forbiddenProperties = ['prompt', 'payload', 'message', 'token', 'user_id', 'content'];
  for (const prop of forbiddenProperties) {
    assert.equal(evalSchema.properties[prop], undefined);
    assert.equal(errorSchema.properties[prop], undefined);
  }
});

test('defines required alert rules with operational thresholds', () => {
  const alerts = contract.alert_rules;
  assert.ok(alerts, 'alert_rules section required');

  assert.ok(alerts.InjectionBlockRateSpike);
  assert.equal(alerts.InjectionBlockRateSpike.severity, 'critical');
  assert.equal(alerts.InjectionBlockRateSpike.condition.threshold_multiplier, 5);
  assert.equal(alerts.InjectionBlockRateSpike.condition.baseline_window, '7d');
  assert.equal(alerts.InjectionBlockRateSpike.condition.evaluation_window, '5m');

  assert.ok(alerts.GuardrailLatencyP95Breach);
  assert.equal(alerts.GuardrailLatencyP95Breach.severity, 'warning');
  assert.equal(alerts.GuardrailLatencyP95Breach.condition.percentile, 95);
  assert.equal(alerts.GuardrailLatencyP95Breach.condition.threshold_ms, 50);
  assert.equal(alerts.GuardrailLatencyP95Breach.condition.evaluation_window, '5m');

  assert.ok(alerts.TelemetryEmitterDropRateHigh);
  assert.equal(alerts.TelemetryEmitterDropRateHigh.severity, 'critical');
  assert.equal(alerts.TelemetryEmitterDropRateHigh.condition.threshold_percent, 1.0);
  assert.equal(alerts.TelemetryEmitterDropRateHigh.condition.denominator_metric, 'security_guardrail_decisions_total');
  assert.equal(alerts.TelemetryEmitterDropRateHigh.condition.evaluation_window, '5m');
  assert.ok(alerts.TelemetryEmitterDropRateHigh.condition.formula.includes('security_emitter_errors_total'));
  assert.ok(alerts.TelemetryEmitterDropRateHigh.condition.formula.includes('security_guardrail_decisions_total'));
});
