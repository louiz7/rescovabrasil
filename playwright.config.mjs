import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.e2e.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1050 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node --experimental-sqlite server/index.mjs',
    url: 'http://127.0.0.1:4174/health',
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      PORT: '4174',
      HOST: '127.0.0.1',
      OUTREACH_MODE: 'demo',
      SEED_DEMO: 'false',
      DATABASE_PATH: join(tmpdir(), `rescova-browser-${process.pid}.sqlite`),
      OPERATOR_PASSWORD: 'browser-test-password',
      LIVE_SEND_ENABLED: 'false',
    },
  },
});
