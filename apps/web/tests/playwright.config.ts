import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './',
  fullyParallel: false,
  workers: 1,
  reporter: [['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3000',
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
      command: 'pnpm --filter @api/backend start:prod',
      url: 'http://localhost:3001/health',
      reuseExistingServer: !process.env.CI,
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/test_db',
        REDIS_URL: 'redis://127.0.0.1:6379/1',
      },
    },
    {
      command: 'pnpm --filter @web/frontend start',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      env: {
        NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3001',
        NEXTAUTH_SECRET: 'test_secret',
      },
    },
  ],
});
