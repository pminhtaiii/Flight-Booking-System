import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeCanonicalHash,
  loadCorpusJsonl,
  normalizePayload,
  validateCorpus,
} from '../../scripts/security/validate-corpus.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..');
const schemaPath = resolve(repoRoot, 'tests/security/corpus/schema.json');
const validatorCliPath = resolve(repoRoot, 'scripts/security/validate-corpus.mjs');

function createSampleRecord(overrides = {}) {
  const payload = overrides.payload ?? 'Find flights from SFO to JFK on October 10';
  const canonicalHash = computeCanonicalHash(payload);

  const base = {
    id: 'inp-ben-travel-0001',
    suiteKind: 'detector',
    expectedStage: 'input',
    expectedLayerFamily: 'topic',
    taxonomyCode: 'LLM01',
    label: 'benign',
    payload,
    canonicalHash,
    variantGroup: 'vg-travel-001',
    split: 'holdout',
    fixture: {
      carrier: 'direct_input',
      authProfile: 'authenticated_user',
      mockToolResponse: null,
    },
    oracle: {
      expectedDecision: 'PASS',
      expectedErrorCode: null,
      reachedStageMarker: 'marker-inp-ben-travel-0001',
    },
    provenance: {
      source: 'synthetic-feature-023',
      license: 'MIT',
      revision: 'git:a1b2c3d4',
      curatedBy: 'Security Team',
      curatedAt: '2026-09-04T00:00:00Z',
    },
  };

  return {
    ...base,
    ...overrides,
    fixture: { ...base.fixture, ...(overrides.fixture || {}) },
    oracle: { ...base.oracle, ...(overrides.oracle || {}) },
    provenance: { ...base.provenance, ...(overrides.provenance || {}) },
  };
}

test('corpus schema file exists and is valid JSON', () => {
  assert.ok(existsSync(schemaPath), 'schema.json must exist');
  const raw = readFileSync(schemaPath, 'utf8');
  const schema = JSON.parse(raw);
  assert.ok(schema.$schema, 'schema must have $schema');
  assert.equal(schema.type, 'object');
  assert.ok(Array.isArray(schema.required));
});

test('normalization and canonical hash', async (t) => {
  await t.test('normalizes NFKC, whitespace, and lowercases', () => {
    // \uFB01 is 'fi' ligature in NFKC -> 'fi'
    const raw = '  \uFB01nd   FLIGHTS   from  SFO\t\nto JFK \n ';
    const normalized = normalizePayload(raw);
    assert.equal(normalized, 'find flights from sfo to jfk');
  });

  await t.test('computes deterministic sha256 of normalized text', () => {
    const raw1 = '  Ignore Previous Instructions  ';
    const raw2 = 'ignore   previous instructions';
    const hash1 = computeCanonicalHash(raw1);
    const hash2 = computeCanonicalHash(raw2);
    assert.equal(hash1, hash2);
    assert.match(hash1, /^[a-f0-9]{64}$/);
  });
});

test('schema validation and record constraints', async (t) => {
  await t.test('valid sample record passes validation without quotas requirement', () => {
    const record = createSampleRecord();
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, true, `Validation failed: ${result.errors.join(', ')}`);
    assert.equal(result.errors.length, 0);
  });

  await t.test('missing required top-level property fails', () => {
    const record = createSampleRecord();
    delete record.taxonomyCode;
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('taxonomyCode')));
  });

  await t.test('invalid enum for suiteKind fails', () => {
    const record = createSampleRecord({ suiteKind: 'unsupported_suite' });
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('suiteKind')));
  });

  await t.test('invalid enum for expectedStage fails', () => {
    const record = createSampleRecord({ expectedStage: 'network' });
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('expectedStage')));
  });

  await t.test('invalid enum for label fails', () => {
    const record = createSampleRecord({ label: 'uncertain' });
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('label')));
  });

  await t.test('invalid enum for split fails', () => {
    const record = createSampleRecord({ split: 'staging' });
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('split')));
  });

  await t.test('missing nested fixture properties fail', () => {
    const record = createSampleRecord();
    delete record.fixture.carrier;
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('carrier')));
  });

  await t.test('missing nested provenance license fails', () => {
    const record = createSampleRecord();
    delete record.provenance.license;
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('license')));
  });

  await t.test('missing nested provenance source fails', () => {
    const record = createSampleRecord();
    delete record.provenance.source;
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('source')));
  });

  await t.test('missing nested provenance revision fails', () => {
    const record = createSampleRecord();
    delete record.provenance.revision;
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('revision')));
  });

  await t.test('disallowed additional properties fail schema check', () => {
    const record = createSampleRecord({ extraUnapprovedField: 'not allowed' });
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Disallowed property')));
  });
});

