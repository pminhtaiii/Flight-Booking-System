/* eslint-disable no-console */
import { execSync } from 'child_process';
import * as path from 'path';

async function main() {
  console.log('Running database seeding...');

  // 1. Seed agent tools mock data
  const seedAgentToolsPath = path.resolve(__dirname, 'seed-agent-tools.ts');
  console.log(`Running: tsx "${seedAgentToolsPath}"`);
  execSync(`npx tsx "${seedAgentToolsPath}"`, { stdio: 'inherit' });

  // 2. Seed airports data
  const seedAirportsPath = path.resolve(__dirname, 'seed/airports.ts');
  console.log(`Running: tsx "${seedAirportsPath}"`);
  execSync(`npx tsx "${seedAirportsPath}"`, { stdio: 'inherit' });

  console.log('All seeding completed successfully.');
}

main().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
