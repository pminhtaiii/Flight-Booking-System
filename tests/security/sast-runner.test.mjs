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
  validateBaselineFinding,
  validateBaselineSchema,
  validateException,
  validateExceptionsSchema,
  runAstFallbackScan,
  computeFindingFingerprint,
  DEFAULT_STANDARD_RULESETS,
  NON_BYPASSABLE_RULES,
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
      expectedLanguages: ['typescript'],
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
  const content = readFileSync(rulesetYamlPath, 'utf8');

  assert.match(
    content,
    /#\s*(ruleset:\s*\w+|metadata:[\s\S]*name:\s*['"]?\w+['"]?)/,
    'ruleset.yml must define a ruleset name in comments',
  );

  // Verify pinned version matches toolchain.json semgrep version 1.88.0
  assert.match(content, /#\s*(version:\s*['"]?1\.88\.0['"]?|pinned_toolchain_version:\s*['"]?1\.88\.0['"]?)/, 'ruleset.yml must pin Semgrep version to 1.88.0 in comments');

  // Verify inclusion or reference of guardrails.yml
  assert.match(
    content,
    /#\s*includes:[\s\S]*-?\s*['"]?guardrails\.yml['"]?/,
    'ruleset.yml must include or reference guardrails.yml in comments',
  );

  // Verify interprocedural properties are documented with behavioral test requirements
  assert.match(
    content,
    /#\s*interprocedural_properties:[\s\S]*#\s*behavioral_tests_required:/,
    'ruleset.yml metadata must document behavioral_tests_required for interprocedural guarantees in comments',
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
  assert.ok(
    resExpired.errors.some((e) => e.includes('Expired exception') || e.includes('expired')),
  );

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
  assert.ok(
    resNonBypassable.errors.some(
      (e) => e.includes('Non-bypassable rule') || e.includes('cannot be bypassed'),
    ),
  );
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
  assert.ok(
    existsSync(canonicalBaselinePath),
    `Baseline file must exist at ${canonicalBaselinePath}`,
  );
  const raw = readFileSync(canonicalBaselinePath, 'utf8');
  const data = JSON.parse(raw);

  assert.equal(data.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(data.version, '1.0.0');
  assert.ok(Array.isArray(data.findings), 'Baseline must contain a findings array');
  assert.equal(data.findings.length, 2, 'Baseline findings list must contain 2 pre-existing benign findings');
  assert.ok(
    data.findings.some(
      (f) =>
        f.ruleId ===
        'javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp',
    ),
  );
  assert.ok(
    data.findings.some(
      (f) =>
        f.ruleId ===
        'javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key',
    ),
  );

  const valResult = validateBaselineSchema(data);
  assert.equal(valResult.valid, true);
  assert.equal(valResult.errors.length, 0);

  const fileValResult = validateBaselineSchema(canonicalBaselinePath);
  assert.equal(fileValResult.valid, true);
  assert.equal(fileValResult.errors.length, 0);
});

test('T032: exceptions.json exists, is valid JSON, and conforms to exception schema', () => {
  assert.ok(
    existsSync(canonicalExceptionsPath),
    `Exceptions file must exist at ${canonicalExceptionsPath}`,
  );
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
  assert.ok(
    invalidCreatedRes.errors.some((e) => e.includes('ISO 8601') || e.includes('createdAt')),
  );

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
  assert.equal(
    exact30DaysRes.valid,
    true,
    `Expected valid for 30 days: ${exact30DaysRes.errors.join('; ')}`,
  );

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
  assert.equal(
    evalEmptyFindings.passed,
    false,
    'Expired exception must fail evaluation even with 0 findings',
  );
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
        (e) =>
          e.includes('Non-Bypassable') ||
          e.includes('cannot be suppressed') ||
          e.includes('hard boundary'),
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
      evalRes.errors.some((e) => e.includes('Non-bypassable') || e.includes('cannot be bypassed')),
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
        (e) =>
          e.includes('Non-bypassable') || e.includes('cannot be bypassed') || e.includes(severity),
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

// -----------------------------------------------------------------------------
// Issue 1: Standard Rulesets Never Run (scripts/security/run-sast.mjs:736-739)
// -----------------------------------------------------------------------------
test('Issue 1: default scan configs include pinned standard rulesets and skip existsSync for registry packages', () => {
  // 1. DEFAULT_STANDARD_RULESETS constant is exported and has required rulesets
  assert.ok(Array.isArray(DEFAULT_STANDARD_RULESETS), 'DEFAULT_STANDARD_RULESETS must be an array');
  assert.equal(DEFAULT_STANDARD_RULESETS.length, 4);
  assert.ok(
    DEFAULT_STANDARD_RULESETS.includes('p/default') ||
      DEFAULT_STANDARD_RULESETS.includes('p/default@v1.88.0'),
  );
  assert.ok(
    DEFAULT_STANDARD_RULESETS.includes('p/owasp-top-ten') ||
      DEFAULT_STANDARD_RULESETS.includes('p/owasp-top-ten@v1.88.0'),
  );
  assert.ok(
    DEFAULT_STANDARD_RULESETS.includes('p/security-audit') ||
      DEFAULT_STANDARD_RULESETS.includes('p/security-audit@v1.88.0'),
  );
  assert.ok(
    DEFAULT_STANDARD_RULESETS.includes('p/secrets') ||
      DEFAULT_STANDARD_RULESETS.includes('p/secrets@v1.88.0'),
  );

  // 2. Default configs passed to Semgrep include guardrails.yml, ruleset.yml, and DEFAULT_STANDARD_RULESETS
  let capturedArgs = null;
  const mockCleanSarif = JSON.stringify({
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'semgrep' } }, results: [] }],
  });

  const res = runSastScan({
    rootDir: repoRoot,
    execFn: (cmd, args) => {
      capturedArgs = args;
      return { status: 0, stdout: mockCleanSarif, stderr: '' };
    },
  });

  assert.equal(res.passed, true, `Expected scan to pass: ${res.errors.join('; ')}`);
  assert.ok(capturedArgs, 'Semgrep must have been invoked');

  // Verify each default config is present in args
  const configIndices = [];
  for (let i = 0; i < capturedArgs.length; i++) {
    if (capturedArgs[i] === '--config') {
      configIndices.push(capturedArgs[i + 1]);
    }
  }

  assert.ok(configIndices.some((c) => c.endsWith('guardrails.yml')));
  assert.ok(configIndices.some((c) => c.endsWith('ruleset.yml')));
  for (const standardRuleset of DEFAULT_STANDARD_RULESETS) {
    const sanitized = standardRuleset.replace(/\//g, '-');
    assert.ok(
      configIndices.some(
        (c) =>
          c === standardRuleset ||
          c.startsWith(`${standardRuleset}@`) ||
          c.replaceAll('\\', '/').includes(`tests/security/sast/snapshots/${sanitized}.json`) ||
          c.replaceAll('\\', '/').includes(`tests/security/sast/snapshots/${sanitized}.yml`),
      ),
      `CLI arguments must include registry config ${standardRuleset}, its version, or resolved local snapshot path`,
    );
  }

  // 3. Custom registry configs (starting with p/ or r/) do not fail existsSync
  let customRegistryArgs = null;
  const customRegistryRes = runSastScan({
    rootDir: repoRoot,
    configs: ['p/my-custom-pack@v1.0.0', 'r/ruleset@v2.0.0'],
    execFn: (cmd, args) => {
      customRegistryArgs = args;
      return { status: 0, stdout: mockCleanSarif, stderr: '' };
    },
  });
  assert.equal(customRegistryRes.passed, true);
  assert.ok(
    customRegistryArgs.includes('p/my-custom-pack@v1.0.0'),
    'CLI arguments must preserve exact version tag for p/my-custom-pack@v1.0.0',
  );
  assert.ok(
    customRegistryArgs.includes('r/ruleset@v2.0.0'),
    'CLI arguments must preserve exact version tag for r/ruleset@v2.0.0',
  );
});

