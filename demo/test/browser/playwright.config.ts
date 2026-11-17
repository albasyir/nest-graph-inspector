import { defineConfig, devices } from '@playwright/test';

/**
 * The viewer, in a real browser, against the demo running as a process of
 * its own (see `global-setup.ts`).
 *
 * The demo binds fixed ports and keeps one Direct Run history, so the tests
 * run one at a time; and they are never retried, because a test that passes
 * only the second time is a fault to look into, not one to paper over.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.browser-spec.ts',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  outputDir: '../../test-results/browser',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../../playwright-report' }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
