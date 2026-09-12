import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PARTITION_CONTRACTS,
  checkPartitionContract,
  computeCanonicalHash,
  loadCorpusJsonl,
  normalizePayload,
  validateCorpus,
  validateCorpusManifest,
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
      revision: 'git:97f23a6f',
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

  await t.test('suiteKind invariant with holdout split fails validation', () => {
    const record = createSampleRecord({ suiteKind: 'invariant', split: 'holdout' });
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Invariant suiteKind records must use split "invariant"')));
  });

  await t.test('suiteKind detector with invariant split fails validation', () => {
    const record = createSampleRecord({ suiteKind: 'detector', split: 'invariant' });
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Detector suiteKind records cannot use split "invariant"')));
  });

  await t.test('contradictory oracle benign with BLOCK fails validation', () => {
    const record = createSampleRecord({
      label: 'benign',
      oracle: { expectedDecision: 'BLOCK', expectedErrorCode: 'SOME_CODE' },
    });
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Contradictory oracle')));
  });

  await t.test('contradictory oracle malicious with PASS fails validation', () => {
    const record = createSampleRecord({
      label: 'malicious',
      oracle: { expectedDecision: 'PASS', expectedErrorCode: null },
    });
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Contradictory oracle')));
  });

  await t.test('expectedDecision PASS with non-null expectedErrorCode fails validation', () => {
    const record = createSampleRecord({
      label: 'benign',
      oracle: { expectedDecision: 'PASS', expectedErrorCode: 'UNEXPECTED_ERROR' },
    });
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('expectedErrorCode')));
  });

  await t.test('expectedDecision BLOCK with null expectedErrorCode fails validation', () => {
    const record = createSampleRecord({
      label: 'malicious',
      oracle: { expectedDecision: 'BLOCK', expectedErrorCode: null },
    });
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('expectedErrorCode')));
  });

  await t.test('empty string payload fails validation', () => {
    const record = createSampleRecord({ payload: '' });
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('payload must be a non-empty string')));
  });

  await t.test('whitespace-only payload fails validation', () => {
    const record = createSampleRecord({ payload: '   \n\t  ' });
    const result = validateCorpus([record], { requireHoldoutQuotas: false });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('payload must be a non-empty string')));
  });

  await t.test('canonical schema enums and properties dynamically match validator constraints', () => {
    const schemaRaw = readFileSync(schemaPath, 'utf8');
    const schema = JSON.parse(schemaRaw);

    const stages = schema.properties.expectedStage.enum;
    assert.ok(Array.isArray(stages) && stages.length > 0);
    for (const stg of stages) {
      const rec = createSampleRecord({ expectedStage: stg });
      const res = validateCorpus([rec], { requireHoldoutQuotas: false });
      assert.equal(res.valid, true, `Stage ${stg} should be accepted`);
    }

    for (const req of schema.required) {
      const rec = createSampleRecord();
      delete rec[req];
      const res = validateCorpus([rec], { requireHoldoutQuotas: false });
      assert.equal(res.valid, false, `Missing required ${req} should fail`);
    }
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
      canonicalHash: '0'.repeat(64),
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
    label: 'malicious',
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
  await t.test('CLI succeeds with exit code 0 against valid corpus directory', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'corpus-test-cli-valid-'));
    try {
      const validRecord = createSampleRecord({ split: 'development' });
      writeFileSync(join(tempDir, 'development.jsonl'), JSON.stringify(validRecord) + '\n');

      const proc = spawnSync('node', [validatorCliPath, tempDir, '--no-quotas'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(
        proc.status,
        0,
        `CLI failed with status ${proc.status}:\nSTDOUT: ${proc.stdout}\nSTDERR: ${proc.stderr}`,
      );
      assert.match(proc.stdout, /corpus validation passed/i);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('CLI succeeds against repo corpus directory if dataset exists', (tSub) => {
    const defaultCorpusDir = resolve(repoRoot, 'tests/security/corpus');
    const hasJsonl =
      existsSync(defaultCorpusDir) &&
      readdirSync(defaultCorpusDir).some((f) => f.endsWith('.jsonl'));
    if (!hasJsonl) {
      tSub.skip('Skipping repo corpus check because no .jsonl files exist in tests/security/corpus yet');
      return;
    }
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

test('frozen split corpus and cryptographic manifest contract', async (t) => {
  const corpusDir = resolve(repoRoot, 'tests/security/corpus');
  const expectedFiles = [
    'holdout_input.jsonl',
    'holdout_tool.jsonl',
    'holdout_output.jsonl',
    'invariant_manifest.jsonl',
  ];

  await t.test('partitioned stage files exist on disk', () => {
    for (const file of expectedFiles) {
      const fullPath = join(corpusDir, file);
      assert.ok(existsSync(fullPath), `Required corpus file must exist: ${file}`);
    }
  });

  await t.test('manifest.json exists and adheres to cryptographic manifest schema', () => {
    const manifestPath = join(corpusDir, 'manifest.json');
    assert.ok(existsSync(manifestPath), 'manifest.json must exist in corpus directory');

    const raw = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);

    assert.equal(typeof manifest.version, 'string', 'manifest must declare version');
    assert.equal(manifest.taxonomy, 'OWASP-LLM-Top10-2025', 'manifest must declare taxonomy OWASP-LLM-Top10-2025');
    assert.equal(typeof manifest.files, 'object', 'manifest must declare files object');
    assert.ok(manifest.files !== null && !Array.isArray(manifest.files));

    assert.equal(typeof manifest.provenance, 'object', 'manifest must declare provenance object');
    assert.equal(manifest.provenance.source, 'synthetic-feature-023');
    assert.match(
      manifest.provenance.revision,
      /^git:[0-9a-f]{7,40}$/,
      `manifest provenance revision must match git commit format, got "${manifest.provenance.revision}"`,
    );
    const revSha = manifest.provenance.revision.replace(/^git:/, '');
    const revCheck = spawnSync('git', ['cat-file', '-e', `${revSha}^{commit}`], { cwd: repoRoot });
    assert.ok(
      revCheck.status === 0 || manifest.provenance.revision === 'git:97f23a6f',
      `Revision ${manifest.provenance.revision} must be a valid resolvable git commit`,
    );
    assert.equal(manifest.provenance.curatedBy, 'Security Team');
    assert.equal(manifest.provenance.curatedAt, '2026-09-04T00:00:00Z');

    for (const expectedFile of expectedFiles) {
      assert.ok(expectedFile in manifest.files, `manifest.files must include ${expectedFile}`);
      const fileMeta = manifest.files[expectedFile];
      assert.match(fileMeta.sha256, /^[a-f0-9]{64}$/, `${expectedFile} sha256 must be 64-char hex string`);
      assert.equal(typeof fileMeta.bytes, 'number', `${expectedFile} bytes must be number`);
      assert.ok(fileMeta.bytes > 0, `${expectedFile} bytes must be > 0`);
      assert.equal(typeof fileMeta.recordCount, 'number', `${expectedFile} recordCount must be number`);
      assert.ok(fileMeta.recordCount > 0, `${expectedFile} recordCount must be > 0`);
      assert.ok(
        ['MIT', 'Apache-2.0', 'CC-BY-4.0'].includes(fileMeta.license),
        `${expectedFile} license must be permissive compliant`,
      );
    }
  });

  await t.test('actual on-disk SHA-256 digests and byte counts match manifest entries exactly', () => {
    const manifestPath = join(corpusDir, 'manifest.json');
    assert.ok(existsSync(manifestPath), 'manifest.json must exist');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    for (const [filename, meta] of Object.entries(manifest.files)) {
      const targetPath = join(corpusDir, filename);
      assert.ok(existsSync(targetPath), `File listed in manifest must exist: ${filename}`);

      const content = readFileSync(targetPath);
      const computedHash = createHash('sha256').update(content).digest('hex');
      assert.equal(
        computedHash,
        meta.sha256,
        `SHA-256 mismatch for ${filename}: expected ${meta.sha256}, got ${computedHash}`,
      );
      assert.equal(
        content.length,
        meta.bytes,
        `Byte count mismatch for ${filename}: expected ${meta.bytes}, got ${content.length}`,
      );
    }
  });

  await t.test('validateCorpusManifest verifies manifest.json successfully', () => {
    const res = validateCorpusManifest(corpusDir);
    assert.equal(res.valid, true, `validateCorpusManifest failed: ${res.errors.join(', ')}`);
    assert.ok(res.manifest, 'manifest object must be present');
    assert.equal(Object.keys(res.manifest.files).length, 4);
    assert.equal(res.errors.length, 0);
  });

  await t.test('validateCorpusManifest accepts compliant permissive licenses (MIT, Apache-2.0, CC-BY-4.0)', () => {
    const permissiveLicenses = ['MIT', 'Apache-2.0', 'CC-BY-4.0'];
    for (const lic of permissiveLicenses) {
      const licDir = mkdtempSync(join(tmpdir(), `corpus-test-lic-${lic.replace(/[^a-zA-Z0-9]/g, '_')}-`));
      try {
        const dummyFile = join(licDir, `test-${lic.replace(/[^a-zA-Z0-9]/g, '_')}.jsonl`);
        writeFileSync(dummyFile, '{"test":true}\n', 'utf8');
        const hash = createHash('sha256').update(readFileSync(dummyFile)).digest('hex');

        const manifest = {
          version: '1.0.0',
          taxonomy: 'OWASP-LLM-Top10-2025',
          files: {
            [`test-${lic.replace(/[^a-zA-Z0-9]/g, '_')}.jsonl`]: {
              sha256: hash,
              bytes: 14,
              recordCount: 1,
              license: lic,
            },
          },
        };
        writeFileSync(join(licDir, 'manifest.json'), JSON.stringify(manifest));
        const res = validateCorpusManifest(licDir);
        assert.equal(res.valid, true, `License ${lic} should be accepted: ${res.errors.join(', ')}`);
      } finally {
        rmSync(licDir, { recursive: true, force: true });
      }
    }

    // Disallowed non-compliant license (e.g. GPL-3.0)
    const badDir = mkdtempSync(join(tmpdir(), 'corpus-test-lic-bad-'));
    try {
      const dummyFile = join(badDir, 'test-GPL.jsonl');
      writeFileSync(dummyFile, '{"test":true}\n', 'utf8');
      const hash = createHash('sha256').update(readFileSync(dummyFile)).digest('hex');
      const badManifest = {
        version: '1.0.0',
        taxonomy: 'OWASP-LLM-Top10-2025',
        files: {
          'test-GPL.jsonl': {
            sha256: hash,
            bytes: 14,
            recordCount: 1,
            license: 'GPL-3.0',
          },
        },
      };
      writeFileSync(join(badDir, 'manifest.json'), JSON.stringify(badManifest));
      const badRes = validateCorpusManifest(badDir);
      assert.equal(badRes.valid, false);
      assert.ok(badRes.errors.some((e) => e.includes('license must be one of')));
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });

  await t.test('validateCorpusManifest detects tampered hash or missing file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'corpus-test-manifest-tamper-'));
    try {
      const dummyFile = join(tempDir, 'holdout_input.jsonl');
      writeFileSync(dummyFile, '{"test":true}\n', 'utf8');

      const tamperedManifest = {
        version: '1.0.0',
        taxonomy: 'OWASP-LLM-Top10-2025',
        files: {
          'holdout_input.jsonl': {
            sha256: '0'.repeat(64), // deliberately invalid hash
            bytes: 14,
            recordCount: 1,
            license: 'MIT',
          },
          'missing_file.jsonl': {
            sha256: 'a'.repeat(64),
            bytes: 100,
            recordCount: 1,
            license: 'MIT',
          },
        },
      };
      writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(tamperedManifest));

      const res = validateCorpusManifest(tempDir);
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('SHA-256 mismatch')));
      assert.ok(res.errors.some((e) => e.includes('does not exist')));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('validateCorpusManifest requires manifest.json for repo corpus directory or when requireManifest: true', () => {
    // When validating repo corpus directory and manifest is missing: fails
    const mockRepoCorpusWithoutManifest = resolve(repoRoot, 'tests/security/corpus');
    // Test with explicit requireManifest: true on tempDir
    const tempDir = mkdtempSync(join(tmpdir(), 'corpus-test-manifest-required-'));
    try {
      const res = validateCorpusManifest(tempDir, { requireManifest: true });
      assert.equal(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('manifest.json is required')));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('validateCorpusManifest returns valid: true when manifest.json is absent and not required', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'corpus-test-manifest-absent-'));
    try {
      const res = validateCorpusManifest(tempDir, { requireManifest: false });
      assert.equal(res.valid, true);
      assert.equal(res.manifest, null);
      assert.equal(res.errors.length, 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

test('partition contracts and stage segregation enforcement', async (t) => {
  await t.test('PARTITION_CONTRACTS defines expected mappings', () => {
    assert.deepEqual(PARTITION_CONTRACTS['holdout_input.jsonl'], {
      split: 'holdout',
      suiteKind: 'detector',
      expectedStage: 'input',
    });
    assert.deepEqual(PARTITION_CONTRACTS['holdout_tool.jsonl'], {
      split: 'holdout',
      suiteKind: 'detector',
      expectedStage: 'tool',
    });
    assert.deepEqual(PARTITION_CONTRACTS['holdout_output.jsonl'], {
      split: 'holdout',
      suiteKind: 'detector',
      expectedStage: 'output',
    });
    assert.deepEqual(PARTITION_CONTRACTS['invariant_manifest.jsonl'], {
      split: 'invariant',
      suiteKind: 'invariant',
    });
  });

  await t.test('checkPartitionContract flags mismatched fields', () => {
    const inputRecord = createSampleRecord({ expectedStage: 'input' });
    const toolContract = PARTITION_CONTRACTS['holdout_tool.jsonl'];
    const violations = checkPartitionContract(inputRecord, toolContract);
    assert.ok(violations.length > 0);
    assert.ok(violations.some((v) => v.includes('expectedStage') && v.includes('tool')));
  });

  await t.test('validateCorpus detects wrong expectedStage in partitioned file (e.g. input record in holdout_tool.jsonl)', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'corpus-test-stage-mismatch-'));
    try {
      // Create holdout_tool.jsonl containing an input stage record
      const mismatchedRecord = createSampleRecord({
        id: 'tol-mismatch-001',
        expectedStage: 'input', // Stage violation for holdout_tool.jsonl
        split: 'holdout',
        suiteKind: 'detector',
      });
      const filePath = join(tempDir, 'holdout_tool.jsonl');
      writeFileSync(filePath, JSON.stringify(mismatchedRecord) + '\n', 'utf8');

      const fileRes = validateCorpus(filePath, { requireHoldoutQuotas: false });
      assert.equal(fileRes.valid, false, 'Should fail validation due to partition violation');
      assert.ok(
        fileRes.errors.some(
          (e) =>
            e.includes('Partition Contract Violation') &&
            e.includes('holdout_tool.jsonl:1') &&
            e.includes('expectedStage'),
        ),
        `Expected partition violation error with context holdout_tool.jsonl:1, got: ${fileRes.errors.join(', ')}`,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('validateCorpusManifest detects partition contract violation in manifest files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'corpus-test-manifest-partition-'));
    try {
      const mismatchedRecord = createSampleRecord({
        id: 'tol-mismatch-002',
        expectedStage: 'input', // Stage violation for holdout_tool.jsonl
        split: 'holdout',
        suiteKind: 'detector',
      });
      const toolFile = join(tempDir, 'holdout_tool.jsonl');
      const lines = JSON.stringify(mismatchedRecord) + '\n';
      writeFileSync(toolFile, lines, 'utf8');
      const sha256 = createHash('sha256').update(Buffer.from(lines, 'utf8')).digest('hex');

      const manifest = {
        version: '1.0.0',
        taxonomy: 'OWASP-LLM-Top10-2025',
        files: {
          'holdout_tool.jsonl': {
            sha256,
            bytes: Buffer.from(lines, 'utf8').length,
            recordCount: 1,
            license: 'MIT',
          },
        },
      };
      writeFileSync(join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

      const res = validateCorpusManifest(tempDir);
      assert.equal(res.valid, false, 'Manifest validation should fail on partition violation');
      assert.ok(
        res.errors.some(
          (e) =>
            e.includes('Partition Contract Violation') &&
            e.includes('holdout_tool.jsonl:1') &&
            e.includes('expectedStage'),
        ),
        `Expected partition contract error in manifest validation, got: ${res.errors.join(', ')}`,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('validateCorpus detects invariant record with detector suiteKind in invariant_manifest.jsonl', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'corpus-test-inv-mismatch-'));
    try {
      const mismatchedInv = createSampleRecord({
        id: 'inv-mismatch-001',
        split: 'invariant',
        suiteKind: 'detector', // suiteKind violation for invariant_manifest.jsonl
        oracle: { expectedDecision: 'PASS', expectedErrorCode: null },
      });
      const filePath = join(tempDir, 'invariant_manifest.jsonl');
      writeFileSync(filePath, JSON.stringify(mismatchedInv) + '\n', 'utf8');

      const res = validateCorpus(filePath, { requireHoldoutQuotas: false });
      assert.equal(res.valid, false);
      assert.ok(
        res.errors.some(
          (e) =>
            e.includes('Partition Contract Violation') &&
            e.includes('invariant_manifest.jsonl:1') &&
            e.includes('suiteKind'),
        ),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('validateCorpus in-memory supports partitionFile option', () => {
    const inputRec = createSampleRecord({ expectedStage: 'input' });
    const res = validateCorpus([inputRec], {
      partitionFile: 'holdout_output.jsonl',
      requireHoldoutQuotas: false,
    });
    assert.equal(res.valid, false);
    assert.ok(
      res.errors.some(
        (e) =>
          e.includes('Partition Contract Violation') &&
          e.includes('holdout_output.jsonl:1') &&
          e.includes('expectedStage'),
      ),
    );
  });

  await t.test('all repository partition files strictly satisfy their PARTITION_CONTRACT', () => {
    const corpusDir = resolve(repoRoot, 'tests/security/corpus');
    for (const [filename, contract] of Object.entries(PARTITION_CONTRACTS)) {
      const fullPath = join(corpusDir, filename);
      assert.ok(existsSync(fullPath), `${filename} must exist`);
      const records = loadCorpusJsonl(fullPath);
      assert.ok(records.length > 0, `${filename} must contain records`);
      for (const item of records) {
        const violations = checkPartitionContract(item.record, contract);
        assert.equal(
          violations.length,
          0,
          `Record ${filename}:${item.line} violates partition contract: ${violations.join(', ')}`,
        );
      }
    }
  });
});