test('caller-specified registry config version tag is preserved in semgrepArgs and never stripped', () => {
  const mockCleanSarif = JSON.stringify({
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'semgrep' } }, results: [] }],
  });
  let capturedArgs = null;
  const res = runSastScan({
    rootDir: repoRoot,
    configs: ['p/my-pack@v1.0.0', 'r/ruleset@v2.0.0', 'p/owasp-top-ten@v2024.1'],
    execFn: (cmd, args) => {
      capturedArgs = args;
      return { status: 0, stdout: mockCleanSarif, stderr: '' };
    },
  });

  assert.equal(res.passed, true, `Expected scan to pass: ${res.errors.join('; ')}`);
  assert.ok(capturedArgs, 'Semgrep must have been invoked');

  const semgrepConfigs = [];
  for (let i = 0; i < capturedArgs.length; i++) {
    if (capturedArgs[i] === '--config') {
      semgrepConfigs.push(capturedArgs[i + 1]);
    }
  }

  assert.ok(
    semgrepConfigs.includes('p/my-pack@v1.0.0'),
    'semgrepArgs must preserve exact caller version p/my-pack@v1.0.0 without stripping',
  );
  assert.ok(
    !semgrepConfigs.includes('p/my-pack'),
    'semgrepArgs must NOT strip version tag to bare alias p/my-pack',
  );
  assert.ok(
    semgrepConfigs.includes('r/ruleset@v2.0.0'),
    'semgrepArgs must preserve exact caller version r/ruleset@v2.0.0',
  );
  assert.ok(
    !semgrepConfigs.includes('r/ruleset'),
    'semgrepArgs must NOT strip version tag to bare alias r/ruleset',
  );
  assert.ok(
    semgrepConfigs.includes('p/owasp-top-ten@v2024.1'),
    'semgrepArgs must preserve explicit version p/owasp-top-ten@v2024.1 even when local unversioned snapshot exists',
  );
});

test('registry packs resolve to local snapshot files when local snapshots exist to lock registry content', () => {
  const mockCleanSarif = JSON.stringify({
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'semgrep' } }, results: [] }],
  });
  let capturedArgs = null;
  const res = runSastScan({
    rootDir: repoRoot,
    configs: ['p/default', 'p/owasp-top-ten', 'p/security-audit', 'p/secrets'],
    execFn: (cmd, args) => {
      capturedArgs = args;
      return { status: 0, stdout: mockCleanSarif, stderr: '' };
    },
  });

  assert.equal(res.passed, true, `Expected scan to pass: ${res.errors.join('; ')}`);
  assert.ok(capturedArgs, 'Semgrep must have been invoked');

  const semgrepConfigs = [];
  for (let i = 0; i < capturedArgs.length; i++) {
    if (capturedArgs[i] === '--config') {
      semgrepConfigs.push(capturedArgs[i + 1]);
    }
  }

  const expectedSnapshots = [
    'p-default.json',
    'p-owasp-top-ten.json',
    'p-security-audit.json',
    'p-secrets.json',
  ];

  for (const snapshotName of expectedSnapshots) {
    const expectedPath = resolve(repoRoot, 'tests/security/sast/snapshots', snapshotName);
    assert.ok(
      semgrepConfigs.includes(expectedPath),
      `semgrepArgs must resolve registry config to locked local snapshot: ${expectedPath}`,
    );
  }

  // Verify bare registry aliases are not passed when snapshots exist
  for (const pack of ['p/default', 'p/owasp-top-ten', 'p/security-audit', 'p/secrets']) {
    assert.ok(
      !semgrepConfigs.includes(pack),
      `semgrepArgs must NOT contain bare mutable registry alias ${pack} when snapshot exists`,
    );
  }

  // Registry pack without local snapshot passes through as-is
  let unmappedArgs = null;
  const unmappedRes = runSastScan({
    rootDir: repoRoot,
    configs: ['p/unmatched-custom-pack'],
    execFn: (cmd, args) => {
      unmappedArgs = args;
      return { status: 0, stdout: mockCleanSarif, stderr: '' };
    },
  });
  assert.equal(unmappedRes.passed, true);
  assert.ok(
    unmappedArgs.includes('p/unmatched-custom-pack'),
    'semgrepArgs must use cfg as-is when no local snapshot exists',
  );
});

