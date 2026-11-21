const { test, expect } = require("@playwright/test");
const { makeHomebrewRom } = require("../fixtures/make-homebrew-rom");
const { readFileSync } = require("node:fs");

test("deployment self-check finds every runtime file", async ({ page }) => {
  const response = await page.goto("/check.html");
  expect(response.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  await expect(page.locator("#summary")).toContainText("runtime files passed", { timeout: 30_000 });
  await expect(page.locator("#summary")).toHaveClass(/ok/);
  await expect(page.locator(".row .bad")).toHaveCount(0);
});

test("app loads, boots a legal fixture, restores a save, and tears down cleanly", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Linux headless Firefox/WebKit have no compatible mGBA WebGL context; asset and responsive checks still run.");
  const pageErrors = [];
  let workerRequested = false;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => { if (request.url().endsWith("/pixelgba-worker.js")) workerRequested = true; });
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
  expect(workerRequested).toBe(true);
  await expect.poll(() => page.evaluate(() => Boolean(window.EJS_emulator?.gamepad))).toBe(true);

  // Reproduce the user-facing live disable/remove path against the real core.
  await page.evaluate(() => {
    const manager = window.EJS_emulator.gameManager;
    const reset = manager.resetCheat.bind(manager);
    window.__pixelgbaCheatResets = 0;
    manager.resetCheat = (...args) => { window.__pixelgbaCheatResets++; return reset(...args); };
  });
  await page.locator("#tab-cheats").click();
  await page.locator("details.custom-cheat summary").click();
  await page.locator("#ccName").fill("Smoke-test cheat");
  await page.locator("#ccType").selectOption("cb");
  await page.locator("#ccCode").fill("82005274 0044");
  await page.locator("#customCheatForm button[type=submit]").click();
  await expect(page.locator("#activeList input")).toBeChecked();
  await page.locator("#activeList label.switch").click();
  await expect(page.locator("#activeList input")).not.toBeChecked();
  expect(await page.evaluate(() => window.__pixelgbaCheatResets)).toBeGreaterThanOrEqual(2);
  await page.locator("#activeList .ac-del").click();
  await expect(page.locator("#activeList .active-cheat")).toHaveCount(0);
  expect(await page.evaluate(() => window.EJS_emulator.cheats.some((cheat) => /82005274/.test(cheat.code)))).toBe(false);

  await page.locator("#savInput").setInputFiles({
    name: "arena-smoke.sav",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(64 * 1024, 0x5a),
  });
  await expect(page.locator("#savStatus")).toContainText("synced");
  await page.locator("#tab-help").click();
  const backupDownload = page.waitForEvent("download");
  await page.locator("#btnExportBackup").click();
  await expect(page.locator("#operationBanner")).toBeHidden({ timeout: 30_000 });
  expect((await backupDownload).suggestedFilename()).toMatch(/\.pgbackup$/);
  await page.locator("#tab-library").click();

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

test("PWA metadata, storage health, and privacy-safe diagnostics are available", async ({ page, request }) => {
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons).toHaveLength(2);

  await page.goto("/");
  await page.locator("#tab-help").click();
  await expect(page.locator("#storagePersistBadge")).not.toContainText("checking");
  await expect(page.locator("#capabilityGrid .capability")).toHaveCount(8);
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent("error", { message: "private-game.gba failed at https://private.example/user" })));
  const diagnosticDownload = page.waitForEvent("download");
  await page.locator("#btnExportDiagnostics").click();
  const download = await diagnosticDownload;
  const report = JSON.parse(readFileSync(await download.path(), "utf8"));
  expect(report.format).toBe("pixelgba-diagnostics-v1");
  expect(report.app.version).toBe("1.3.0");
  expect(report).not.toHaveProperty("url");
  expect(report.browser).not.toHaveProperty("userAgent");
  expect(report.recentErrors.at(-1)).toEqual(expect.objectContaining({ category: "application-error" }));
  expect(report.recentErrors.at(-1)).not.toHaveProperty("message");
  expect(JSON.stringify(report)).not.toContain("private-game");
  expect(JSON.stringify(report)).not.toContain("private.example");
});

test("library controls fit the configured desktop or mobile viewport", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#librarySearch")).toBeVisible();
  await expect(page.locator("#librarySort")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
