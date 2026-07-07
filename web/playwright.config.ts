import { defineConfig } from "@playwright/test";

const minutes = 60_000;

// Agent-mode functional runs drive backend Codex turns that can take up to
// 300s (default) or 600s (review context) each, and a single run may validate
// many behaviors sequentially. The 30s Playwright default would abort these,
// so use a generous per-test budget. All values are env-overridable for CI.
const testTimeout = Number(process.env.E2E_TEST_TIMEOUT_MS) || 15 * minutes;
const expectTimeout = Number(process.env.E2E_EXPECT_TIMEOUT_MS) || 60_000;
const actionTimeout = Number(process.env.E2E_ACTION_TIMEOUT_MS) || 60_000;
const navigationTimeout = Number(process.env.E2E_NAVIGATION_TIMEOUT_MS) || 60_000;

export default defineConfig({
  testDir: "./e2e",
  timeout: testTimeout,
  expect: {
    timeout: expectTimeout,
  },
  use: {
    baseURL: "http://localhost:4200",
    headless: true,
    actionTimeout,
    navigationTimeout,
  },
  webServer: {
    command: "npm run start",
    port: 4200,
    reuseExistingServer: true,
    timeout: 120000,
  },
});
