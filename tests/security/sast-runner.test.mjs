import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  calculateFileCensus,
  resolveTargetFiles,
  parseSarifResults,
  evaluateFindings,
  runSastScan,
  validateBaselineSchema,
  validateException,
  validateExceptionsSchema,
  main,
} from '../../scripts/security/run-sast.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..');
const fixturesDir = resolve(repoRoot, 'tests/security/sast/fixtures');

const EXPECTED_FIXTURES = [
  'llm-guardrails.unsafe.py',
  'llm-guardrails.safe.py',
  'dynamic-imports.unsafe.py',
  'dynamic-imports.safe.py',
  'tool-execution.unsafe.py',
  'tool-execution.safe.py',
  'payload-logging.unsafe.py',
  'payload-logging.safe.py',
  'html-interpolation.unsafe.tsx',
  'html-interpolation.safe.tsx',
];

test('T029: all 10 fixture files exist in tests/security/sast/fixtures/', () => {
  assert.ok(existsSync(fixturesDir), `Fixtures directory must exist: ${fixturesDir}`);

  for (const filename of EXPECTED_FIXTURES) {
    const filePath = join(fixturesDir, filename);
    assert.ok(existsSync(filePath), `Fixture file must exist: ${filename}`);
    const stat = readFileSync(filePath, 'utf8');
    assert.ok(stat.trim().length > 0, `Fixture file must not be empty: ${filename}`);
  }
});

test('T029: Python fixtures are syntactically valid Python', () => {
  const pythonFixtures = EXPECTED_FIXTURES.filter((f) => f.endsWith('.py'));
  assert.equal(pythonFixtures.length, 8);

  for (const filename of pythonFixtures) {
    const filePath = join(fixturesDir, filename);
    assert.ok(existsSync(filePath), `File missing: ${filename}`);

    const res = spawnSync(
      'python',
      ['-c', 'import ast, sys; ast.parse(open(sys.argv[1], "rb").read())', filePath],
      { encoding: 'utf8' },
    );

    assert.equal(
      res.status,
      0,
      `Python fixture ${filename} failed syntax validation:\nStdout: ${res.stdout}\nStderr: ${res.stderr}`,
    );
  }
});