// -----------------------------------------------------------------------------
// Issue 2: Baseline Bypasses Blocking Checks (scripts/security/run-sast.mjs:522-532)
// -----------------------------------------------------------------------------
test('Issue 2: validateBaselineFinding and evaluateFindings reject non-bypassable rules and blocking severities with path boundary matching', () => {
  // 1. validateBaselineFinding rejects non-bypassable rules
  for (const ruleId of NON_BYPASSABLE_RULES) {
    const res = validateBaselineFinding({ ruleId, file: 'apps/agent/src/agent/guardrails/bad.py' });
    assert.equal(res.valid, false, `Baseline finding for ${ruleId} should be rejected`);
    assert.ok(res.errors.some((e) => e.includes('non-bypassable')));
  }

  // 2. validateBaselineFinding rejects CRITICAL, HIGH, and ERROR severities
  for (const severity of ['CRITICAL', 'HIGH', 'ERROR']) {
    const res = validateBaselineFinding({
      ruleId: 'no-raw-payload-logging',
      file: 'apps/agent/src/agent/tools/debug.py',
      severity,
    });
    assert.equal(res.valid, false, `Baseline finding with severity ${severity} must be rejected`);
    assert.ok(res.errors.some((e) => e.includes('non-bypassable') || e.includes(severity)));
  }

  // Lower severity in baseline finding is accepted
  const validLow = validateBaselineFinding({
    ruleId: 'no-raw-payload-logging',
    file: 'apps/agent/src/agent/tools/debug.py',
    severity: 'LOW',
  });
  assert.equal(validLow.valid, true);

  // 3. evaluateFindings fails closed if matching baseline targets non-bypassable rule or CRITICAL/HIGH/ERROR
  const hardFinding = {
    ruleId: 'no-llm-in-guardrails',
    file: 'apps/agent/src/agent/guardrails/bad.py',
    startLine: 15,
    severity: 'MEDIUM',
    message: 'Hard violation',
  };
  const evalHard = evaluateFindings([hardFinding], {
    baseline: [{ ruleId: 'no-llm-in-guardrails', file: 'apps/agent/src/agent/guardrails/bad.py' }],
  });
  assert.equal(evalHard.passed, false, 'Non-bypassable rule in baseline must fail closed');
  assert.equal(evalHard.baselinedCount, 0);
  assert.equal(evalHard.unbaselinedCount, 1);
  assert.ok(evalHard.errors.some((e) => e.includes('Non-Bypassable Rule Violation')));

  for (const sev of ['CRITICAL', 'HIGH', 'ERROR']) {
    const blockingFinding = {
      ruleId: 'no-raw-payload-logging',
      file: 'apps/agent/src/agent/tools/leak.py',
      startLine: 20,
      severity: sev,
      message: `${sev} leak`,
    };
    const evalBlocking = evaluateFindings([blockingFinding], {
      baseline: [{ ruleId: 'no-raw-payload-logging', file: 'apps/agent/src/agent/tools/leak.py' }],
    });
    assert.equal(evalBlocking.passed, false, `Severity ${sev} in baseline must fail closed`);
    assert.equal(evalBlocking.baselinedCount, 0);
    assert.equal(evalBlocking.unbaselinedCount, 1);
    assert.ok(evalBlocking.errors.some((e) => e.includes('Non-Bypassable Rule Violation')));
  }

  // 4. Suffix matching respects path boundaries
  const findingNotMain = {
    ruleId: 'no-raw-payload-logging',
    file: 'apps/agent/src/agent/notmain.py',
    startLine: 1,
    severity: 'LOW',
    message: 'Test',
  };
  const evalBoundaryMismatch = evaluateFindings([findingNotMain], {
    baseline: [{ ruleId: 'no-raw-payload-logging', file: 'main.py' }],
  });
  assert.equal(evalBoundaryMismatch.passed, false, 'notmain.py must NOT match baseline main.py');
  assert.equal(evalBoundaryMismatch.unbaselinedCount, 1);

  const findingMain = {
    ruleId: 'no-raw-payload-logging',
    file: 'apps/agent/src/agent/main.py',
    startLine: 1,
    severity: 'LOW',
    message: 'Test',
  };
  const evalBoundaryMatch = evaluateFindings([findingMain], {
    baseline: [{ ruleId: 'no-raw-payload-logging', file: 'agent/main.py' }],
  });
  assert.equal(evalBoundaryMatch.passed, true, 'agent/main.py must match baseline agent/main.py');
  assert.equal(evalBoundaryMatch.baselinedCount, 1);
});

// -----------------------------------------------------------------------------
// Issue 3: Severity Mapping Allows Suppression (scripts/security/run-sast.mjs:216-220)
// -----------------------------------------------------------------------------
test('Issue 3: parseSarifResults maps CVSS numeric and string severities, and ERROR is recognized as blocking', () => {
  // 1. Numeric CVSS scores
  const mockSarifCVSS = {
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'semgrep', rules: [] } },
        results: [
          {
            ruleId: 'cvss-critical',
            level: 'warning',
            properties: { 'security-severity': 9.8 },
            locations: [
              { physicalLocation: { artifactLocation: { uri: 'apps/agent/src/crit.py' } } },
            ],
          },
          {
            ruleId: 'cvss-high',
            level: 'warning',
            properties: { 'security-severity': '7.5' },
            locations: [
              { physicalLocation: { artifactLocation: { uri: 'apps/agent/src/high.py' } } },
            ],
          },
          {
            ruleId: 'cvss-medium',
            level: 'note',
            properties: { 'security-severity': 5.5 },
            locations: [
              { physicalLocation: { artifactLocation: { uri: 'apps/agent/src/med.py' } } },
            ],
          },
          {
            ruleId: 'cvss-low',
            level: 'error',
            properties: { 'security-severity': 2.5 },
            locations: [
              { physicalLocation: { artifactLocation: { uri: 'apps/agent/src/low.py' } } },
            ],
          },
        ],
      },
    ],
  };

  const cvssFindings = parseSarifResults(mockSarifCVSS);
  assert.equal(cvssFindings.length, 4);
  assert.equal(cvssFindings[0].severity, 'CRITICAL');
  assert.equal(cvssFindings[1].severity, 'HIGH');
  assert.equal(cvssFindings[2].severity, 'MEDIUM');
  assert.equal(cvssFindings[3].severity, 'LOW');

  // 2. Rule metadata severity fallback
  const mockRuleMetaSarif = {
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'semgrep',
            rules: [
              { id: 'rule-critical', properties: { 'security-severity': '9.0' } },
              { id: 'rule-error-str', properties: { severity: 'error' } },
            ],
          },
        },
        results: [
          {
            ruleId: 'rule-critical',
            locations: [{ physicalLocation: { artifactLocation: { uri: 'apps/agent/src/a.py' } } }],
          },
          {
            ruleId: 'rule-error-str',
            locations: [{ physicalLocation: { artifactLocation: { uri: 'apps/agent/src/b.py' } } }],
          },
        ],
      },
    ],
  };

  const ruleMetaFindings = parseSarifResults(mockRuleMetaSarif);
  assert.equal(ruleMetaFindings[0].severity, 'CRITICAL');
  assert.equal(ruleMetaFindings[1].severity, 'ERROR');

  // 3. validateException blocks ERROR severity
  const exError = {
    id: 'EX-ERR-001',
    ruleId: 'some-rule',
    file: 'apps/agent/src/agent.py',
    owner: 'sec-eng',
    rationale: 'Suppression test',
    compensatingControl: 'None',
    severity: 'ERROR',
    createdAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-09-20T00:00:00Z',
  };
  const valExRes = validateException(exError, { currentDate: '2026-09-10T00:00:00Z' });
  assert.equal(valExRes.valid, false, 'validateException must reject ERROR severity');
  assert.ok(valExRes.errors.some((e) => e.includes('ERROR')));

  // 4. evaluateFindings blocks ERROR severity from being excepted
  const findingError = {
    ruleId: 'generic-rule',
    file: 'apps/agent/src/agent.py',
    startLine: 10,
    severity: 'ERROR',
    message: 'Error finding',
  };
  const exValidObj = {
    id: 'EX-VALID-BUT-SEV-BLOCKED',
    ruleId: 'generic-rule',
    file: 'apps/agent/src/agent.py',
    owner: 'sec-eng',
    rationale: 'Suppression test',
    compensatingControl: 'None',
    createdAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-09-20T00:00:00Z',
  };
  const evalError = evaluateFindings([findingError], {
    exceptions: [exValidObj],
    currentDate: '2026-09-10T00:00:00Z',
  });
  assert.equal(
    evalError.passed,
    false,
    'evaluateFindings must block ERROR severity from exceptions',
  );
  assert.equal(evalError.unbaselinedCount, 1);
  assert.ok(
    evalError.errors.some(
      (e) => e.includes('Non-Bypassable Rule Violation') || e.includes('ERROR'),
    ),
  );
});

