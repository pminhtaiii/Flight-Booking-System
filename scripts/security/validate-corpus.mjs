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
function validatePropertyBySchema(propName, val, propDef, prefix = '') {
  const errs = [];
  const fullName = prefix ? `${prefix}.${propName}` : propName;

  if (Array.isArray(propDef.type)) {
    const matched = propDef.type.some((t) => {
      if (t === 'null') return val === null;
      if (t === 'string') return typeof val === 'string';
      if (t === 'object') return typeof val === 'object' && val !== null && !Array.isArray(val);
      return false;
    });
    if (!matched) {
      errs.push(`${fullName} must be one of types: [${propDef.type.join(', ')}]`);
      return errs;
    }
  } else if (propDef.type === 'string') {
    if (typeof val !== 'string') {
      errs.push(`${fullName} must be a string`);
      return errs;
    }
  } else if (propDef.type === 'object') {
    if (typeof val !== 'object' || val === null || Array.isArray(val)) {
      errs.push(`${fullName} must be an object`);
      return errs;
    }
  }

  if (typeof val === 'string') {
    if (propDef.minLength !== undefined && val.trim().length < propDef.minLength) {
      errs.push(`${fullName} must be a non-empty string`);
    }
    if (propDef.pattern !== undefined && !new RegExp(propDef.pattern).test(val)) {
      errs.push(`Invalid ${fullName}: "${val}". Must match pattern ${propDef.pattern}`);
    }
    if (propDef.enum !== undefined && !propDef.enum.includes(val)) {
      errs.push(`Invalid ${fullName}: "${val}". Must be one of: ${propDef.enum.join(', ')}`);
    }
  }

  return errs;
}

function validateObjectBySchema(objName, obj, objSchema) {
  const errs = [];
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return [`${objName} must be an object`];
  }

  if (objSchema.additionalProperties === false && objSchema.properties) {
    const allowed = new Set(Object.keys(objSchema.properties));
    for (const k of Object.keys(obj)) {
      if (!allowed.has(k)) {
        errs.push(`Disallowed ${objName} property "${k}"`);
      }
    }
  }

  const required = objSchema.required || [];
  for (const req of required) {
    if (!(req in obj) || obj[req] === undefined) {
      errs.push(`Missing required ${objName} property "${req}"`);
    }
  }

  if (objSchema.properties) {
    for (const [key, propDef] of Object.entries(objSchema.properties)) {
      if (key in obj && obj[key] !== undefined) {
        errs.push(...validatePropertyBySchema(key, obj[key], propDef, objName));
      }
    }
  }

  return errs;
}

