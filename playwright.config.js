// @ts-check
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: process.env.PIXELGBA_CHROMIUM_PATH ? {
      executablePath: process.env.PIXELGBA_CHROMIUM_PATH,
      args: JSON.parse(process.env.PIXELGBA_CHROMIUM_ARGS || "[]"),
    } : {},
  },
  webServer: {
    command: "node serve.js 4173 127.0.0.1",
    url: "http://127.0.0.1:4173/check.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