test('loadCorpusJsonl file loader', async (t) => {
  await t.test('throws error when file does not exist', () => {
    assert.throws(
      () => loadCorpusJsonl(resolve(repoRoot, 'non-existent-corpus.jsonl')),
      /Corpus file does not exist/,
    );
  });

  await t.test('throws error when line is invalid JSON', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'corpus-test-corrupt-'));
    try {
      const corruptFile = join(tempDir, 'corrupt.jsonl');
      writeFileSync(corruptFile, '{ "id": "valid" }\n{ invalid json line }\n');
      assert.throws(
        () => loadCorpusJsonl(corruptFile),
        /Invalid JSON on line 2/,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test('hash and deduplication validation', async (t) => {
  await t.test('hash mismatch fails validation', () => {
    const record = createSampleRecord({
      canonicalHash: '0000000000000000000000000000000000000000000000000000000000000000',
    });
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.toLowerCase().includes('hash')));
  });

  await t.test('duplicate record IDs fail validation', () => {
    const rec1 = createSampleRecord({ id: 'rec-001', payload: 'Payload 1' });
    const rec2 = createSampleRecord({ id: 'rec-001', payload: 'Payload 2' });
    const result = validateCorpus([rec1, rec2], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.toLowerCase().includes('duplicate id')));
  });

  await t.test('duplicate normalized payload fails validation even with different raw formatting', () => {
    const rec1 = createSampleRecord({ id: 'rec-001', payload: 'Book flight to LAX' });
    const rec2 = createSampleRecord({ id: 'rec-002', payload: '  book  FLIGHT   to lax  ' });
    const result = validateCorpus([rec1, rec2], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(
        (e) => e.toLowerCase().includes('duplicate') && e.toLowerCase().includes('payload'),
      ),
    );
  });
});

test('cross-split variant group contamination fails', () => {
  const rec1 = createSampleRecord({
    id: 'rec-001',
    payload: 'Payload in holdout',
    split: 'holdout',
    variantGroup: 'vg-attack-family-a',
  });
  const rec2 = createSampleRecord({
    id: 'rec-002',
    payload: 'Payload in development',
    split: 'development',
    variantGroup: 'vg-attack-family-a',
  });
  const result = validateCorpus([rec1, rec2], { requireHoldoutQuotas: false });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some(
      (e) => e.includes('variantGroup') || e.includes('vg-attack-family-a') || e.includes('split'),
    ),
  );
});