/**
 * Dynamic JSON schema validation matching tests/security/corpus/schema.json.
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

  // Validate top-level primitive/string fields dynamically from schema
  const props = schema.properties || {};
  for (const [propName, propDef] of Object.entries(props)) {
    if (propDef.type === 'object') continue;
    if (propName in record && record[propName] !== undefined) {
      errors.push(...validatePropertyBySchema(propName, record[propName], propDef));
    }
  }

  // Validate nested objects dynamically from schema
  if ('fixture' in props) {
    errors.push(...validateObjectBySchema('fixture', record.fixture, props.fixture));
  }
  if ('oracle' in props) {
    errors.push(...validateObjectBySchema('oracle', record.oracle, props.oracle));
  }
  if ('provenance' in props) {
    errors.push(...validateObjectBySchema('provenance', record.provenance, props.provenance));
  }

  // Semantic checks & relational invariants:
  // Issue 4: Payload must not be empty or whitespace-only after normalization
  if (typeof record.payload === 'string') {
    if (record.payload.trim().length === 0 || normalizePayload(record.payload).length === 0) {
      errors.push('payload must be a non-empty string');
    }
  }

  // Issue 2: Suite kind and split alignment (invariants must not mix with detector splits)
  if (record.suiteKind === 'invariant' && record.split !== 'invariant') {
    errors.push(`Invariant suiteKind records must use split "invariant", got "${record.split}"`);
  }
  if (record.suiteKind === 'detector' && record.split === 'invariant') {
    errors.push(`Detector suiteKind records cannot use split "invariant", must be "holdout" or "development"`);
  }

  // Issue 3: Oracle and label consistency (no contradictory ground truth)
  if (record.oracle && typeof record.oracle === 'object' && !Array.isArray(record.oracle)) {
    if (record.label === 'benign') {
      if (record.oracle.expectedDecision !== 'PASS') {
        errors.push(`Contradictory oracle: benign records must have expectedDecision "PASS", got "${record.oracle.expectedDecision}"`);
      }
      if (record.oracle.expectedErrorCode !== null) {
        errors.push(`Contradictory oracle: records with expectedDecision "PASS" must have expectedErrorCode null, got "${record.oracle.expectedErrorCode}"`);
      }
    } else if (record.label === 'malicious') {
      if (record.oracle.expectedDecision !== 'BLOCK') {
        errors.push(`Contradictory oracle: malicious records must have expectedDecision "BLOCK", got "${record.oracle.expectedDecision}"`);
      }
      if (typeof record.oracle.expectedErrorCode !== 'string' || record.oracle.expectedErrorCode.trim().length === 0) {
        errors.push(`Contradictory oracle: malicious records with expectedDecision "BLOCK" must have non-empty string expectedErrorCode`);
      }
    }

    if (record.oracle.expectedDecision === 'PASS' && record.oracle.expectedErrorCode !== null) {
      errors.push(`oracle.expectedErrorCode must be null when expectedDecision is "PASS"`);
    }
    if (record.oracle.expectedDecision === 'BLOCK' && (typeof record.oracle.expectedErrorCode !== 'string' || record.oracle.expectedErrorCode.trim().length === 0)) {
      errors.push(`oracle.expectedErrorCode must be a non-empty string when expectedDecision is "BLOCK"`);
    }
  }

  return errors;
}

/**
 * Validates corpus manifest if manifest.json exists in corpusDir.
 * Checks that all listed files exist, SHA-256 hashes match,
 * bytes and record counts match, and license is 'MIT'.
 * Also checks that no undeclared .jsonl files exist in corpusDir.
 *
 * @param {string} corpusDir
 * @returns {{ valid: boolean, errors: string[], manifest: any }}
 */
