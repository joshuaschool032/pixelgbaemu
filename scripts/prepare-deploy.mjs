import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await import(resolve(root, "build-info.js"));
const build = globalThis.PIXELGBA_BUILD;
if (!build?.assets) throw new Error("build-info.js is missing or invalid; run npm run build:meta");
const output = resolve(root, ".pages");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const extras = ["README.md", "UPLOAD.txt", "SECURITY.md", "LICENSES", "docs/DEVICE_TEST_MATRIX.md"];
const paths = [...new Set([...build.assets.filter((item) => item !== "./").map((item) => item.replace(/^\.\//, "")), ...extras])];
for (const relative of paths) {
  const source = resolve(root, relative);
  if (!existsSync(source)) throw new Error(`Deployment file is missing: ${relative}`);
  const target = resolve(output, relative);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}
console.log(`Prepared ${paths.length} deployment paths in .pages/ for build ${build.id}.`);