// -----------------------------------------------------------------------------
// Issue 4: Exceptions Suppress Unrelated Findings (scripts/security/run-sast.mjs:536-540)
// -----------------------------------------------------------------------------
test('Issue 4: exception matching enforces path boundaries, line/fingerprint matching, and single consumption', () => {
  // 1. Path boundary enforcement for exceptions
  const findingSafe = {
    ruleId: 'no-raw-payload-logging',
    file: 'apps/agent/src/agent/safe_bad.py',
    startLine: 10,
    severity: 'LOW',
    message: 'Test',
  };
  const exBad = {
    id: 'EX-BAD-FILE',
    ruleId: 'no-raw-payload-logging',
    file: 'bad.py',
    owner: 'sec-eng',
    rationale: 'Specific file exception',
    compensatingControl: 'Audit',
    createdAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-09-20T00:00:00Z',
  };
  const evalPathMismatch = evaluateFindings([findingSafe], {
    exceptions: [exBad],
    currentDate: '2026-09-10T00:00:00Z',
  });
  assert.equal(evalPathMismatch.passed, false, 'safe_bad.py must NOT match exception bad.py');
  assert.equal(evalPathMismatch.unbaselinedCount, 1);

  // 2. Line matching enforcement
  const findingLine40 = {
    ruleId: 'no-raw-payload-logging',
    file: 'apps/agent/src/agent/bad.py',
    startLine: 40,
    severity: 'LOW',
    message: 'Test',
  };
  const exLine10 = {
    ...exBad,
    id: 'EX-LINE-10',
    file: 'apps/agent/src/agent/bad.py',
    line: 10,
  };
  const evalLineMismatch = evaluateFindings([findingLine40], {
    exceptions: [exLine10],
    currentDate: '2026-09-10T00:00:00Z',
  });
  assert.equal(
    evalLineMismatch.passed,
    false,
    'Line 40 must not match exception specifying line 10',
  );

  const findingLine10 = { ...findingLine40, startLine: 10 };
  const evalLineMatch = evaluateFindings([findingLine10], {
    exceptions: [exLine10],
    currentDate: '2026-09-10T00:00:00Z',
  });
  assert.equal(evalLineMatch.passed, true, 'Line 10 must match exception specifying line 10');

  // 3. Fingerprint matching enforcement
  const findingFp1 = {
    ruleId: 'no-raw-payload-logging',
    file: 'apps/agent/src/agent/bad.py',
    startLine: 10,
    severity: 'LOW',
    fingerprint: 'fp-target-12345',
    message: 'Test',
  };
  const exFpMismatch = {
    ...exBad,
    id: 'EX-FP-MISMATCH',
    file: 'apps/agent/src/agent/bad.py',
    fingerprint: 'fp-other-99999',
  };
  const evalFpMismatch = evaluateFindings([findingFp1], {
    exceptions: [exFpMismatch],
    currentDate: '2026-09-10T00:00:00Z',
  });
  assert.equal(evalFpMismatch.passed, false, 'Fingerprint mismatch must not match exception');

  const exFpMatch = { ...exFpMismatch, id: 'EX-FP-MATCH', fingerprint: 'fp-target-12345' };
  const evalFpMatch = evaluateFindings([findingFp1], {
    exceptions: [exFpMatch],
    currentDate: '2026-09-10T00:00:00Z',
  });
  assert.equal(evalFpMatch.passed, true, 'Matching fingerprint must be suppressed');

  // 4. Consumed exception IDs - single exception cannot suppress multiple findings
  const findingA = {
    ruleId: 'no-raw-payload-logging',
    file: 'apps/agent/src/agent/bad.py',
    startLine: 10,
    severity: 'LOW',
    message: 'Leak 1',
  };
  const findingB = {
    ruleId: 'no-raw-payload-logging',
    file: 'apps/agent/src/agent/bad.py',
    startLine: 20,
    severity: 'LOW',
    message: 'Leak 2',
  };
  const singleEx = {
    id: 'EX-SINGLE-USE',
    ruleId: 'no-raw-payload-logging',
    file: 'apps/agent/src/agent/bad.py',
    owner: 'sec-eng',
    rationale: 'Only one finding allowed',
    compensatingControl: 'Audit',
    createdAt: '2026-09-01T00:00:00Z',
    expiresAt: '2026-09-20T00:00:00Z',
  };
  const evalDoubleUse = evaluateFindings([findingA, findingB], {
    exceptions: [singleEx],
    currentDate: '2026-09-10T00:00:00Z',
  });
  assert.equal(evalDoubleUse.passed, false, 'Single exception cannot suppress both findings');
  assert.equal(evalDoubleUse.exceptedCount, 1, 'Exactly one finding must be excepted');
  assert.equal(evalDoubleUse.unbaselinedCount, 1, 'Second finding must remain unbaselined');

  // 5. Deterministic fingerprint presence in parseSarifResults and computeFindingFingerprint
  const fpRes = parseSarifResults({
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'semgrep' } },
        results: [
          {
            ruleId: 'rule-fp-test',
            message: { text: 'msg' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'test.py' },
                  region: { startLine: 5 },
                },
              },
            ],
          },
        ],
      },
    ],
  });
  assert.ok(fpRes[0].fingerprint, 'Finding must have a deterministic fingerprint');
  const expectedFp = computeFindingFingerprint('rule-fp-test', 'test.py', 5, 'msg');
  assert.equal(fpRes[0].fingerprint, expectedFp);

  // 6. validateException validates line and fingerprint if present
  const invalidLineEx = validateException({ ...singleEx, line: -5 });
  assert.equal(invalidLineEx.valid, false, 'Negative line number must be rejected');

  const invalidFpEx = validateException({ ...singleEx, fingerprint: '   ' });
  assert.equal(invalidFpEx.valid, false, 'Empty string fingerprint must be rejected');
});

