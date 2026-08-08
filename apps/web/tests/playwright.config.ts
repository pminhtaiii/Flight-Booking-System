import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const directStreamE2E = process.env.CHAT_DIRECT_STREAM_E2E === 'true';

const frontendEnv = {
  CI: 'true',
  NEXTAUTH_SECRET: 'test_secret',
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001',
  NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS: 'true',
  NEXT_PUBLIC_FEATURE_FLAG_CHAT_HANDOFF: 'true',
  NEXT_PUBLIC_FEATURE_FLAG_CHAT_DIRECT_STREAM:
    directStreamE2E ? 'true' : 'false',
  NEXT_PUBLIC_AGENT_URL: 'http://127.0.0.1:3002',
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
    ...(!directStreamE2E
      ? [{
          command: 'pnpm start:prod',
          url: 'http://127.0.0.1:3001/health',
          reuseExistingServer: !process.env.CI,
          timeout: 600000,
          cwd: path.resolve(__dirname, '../../api'),
          env: {
            NODE_ENV: 'test',
            DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/test_db',
            REDIS_URL: 'redis://127.0.0.1:6379/1',
            FEATURE_FLAG_BOOKING_READINESS: 'true',
            FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'true',
            FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'true',
            FRONTEND_URL: 'http://127.0.0.1:3000',
          },
        }]
      : []),
    {
      command: directStreamE2E ? 'pnpm dev' : 'pnpm start',
      url: 'http://127.0.0.1:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 600000,
      cwd: path.resolve(__dirname, '..'),
      env: frontendEnv,
    },
  ],
});
