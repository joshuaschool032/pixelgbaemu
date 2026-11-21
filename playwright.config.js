// @ts-check
const { defineConfig, devices } = require("@playwright/test");

const bundledChromium = process.env.PIXELGBA_CHROMIUM_PATH ? {
  executablePath: process.env.PIXELGBA_CHROMIUM_PATH,
  args: JSON.parse(process.env.PIXELGBA_CHROMIUM_ARGS || "[]"),
} : undefined;

module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 75_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: bundledChromium },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"], browserName: "chromium", launchOptions: bundledChromium },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    command: "node serve.js 4173 127.0.0.1",
    url: "http://127.0.0.1:4173/check.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
