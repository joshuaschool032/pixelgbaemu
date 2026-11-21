const { test, expect } = require("@playwright/test");
const { makeHomebrewRom } = require("../fixtures/make-homebrew-rom");

test("deployment self-check finds every runtime file", async ({ page }) => {
  await page.goto("/check.html");
  await expect(page.locator("#summary")).toContainText("runtime files passed", { timeout: 30_000 });
  await expect(page.locator("#summary")).toHaveClass(/ok/);
  await expect(page.locator(".row .bad")).toHaveCount(0);
});

test("app loads, boots a legal fixture, and tears down cleanly", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await expect(page).toHaveTitle(/PixelGBA/);
  await expect(page.locator('[role="tab"]')).toHaveCount(4);
  await expect(page.locator("#slotGrid .slot")).toHaveCount(5);

  await page.locator("#romInput").setInputFiles({
    name: "arena-smoke.gba",
    mimeType: "application/octet-stream",
    buffer: makeHomebrewRom(),
  });
  await page.waitForFunction(() => window.PixelGBA?.state.running === true, null, { timeout: 45_000 });
  await expect(page.locator("#enginePill")).toContainText("Playing");
  await expect(page.locator("#game canvas")).toHaveCount(1);

  await page.locator("#btnStop").click();
  await page.waitForFunction(() => window.PixelGBA?.state.running === false && window.PixelGBA?.state.starting === false);
  await expect(page.locator("#bootScreen")).not.toHaveClass(/is-hidden/);

  // A second session exercises listener/WASM teardown and loader asset reuse.
  await expect(page.locator("#bootPlayAgain")).toBeVisible();
  await page.locator("#bootPlayAgain").click();
  await page.waitForFunction(() => window.PixelGBA?.state.running === true, null, { timeout: 45_000 });
  await expect(page.locator('link[href$="emulator.min.css"]')).toHaveCount(1);
  await page.locator("#btnStop").click();
  await page.waitForFunction(() => window.PixelGBA?.state.running === false && window.PixelGBA?.state.starting === false);
  expect(pageErrors).toEqual([]);
});
