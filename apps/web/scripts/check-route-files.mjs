import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const routeFiles = new Map();

function collectRouteFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      collectRouteFiles(entryPath);
      continue;
    }

    const match = /^(page|route)\.[^.]+$/.exec(entry.name);
    if (!match) {
      continue;
    }

    const routeKey = relative(appDirectory, join(directory, match[1]));
    const files = routeFiles.get(routeKey) ?? [];
    files.push(relative(resolve(appDirectory, '..'), entryPath));
    routeFiles.set(routeKey, files);
  }
}

collectRouteFiles(appDirectory);

const duplicates = [...routeFiles.entries()].filter(([, files]) => files.length > 1);

if (duplicates.length > 0) {
  console.error('Duplicate Next.js route files detected:');
  for (const [routeKey, files] of duplicates) {
    console.error(`  ${routeKey}:`);
    for (const file of files) {
      console.error(`    - ${file}`);
    }
  }
  process.exitCode = 1;
}
