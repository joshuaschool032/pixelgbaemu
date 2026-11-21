import { resolve } from "node:path";

const base = process.argv[2];
if (!base) throw new Error("Usage: node scripts/check-deployment.mjs <page-url>");
await import(resolve("build-info.js"));
const assets = globalThis.PIXELGBA_BUILD.assets.filter((asset) => asset !== "./");
const root = base.endsWith("/") ? base : base + "/";
let lastError;
for (let attempt = 1; attempt <= 8; attempt++) {
  try {
    const checkResponse = await fetch(new URL("check.html?verify=" + Date.now(), root), { cache: "no-store" });
    const checkText = await checkResponse.text();
    if (!checkResponse.ok || !checkText.includes('id="summary"') || !checkText.includes("runtime files passed")) {
      throw new Error(`live check.html is missing or invalid (HTTP ${checkResponse.status})`);
    }
    const failures = [];
    for (const asset of assets) {
      const response = await fetch(new URL(asset.replace(/^\.\//, ""), root), { cache: "no-store" });
      if (!response.ok) failures.push(`${asset}: HTTP ${response.status}`);
      else await response.body?.cancel();
    }
    if (failures.length) throw new Error(failures.join("; "));
    const buildResponse = await fetch(new URL("build-info.js?verify=" + Date.now(), root), { cache: "no-store" });
    const buildText = await buildResponse.text();
    if (!buildText.includes(globalThis.PIXELGBA_BUILD.id)) throw new Error("deployed build ID does not match the workflow artifact");
    console.log(`Deployment check passed: live check.html and ${assets.length} assets for build ${globalThis.PIXELGBA_BUILD.id}.`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    console.warn(`Deployment check attempt ${attempt}/8 failed: ${error.message}`);
    if (attempt < 8) await new Promise((resolveWait) => setTimeout(resolveWait, 10_000));
  }
}
throw lastError;
