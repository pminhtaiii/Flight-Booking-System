import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const frontendEnv = {
  CI: 'true',
  NEXTAUTH_SECRET: 'test_secret',
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001',
};

export default defineConfig({
  testDir: './',
  fullyParallel: false,
  workers: 1,
  reporter: [['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    actionTimeout: 10000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: [
    {
      command: 'pnpm build && pnpm start:prod',
      url: 'http://127.0.0.1:3001/health',
      reuseExistingServer: !process.env.CI,
      timeout: 300000,
      cwd: path.resolve(__dirname, '../../api'),
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/test_db',
        REDIS_URL: 'redis://127.0.0.1:6379/1',
      },
    },
    {
      command: 'pnpm build && pnpm start',
      url: 'http://127.0.0.1:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 300000,
      cwd: path.resolve(__dirname, '..'),
      env: frontendEnv,
    },
  ],
});