// -----------------------------------------------------------------------------
// Issue 5: Malformed SARIF Passes Cleanly (scripts/security/run-sast.mjs:198-206)
// -----------------------------------------------------------------------------
test('Issue 5: malformed SARIF throws in parseSarifResults and fails closed in runSastScan', () => {
  // 1. parseSarifResults throws SyntaxError on invalid JSON string
  assert.throws(
    () => parseSarifResults('{ invalid json syntax'),
    (err) => err instanceof SyntaxError,
    'Invalid JSON string must throw SyntaxError',
  );

  // 2. parseSarifResults throws Error on object without runs array (when not empty object {})
  assert.throws(
    () => parseSarifResults({ version: '2.1.0', wrongKey: [] }),
    (err) => err.message.includes('runs'),
    'SARIF missing runs array must throw an error',
  );

  assert.throws(
    () => parseSarifResults({ runs: 'not-an-array' }),
    (err) => err.message.includes('runs'),
    'SARIF with non-array runs must throw an error',
  );

  // Empty object {} returns []
  assert.deepEqual(parseSarifResults({}), []);
  assert.deepEqual(parseSarifResults(null), []);

  // 3. runSastScan catches parse error, logs [SAST Parse Error], and returns passed: false, exitCode: 1
  const malformedScan = runSastScan({
    rootDir: repoRoot,
    execFn: () => ({ status: 0, stdout: '<<< NOT JSON AT ALL >>>', stderr: '' }),
  });
  assert.equal(malformedScan.passed, false, 'Malformed SARIF scan must fail');
  assert.equal(malformedScan.exitCode, 1, 'Malformed SARIF scan must exit with code 1');
  assert.ok(
    malformedScan.errors.some((e) => e.includes('[SAST Parse Error]')),
    `Expected [SAST Parse Error] in: ${malformedScan.errors.join('; ')}`,
  );

  const missingRunsScan = runSastScan({
    rootDir: repoRoot,
    execFn: () => ({
      status: 0,
      stdout: JSON.stringify({ version: '2.1.0', noRunsHere: true }),
      stderr: '',
    }),
  });
  assert.equal(missingRunsScan.passed, false);
  assert.equal(missingRunsScan.exitCode, 1);
  assert.ok(
    missingRunsScan.errors.some((e) => e.includes('[SAST Parse Error]')),
    `Expected [SAST Parse Error] for missing runs in: ${missingRunsScan.errors.join('; ')}`,
  );
});

// -----------------------------------------------------------------------------
// Issue 6: Fallback Silently Skips Failures (scripts/security/run-sast.mjs:621-625)
// -----------------------------------------------------------------------------
test('Issue 6: runAstFallbackScan returns { findings, errors }, reports failures, and runSastScan fails closed', () => {
  // 1. runAstFallbackScan returns { findings, errors }
  const cleanResult = runAstFallbackScan([], repoRoot);
  assert.ok(cleanResult && typeof cleanResult === 'object');
  assert.ok(Array.isArray(cleanResult.findings));
  assert.ok(Array.isArray(cleanResult.errors));

  // 2. Python source file with syntax error reports in errors
  const brokenPyRel = 'apps/agent/src/agent/temp_broken_syntax.py';
  const brokenPyPath = resolve(repoRoot, brokenPyRel);
  writeFileSync(brokenPyPath, 'def broken_syntax(:\n    pass\n', 'utf8');

  try {
    const pyResult = runAstFallbackScan([brokenPyRel], repoRoot);
    assert.ok(pyResult.errors.length > 0, 'AST syntax error must be reported in errors');
    assert.ok(
      pyResult.errors.some(
        (e) => e.includes('temp_broken_syntax.py') || e.includes('AST parse error'),
      ),
      `Expected syntax error details in: ${pyResult.errors.join('; ')}`,
    );

    // 3. TSX read error reports in errors
    const nonExistentTsx = 'apps/web/non_existent_file.tsx';
    const tsxResult = runAstFallbackScan([nonExistentTsx], repoRoot);
    assert.ok(
      tsxResult.errors.some((e) => e.includes('non_existent_file.tsx')),
      `Expected TSX error in: ${tsxResult.errors.join('; ')}`,
    );

    // 4. runSastScan fails closed when fallback scanner reports errors
    const scanWithFallbackErr = runSastScan({
      rootDir: repoRoot,
      allowAstFallback: true,
      execFn: () => ({ status: 127, stderr: 'semgrep: command not found', stdout: '' }),
      gitDiffOutput: brokenPyRel,
      mode: 'diff',
    });

    assert.equal(scanWithFallbackErr.passed, false, 'Scan with fallback errors must fail closed');
    assert.equal(
      scanWithFallbackErr.exitCode,
      1,
      'Scan with fallback errors must exit with code 1',
    );
    assert.ok(
      scanWithFallbackErr.errors.some((e) => e.includes('[AST Fallback Error]')),
      `Expected [AST Fallback Error] in: ${scanWithFallbackErr.errors.join('; ')}`,
    );
  } finally {
    if (existsSync(brokenPyPath)) {
      rmSync(brokenPyPath, { force: true });
    }
  }
});

