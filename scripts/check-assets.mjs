import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const required = [
  "index.html", "styles.css", "app.js", "cheats-db.js", "loader.js",
  "emulator.min.js", "emulator.min.css", "en-US.json", "version.json", "mgba.json",
  "mgba-wasm.data", "mgba-legacy-wasm.data", "extract7z.js", "extractzip.js",
  "libunrar.js", "libunrar.wasm", "sw.js", "build-info.js", "check.html", "README.md", "LICENSE",
  "THIRD_PARTY_NOTICES.md", "LICENSES/MPL-2.0.txt", "LICENSES/UnRAR.txt",
  "LICENSES/7-Zip.txt", "serve.js", "serve.sh", "serve.ps1", "serve.bat"
];
for (const name of required) if (!existsSync(resolve(root, name))) errors.push(`missing required file: ${name}`);

const index = readFileSync(resolve(root, "index.html"), "utf8");
const localRefs = [...index.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1])
  .filter((url) => !/^(?:data:|https?:|#|mailto:)/.test(url))
  .map((url) => url.split(/[?#]/)[0]);
for (const name of localRefs) if (!existsSync(resolve(root, name))) errors.push(`index.html references missing file: ${name}`);

const flatMap = [...index.matchAll(/^\s*"[^"]+":\s*"([^"]+)"/gm)].map((match) => match[1]);
for (const name of flatMap) if (!existsSync(resolve(root, name))) errors.push(`flat runtime map references missing file: ${name}`);

const lock = JSON.parse(readFileSync(resolve(root, "vendor-lock.json"), "utf8"));
for (const artifact of lock.artifacts) {
  const filename = resolve(root, artifact.path);
  if (!existsSync(filename)) { errors.push(`vendor artifact missing: ${artifact.path}`); continue; }
  const actual = createHash("sha256").update(readFileSync(filename)).digest("hex");
  if (actual !== artifact.sha256) errors.push(`vendor hash mismatch: ${artifact.path}\n  expected ${artifact.sha256}\n  actual   ${actual}`);
  if (!artifact.source || !artifact.license || !artifact.version) errors.push(`incomplete vendor metadata: ${artifact.path}`);
}

for (const name of ["app.js", "cheats-db.js", "loader.js", "serve.js", "sw.js", "build-info.js", "playwright.config.js", "scripts/generate-build-info.mjs"]) {
  try { execFileSync(process.execPath, ["--check", resolve(root, name)], { stdio: "pipe" }); }
  catch (error) { errors.push(`syntax check failed: ${name}\n${error.stderr?.toString() || error.message}`); }
}

for (const name of ["mgba-wasm.data", "mgba-legacy-wasm.data"]) {
  if (existsSync(resolve(root, name)) && statSync(resolve(root, name)).size < 1_000_000) errors.push(`${name} is unexpectedly small`);
}
if (!index.includes('href="check.html"')) errors.push("Help page no longer links to check.html");
if (!readFileSync(resolve(root, "README.md"), "utf8").includes("npm run test:all")) errors.push("README is missing the verification workflow");

if (errors.length) {
  console.error(`Asset check failed (${errors.length}):\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(`Asset check passed: ${required.length} required files, ${flatMap.length} mapped assets, ${lock.artifacts.length} pinned vendor artifacts.`);
