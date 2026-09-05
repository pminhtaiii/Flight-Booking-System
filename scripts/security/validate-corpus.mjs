import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..');
const defaultSchemaPath = resolve(repoRoot, 'tests/security/corpus/schema.json');

/**
 * Normalizes payload using NFKC unicode normalization,
 * collapsing whitespace into single spaces, trimming, and lowercasing.
 * @param {string} payload
 * @returns {string}
 */
export function normalizePayload(payload) {
  if (typeof payload !== 'string') {
    return '';
  }
  return payload.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Computes SHA-256 hex digest of normalized payload.
 * @param {string} payload
 * @returns {string}
 */
export function computeCanonicalHash(payload) {
  const normalized = normalizePayload(payload);
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Loads and parses line-delimited JSON (JSONL) file.
 * @param {string} filePath
 * @returns {Array<{ record: any, line: number, sourceFile: string }>}
 */
export function loadCorpusJsonl(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Corpus file does not exist: ${filePath}`);
  }
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const records = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx].trim();
    if (!rawLine) continue;

    try {
      const parsed = JSON.parse(rawLine);
      records.push({
        record: parsed,
        line: idx + 1,
        sourceFile: filePath,
      });
    } catch (err) {
      throw new Error(
        `Invalid JSON on line ${idx + 1} of ${filePath}: ${err.message}`,
      );
    }
  }

  return records;
}

/**
 * Lightweight JSON schema validation matching tests/security/corpus/schema.json.
 * @param {any} record
 * @param {any} schema
 * @returns {string[]} List of validation error messages, or empty if valid.
 */
export function validateRecordSchema(record, schema) {
  const errors = [];
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return ['Record must be a JSON object'];
  }

  const allowedTopProperties = new Set(Object.keys(schema.properties || {}));
  for (const key of Object.keys(record)) {
    if (!allowedTopProperties.has(key)) {
      errors.push(`Disallowed property "${key}" in record (additionalProperties: false)`);
    }
  }

  const requiredTop = schema.required || [];
  for (const req of requiredTop) {
    if (!(req in record) || record[req] === undefined) {
      errors.push(`Missing required property "${req}"`);
    }
  }

  if (errors.length > 0) return errors;

  // id
  if (typeof record.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(record.id)) {
    errors.push(`Invalid id: "${record.id}". Must match pattern ^[a-zA-Z0-9_-]+$`);
  }

  // suiteKind
  if (!['detector', 'invariant'].includes(record.suiteKind)) {
    errors.push(`Invalid suiteKind: "${record.suiteKind}". Must be "detector" or "invariant"`);
  }

  // expectedStage
  if (!['input', 'tool', 'output'].includes(record.expectedStage)) {
    errors.push(`Invalid expectedStage: "${record.expectedStage}". Must be "input", "tool", or "output"`);
  }

  // expectedLayerFamily
  if (typeof record.expectedLayerFamily !== 'string' || record.expectedLayerFamily.trim().length === 0) {
    errors.push('expectedLayerFamily must be a non-empty string');
  }

  // taxonomyCode
  if (typeof record.taxonomyCode !== 'string' || record.taxonomyCode.trim().length === 0) {
    errors.push('taxonomyCode must be a non-empty string');
  }

  // label
  if (!['malicious', 'benign'].includes(record.label)) {
    errors.push(`Invalid label: "${record.label}". Must be "malicious" or "benign"`);
  }

  // payload
  if (typeof record.payload !== 'string') {
    errors.push('payload must be a string');
  }

  // canonicalHash
  if (typeof record.canonicalHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.canonicalHash)) {
    errors.push(`canonicalHash must be a 64-character lowercase hex SHA-256 digest`);
  }

  // variantGroup
  if (typeof record.variantGroup !== 'string' || record.variantGroup.trim().length === 0) {
    errors.push('variantGroup must be a non-empty string');
  }

  // split
  if (!['holdout', 'development', 'invariant'].includes(record.split)) {
    errors.push(`Invalid split: "${record.split}". Must be "holdout", "development", or "invariant"`);
  }

  // fixture
  if (typeof record.fixture !== 'object' || record.fixture === null || Array.isArray(record.fixture)) {
    errors.push('fixture must be an object');
  } else {
    const fixtureAllowed = new Set(['carrier', 'authProfile', 'mockToolResponse']);
    for (const k of Object.keys(record.fixture)) {
      if (!fixtureAllowed.has(k)) {
        errors.push(`Disallowed fixture property "${k}"`);
      }
    }
    if (typeof record.fixture.carrier !== 'string' || record.fixture.carrier.trim().length === 0) {
      errors.push('fixture.carrier must be a non-empty string');
    }
    if (typeof record.fixture.authProfile !== 'string' || record.fixture.authProfile.trim().length === 0) {
      errors.push('fixture.authProfile must be a non-empty string');
    }
    const mockTool = record.fixture.mockToolResponse;
    if (mockTool !== null && typeof mockTool !== 'string' && (typeof mockTool !== 'object' || Array.isArray(mockTool))) {
      errors.push('fixture.mockToolResponse must be an object, string, or null');
    }
  }

  // oracle
  if (typeof record.oracle !== 'object' || record.oracle === null || Array.isArray(record.oracle)) {
    errors.push('oracle must be an object');
  } else {
    const oracleAllowed = new Set(['expectedDecision', 'expectedErrorCode', 'reachedStageMarker']);
    for (const k of Object.keys(record.oracle)) {
      if (!oracleAllowed.has(k)) {
        errors.push(`Disallowed oracle property "${k}"`);
      }
    }
    if (!['PASS', 'BLOCK'].includes(record.oracle.expectedDecision)) {
      errors.push(`oracle.expectedDecision must be "PASS" or "BLOCK"`);
    }
    if (record.oracle.expectedErrorCode !== null && typeof record.oracle.expectedErrorCode !== 'string') {
      errors.push('oracle.expectedErrorCode must be string or null');
    }
    if (typeof record.oracle.reachedStageMarker !== 'string' || record.oracle.reachedStageMarker.trim().length === 0) {
      errors.push('oracle.reachedStageMarker must be a non-empty string');
    }
  }

  // provenance
  if (typeof record.provenance !== 'object' || record.provenance === null || Array.isArray(record.provenance)) {
    errors.push('provenance must be an object');
  } else {
    const provAllowed = new Set(['source', 'license', 'revision', 'curatedBy', 'curatedAt']);
    for (const k of Object.keys(record.provenance)) {
      if (!provAllowed.has(k)) {
        errors.push(`Disallowed provenance property "${k}"`);
      }
    }
    if (typeof record.provenance.source !== 'string' || record.provenance.source.trim().length === 0) {
      errors.push('provenance.source must be a non-empty string');
    }
    if (typeof record.provenance.license !== 'string' || record.provenance.license.trim().length === 0) {
      errors.push('provenance.license must be a non-empty string');
    }
    if (typeof record.provenance.revision !== 'string' || record.provenance.revision.trim().length === 0) {
      errors.push('provenance.revision must be a non-empty string');
    }
    if (typeof record.provenance.curatedBy !== 'string' || record.provenance.curatedBy.trim().length === 0) {
      errors.push('provenance.curatedBy must be a non-empty string');
    }
    if (typeof record.provenance.curatedAt !== 'string' || record.provenance.curatedAt.trim().length === 0) {
      errors.push('provenance.curatedAt must be a non-empty string');
    }
  }

  return errors;
}

/**
 * Validates corpus records against schema, deduplication, hash matching,
 * variant group split isolation, holdout quotas, and invariant segregation.
 *
 * @param {string|Array<any>} target Path to corpus directory, JSONL file, or array of record objects.
 * @param {object} [options]
 * @param {boolean} [options.requireHoldoutQuotas=true]
 * @param {string} [options.schemaPath]
 * @returns {{
 *   valid: boolean,
 *   errors: string[],
 *   records: Array<any>,
 *   stats: object
 * }}
 */
export function validateCorpus(target, options = {}) {
  const requireHoldoutQuotas = options.requireHoldoutQuotas ?? true;
  const schemaFile = options.schemaPath || defaultSchemaPath;

  let schema;
  try {
    const rawSchema = readFileSync(schemaFile, 'utf8');
    schema = JSON.parse(rawSchema);
  } catch (err) {
    return {
      valid: false,
      errors: [`Failed to load corpus schema from ${schemaFile}: ${err.message}`],
      records: [],
      stats: createEmptyStats(),
    };
  }

  // Load records
  let itemsToValidate = [];
  if (typeof target === 'string') {
    if (!existsSync(target)) {
      return {
        valid: false,
        errors: [`Corpus target path does not exist: ${target}`],
        records: [],
        stats: createEmptyStats(),
      };
    }
    const stat = statSync(target);
    if (stat.isDirectory()) {
      const files = readdirSync(target)
        .filter((f) => f.endsWith('.jsonl'))
        .sort();
      if (files.length === 0) {
        return {
          valid: false,
          errors: [`No .jsonl corpus files found in directory: ${target}`],
          records: [],
          stats: createEmptyStats(),
        };
      }
      for (const file of files) {
        const fullPath = join(target, file);
        itemsToValidate.push(...loadCorpusJsonl(fullPath));
      }
    } else {
      itemsToValidate.push(...loadCorpusJsonl(target));
    }
  } else if (Array.isArray(target)) {
    itemsToValidate = target.map((rec, i) => ({
      record: rec,
      line: i + 1,
      sourceFile: 'in-memory',
    }));
  } else {
    return {
      valid: false,
      errors: ['Invalid target: must be a directory path, file path, or array of records'],
      records: [],
      stats: createEmptyStats(),
    };
  }

  const errors = [];
  const stats = createEmptyStats();

  const seenIds = new Map(); // id -> { line, sourceFile }
  const seenNormalizedPayloads = new Map(); // normalizedPayload -> { id, line, sourceFile }
  const variantGroupToSplit = new Map(); // variantGroup -> split

  const validRecords = [];

  for (const item of itemsToValidate) {
    const rec = item.record;
    const context = `${item.sourceFile}:${item.line} (ID: ${rec?.id || 'unknown'})`;

    // 1. Schema validation
    const schemaErrors = validateRecordSchema(rec, schema);
    if (schemaErrors.length > 0) {
      for (const e of schemaErrors) {
        errors.push(`[Schema Error] ${context}: ${e}`);
      }
      continue;
    }

    validRecords.push(rec);

    // 2. Canonical hash verification
    const expectedHash = computeCanonicalHash(rec.payload);
    if (rec.canonicalHash !== expectedHash) {
      errors.push(
        `[Hash Mismatch] ${context}: canonicalHash "${rec.canonicalHash}" does not match computed sha256 of normalized payload "${expectedHash}"`,
      );
    }

    // 3. ID uniqueness
    if (seenIds.has(rec.id)) {
      const prior = seenIds.get(rec.id);
      errors.push(
        `[Duplicate ID] ${context}: duplicate id "${rec.id}" previously declared at ${prior.sourceFile}:${prior.line}`,
      );
    } else {
      seenIds.set(rec.id, { line: item.line, sourceFile: item.sourceFile });
    }

    // 4. Normalized payload uniqueness
    const normalized = normalizePayload(rec.payload);
    if (seenNormalizedPayloads.has(normalized)) {
      const prior = seenNormalizedPayloads.get(normalized);
      errors.push(
        `[Duplicate Payload] ${context}: duplicate normalized text identical to record "${prior.id}" at ${prior.sourceFile}:${prior.line}`,
      );
    } else {
      seenNormalizedPayloads.set(normalized, {
        id: rec.id,
        line: item.line,
        sourceFile: item.sourceFile,
      });
    }

    // 5. Cross-split variant group contamination check
    if (variantGroupToSplit.has(rec.variantGroup)) {
      const priorSplit = variantGroupToSplit.get(rec.variantGroup);
      if (priorSplit !== rec.split) {
        errors.push(
          `[Cross-Split Variant Contamination] ${context}: variantGroup "${rec.variantGroup}" belongs to split "${priorSplit}" but found in split "${rec.split}"`,
        );
      }
    } else {
      variantGroupToSplit.set(rec.variantGroup, rec.split);
    }

    // 6. Aggregate stats
    stats.total++;
    if (rec.split in stats.bySplit) {
      stats.bySplit[rec.split]++;
    }

    if (rec.suiteKind === 'detector') {
      stats.detectors.total++;
      const stage = rec.expectedStage;
      const label = rec.label;
      if (stats.detectors.byStage[stage]) {
        stats.detectors.byStage[stage][label]++;
        stats.detectors.byStage[stage].total++;
      }
    } else if (rec.suiteKind === 'invariant') {
      stats.invariants.total++;
    }
  }

  // 7. Holdout quota and empty stage denominator validation
  if (requireHoldoutQuotas) {
    validateHoldoutQuotas(validRecords, errors);
  }

  return {
    valid: errors.length === 0,
    errors,
    records: validRecords,
    stats,
  };
}

function validateHoldoutQuotas(records, errors) {
  const holdoutDetectors = records.filter(
    (r) => r.split === 'holdout' && r.suiteKind === 'detector',
  );

  const stageCounts = {
    input: { malicious: 0, benign: 0, total: 0 },
    tool: { malicious: 0, benign: 0, total: 0 },
    output: { malicious: 0, benign: 0, total: 0 },
  };

  for (const r of holdoutDetectors) {
    if (stageCounts[r.expectedStage]) {
      stageCounts[r.expectedStage][r.label]++;
      stageCounts[r.expectedStage].total++;
    }
  }

  // Strict Stage-local minimum quotas
  const quotaMinimums = {
    input: { malicious: 100, benign: 250 },
    tool: { malicious: 50, benign: 125 },
    output: { malicious: 50, benign: 125 },
  };

  for (const [stage, mins] of Object.entries(quotaMinimums)) {
    const current = stageCounts[stage];

    // Empty stage denominator
    if (current.total === 0 || current.malicious === 0 || current.benign === 0) {
      errors.push(
        `[Empty Stage Denominator] Stage "${stage}" has empty denominator or zero partition count: malicious=${current.malicious}, benign=${current.benign}, total=${current.total}`,
      );
    }

    if (current.malicious < mins.malicious) {
      errors.push(
        `[Holdout Quota Failure] Stage "${stage}" malicious count (${current.malicious}) below minimum quota (${mins.malicious})`,
      );
    }
    if (current.benign < mins.benign) {
      errors.push(
        `[Holdout Quota Failure] Stage "${stage}" benign count (${current.benign}) below minimum quota (${mins.benign})`,
      );
    }
  }

  const totalMalicious =
    stageCounts.input.malicious + stageCounts.tool.malicious + stageCounts.output.malicious;
  const totalBenign =
    stageCounts.input.benign + stageCounts.tool.benign + stageCounts.output.benign;
  const totalHoldout = totalMalicious + totalBenign;

  if (totalMalicious < 200) {
    errors.push(
      `[Holdout Quota Failure] Total holdout malicious cases (${totalMalicious}) below minimum requirement (200)`,
    );
  }
  if (totalBenign < 500) {
    errors.push(
      `[Holdout Quota Failure] Total holdout benign cases (${totalBenign}) below minimum requirement (500)`,
    );
  }
  if (totalHoldout < 700) {
    errors.push(
      `[Holdout Quota Failure] Total holdout detector cases (${totalHoldout}) below minimum requirement (700)`,
    );
  }
}

function createEmptyStats() {
  return {
    total: 0,
    detectors: {
      total: 0,
      byStage: {
        input: { malicious: 0, benign: 0, total: 0 },
        tool: { malicious: 0, benign: 0, total: 0 },
        output: { malicious: 0, benign: 0, total: 0 },
      },
    },
    invariants: {
      total: 0,
    },
    bySplit: {
      holdout: 0,
      development: 0,
      invariant: 0,
    },
  };
}

// CLI execution
/* eslint-disable no-console */
const isMain =
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    resolve(process.argv[1]) === resolve(__filename));

if (isMain) {
  const targetDir = resolve(process.argv[2] || join(repoRoot, 'tests/security/corpus'));
  console.log(`[Corpus Validator] Validating corpus directory: ${targetDir}`);

  const result = validateCorpus(targetDir, { requireHoldoutQuotas: true });

  if (!result.valid) {
    console.error(`\n[Corpus Validation Failed] Found ${result.errors.length} error(s):`);
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log(`[Corpus Validation Passed] Total records: ${result.stats.total}`);
  console.log(`  Detectors: ${result.stats.detectors.total}`);
  console.log(
    `    - Input: ${result.stats.detectors.byStage.input.malicious} malicious / ${result.stats.detectors.byStage.input.benign} benign`,
  );
  console.log(
    `    - Tool:  ${result.stats.detectors.byStage.tool.malicious} malicious / ${result.stats.detectors.byStage.tool.benign} benign`,
  );
  console.log(
    `    - Output:${result.stats.detectors.byStage.output.malicious} malicious / ${result.stats.detectors.byStage.output.benign} benign`,
  );
  console.log(`  Invariants: ${result.stats.invariants.total}`);
  console.log(
    `  By split: holdout=${result.stats.bySplit.holdout}, dev=${result.stats.bySplit.development}, inv=${result.stats.bySplit.invariant}`,
  );
  process.exit(0);
}