export function validateCorpusManifest(corpusDir) {
  const manifestPath = join(corpusDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { valid: true, errors: [], manifest: null };
  }

  const errors = [];
  let manifest;
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(raw);
  } catch (err) {
    return {
      valid: false,
      errors: [`[Manifest Error] Failed to parse manifest.json: ${err.message}`],
      manifest: null,
    };
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {
      valid: false,
      errors: ['[Manifest Error] manifest.json must be a JSON object'],
      manifest: null,
    };
  }

  if (typeof manifest.version !== 'string' || manifest.version.trim().length === 0) {
    errors.push('[Manifest Error] manifest.json must declare a non-empty version string');
  }

  if (manifest.taxonomy !== 'OWASP-LLM-Top10-2025') {
    errors.push(
      `[Manifest Error] manifest.json taxonomy must be "OWASP-LLM-Top10-2025", got "${manifest.taxonomy}"`,
    );
  }

  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    errors.push('[Manifest Error] manifest.json must declare a files object');
    return { valid: false, errors, manifest: null };
  }

  const declaredFiles = Object.keys(manifest.files);
  if (declaredFiles.length === 0) {
    errors.push('[Manifest Error] manifest.json files object must not be empty');
  }

  for (const [filename, fileMeta] of Object.entries(manifest.files)) {
    const targetFile = join(corpusDir, filename);
    if (!existsSync(targetFile)) {
      errors.push(`[Manifest Error] File listed in manifest does not exist: ${filename}`);
      continue;
    }

    if (!fileMeta || typeof fileMeta !== 'object' || Array.isArray(fileMeta)) {
      errors.push(`[Manifest Error] Entry for ${filename} in manifest.json must be an object`);
      continue;
    }

    if (!/^[a-f0-9]{64}$/.test(fileMeta.sha256 || '')) {
      errors.push(
        `[Manifest Error] ${filename} sha256 must be a 64-character lowercase hex digest, got "${fileMeta.sha256}"`,
      );
    }

    if (typeof fileMeta.bytes !== 'number' || fileMeta.bytes < 0) {
      errors.push(`[Manifest Error] ${filename} bytes must be a non-negative number`);
    }

    if (typeof fileMeta.recordCount !== 'number' || fileMeta.recordCount < 0) {
      errors.push(`[Manifest Error] ${filename} recordCount must be a non-negative number`);
    }

    if (fileMeta.license !== 'MIT') {
      errors.push(`[Manifest Error] ${filename} license must be "MIT", got "${fileMeta.license}"`);
    }

    const content = readFileSync(targetFile);
    const computedHash = createHash('sha256').update(content).digest('hex');
    if (fileMeta.sha256 && computedHash !== fileMeta.sha256) {
      errors.push(
        `[Manifest Hash Mismatch] ${filename}: SHA-256 mismatch. Manifest declared "${fileMeta.sha256}", computed "${computedHash}"`,
      );
    }

    if (typeof fileMeta.bytes === 'number' && content.length !== fileMeta.bytes) {
      errors.push(
        `[Manifest Byte Count Mismatch] ${filename}: Byte count mismatch. Manifest declared ${fileMeta.bytes}, actual ${content.length}`,
      );
    }

    try {
      const records = loadCorpusJsonl(targetFile);
      if (typeof fileMeta.recordCount === 'number' && records.length !== fileMeta.recordCount) {
        errors.push(
          `[Manifest Record Count Mismatch] ${filename}: Record count mismatch. Manifest declared ${fileMeta.recordCount}, actual ${records.length}`,
        );
      }
    } catch (e) {
      errors.push(`[Manifest Error] ${filename} failed to parse as JSONL: ${e.message}`);
    }
  }

  // Ensure no undeclared .jsonl files in corpus directory
  const onDiskFiles = readdirSync(corpusDir).filter((f) => f.endsWith('.jsonl'));
  for (const f of onDiskFiles) {
    if (!manifest.files[f]) {
      errors.push(`[Manifest Error] Undeclared corpus file found in directory: ${f}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    manifest,
  };
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

  const errors = [];
  const stats = createEmptyStats();

  // Load records
  let itemsToValidate = [];
  if (typeof target === 'string') {
    if (!existsSync(target)) {
      return {
        valid: false,
        errors: [`Corpus target path does not exist: ${target}`],
        records: [],
        stats,
      };
    }
    const stat = statSync(target);
    if (stat.isDirectory()) {
      const manifestResult = validateCorpusManifest(target);
      if (!manifestResult.valid) {
        errors.push(...manifestResult.errors);
      }
      if (manifestResult.manifest) {
        stats.manifest = {
          version: manifestResult.manifest.version,
          taxonomy: manifestResult.manifest.taxonomy,
          filesCount: Object.keys(manifestResult.manifest.files || {}).length,
        };
      }

      const files = readdirSync(target)
        .filter((f) => f.endsWith('.jsonl'))
        .sort();
      if (files.length === 0) {
        return {
          valid: false,
          errors: [`No .jsonl corpus files found in directory: ${target}`, ...errors],
          records: [],
          stats,
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
      stats,
    };
  }

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
    manifest: null,
  };
}

// CLI execution
/* eslint-disable no-console */
const isMain =
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    resolve(process.argv[1]) === resolve(__filename));

if (isMain) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const nonFlags = args.filter((a) => !a.startsWith('--'));
  const requireHoldoutQuotas = !flags.has('--no-quotas') && !flags.has('--skip-quotas');
  const targetDir = resolve(nonFlags[0] || join(repoRoot, 'tests/security/corpus'));
  console.log(`[Corpus Validator] Validating corpus directory: ${targetDir}`);

  const result = validateCorpus(targetDir, { requireHoldoutQuotas });

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
  if (result.stats.manifest) {
    console.log(
      `  Manifest: verified (${result.stats.manifest.filesCount} files, version ${result.stats.manifest.version}, taxonomy ${result.stats.manifest.taxonomy})`,
    );
  }
  process.exit(0);
}