// -----------------------------------------------------------------------------
// Issue 7: Git Failure Becomes Success (scripts/security/run-sast.mjs:132-146)
// -----------------------------------------------------------------------------
test('Issue 7: resolveTargetFiles returns passed: false on git failure and runSastScan fails closed', () => {
  // 1. resolveTargetFiles with mode: 'diff' fails when git fails
  const failedDiff = resolveTargetFiles({
    mode: 'diff',
    rootDir: repoRoot,
    execFn: () => ({
      status: 128,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    }),
  });

  assert.equal(
    failedDiff.passed,
    false,
    'resolveTargetFiles must report passed: false when git fails',
  );
  assert.equal(failedDiff.files.length, 0);
  assert.ok(failedDiff.errors.length > 0);
  assert.ok(
    failedDiff.errors.some(
      (e) => e.includes('[Git Diff Error]') || e.includes('git command exited with status 128'),
    ),
    `Expected git diff error in: ${failedDiff.errors.join('; ')}`,
  );

  // 2. resolveTargetFiles with exec error (e.g. ENOENT / crash)
  const threwDiff = resolveTargetFiles({
    mode: 'diff',
    rootDir: repoRoot,
    execFn: () => {
      const err = new Error('git spawn ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });
  assert.equal(threwDiff.passed, false);
  assert.ok(threwDiff.errors.some((e) => e.includes('[Git Diff Error]')));

  // 3. runSastScan in diff mode fails closed when git diff fails
  const failedScan = runSastScan({
    mode: 'diff',
    rootDir: repoRoot,
    execFn: () => ({
      status: 128,
      stdout: '',
      stderr: 'fatal: ambiguous argument "origin/development...HEAD"',
    }),
  });

  assert.equal(
    failedScan.passed,
    false,
    'runSastScan must fail closed on git failure in diff mode',
  );
  assert.equal(failedScan.exitCode, 1, 'runSastScan must exit with code 1 on git failure');
  assert.ok(
    failedScan.errors.some((e) => e.includes('[Git Diff Error]')),
    `Expected [Git Diff Error] in scan output: ${failedScan.errors.join('; ')}`,
  );
});

// -----------------------------------------------------------------------------
// Issue 1: Fallback Omits Standard Rules (scripts/security/run-sast.mjs)
// -----------------------------------------------------------------------------
test('Issue 1: runAstFallbackScan evaluates configured standard packs (p/secrets, p/owasp-top-ten, p/security-audit, p/default)', () => {
  const pyRelPath = 'apps/agent/src/agent/temp_sast_test_vulns.py';
  const pyFullPath = resolve(repoRoot, pyRelPath);

  const tsRelPath = 'apps/web/temp_sast_test_vulns.ts';
  const tsFullPath = resolve(repoRoot, tsRelPath);

  const mockStripeKey1 = ['sk', 'test', '1234567890abcdef12345678'].join('_');
  const mockStripeKey2 = ['sk', 'test', 'abcdef1234567890abcdef12'].join('_');
  const mockAwsKey = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

  const pyContent = `
import os, subprocess, pickle, yaml, hashlib, marshal, shelve

# p/secrets violations
STRIPE_KEY = "${mockStripeKey1}"
AWS_KEY = "${mockAwsKey}"
secret_api_key = "very_secret_production_key_12345"

# p/owasp-top-ten violations
eval("1 + 1")
exec("x = 2")
os.system("echo hello")
subprocess.run("ls -la", shell=True)
cursor = None
user_id = 42
if cursor:
    cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")

# p/security-audit violations
pickle.loads(b"cos\\nsystem\\n(S'ls'\\ntR.")
yaml.load("key: value")
hashlib.md5(b"weak")
hashlib.sha1(b"weak")

# p/default violations
import marshal
from shelve import open as shelve_open
`;

  const tsContent = `
import { exec } from 'child_process';

// p/secrets violation
const privateKeyHeader = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEA0";
const stripeKey = "${mockStripeKey2}";

// p/owasp-top-ten violations
eval("console.log(1)");
const fn = new Function("return 1");
exec("ls -la");
const rawHtml = "<div>unsafe</div>";
const el = { dangerouslySetInnerHTML: { __html: rawHtml } };
`;

  try {
    writeFileSync(pyFullPath, pyContent, 'utf8');
    writeFileSync(tsFullPath, tsContent, 'utf8');

    // 1. Scan with all DEFAULT_STANDARD_RULESETS
    const allPacksResult = runAstFallbackScan([pyRelPath, tsRelPath], repoRoot, {
      configs: DEFAULT_STANDARD_RULESETS,
    });

    assert.equal(
      allPacksResult.errors.length,
      0,
      `Unexpected errors: ${allPacksResult.errors.join('; ')}`,
    );
    const ruleIds = allPacksResult.findings.map((f) => f.ruleId);

    // Verify p/secrets findings
    assert.ok(ruleIds.includes('p/secrets:hardcoded-secret'), 'Must detect hardcoded secrets');

    // Verify p/owasp-top-ten findings
    assert.ok(
      ruleIds.includes('p/owasp-top-ten:eval-injection'),
      'Must detect eval injection in Python',
    );
    assert.ok(
      ruleIds.includes('p/owasp-top-ten:command-injection'),
      'Must detect command injection in Python/TS',
    );
    assert.ok(
      ruleIds.includes('p/owasp-top-ten:code-injection'),
      'Must detect code injection in TS',
    );
    assert.ok(
      ruleIds.includes('p/owasp-top-ten:xss'),
      'Must detect XSS via dangerouslySetInnerHTML',
    );
    assert.ok(ruleIds.includes('p/owasp-top-ten:sql-injection'), 'Must detect SQL injection');

    // Verify p/security-audit findings
    assert.ok(
      ruleIds.includes('p/security-audit:insecure-deserialization'),
      'Must detect pickle insecure deserialization',
    );
    assert.ok(
      ruleIds.includes('p/security-audit:insecure-yaml-load'),
      'Must detect yaml.load without SafeLoader',
    );
    assert.ok(
      ruleIds.includes('p/security-audit:weak-crypto-hash'),
      'Must detect weak crypto hash (md5/sha1)',
    );
    const weakHashFinding = allPacksResult.findings.find(
      (f) => f.ruleId === 'p/security-audit:weak-crypto-hash',
    );
    assert.equal(
      weakHashFinding?.severity,
      'WARNING',
      'Weak hash finding should have WARNING severity',
    );

    // Verify p/default findings
    assert.ok(
      ruleIds.includes('p/default:dangerous-module'),
      'Must detect dangerous modules (marshal/shelve)',
    );
    assert.ok(ruleIds.includes('no-generic-eval-exec'), 'Must detect no-generic-eval-exec');

    // 2. Selective scan with ONLY p/secrets
    const secretsOnly = runAstFallbackScan([pyRelPath, tsRelPath], repoRoot, {
      configs: ['p/secrets'],
    });
    const secretsRuleIds = secretsOnly.findings.map((f) => f.ruleId);
    assert.ok(
      secretsRuleIds.every((id) => id.startsWith('p/secrets:')),
      'Only p/secrets findings should be present',
    );
    assert.ok(
      secretsRuleIds.includes('p/secrets:hardcoded-secret'),
      'Must detect hardcoded secrets',
    );

    // 3. Selective scan with ONLY p/owasp-top-ten
    const owaspOnly = runAstFallbackScan([pyRelPath, tsRelPath], repoRoot, {
      configs: ['p/owasp-top-ten'],
    });
    const owaspRuleIds = owaspOnly.findings.map((f) => f.ruleId);
    assert.ok(owaspRuleIds.includes('p/owasp-top-ten:eval-injection'));
    assert.ok(owaspRuleIds.includes('p/owasp-top-ten:command-injection'));
    assert.ok(
      !owaspRuleIds.includes('p/security-audit:insecure-deserialization'),
      'Should not include security-audit findings',
    );

    // 4. Selective scan with ONLY p/security-audit
    const auditOnly = runAstFallbackScan([pyRelPath, tsRelPath], repoRoot, {
      configs: ['p/security-audit'],
    });
    const auditRuleIds = auditOnly.findings.map((f) => f.ruleId);
    assert.ok(auditRuleIds.includes('p/security-audit:insecure-deserialization'));
    assert.ok(auditRuleIds.includes('p/security-audit:insecure-yaml-load'));
    assert.ok(auditRuleIds.includes('p/security-audit:weak-crypto-hash'));
    assert.ok(!auditRuleIds.includes('p/owasp-top-ten:command-injection'));

    // 5. Unsupported ruleset records error
    const unsupportedResult = runAstFallbackScan([pyRelPath], repoRoot, {
      configs: ['p/unsupported-ruleset@v1.0.0'],
    });
    assert.ok(
      unsupportedResult.errors.some((e) =>
        e.includes(
          '[SAST Fallback Error] Unsupported standard ruleset: p/unsupported-ruleset@v1.0.0',
        ),
      ),
      `Expected unsupported error in: ${unsupportedResult.errors.join('; ')}`,
    );

    // 6. runSastScan fails closed on synthetic targets with violations in fallback mode
    const failedScan = runSastScan({
      rootDir: repoRoot,
      mode: 'diff',
      gitDiffOutput: pyRelPath,
      allowAstFallback: true,
      execFn: () => ({ status: 127, stderr: 'semgrep: command not found', stdout: '' }),
    });
    assert.equal(failedScan.passed, false, 'Scan with standard rule violations must fail');
    assert.equal(
      failedScan.exitCode,
      1,
      'Scan with standard rule violations must exit with code 1',
    );
    assert.ok(failedScan.findings.length > 0, 'Scan should record findings');
  } finally {
    if (existsSync(pyFullPath)) {
      rmSync(pyFullPath, { force: true });
    }
    if (existsSync(tsFullPath)) {
      rmSync(tsFullPath, { force: true });
    }
  }

  // 7. Clean fallback on existing repository files passes
  const cleanResult = runAstFallbackScan(
    ['apps/agent/src/agent/main.py', 'apps/api/src/main.ts'],
    repoRoot,
    { configs: DEFAULT_STANDARD_RULESETS },
  );
  assert.equal(
    cleanResult.errors.length,
    0,
    `Clean scan should have 0 errors: ${cleanResult.errors.join('; ')}`,
  );
  assert.equal(
    cleanResult.findings.length,
    0,
    `Clean scan should have 0 findings: ${JSON.stringify(cleanResult.findings)}`,
  );
});

test('Issue 1: runAstFallbackScan detects syntax errors in JS/TS/TSX/MJS files and fails closed', () => {
  const malformedFiles = [
    {
      relPath: 'apps/web/temp_malformed_script.ts',
      content: 'const x: number = ;\nconst y = 1;',
      ext: '.ts',
    },
    {
      relPath: 'apps/web/temp_malformed_component.tsx',
      content: 'export const Button = () => <div><span><span></div>;\n',
      ext: '.tsx',
    },
    {
      relPath: 'apps/web/temp_malformed_util.js',
      content: 'function test() { const a = ; return a; }',
      ext: '.js',
    },
    {
      relPath: 'apps/web/temp_malformed_module.mjs',
      content: 'export default { foo: , bar: 1 };',
      ext: '.mjs',
    },
  ];

  const validFiles = [
    {
      relPath: 'apps/web/temp_valid_script.ts',
      content: 'const x: number = 42;\nexport const answer = x;',
      ext: '.ts',
    },
    {
      relPath: 'apps/web/temp_valid_component.tsx',
      content: 'export const Button = () => <div><span>Valid</span></div>;\n',
      ext: '.tsx',
    },
    {
      relPath: 'apps/web/temp_valid_util.js',
      content: 'function test() { const a = 1; return a; }\nmodule.exports = { test };',
      ext: '.js',
    },
    {
      relPath: 'apps/web/temp_valid_module.mjs',
      content: 'export default { foo: 1, bar: 2 };',
      ext: '.mjs',
    },
  ];

  try {
    for (const item of malformedFiles) {
      writeFileSync(resolve(repoRoot, item.relPath), item.content, 'utf8');
    }
    for (const item of validFiles) {
      writeFileSync(resolve(repoRoot, item.relPath), item.content, 'utf8');
    }

    // 1. Verify runAstFallbackScan reports syntax errors for all malformed file types (.ts, .tsx, .js, .mjs)
    for (const item of malformedFiles) {
      const result = runAstFallbackScan([item.relPath], repoRoot, {
        configs: DEFAULT_STANDARD_RULESETS,
      });

      assert.ok(result.errors.length > 0, `Expected syntax errors for ${item.relPath}`);
      const normRel = item.relPath.replaceAll('\\', '/');
      assert.ok(
        result.errors.some(
          (e) =>
            e.includes('[AST Fallback Error] Syntax error in ' + normRel) && e.includes('(line '),
        ),
        `Error message missing standard format for ${item.relPath}: ${result.errors.join('; ')}`,
      );
      // Ensure regex matching was skipped on malformed file
      assert.equal(
        result.findings.length,
        0,
        `Findings should be empty on malformed file ${item.relPath}`,
      );
    }

    // 2. Verify batch scan with multiple malformed files returns errors for each
    const batchResult = runAstFallbackScan(
      malformedFiles.map((m) => m.relPath),
      repoRoot,
      { configs: DEFAULT_STANDARD_RULESETS },
    );
    for (const item of malformedFiles) {
      const normRel = item.relPath.replaceAll('\\', '/');
      assert.ok(
        batchResult.errors.some((e) => e.includes(normRel)),
        `Batch scan errors missing ${item.relPath}: ${batchResult.errors.join('; ')}`,
      );
    }

    // 3. Verify valid files produce 0 syntax errors
    for (const item of validFiles) {
      const validResult = runAstFallbackScan([item.relPath], repoRoot, {
        configs: DEFAULT_STANDARD_RULESETS,
      });
      assert.equal(
        validResult.errors.length,
        0,
        `Valid file ${item.relPath} should have 0 errors: ${validResult.errors.join('; ')}`,
      );
    }

    // 4. Verify runSastScan fails closed in fallback mode when malformed TS is present in diff mode
    const failedDiffScan = runSastScan({
      rootDir: repoRoot,
      mode: 'diff',
      gitDiffOutput: malformedFiles[0].relPath,
      allowAstFallback: true,
      execFn: () => ({ status: 127, stderr: 'semgrep: command not found', stdout: '' }),
    });
    assert.equal(failedDiffScan.passed, false, 'Scan must fail closed on malformed TS file');
    assert.equal(failedDiffScan.exitCode, 1, 'Scan must exit with 1 on malformed TS file');
    assert.ok(
      failedDiffScan.errors.some((e) => e.includes('[AST Fallback Error] Syntax error in ')),
      `Expected AST fallback error in runSastScan: ${failedDiffScan.errors.join('; ')}`,
    );

    // 5. Verify runSastScan fails closed for TSX malformed file as well
    const failedTsxScan = runSastScan({
      rootDir: repoRoot,
      mode: 'diff',
      gitDiffOutput: malformedFiles[1].relPath,
      allowAstFallback: true,
      execFn: () => ({ status: 127, stderr: 'semgrep: command not found', stdout: '' }),
    });
    assert.equal(failedTsxScan.passed, false, 'Scan must fail closed on malformed TSX file');
    assert.equal(failedTsxScan.exitCode, 1, 'Scan must exit with 1 on malformed TSX file');
    assert.ok(
      failedTsxScan.errors.some((e) => e.includes('[AST Fallback Error] Syntax error in ')),
      `Expected AST fallback error in TSX scan: ${failedTsxScan.errors.join('; ')}`,
    );

    // 6. Verify runSastScan fails closed for JS malformed file
    const failedJsScan = runSastScan({
      rootDir: repoRoot,
      mode: 'diff',
      gitDiffOutput: malformedFiles[2].relPath,
      allowAstFallback: true,
      execFn: () => ({ status: 127, stderr: 'semgrep: command not found', stdout: '' }),
    });
    assert.equal(failedJsScan.passed, false, 'Scan must fail closed on malformed JS file');
    assert.equal(failedJsScan.exitCode, 1, 'Scan must exit with 1 on malformed JS file');

    // 7. Verify runSastScan fails closed for MJS malformed file
    const failedMjsScan = runSastScan({
      rootDir: repoRoot,
      mode: 'diff',
      gitDiffOutput: malformedFiles[3].relPath,
      allowAstFallback: true,
      execFn: () => ({ status: 127, stderr: 'semgrep: command not found', stdout: '' }),
    });
    assert.equal(failedMjsScan.passed, false, 'Scan must fail closed on malformed MJS file');
    assert.equal(failedMjsScan.exitCode, 1, 'Scan must exit with 1 on malformed MJS file');
  } finally {
    for (const item of malformedFiles) {
      const p = resolve(repoRoot, item.relPath);
      if (existsSync(p)) {
        rmSync(p, { force: true });
      }
    }
    for (const item of validFiles) {
      const p = resolve(repoRoot, item.relPath);
      if (existsSync(p)) {
        rmSync(p, { force: true });
      }
    }
  }
});

test('runSastScan safeguards maxBuffer and handles sarifOutput file routing', () => {
  const mockCleanSarif = {
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'semgrep' } }, results: [] }],
  };

  // 1. Verify runSastScan passes default maxBuffer: 128 * 1024 * 1024 to execFn
  let capturedOptions = null;
  let capturedArgs = null;
  runSastScan({
    rootDir: repoRoot,
    execFn: (cmd, args, opts) => {
      capturedArgs = args;
      capturedOptions = opts;
      return { status: 0, stdout: JSON.stringify(mockCleanSarif), stderr: '' };
    },
  });
  assert.ok(capturedOptions, 'execFn must be called with options');
  assert.equal(capturedOptions.maxBuffer, 128 * 1024 * 1024, 'default maxBuffer must be 128MB');

  // Verify custom maxBuffer is respected
  capturedOptions = null;
  runSastScan({
    rootDir: repoRoot,
    maxBuffer: 32 * 1024 * 1024,
    execFn: (cmd, args, opts) => {
      capturedOptions = opts;
      return { status: 0, stdout: JSON.stringify(mockCleanSarif), stderr: '' };
    },
  });
  assert.equal(capturedOptions.maxBuffer, 32 * 1024 * 1024, 'custom maxBuffer must be passed to execFn');

  // 2. When sarifOutput is provided, semgrepArgs includes --output and resolved sarifOutput
  const tempDir = mkdtempSync(join(tmpdir(), 'sast-buf-test-'));
  const targetSarif = join(tempDir, 'sub', 'report.sarif');
  try {
    capturedArgs = null;
    runSastScan({
      rootDir: repoRoot,
      sarifOutput: targetSarif,
      execFn: (cmd, args) => {
        capturedArgs = args;
        return { status: 0, stdout: JSON.stringify(mockCleanSarif), stderr: '' };
      },
    });
    const outputIdx = capturedArgs.indexOf('--output');
    assert.ok(outputIdx !== -1, 'semgrepArgs must include --output flag');
    assert.equal(
      capturedArgs[outputIdx + 1],
      resolve(repoRoot, targetSarif),
      'resolved sarifOutput must follow --output flag',
    );

    // 3. When sarifOutput already has SARIF written (or mock writes to file), runSastScan reads and evaluates findings from sarifOutput
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
    writeFileSync(targetSarif, JSON.stringify(mockFindingSarif), 'utf8');

    // execFn returns empty stdout to verify findings are read from targetSarif file
    const fileScanResult = runSastScan({
      rootDir: repoRoot,
      sarifOutput: targetSarif,
      execFn: () => ({ status: 1, stdout: '', stderr: '' }),
    });
    assert.equal(
      fileScanResult.passed,
      false,
      'Scan must fail closed due to findings read from sarifOutput file',
    );
    assert.equal(
      fileScanResult.unbaselinedFindings.length,
      1,
      'Should evaluate unbaselined finding read from sarifOutput',
    );
    assert.equal(
      fileScanResult.findings[0].ruleId,
      'no-raw-payload-logging',
      'Finding ruleId must match sarifOutput content',
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('evaluateFindings matches finding with snapshot-prefixed rule ID against unprefixed baseline entry', () => {
  const prefixedFinding = {
    ruleId:
      'tests.security.sast.snapshots.javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp',
    file: 'apps/api/src/cache/cache.service.ts',
    startLine: 336,
    severity: 'WARNING',
    message: 'Non-literal RegExp',
  };

  const baselineEntry = {
    ruleId:
      'javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp',
    file: 'apps/api/src/cache/cache.service.ts',
    line: 336,
  };

  const resBaseline = evaluateFindings([prefixedFinding], {
    baseline: [baselineEntry],
  });

  assert.equal(resBaseline.passed, true);
  assert.equal(resBaseline.baselinedCount, 1);
  assert.equal(resBaseline.unbaselinedCount, 0);

  // Reverse match: unprefixed finding against prefixed baseline
  const unprefixedFinding = {
    ruleId:
      'javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp',
    file: 'apps/api/src/cache/cache.service.ts',
    startLine: 336,
    severity: 'WARNING',
    message: 'Non-literal RegExp',
  };

  const prefixedBaselineEntry = {
    ruleId:
      'tests.security.sast.snapshots.javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp',
    file: 'apps/api/src/cache/cache.service.ts',
    line: 336,
  };

  const resReverse = evaluateFindings([unprefixedFinding], {
    baseline: [prefixedBaselineEntry],
  });

  assert.equal(resReverse.passed, true);
  assert.equal(resReverse.baselinedCount, 1);
  assert.equal(resReverse.unbaselinedCount, 0);

  // Exception match: prefixed finding against unprefixed exception
  const resException = evaluateFindings([prefixedFinding], {
    exceptions: [
      {
        id: 'EX-TEST-001',
        ruleId:
          'javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp',
        file: 'apps/api/src/cache/cache.service.ts',
        owner: 'security-team',
        rationale: 'Testing prefix tolerance in exceptions',
        compensatingControl: 'Input validated before regexp compilation',
        createdAt: '2026-09-01T00:00:00Z',
        expiresAt: '2026-09-20T00:00:00Z',
      },
    ],
    currentDate: '2026-09-10T00:00:00Z',
  });

  assert.equal(resException.passed, true);
  assert.equal(resException.exceptedCount, 1);
  assert.equal(resException.unbaselinedCount, 0);
});

