import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');

const rawCategory = process.argv[2] ?? 'all';
const rawFilter = process.argv[3];
const validCategories = ['all', 'unit', 'routes'];
const isCustomPath =
  !validCategories.includes(rawCategory) &&
  (rawCategory.includes('/') || rawCategory.includes('\\') || rawCategory.endsWith('.ts'));

if (!validCategories.includes(rawCategory) && !isCustomPath) {
  process.stderr.write('Choose a Node test category: all, unit, or routes.\n');
  process.exit(2);
}

const category = isCustomPath ? 'all' : rawCategory;
const filter = isCustomPath ? rawCategory : rawFilter;
const testFiles = [];

function collectNodeTests(directory) {
  for (const entry of readdirSync(directory)) {
    const entryPath = path.join(directory, entry);
    const stats = statSync(entryPath);

    if (stats.isDirectory()) {
      if (entry !== 'node_modules' && entry !== '.next') collectNodeTests(entryPath);
      continue;
    }

    if (/\.(?:ts|mts)$/.test(entry) && readFileSync(entryPath, 'utf8').includes('node:test')) {
      const rel = path.relative(webRoot, entryPath);
      const isRouteTest = rel.split(path.sep)[0] === 'app';
      if (category === 'all' || (category === 'routes') === isRouteTest) {
        if (!filter || rel.includes(filter)) {
          testFiles.push(rel);
        }
      }
    }
  }
}

collectNodeTests(webRoot);
testFiles.sort();

if (testFiles.length === 0) {
  process.stderr.write('No Node test files importing node:test were found.\n');
  process.exit(1);
}

const cliTestFiles = testFiles.map((file) => file.replace(/\[/g, '[[]'));

const result = spawnSync(process.execPath, [tsxCli, '--test', ...cliTestFiles], {
  cwd: webRoot,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
