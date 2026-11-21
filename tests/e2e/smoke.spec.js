const { test, expect } = require("@playwright/test");
const { makeHomebrewRom } = require("../fixtures/make-homebrew-rom");

test("deployment self-check finds every runtime file", async ({ page }) => {
  await page.goto("/check.html");
  await expect(page.locator("#summary")).toContainText("runtime files passed", { timeout: 30_000 });
  await expect(page.locator("#summary")).toHaveClass(/ok/);
  await expect(page.locator(".row .bad")).toHaveCount(0);
});

test("app loads, boots a legal fixture, restores a save, and tears down cleanly", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const gamepad = { id: "PixelGBA test pad", index: 0, connected: true, mapping: "standard", buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0], timestamp: 1 };
    Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => [gamepad] });
  });
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
  await expect.poll(() => page.evaluate(() => Boolean(window.EJS_emulator?.gamepad))).toBe(true);

  await page.locator("#savInput").setInputFiles({
    name: "arena-smoke.sav",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(64 * 1024, 0x5a),
  });
  await expect(page.locator("#savStatus")).toContainText("synced");

  await page.locator("#btnStop").click();
  await page.waitForFunction(() => window.PixelGBA?.state.running === false && window.PixelGBA?.state.starting === false);
  await expect(page.locator("#bootScreen")).not.toHaveClass(/is-hidden/);

  // A second session exercises listener/WASM teardown and loader asset reuse.
  await expect(page.locator("#bootPlayAgain")).toBeVisible();
  await page.locator("#bootPlayAgain").click();
  await page.waitForFunction(() => window.PixelGBA?.state.running === true, null, { timeout: 45_000 });
  await expect(page.locator('link[href$="emulator.min.css"]')).toHaveCount(1);
  await expect(page.locator("#savStatus")).toContainText("synced");
  await page.locator("#tab-saves").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#btnDeleteSav").click();
  await page.waitForFunction(() => window.PixelGBA?.state.running === false && window.PixelGBA?.state.starting === false);
  await expect(page.locator("#savStatus")).toContainText("—");
  expect(pageErrors).toEqual([]);
});

test("library controls fit the configured desktop or mobile viewport", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#librarySearch")).toBeVisible();
  await expect(page.locator("#librarySort")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
