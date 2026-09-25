import { defineConfig } from '@playwright/test';
const port = Number(process.env.POCKET_TEST_PORT || 18790);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  use: {
    baseURL,
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
    launchOptions: { executablePath: process.env.POCKET_TEST_CHROME },
  },
  webServer: {
    command: `python3 -m http.server ${port} --bind 127.0.0.1 --directory web`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