test('T029: TSX fixtures are syntactically valid TSX', () => {
  const tsxFixtures = EXPECTED_FIXTURES.filter((f) => f.endsWith('.tsx'));
  assert.equal(tsxFixtures.length, 2);

  for (const filename of tsxFixtures) {
    const filePath = join(fixturesDir, filename);
    assert.ok(existsSync(filePath), `File missing: ${filename}`);

    const content = readFileSync(filePath, 'utf8');
    const sf = ts.createSourceFile(
      filename,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const diagnostics = sf.parseDiagnostics || [];
    assert.equal(
      diagnostics.length,
      0,
      `TSX fixture ${filename} has parse errors: ${diagnostics
        .map((d) => (typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText))
        .join('; ')}`,
    );
  }
});

test('T029: Category 1 - Model Calls in Guardrails pattern verification', () => {
  const unsafePath = join(fixturesDir, 'llm-guardrails.unsafe.py');
  const safePath = join(fixturesDir, 'llm-guardrails.safe.py');

  const unsafeCode = readFileSync(unsafePath, 'utf8');
  const safeCode = readFileSync(safePath, 'utf8');

  // Unsafe fixture must invoke/initialize LLM inside guardrail
  assert.match(
    unsafeCode,
    /(ChatOpenAI|ChatAnthropic|ChatGoogleGenerativeAI|OpenAI|langchain)/,
    'Unsafe llm-guardrails fixture must import or instantiate an LLM',
  );
  assert.match(
    unsafeCode,
    /\.(invoke|ainvoke)\(/,
    'Unsafe llm-guardrails fixture must invoke or ainvoke the LLM model',
  );

  // Safe fixture uses pure deterministic regex/algorithmic parsing without any LLM
  assert.doesNotMatch(
    safeCode,
    /(ChatOpenAI|ChatAnthropic|ChatGoogleGenerativeAI|OpenAI|langchain)/,
    'Safe llm-guardrails fixture must not reference LLM client/library',
  );
  assert.doesNotMatch(
    safeCode,
    /\.(invoke|ainvoke)\(/,
    'Safe llm-guardrails fixture must not call invoke/ainvoke on LLM',
  );
  assert.match(
    safeCode,
    /(re\.compile|re\.search|re\.match|re\.findall)/,
    'Safe llm-guardrails fixture must use deterministic regex/algorithmic parsing',
  );
});

test('T029: Category 2 - Dynamic Imports pattern verification', () => {
  const unsafePath = join(fixturesDir, 'dynamic-imports.unsafe.py');
  const safePath = join(fixturesDir, 'dynamic-imports.safe.py');

  const unsafeCode = readFileSync(unsafePath, 'utf8');
  const safeCode = readFileSync(safePath, 'utf8');

  // Unsafe fixture uses __import__, importlib.import_module, eval, or exec
  assert.match(
    unsafeCode,
    /(__import__|importlib\.import_module|eval\(|exec\()/,
    'Unsafe dynamic-imports fixture must contain dynamic import or code execution construct',
  );

  // Safe fixture uses static explicit code factories / dictionary mapping
  assert.doesNotMatch(
    safeCode,
    /(__import__|importlib\.import_module|eval\(|exec\()/,
    'Safe dynamic-imports fixture must not contain dynamic imports or eval/exec',
  );
  assert.match(
    safeCode,
    /(\{|\bdict\(|\bMapping\b)/,
    'Safe dynamic-imports fixture must use static dictionary/factory mapping',
  );
});

test('T029: Category 3 - Bypass Tool Dispatch pattern verification', () => {
  const unsafePath = join(fixturesDir, 'tool-execution.unsafe.py');
  const safePath = join(fixturesDir, 'tool-execution.safe.py');

  const unsafeCode = readFileSync(unsafePath, 'utf8');
  const safeCode = readFileSync(safePath, 'utf8');

  // Unsafe fixture executes tool directly bypassing gateway
  assert.match(
    unsafeCode,
    /(search_flights\(|booking_detail\(|ToolNode\(|tool_function\()/,
    'Unsafe tool-execution fixture must invoke tool directly without gateway',
  );
  assert.doesNotMatch(
    unsafeCode,
    /gateway\.execute_tool\(/,
    'Unsafe tool-execution fixture must not route through gateway.execute_tool',
  );

  // Safe fixture routes via gateway.execute_tool()
  assert.match(
    safeCode,
    /gateway\.execute_tool\(/,
    'Safe tool-execution fixture must route via gateway.execute_tool()',
  );
});

test('T029: Category 4 - Raw Payload Logging pattern verification', () => {
  const unsafePath = join(fixturesDir, 'payload-logging.unsafe.py');
  const safePath = join(fixturesDir, 'payload-logging.safe.py');

  const unsafeCode = readFileSync(unsafePath, 'utf8');
  const safeCode = readFileSync(safePath, 'utf8');

  // Unsafe fixture logs raw user prompts or unredacted tool outputs
  assert.match(
    unsafeCode,
    /(prompt|user_input|raw_message|unredacted_output)/,
    'Unsafe payload-logging fixture must log raw user input or unredacted output',
  );
  assert.match(
    unsafeCode,
    /(logger\.(info|debug|warning|error)|logging\.(info|debug|warning|error))/,
    'Unsafe payload-logging fixture must perform logger call with raw payload',
  );

  // Safe fixture logs payload-free metadata (counts, status, event names)
  assert.doesNotMatch(
    safeCode,
    /(prompt|user_input|raw_message|unredacted_output)/,
    'Safe payload-logging fixture must not log sensitive payload variables',
  );
  assert.match(
    safeCode,
    /(status|event|token_count|duration_ms|count)/,
    'Safe payload-logging fixture must log payload-free metadata',
  );
});

test('T029: Category 5 - Unsafe HTML Injection pattern verification', () => {
  const unsafePath = join(fixturesDir, 'html-interpolation.unsafe.tsx');
  const safePath = join(fixturesDir, 'html-interpolation.safe.tsx');

  const unsafeCode = readFileSync(unsafePath, 'utf8');
  const safeCode = readFileSync(safePath, 'utf8');

  // Unsafe TSX fixture interpolates raw strings into dangerouslySetInnerHTML={{ __html: rawHtml }}
  assert.match(
    unsafeCode,
    /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:/,
    'Unsafe html-interpolation fixture must use dangerouslySetInnerHTML',
  );

  // Safe fixture renders sanitized React text <div>{sanitizedContent}</div>
  assert.doesNotMatch(
    safeCode,
    /dangerouslySetInnerHTML/,
    'Safe html-interpolation fixture must not use dangerouslySetInnerHTML',
  );
  assert.match(
    safeCode,
    /\{sanitizedContent\}|\{content\}|\{sanitizedText\}/,
    'Safe html-interpolation fixture must render safe React child',
  );
});

// -----------------------------------------------------------------------------
// T030: Pinned Custom Semgrep Rules and Ruleset Verification
// -----------------------------------------------------------------------------

const sastDir = resolve(repoRoot, 'tests/security/sast');
const guardrailsYamlPath = join(sastDir, 'guardrails.yml');
const rulesetYamlPath = join(sastDir, 'ruleset.yml');

function loadYaml(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`YAML file does not exist: ${filePath}`);
  }
  const res = spawnSync(
    'python',
    [
      '-c',
      'import yaml, json, sys; json.dump(yaml.safe_load(open(sys.argv[1], encoding="utf-8")), sys.stdout)',
      filePath,
    ],
    { encoding: 'utf8' },
  );

  if (res.status !== 0) {
    throw new Error(`Failed to parse YAML file ${filePath}:\n${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

function runPythonAstMatcher(ruleId, filePath) {
  const pythonScript = `
import ast, sys, json

rule_id = sys.argv[1]
file_path = sys.argv[2]

with open(file_path, 'rb') as f:
    tree = ast.parse(f.read())

matches = []

class ViolationFinder(ast.NodeVisitor):
    def visit_Call(self, node):
        func = node.func
        if rule_id == 'no-llm-in-guardrails':
            # Flag model class initialization or model invoke/ainvoke
            if isinstance(func, ast.Name) and func.id in ('ChatOpenAI', 'ChatAnthropic', 'ChatGoogleGenerativeAI', 'OpenAI'):
                matches.append(node.lineno)
            elif isinstance(func, ast.Attribute) and func.attr in ('invoke', 'ainvoke'):
                matches.append(node.lineno)
        elif rule_id == 'no-dynamic-imports-in-guardrails':
            # Flag dynamic imports or dynamic code execution sinks
            if isinstance(func, ast.Name) and func.id in ('eval', 'exec', '__import__'):
                matches.append(node.lineno)
            elif isinstance(func, ast.Attribute) and func.attr == 'import_module':
                if isinstance(func.value, ast.Name) and func.value.id == 'importlib':
                    matches.append(node.lineno)
        elif rule_id == 'no-unshielded-tool-execution':
            # Flag direct tool invocation or direct ToolNode execution
            tool_names = (
                'ToolNode', 'search_flights', 'booking_detail', 'booking_summaries',
                'get_preferences', 'check_booking_readiness', 'signal_checkout_intent', 'tool_function'
            )
            if isinstance(func, ast.Name) and func.id in tool_names:
                matches.append(node.lineno)
        elif rule_id == 'no-raw-payload-logging':
            # Flag logging unredacted payload or user input variables
            is_log_call = False
            if isinstance(func, ast.Attribute) and func.attr in ('debug', 'info', 'warning', 'error', 'critical', 'exception'):
                if (isinstance(func.value, ast.Name) and ('logger' in func.value.id.lower() or func.value.id == 'logging')) or \\
                   (isinstance(func.value, ast.Attribute) and 'logger' in func.value.attr.lower()):
                    is_log_call = True
            if is_log_call:
                sensitive_tokens = {'prompt', 'user_input', 'raw_message', 'raw_payload', 'unredacted_output'}
                found_sensitive = False
                for arg in node.args:
                    arg_str = ast.unparse(arg).lower() if hasattr(ast, 'unparse') else str(arg)
                    if any(t in arg_str for t in sensitive_tokens):
                        found_sensitive = True
                        break
                for kw in node.keywords:
                    kw_str = ast.unparse(kw.value).lower() if hasattr(ast, 'unparse') else str(kw.value)
                    if any(t in kw_str for t in sensitive_tokens):
                        found_sensitive = True
                        break
                if found_sensitive:
                    matches.append(node.lineno)
        self.generic_visit(node)

ViolationFinder().visit(tree)
print(json.dumps(matches))
`;

  const res = spawnSync('python', ['-c', pythonScript, ruleId, filePath], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`Python AST matcher failed for ${ruleId} on ${filePath}:\n${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

function runTsxAstMatcher(ruleId, filePath) {
  const content = readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const matches = [];

  function visit(node) {
    if (ruleId === 'safe-html-interpolation') {
      if (ts.isJsxAttribute(node) && node.name.text === 'dangerouslySetInnerHTML') {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        matches.push(line + 1);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return matches;
}

test('T030: YAML rule files exist and have valid YAML syntax', () => {
  assert.ok(existsSync(guardrailsYamlPath), `guardrails.yml must exist at ${guardrailsYamlPath}`);
  assert.ok(existsSync(rulesetYamlPath), `ruleset.yml must exist at ${rulesetYamlPath}`);

  const guardrailsDoc = loadYaml(guardrailsYamlPath);
  assert.ok(
    guardrailsDoc && typeof guardrailsDoc === 'object',
    'guardrails.yml must parse to an object',
  );
  assert.ok(Array.isArray(guardrailsDoc.rules), 'guardrails.yml must have a top-level rules array');

  const rulesetDoc = loadYaml(rulesetYamlPath);
  assert.ok(rulesetDoc && typeof rulesetDoc === 'object', 'ruleset.yml must parse to an object');
});

test('T030: guardrails.yml contains all 5 required rules with severity ERROR and proper languages', () => {
  const guardrailsDoc = loadYaml(guardrailsYamlPath);
  const rules = guardrailsDoc.rules;

  const EXPECTED_RULES = [
    {
      id: 'no-llm-in-guardrails',
      expectedLanguages: ['python'],
      severity: 'ERROR',
    },
    {
      id: 'no-dynamic-imports-in-guardrails',
      expectedLanguages: ['python'],
      severity: 'ERROR',
    },
    {
      id: 'no-unshielded-tool-execution',
      expectedLanguages: ['python'],
      severity: 'ERROR',
    },
    {
      id: 'no-raw-payload-logging',
      expectedLanguages: ['python'],
      severity: 'ERROR',
    },
    {
      id: 'safe-html-interpolation',
      expectedLanguages: ['typescript', 'tsx'],
      severity: 'ERROR',
    },
  ];

  for (const exp of EXPECTED_RULES) {
    const rule = rules.find((r) => r.id === exp.id);
    assert.ok(rule, `Rule ${exp.id} must be defined in guardrails.yml`);
    assert.equal(rule.severity, exp.severity, `Rule ${exp.id} must have severity ${exp.severity}`);

    const langs = Array.isArray(rule.languages) ? rule.languages : [rule.languages];
    for (const expLang of exp.expectedLanguages) {
      assert.ok(
        langs.includes(expLang),
        `Rule ${exp.id} languages (${langs.join(',')}) must include ${expLang}`,
      );
    }

    assert.ok(
      typeof rule.message === 'string' && rule.message.trim().length > 0,
      `Rule ${exp.id} must have a descriptive message`,
    );

    assert.ok(rule.metadata, `Rule ${exp.id} must have metadata`);
    assert.ok(rule.metadata.cwe, `Rule ${exp.id} metadata must include CWE classification`);
    assert.ok(
      rule.metadata.interprocedural_note,
      `Rule ${exp.id} metadata must document interprocedural behavioral test boundaries`,
    );
  }
});

test('T030: ruleset.yml references guardrails.yml and defines pinned versions and interprocedural docs', () => {
  const rulesetDoc = loadYaml(rulesetYamlPath);

  assert.ok(
    rulesetDoc.ruleset || rulesetDoc.metadata?.name,
    'ruleset.yml must define a ruleset name',
  );

  // Verify pinned version matches toolchain.json semgrep version 1.88.0
  const pinnedVersion = rulesetDoc.version || rulesetDoc.metadata?.pinned_toolchain_version;
  assert.equal(pinnedVersion, '1.88.0', 'ruleset.yml must pin Semgrep version to 1.88.0');

  // Verify inclusion or reference of guardrails.yml
  const includes = rulesetDoc.includes || [];
  assert.ok(
    includes.includes('guardrails.yml') || includes.some((inc) => inc.endsWith('guardrails.yml')),
    'ruleset.yml must include or reference guardrails.yml',
  );

  // Verify interprocedural properties are documented with behavioral test requirements
  const interprocedural = rulesetDoc.metadata?.interprocedural_properties;
  assert.ok(
    interprocedural && Array.isArray(interprocedural.behavioral_tests_required),
    'ruleset.yml metadata must document behavioral_tests_required for interprocedural guarantees',
  );
  assert.ok(
    interprocedural.behavioral_tests_required.length >= 2,
    'ruleset.yml must list at least 2 interprocedural properties requiring behavioral tests',
  );
});

test('T030: deterministic AST matcher verifies all 5 unsafe fixtures match and all 5 safe fixtures pass', () => {
  const guardrailsDoc = loadYaml(guardrailsYamlPath);
  const ruleIds = guardrailsDoc.rules.map((r) => r.id);

  const FIXTURE_PAIRS = [
    {
      ruleId: 'no-llm-in-guardrails',
      unsafe: 'llm-guardrails.unsafe.py',
      safe: 'llm-guardrails.safe.py',
      matcher: runPythonAstMatcher,
    },
    {
      ruleId: 'no-dynamic-imports-in-guardrails',
      unsafe: 'dynamic-imports.unsafe.py',
      safe: 'dynamic-imports.safe.py',
      matcher: runPythonAstMatcher,
    },
    {
      ruleId: 'no-unshielded-tool-execution',
      unsafe: 'tool-execution.unsafe.py',
      safe: 'tool-execution.safe.py',
      matcher: runPythonAstMatcher,
    },
    {
      ruleId: 'no-raw-payload-logging',
      unsafe: 'payload-logging.unsafe.py',
      safe: 'payload-logging.safe.py',
      matcher: runPythonAstMatcher,
    },
    {
      ruleId: 'safe-html-interpolation',
      unsafe: 'html-interpolation.unsafe.tsx',
      safe: 'html-interpolation.safe.tsx',
      matcher: runTsxAstMatcher,
    },
  ];

  const allSafePythonFixtures = [
    'llm-guardrails.safe.py',
    'dynamic-imports.safe.py',
    'tool-execution.safe.py',
    'payload-logging.safe.py',
  ];
  const allSafeTsxFixtures = ['html-interpolation.safe.tsx'];

  for (const pair of FIXTURE_PAIRS) {
    assert.ok(
      ruleIds.includes(pair.ruleId),
      `Rule ${pair.ruleId} must be present in guardrails.yml`,
    );

    const unsafePath = join(fixturesDir, pair.unsafe);
    const unsafeViolations = pair.matcher(pair.ruleId, unsafePath);
    assert.ok(
      unsafeViolations.length > 0,
      `Rule ${pair.ruleId} must detect violations in ${pair.unsafe}, got 0 matches`,
    );

    const safeCandidates =
      pair.ruleId === 'safe-html-interpolation' ? allSafeTsxFixtures : allSafePythonFixtures;

    for (const safeFilename of safeCandidates) {
      const safePath = join(fixturesDir, safeFilename);
      const safeViolations = pair.matcher(pair.ruleId, safePath);
      assert.equal(
        safeViolations.length,
        0,
        `Rule ${pair.ruleId} must NOT match safe fixture ${safeFilename}, got violations on lines: ${safeViolations.join(', ')}`,
      );
    }
  }
});

test('T030: live Semgrep scan if CLI is available in environment', (t) => {
  const semgrepCheck = spawnSync('semgrep', ['--version'], { encoding: 'utf8' });
  if (semgrepCheck.error || semgrepCheck.status !== 0) {
    t.diagnostic(
      'Semgrep CLI not detected in local environment; AST/semantic matcher verified fixture patterns deterministically.',
    );
    return;
  }

  const scan = spawnSync(
    'semgrep',
    ['--config', guardrailsYamlPath, fixturesDir, '--json', '--quiet'],
    { encoding: 'utf8' },
  );

  assert.equal(scan.status, 0, `Semgrep execution failed: ${scan.stderr}`);
  const results = JSON.parse(scan.stdout);
  assert.ok(Array.isArray(results.results), 'Semgrep output must contain results array');

  const unsafeMatches = results.results.filter((r) => r.path.includes('.unsafe.'));
  const safeMatches = results.results.filter((r) => r.path.includes('.safe.'));

  assert.ok(unsafeMatches.length >= 5, 'Semgrep should flag all unsafe fixtures');
  assert.equal(
    safeMatches.length,
    0,
    `Semgrep flagged safe fixtures: ${JSON.stringify(safeMatches)}`,
  );
});

// -----------------------------------------------------------------------------
// T031: SAST Scan Driver & File Census Validation
// -----------------------------------------------------------------------------

test('T031: calculateFileCensus returns valid counts exceeding minimum thresholds for all 4 workspaces', () => {
  const census = calculateFileCensus({ rootDir: repoRoot });
  assert.equal(
    census.passed,
    true,
    `Census should pass on repo root, errors: ${census.errors?.join('; ')}`,
  );
  assert.equal(census.errors.length, 0);

  assert.ok(
    census.workspaceCounts['apps/agent'] >= 30,
    `apps/agent file count must be >= 30, got ${census.workspaceCounts['apps/agent']}`,
  );
  assert.ok(
    census.workspaceCounts['apps/api'] >= 20,
    `apps/api file count must be >= 20, got ${census.workspaceCounts['apps/api']}`,
  );
  assert.ok(
    census.workspaceCounts['apps/web'] >= 20,
    `apps/web file count must be >= 20, got ${census.workspaceCounts['apps/web']}`,
  );
  assert.ok(
    census.workspaceCounts['packages/shared'] >= 1,
    `packages/shared file count must be >= 1, got ${census.workspaceCounts['packages/shared']}`,
  );

  const sumCounts =
    census.workspaceCounts['apps/agent'] +
    census.workspaceCounts['apps/api'] +
    census.workspaceCounts['apps/web'] +
    census.workspaceCounts['packages/shared'];
  assert.equal(census.totalFiles, sumCounts);
});

test('T031: calculateFileCensus fails closed when workspace count is below threshold or missing', () => {
  const censusHigh = calculateFileCensus({
    rootDir: repoRoot,
    minCounts: { 'apps/agent': 999999 },
  });
  assert.equal(censusHigh.passed, false, 'Census must fail when count is below threshold');
  assert.ok(censusHigh.errors.length > 0);
  assert.match(
    censusHigh.errors.join('; '),
    /apps\/agent.*below required minimum/,
    'Error must identify workspace falling below threshold',
  );

  const censusMissing = calculateFileCensus({
    rootDir: repoRoot,
    workspaces: ['nonexistent/workspace'],
    minCounts: { 'nonexistent/workspace': 1 },
  });
  assert.equal(censusMissing.passed, false, 'Census must fail when workspace directory is missing');
  assert.ok(censusMissing.errors.some((e) => e.includes('nonexistent/workspace')));
});

test('T031: calculateFileCensus strictly ignores excluded directories and fixtures', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'sast-census-test-'));
  try {
    const wsName = 'test_ws';
    const wsDir = join(tempDir, wsName);
    mkdirSync(wsDir, { recursive: true });

    // Valid target source files
    writeFileSync(join(wsDir, 'index.ts'), 'console.log("hello");');
    writeFileSync(join(wsDir, 'helper.py'), 'print("hello")');

    // Ignored directories & files
    const ignoredDirs = [
      'node_modules/pkg',
      'dist/out',
      '.next/static',
      '.venv/lib',
      '__pycache__',
      '.pytest_cache',
      '.git/objects',
      'tests/security/sast/fixtures',
    ];
    for (const d of ignoredDirs) {
      const fullDir = join(wsDir, d);
      mkdirSync(fullDir, { recursive: true });
      writeFileSync(join(fullDir, 'should-ignore.ts'), 'console.log("ignored");');
      writeFileSync(join(fullDir, 'should-ignore.py'), 'print("ignored")');
    }

    const census = calculateFileCensus({
      rootDir: tempDir,
      workspaces: [wsName],
      minCounts: { [wsName]: 2 },
    });

    assert.equal(census.passed, true);
    assert.equal(
      census.workspaceCounts[wsName],
      2,
      `Expected exactly 2 valid source files, got ${census.workspaceCounts[wsName]}`,
    );
    assert.equal(census.totalFiles, 2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('T031: resolveTargetFiles returns workspace files in full mode and git diff filtered files in diff mode', () => {
  const full = resolveTargetFiles({ mode: 'full', rootDir: repoRoot });
  assert.ok(
    full.files.length >= 700,
    `Full mode should return >= 700 files, got ${full.files.length}`,
  );
  const targetExtRegex = /\.(py|ts|tsx|js|mjs)$/i;
  for (const f of full.files) {
    assert.match(f, targetExtRegex, `File ${f} does not match target extensions`);
    assert.doesNotMatch(
      f,
      /(^|\/)(node_modules|\.venv|\.next|dist|__pycache__|\.pytest_cache|\.git)(\/|$)|tests\/security\/sast\/fixtures/,
    );
  }

  // Diff mode with simulated git diff
  const mockDiff = [
    'apps/agent/src/agent/main.py',
    'apps/agent/poetry.lock',
    'apps/web/node_modules/foo/index.ts',
    'apps/api/src/app.module.ts',
    'docs/readme.md',
    'other/script.py',
    'tests/security/sast/fixtures/llm-guardrails.unsafe.py',
  ].join('\n');

  const diff = resolveTargetFiles({
    mode: 'diff',
    rootDir: repoRoot,
    gitDiffOutput: mockDiff,
  });

  const normalizedDiffFiles = diff.files.map((p) => p.replaceAll('\\', '/'));
  assert.equal(
    normalizedDiffFiles.length,
    2,
    `Expected exactly 2 matching files in diff, got: ${JSON.stringify(normalizedDiffFiles)}`,
  );
  assert.ok(normalizedDiffFiles.some((f) => f.endsWith('apps/agent/src/agent/main.py')));
  assert.ok(normalizedDiffFiles.some((f) => f.endsWith('apps/api/src/app.module.ts')));

  // Empty diff mode
  const emptyDiff = resolveTargetFiles({
    mode: 'diff',
    rootDir: repoRoot,
    gitDiffOutput: '',
  });
  assert.equal(emptyDiff.files.length, 0);
});

test('T031: parseSarifResults normalizes SARIF findings and handles edge cases', () => {
  const mockSarif = {
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'semgrep',
            rules: [
              { id: 'no-llm-in-guardrails', defaultConfiguration: { level: 'error' } },
              { id: 'no-raw-payload-logging', defaultConfiguration: { level: 'warning' } },
            ],
          },
        },
        results: [
          {
            ruleId: 'no-llm-in-guardrails',
            level: 'error',
            message: { text: 'Direct LLM call detected.' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'apps/agent/src/agent/guardrails/bad.py' },
                  region: { startLine: 42, endLine: 42 },
                },
              },
            ],
          },
          {
            ruleId: 'no-raw-payload-logging',
            level: 'warning',
            message: { text: 'Payload logging detected.' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'apps/agent/src/agent/tools/leak.py' },
                  region: { startLine: 10, endLine: 12 },
                },
              },
            ],
          },
        ],
      },
    ],
  };

  const findings = parseSarifResults(mockSarif);
  assert.equal(findings.length, 2);

  assert.equal(findings[0].ruleId, 'no-llm-in-guardrails');
  assert.equal(findings[0].level, 'error');
  assert.equal(findings[0].severity, 'ERROR');
  assert.equal(findings[0].file, 'apps/agent/src/agent/guardrails/bad.py');
  assert.equal(findings[0].startLine, 42);

  assert.equal(findings[1].ruleId, 'no-raw-payload-logging');
  assert.equal(findings[1].level, 'warning');
  assert.equal(findings[1].severity, 'WARNING');
  assert.equal(findings[1].file, 'apps/agent/src/agent/tools/leak.py');
  assert.equal(findings[1].startLine, 10);

  // Empty SARIF
  const emptyFindings = parseSarifResults({ runs: [{ results: [] }] });
  assert.deepEqual(emptyFindings, []);

  // Empty or invalid input
  assert.deepEqual(parseSarifResults(null), []);
  assert.deepEqual(parseSarifResults({}), []);
});

test('T031: evaluateFindings handles baseline matching, valid exceptions, expired exceptions, and non-bypassable rules', () => {
  const finding1 = {
    ruleId: 'no-raw-payload-logging',
    file: 'apps/agent/src/agent/tools/leak.py',
    level: 'warning',
    severity: 'WARNING',
    startLine: 10,
    message: 'Logging payload',
  };

  const hardFinding = {
    ruleId: 'no-llm-in-guardrails',
    file: 'apps/agent/src/agent/guardrails/bad.py',
    level: 'error',
    severity: 'ERROR',
    startLine: 42,
    message: 'LLM inside guardrails',
  };

  // 1. Unbaselined finding without baseline or exceptions fails
  const resUnbaselined = evaluateFindings([finding1]);
  assert.equal(resUnbaselined.passed, false);
  assert.equal(resUnbaselined.unbaselinedCount, 1);
  assert.equal(resUnbaselined.baselinedCount, 0);
  assert.equal(resUnbaselined.exceptedCount, 0);

  // 2. Finding present in baseline passes
  const resBaselined = evaluateFindings([finding1], {
    baseline: [{ ruleId: 'no-raw-payload-logging', file: 'apps/agent/src/agent/tools/leak.py' }],
  });
  assert.equal(resBaselined.passed, true);
  assert.equal(resBaselined.unbaselinedCount, 0);
  assert.equal(resBaselined.baselinedCount, 1);

  // 3. Valid active exception suppresses finding
  const resExcepted = evaluateFindings([finding1], {
    exceptions: [
      {
        id: 'EX-001',
        ruleId: 'no-raw-payload-logging',
        file: 'apps/agent/src/agent/tools/leak.py',
        owner: 'security-team',
        rationale: 'Temporary debug log during test staging',
        compensatingControl: 'Restricted to local development runs',
        createdAt: '2026-09-01T00:00:00Z',
        expiresAt: '2026-09-20T00:00:00Z',
      },
    ],
    currentDate: '2026-09-10T00:00:00Z',
  });
  assert.equal(resExcepted.passed, true);
  assert.equal(resExcepted.unbaselinedCount, 0);
  assert.equal(resExcepted.exceptedCount, 1);

  // 4. Expired exception fails closed
  const resExpired = evaluateFindings([finding1], {
    exceptions: [
      {
        id: 'EX-002',
        ruleId: 'no-raw-payload-logging',
        file: 'apps/agent/src/agent/tools/leak.py',
        owner: 'security-team',
        rationale: 'Expired exception',
        compensatingControl: 'Audit logging in development',
        createdAt: '2019-12-15T00:00:00Z',
        expiresAt: '2020-01-01T00:00:00Z',
      },
    ],
    currentDate: '2026-09-10T00:00:00Z',
  });
  assert.equal(resExpired.passed, false);
  assert.ok(resExpired.errors.some((e) => e.includes('Expired exception') || e.includes('expired')));

  // 5. Non-bypassable rule cannot be suppressed by exceptions
  const resNonBypassable = evaluateFindings([hardFinding], {
    exceptions: [
      {
        id: 'EX-003',
        ruleId: 'no-llm-in-guardrails',
        file: 'apps/agent/src/agent/guardrails/bad.py',
        owner: 'bad-actor',
        rationale: 'Trying to bypass hard rule',
        compensatingControl: 'None',
        createdAt: '2026-09-01T00:00:00Z',
        expiresAt: '2026-09-20T00:00:00Z',
      },
    ],
    currentDate: '2026-09-10T00:00:00Z',
  });
  assert.equal(resNonBypassable.passed, false);
  assert.ok(resNonBypassable.errors.some((e) => e.includes('Non-bypassable rule') || e.includes('cannot be bypassed')));
});

test('T031: runSastScan fails closed on census failure, missing semgrep, scanner crash, and unbaselined findings', () => {
  // 1. Census failure aborts scan
  const censusFail = runSastScan({
    rootDir: repoRoot,
    minCounts: { 'apps/agent': 999999 },
  });
  assert.equal(censusFail.exitCode, 1);
  assert.equal(censusFail.passed, false);
  assert.ok(censusFail.errors.some((e) => e.includes('below required minimum')));

  // 2. Missing Semgrep executable in environment fails closed
  const missingSemgrep = runSastScan({
    rootDir: repoRoot,
    execFn: () => {
      const err = new Error('spawnSync semgrep ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });
  assert.equal(missingSemgrep.exitCode, 1);
  assert.equal(missingSemgrep.passed, false);
  assert.ok(
    missingSemgrep.errors.some((e) => e.includes('Semgrep CLI not found') || e.includes('ENOENT')),
  );

  // 3. Scanner crash (status > 1) fails closed
  const crashedScan = runSastScan({
    rootDir: repoRoot,
    execFn: () => ({ status: 2, stderr: 'Fatal Semgrep segfault / internal error', stdout: '' }),
  });
  assert.equal(crashedScan.exitCode, 1);
  assert.equal(crashedScan.passed, false);
  assert.ok(crashedScan.errors.some((e) => e.includes('crashed') || e.includes('Fatal Semgrep')));

  // 4. Scanner findings (status 1 with findings) fails closed
  const mockFindingSarif = {
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'semgrep' } },
        results: [
          {
            ruleId: 'no-raw-payload-logging',
            level: 'error',
            message: { text: 'Unredacted log detected' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'apps/agent/src/agent/bad.py' },
                  region: { startLine: 1 },
                },
              },
            ],
          },
        ],
      },
    ],
  };

  const findingsScan = runSastScan({
    rootDir: repoRoot,
    execFn: () => ({ status: 1, stdout: JSON.stringify(mockFindingSarif), stderr: '' }),
  });
  assert.equal(findingsScan.exitCode, 1);
  assert.equal(findingsScan.passed, false);
  assert.equal(findingsScan.unbaselinedFindings.length, 1);

  // 5. Clean scan passes with exit code 0
  const mockCleanSarif = {
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'semgrep' } }, results: [] }],
  };
  const cleanScan = runSastScan({
    rootDir: repoRoot,
    execFn: () => ({ status: 0, stdout: JSON.stringify(mockCleanSarif), stderr: '' }),
  });
  assert.equal(cleanScan.exitCode, 0);
  assert.equal(cleanScan.passed, true);
  assert.equal(cleanScan.unbaselinedFindings.length, 0);

  // 6. SARIF output file written if sarifOutput option provided
  const tempDir = mkdtempSync(join(tmpdir(), 'sast-sarif-out-'));
  const sarifPath = join(tempDir, 'output.sarif.json');
  try {
    const outScan = runSastScan({
      rootDir: repoRoot,
      sarifOutput: sarifPath,
      execFn: () => ({ status: 0, stdout: JSON.stringify(mockCleanSarif), stderr: '' }),
    });
    assert.equal(outScan.exitCode, 0);
    assert.ok(existsSync(sarifPath), 'SARIF output file must exist');
    const written = JSON.parse(readFileSync(sarifPath, 'utf8'));
    assert.equal(written.version, '2.1.0');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('T031: main CLI parser dispatches scan, parses arguments, and enforces exit codes', () => {
  const mockCleanSarif = JSON.stringify({
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'semgrep' } }, results: [] }],
  });

  const mockFindingSarif = JSON.stringify({
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'semgrep' } },
        results: [
          {
            ruleId: 'no-llm-in-guardrails',
            level: 'error',
            locations: [{ physicalLocation: { artifactLocation: { uri: 'apps/agent/bad.py' } } }],
          },
        ],
      },
    ],
  });

  let capturedExitCode = null;
  const exitFn = (code) => {
    capturedExitCode = code;
  };

  // Clean scan exit 0
  capturedExitCode = null;
  main(['--mode', 'full'], {
    rootDir: repoRoot,
    execFn: () => ({ status: 0, stdout: mockCleanSarif, stderr: '' }),
    exitFn,
    logFn: () => {},
    errFn: () => {},
  });
  assert.equal(capturedExitCode, 0, 'Clean scan CLI should exit with code 0');

  // Findings scan exit 1
  capturedExitCode = null;
  main(['--mode', 'full'], {
    rootDir: repoRoot,
    execFn: () => ({ status: 1, stdout: mockFindingSarif, stderr: '' }),
    exitFn,
    logFn: () => {},
    errFn: () => {},
  });
  assert.equal(capturedExitCode, 1, 'Findings scan CLI should exit with code 1');

  // Unknown flag exit 1
  capturedExitCode = null;
  main(['--unknown-flag'], {
    rootDir: repoRoot,
    exitFn,
    logFn: () => {},
    errFn: () => {},
  });
  assert.equal(capturedExitCode, 1, 'Unknown flag CLI should exit with code 1');
});

