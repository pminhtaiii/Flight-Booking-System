import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  projects: [{ name: 'state' }],
});