test('holdout quotas and empty stage denominator enforcement', async (t) => {
  await t.test('under-allocated holdout quotas fail validation', () => {
    // Only 1 record, but holdout requires >= 200 malicious and >= 500 benign
    const rec = createSampleRecord({ split: 'holdout', suiteKind: 'detector' });
    const result = validateCorpus([rec], { requireHoldoutQuotas: true });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.toLowerCase().includes('quota')));
  });

  await t.test('empty stage denominator fails validation', () => {
    // Build a mock collection that meets total counts but omits tool stage
    const records = [];
    let idCounter = 1;

    // 100 input malicious, 250 input benign
    for (let i = 0; i < 100; i++) {
      records.push(
        createSampleRecord({
          id: `inp-mal-${idCounter++}`,
          expectedStage: 'input',
          label: 'malicious',
          payload: `Malicious input probe ${i}`,
          variantGroup: `vg-inp-mal-${i}`,
          oracle: { expectedDecision: 'BLOCK', expectedErrorCode: 'GUARDRAIL_BLOCKED', reachedStageMarker: `m-${idCounter}` },
        }),
      );
    }
    for (let i = 0; i < 250; i++) {
      records.push(
        createSampleRecord({
          id: `inp-ben-${idCounter++}`,
          expectedStage: 'input',
          label: 'benign',
          payload: `Benign input probe ${i}`,
          variantGroup: `vg-inp-ben-${i}`,
        }),
      );
    }
    // 100 output malicious, 250 output benign (tool stage has 0 cases)
    for (let i = 0; i < 100; i++) {
      records.push(
        createSampleRecord({
          id: `out-mal-${idCounter++}`,
          expectedStage: 'output',
          label: 'malicious',
          payload: `Malicious output probe ${i}`,
          variantGroup: `vg-out-mal-${i}`,
          oracle: { expectedDecision: 'BLOCK', expectedErrorCode: 'OUTPUT_GUARDRAIL_BLOCKED', reachedStageMarker: `m-${idCounter}` },
        }),
      );
    }
    for (let i = 0; i < 250; i++) {
      records.push(
        createSampleRecord({
          id: `out-ben-${idCounter++}`,
          expectedStage: 'output',
          label: 'benign',
          payload: `Benign output probe ${i}`,
          variantGroup: `vg-out-ben-${i}`,
        }),
      );
    }

    const result = validateCorpus(records, { requireHoldoutQuotas: true });
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some(
        (e) => e.toLowerCase().includes('tool') || e.toLowerCase().includes('denominator') || e.toLowerCase().includes('quota'),
      ),
    );
  });
});

test('invariant suite segregation', () => {
  const invRecord = createSampleRecord({
    id: 'inv-auth-001',
    suiteKind: 'invariant',
    split: 'invariant',
    expectedStage: 'input',
    expectedLayerFamily: 'authorization',
    payload: 'Attempt access without AGENT_SERVICE_API_KEY',
    oracle: {
      expectedDecision: 'BLOCK',
      expectedErrorCode: 'AUTH_REQUIRED',
      reachedStageMarker: 'marker-inv-auth-001',
    },
  });

  const result = validateCorpus([invRecord], { requireHoldoutQuotas: false });
  assert.equal(result.valid, true, `Invariant failed validation: ${result.errors.join(', ')}`);
  assert.equal(result.stats.invariants.total, 1);
  assert.equal(result.stats.detectors.total, 0);
});

test('CLI validation execution via spawnSync', async (t) => {
  await t.test('CLI succeeds with exit code 0 against repo corpus directory', () => {
    const proc = spawnSync('node', [validatorCliPath], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(
      proc.status,
      0,
      `CLI failed with status ${proc.status}:\nSTDOUT: ${proc.stdout}\nSTDERR: ${proc.stderr}`,
    );
    assert.match(proc.stdout, /corpus validation passed/i);
  });

  await t.test('CLI exits with code 1 when given invalid corpus directory', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'corpus-test-invalid-'));
    try {
      const invalidRecord = createSampleRecord({ id: 'bad-rec', suiteKind: 'invalid_kind' });
      writeFileSync(join(tempDir, 'holdout.jsonl'), JSON.stringify(invalidRecord) + '\n');

      const proc = spawnSync('node', [validatorCliPath, tempDir], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(proc.status, 1, `Expected exit code 1, got ${proc.status}`);
      const output = `${proc.stdout}\n${proc.stderr}`;
      assert.match(output, /error|invalid|failed/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