// -----------------------------------------------------------------------------
// T032: SAST Baseline and Temporary Exception Schema Verification
// -----------------------------------------------------------------------------

const canonicalBaselinePath = resolve(repoRoot, 'tests/security/sast/baseline.json');
const canonicalExceptionsPath = resolve(repoRoot, 'tests/security/exceptions.json');

test('T032: baseline.json exists, is valid JSON, and conforms to baseline format', () => {
  assert.ok(existsSync(canonicalBaselinePath), `Baseline file must exist at ${canonicalBaselinePath}`);
  const raw = readFileSync(canonicalBaselinePath, 'utf8');
  const data = JSON.parse(raw);

  assert.equal(data.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(data.version, '1.0.0');
  assert.ok(Array.isArray(data.findings), 'Baseline must contain a findings array');
  assert.equal(data.findings.length, 0, 'Initial baseline findings list must be clean/empty');

  const valResult = validateBaselineSchema(data);
  assert.equal(valResult.valid, true);
  assert.equal(valResult.errors.length, 0);

  const fileValResult = validateBaselineSchema(canonicalBaselinePath);
  assert.equal(fileValResult.valid, true);
  assert.equal(fileValResult.errors.length, 0);
});

test('T032: exceptions.json exists, is valid JSON, and conforms to exception schema', () => {
  assert.ok(existsSync(canonicalExceptionsPath), `Exceptions file must exist at ${canonicalExceptionsPath}`);
  const raw = readFileSync(canonicalExceptionsPath, 'utf8');
  const data = JSON.parse(raw);

  assert.equal(data.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(data.version, '1.0.0');
  assert.ok(Array.isArray(data.exceptions), 'Exceptions file must contain an exceptions array');
  assert.equal(data.exceptions.length, 0, 'Initial exceptions list must be clean/empty');

  const valResult = validateExceptionsSchema(data);
  assert.equal(valResult.valid, true);
  assert.equal(valResult.errors.length, 0);

  const fileValResult = validateExceptionsSchema(canonicalExceptionsPath);
  assert.equal(fileValResult.valid, true);
  assert.equal(fileValResult.errors.length, 0);
});

test('T032: validateBaselineSchema validates findings and rejects invalid entries', () => {
  // Missing version or findings
  assert.equal(validateBaselineSchema({}).valid, false);
  assert.equal(validateBaselineSchema({ version: '1.0.0' }).valid, false);
  assert.equal(validateBaselineSchema({ version: '1.0.0', findings: 'not-array' }).valid, false);

  // Invalid finding structure
  const invalidFinding = validateBaselineSchema({
    version: '1.0.0',
    findings: [{ ruleId: '' }],
  });
  assert.equal(invalidFinding.valid, false);
  assert.ok(invalidFinding.errors.length > 0);

  // Valid baseline with findings
  const validBaseline = validateBaselineSchema({
    version: '1.0.0',
    findings: [
      {
        ruleId: 'no-raw-payload-logging',
        file: 'apps/agent/src/agent/bad.py',
        line: 12,
        fingerprint: 'sha256-abc12345',
        context: 'logger.info(payload)',
      },
    ],
  });
  assert.equal(validBaseline.valid, true);
  assert.equal(validBaseline.findings.length, 1);
});

test('T032: validateException and validateExceptionsSchema reject missing required fields', () => {
  const completeException = {
    id: 'EX-TEST-001',
    ruleId: 'no-raw-payload-logging',
    file: 'apps/agent/src/agent/bad.py',
    owner: 'sec-eng@example.com',
    rationale: 'Temporary debugging during staging deployment',
    compensatingControl: 'Restricted network egress in test sandbox',
    createdAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-09-20T00:00:00Z',
  };

  const validRes = validateException(completeException, { currentDate: '2026-09-10T00:00:00Z' });
  assert.equal(validRes.valid, true, `Expected valid but got: ${validRes.errors.join('; ')}`);

  // Enforce each required field: id, ruleId, file, owner, rationale, compensatingControl, expiresAt
  const requiredFields = [
    'id',
    'ruleId',
    'file',
    'owner',
    'rationale',
    'compensatingControl',
    'expiresAt',
  ];

  for (const field of requiredFields) {
    const incomplete = { ...completeException };
    delete incomplete[field];

    const res = validateException(incomplete, { currentDate: '2026-09-10T00:00:00Z' });
    assert.equal(res.valid, false, `Expected validation failure when ${field} is missing`);
    assert.ok(
      res.errors.some((e) => e.includes(field)),
      `Error should mention missing field ${field}`,
    );
  }

  // validateExceptionsSchema on list containing incomplete exception
  const schemaRes = validateExceptionsSchema(
    {
      version: '1.0.0',
      exceptions: [{ id: 'EX-BAD', ruleId: 'rule-1' }],
    },
    { currentDate: '2026-09-10T00:00:00Z' },
  );
  assert.equal(schemaRes.valid, false);
  assert.ok(schemaRes.errors.length > 0);
});

test('T032: validateException rejects invalid ISO 8601 dates and durations exceeding 30 days', () => {
  const base = {
    id: 'EX-TEST-DUR',
    ruleId: 'no-raw-payload-logging',
    file: 'apps/agent/src/agent/bad.py',
    owner: 'sec-eng@example.com',
    rationale: 'Temporary staging exemption',
    compensatingControl: 'Sandboxed environment',
  };

  // Invalid expiresAt date string
  const invalidDateRes = validateException({
    ...base,
    createdAt: '2026-09-01T00:00:00Z',
    expiresAt: 'not-a-valid-iso-date',
  });
  assert.equal(invalidDateRes.valid, false);
  assert.ok(invalidDateRes.errors.some((e) => e.includes('ISO 8601') || e.includes('expiresAt')));

  // Invalid createdAt date string
  const invalidCreatedRes = validateException({
    ...base,
    createdAt: 'invalid-date',
    expiresAt: '2026-09-20T00:00:00Z',
  });
  assert.equal(invalidCreatedRes.valid, false);
  assert.ok(invalidCreatedRes.errors.some((e) => e.includes('ISO 8601') || e.includes('createdAt')));

  // Exceeding 30 days duration (40 days between createdAt and expiresAt)
  const excessiveDurationRes = validateException(
    {
      ...base,
      createdAt: '2026-09-01T00:00:00Z',
      expiresAt: '2026-10-11T00:00:00Z', // 40 days
    },
    { currentDate: '2026-09-05T00:00:00Z' },
  );
  assert.equal(excessiveDurationRes.valid, false);
  assert.ok(
    excessiveDurationRes.errors.some(
      (e) => e.includes('30 days') || e.includes('duration') || e.includes('exceeds'),
    ),
  );

  // Exactly 30 days duration is allowed
  const exact30DaysRes = validateException(
    {
      ...base,
      createdAt: '2026-09-01T00:00:00Z',
      expiresAt: '2026-10-01T00:00:00Z', // exactly 30 days
    },
    { currentDate: '2026-09-05T00:00:00Z' },
  );
  assert.equal(exact30DaysRes.valid, true, `Expected valid for 30 days: ${exact30DaysRes.errors.join('; ')}`);

  // Omitted createdAt calculates duration from currentDate
  const noCreatedExcessive = validateException(
    {
      ...base,
      expiresAt: '2026-10-25T00:00:00Z', // 45 days after currentDate
    },
    { currentDate: '2026-09-10T00:00:00Z' },
  );
  assert.equal(noCreatedExcessive.valid, false);
  assert.ok(noCreatedExcessive.errors.some((e) => e.includes('30 days') || e.includes('duration')));
});

test('T032: scanner and evaluateFindings fail closed on expired exceptions', () => {
  const expiredException = {
    id: 'EX-EXPIRED',
    ruleId: 'no-raw-payload-logging',
    file: 'apps/agent/src/agent/bad.py',
    owner: 'sec-eng@example.com',
    rationale: 'Expired exception test',
    compensatingControl: 'Sandboxed environment',
    createdAt: '2026-08-01T00:00:00Z',
    expiresAt: '2026-08-20T00:00:00Z',
  };

  // Direct validator check
  const valRes = validateException(expiredException, { currentDate: '2026-09-10T00:00:00Z' });
  assert.equal(valRes.valid, false);
  assert.ok(valRes.errors.some((e) => e.includes('Expired') || e.includes('expired')));

  // evaluateFindings with 0 findings but an expired exception fails closed
  const evalEmptyFindings = evaluateFindings([], {
    exceptions: [expiredException],
    currentDate: '2026-09-10T00:00:00Z',
  });
  assert.equal(evalEmptyFindings.passed, false, 'Expired exception must fail evaluation even with 0 findings');
  assert.ok(evalEmptyFindings.errors.some((e) => e.includes('Expired') || e.includes('expired')));

  // evaluateFindings with matching finding fails closed and counts finding as unbaselined
  const evalMatching = evaluateFindings(
    [
      {
        ruleId: 'no-raw-payload-logging',
        file: 'apps/agent/src/agent/bad.py',
        startLine: 10,
        severity: 'MEDIUM',
        message: 'Leak',
      },
    ],
    {
      exceptions: [expiredException],
      currentDate: '2026-09-10T00:00:00Z',
    },
  );
  assert.equal(evalMatching.passed, false);
  assert.equal(evalMatching.unbaselinedCount, 1);
  assert.equal(evalMatching.exceptedCount, 0);
  assert.ok(evalMatching.errors.some((e) => e.includes('Expired') || e.includes('expired')));
});

test('T032: validateException and evaluateFindings fail closed on non-bypassable rules and Critical/High findings', () => {
  const nonBypassableRules = ['no-llm-in-guardrails', 'no-unshielded-tool-execution'];

  for (const ruleId of nonBypassableRules) {
    const ex = {
      id: `EX-${ruleId}`,
      ruleId,
      file: 'apps/agent/src/agent/guardrails/input.py',
      owner: 'sec-eng@example.com',
      rationale: 'Attempting to bypass hard boundary rule',
      compensatingControl: 'None',
      createdAt: '2026-09-01T00:00:00Z',
      expiresAt: '2026-09-20T00:00:00Z',
    };

    // Validator rejects non-bypassable rule
    const valRes = validateException(ex, { currentDate: '2026-09-10T00:00:00Z' });
    assert.equal(valRes.valid, false);
    assert.ok(
      valRes.errors.some(
        (e) => e.includes('Non-Bypassable') || e.includes('cannot be suppressed') || e.includes('hard boundary'),
      ),
    );

    // evaluateFindings fails closed
    const evalRes = evaluateFindings(
      [
        {
          ruleId,
          file: 'apps/agent/src/agent/guardrails/input.py',
          startLine: 5,
          severity: 'HIGH',
          message: 'Hard boundary violation',
        },
      ],
      {
        exceptions: [ex],
        currentDate: '2026-09-10T00:00:00Z',
      },
    );
    assert.equal(evalRes.passed, false);
    assert.equal(evalRes.unbaselinedCount, 1);
    assert.ok(
      evalRes.errors.some(
        (e) => e.includes('Non-bypassable') || e.includes('cannot be bypassed'),
      ),
    );
  }

  // Critical or High severity findings cannot be suppressed even with generic rules
  for (const severity of ['CRITICAL', 'HIGH']) {
    const ex = {
      id: `EX-${severity}`,
      ruleId: 'no-raw-payload-logging',
      file: 'apps/agent/src/agent/bad.py',
      owner: 'sec-eng@example.com',
      rationale: 'Attempting to suppress critical finding',
      compensatingControl: 'None',
      createdAt: '2026-09-01T00:00:00Z',
      expiresAt: '2026-09-20T00:00:00Z',
    };

    const evalRes = evaluateFindings(
      [
        {
          ruleId: 'no-raw-payload-logging',
          file: 'apps/agent/src/agent/bad.py',
          startLine: 15,
          severity,
          message: 'High severity leak',
        },
      ],
      {
        exceptions: [ex],
        currentDate: '2026-09-10T00:00:00Z',
      },
    );
    assert.equal(evalRes.passed, false, `evaluateFindings must fail for ${severity} severity`);
    assert.equal(evalRes.unbaselinedCount, 1);
    assert.ok(
      evalRes.errors.some(
        (e) => e.includes('Non-bypassable') || e.includes('cannot be bypassed') || e.includes(severity),
      ),
    );
  }
});

test('T032: valid active exception correctly suppresses eligible lower-severity finding', () => {
  const activeException = {
    id: 'EX-VALID-001',
    ruleId: 'no-raw-payload-logging',
    file: 'apps/agent/src/agent/tools/debug.py',
    owner: 'sec-eng@example.com',
    rationale: 'Temporary staging debug logging',
    compensatingControl: 'Redacted stream output in production sandbox',
    createdAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-09-25T00:00:00Z',
  };

  const finding = {
    ruleId: 'no-raw-payload-logging',
    file: 'apps/agent/src/agent/tools/debug.py',
    startLine: 30,
    severity: 'MEDIUM',
    message: 'Raw payload logging detected',
  };

  const evalRes = evaluateFindings([finding], {
    exceptions: [activeException],
    currentDate: '2026-09-10T00:00:00Z',
  });

  assert.equal(evalRes.passed, true);
  assert.equal(evalRes.totalFindings, 1);
  assert.equal(evalRes.unbaselinedCount, 0);
  assert.equal(evalRes.exceptedCount, 1);
  assert.equal(evalRes.errors.length, 0);
});

