import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The package ships its matching NSS/NSPR libraries in the Amazon Linux bundle.
// Force extraction on generic Linux CI images too, then put those libraries on
// LD_LIBRARY_PATH through the package's normal environment setup.
process.env.AWS_EXECUTION_ENV ||= "AWS_Lambda_nodejs22.x";
if (!existsSync(join(tmpdir(), "al2023", "lib", "libnspr4.so"))) rmSync(join(tmpdir(), "chromium"), { force: true });

const require = createRequire(import.meta.url);
const chromium = require("@sparticuz/chromium");
chromium.setGraphicsMode = true;
const executablePath = await chromium.executablePath();
const command = resolve("node_modules", ".bin", process.platform === "win32" ? "playwright.cmd" : "playwright");
const child = spawn(command, ["test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    PIXELGBA_CHROMIUM_PATH: executablePath,
    PIXELGBA_CHROMIUM_ARGS: JSON.stringify(chromium.args.filter((arg) => arg !== "--single-process")),
  },
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
