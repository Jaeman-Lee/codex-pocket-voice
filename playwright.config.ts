import { defineConfig } from "@playwright/test";

const port = Number(process.env.CODEX_POCKET_BROWSER_PORT ?? "41731");
if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
  throw new Error("CODEX_POCKET_BROWSER_PORT must be an unprivileged TCP port");
}
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results/playwright",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["line"], ["html", { outputFolder: "playwright-report", open: "never" }]]
    : [["line"]],
  use: {
    baseURL,
    browserName: "chromium",
    viewport: { width: 360, height: 780 },
    colorScheme: "dark",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: {
      mode: "retain-on-failure",
      screenshots: true,
      snapshots: true,
      sources: false,
    },
    video: "off",
  },
  webServer: {
    command: "npm run test:browser:server",
    url: `${baseURL}/api/status`,
    env: {
      ...process.env,
      CODEX_POCKET_BROWSER_PORT: String(port),
    },
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 3_000 },
  },
});
