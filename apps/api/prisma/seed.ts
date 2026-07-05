import { execSync } from 'child_process';
import * as path from 'path';

async function main() {
  console.log('Running database seeding...');
  
  // 1. Seed agent tools mock data
  const seedAgentToolsPath = path.resolve(__dirname, 'seed-agent-tools.ts');
  console.log(`Running: ts-node "${seedAgentToolsPath}"`);
  execSync(`npx ts-node -r tsconfig-paths/register "${seedAgentToolsPath}"`, { stdio: 'inherit' });

  // 2. Seed airports data
  const seedAirportsPath = path.resolve(__dirname, 'seed/airports.ts');
  console.log(`Running: ts-node "${seedAirportsPath}"`);
  execSync(`npx ts-node -r tsconfig-paths/register "${seedAirportsPath}"`, { stdio: 'inherit' });


  console.log('All seeding completed successfully.');
}

main().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
