# Third-party software notices

PixelGBA includes third-party runtime artifacts so games can run without contacting a CDN. `vendor-lock.json` records every bundled artifact's SHA-256 digest, version information, license, and source URL. Run `npm run check` to verify those digests.

## EmulatorJS 4.2.3

- Files: `emulator.min.js`, `emulator.min.css`, `loader.js`, `en-US.json`, `version.json`, and the compression runtime files.
- Upstream: <https://github.com/EmulatorJS/EmulatorJS/tree/v4.2.3>
- Preferred source: <https://github.com/EmulatorJS/EmulatorJS/tree/v4.2.3/data/src>
- Release archive: <https://github.com/EmulatorJS/EmulatorJS/releases/tag/v4.2.3>
- License: GNU GPL version 3; see the repository-root `LICENSE`.

`loader.js` is derived from the upstream 4.2.3 loader. PixelGBA's readable modifications are marked `PixelGBA patch` and cover denied browser storage, flat-file asset paths, language preloading, duplicate runtime assets, asynchronous IndexedDB probing, and listener tracking needed for deterministic teardown. The rest of the application-specific source is in `app.js`, `cheats-db.js`, `styles.css`, and `index.html`.

## mGBA core

- Files: `mgba-wasm.data`, `mgba-legacy-wasm.data`, and `mgba.json`.
- The archives identify themselves as EmulatorJS core format `2.0.2`, repository `https://github.com/EmulatorJS/mgba`, and MPL-2.0.
- `mgba.json` records a build from 2025-06-14. The last source commit in that repository before the recorded build was [`57678d6180e7020798809703283e02d2bba18b63`](https://github.com/EmulatorJS/mgba/commit/57678d6180e7020798809703283e02d2bba18b63); because the binary does not embed a Git commit, this is the best reproducible source correspondence rather than a cryptographic assertion.
- Core build tooling: <https://github.com/EmulatorJS/build>
- License: Mozilla Public License 2.0; see `LICENSES/MPL-2.0.txt`. Each `.data` archive also contains `license.txt`, `core.json`, and `build.json`.

To rebuild, check out the source commit above and follow the `EmulatorJS/build` repository's container/toolchain instructions for the `mgba` core. Compare the resulting archives deliberately; Emscripten/toolchain versions and archive metadata can make byte-for-byte reproduction differ.

## Compression runtimes

### 7-Zip extraction

- File: `extract7z.js` from the EmulatorJS 4.2.3 distribution.
- Upstream distribution source: <https://github.com/EmulatorJS/EmulatorJS/blob/v4.2.3/data/compression/extract7z.js>
- 7-Zip licensing includes LGPL-2.1-or-later, BSD components, and the unRAR restriction where applicable. See `LICENSES/7-Zip.txt`.

### ZIP extraction

- File: `extractzip.js` from the EmulatorJS 4.2.3 distribution.
- Upstream distribution source: <https://github.com/EmulatorJS/EmulatorJS/blob/v4.2.3/data/compression/extractzip.js>
- Distributed as part of EmulatorJS under GPL-3.0. The generated artifact does not carry enough embedded metadata to identify a narrower underlying revision; preserve the pinned upstream artifact and digest when redistributing it.

### libunrar-js

- Files: `libunrar.js`, `libunrar.wasm`.
- Upstream: <https://github.com/tnikolai2/libunrar-js>
- License: RARLAB UnRAR license, including the prohibition on using the source to recreate the proprietary RAR compression algorithm. See `LICENSES/UnRAR.txt`.

## Trademarks and game content

Game Boy Advance, Pokémon, Nintendo, Creatures, and GAME FREAK are trademarks or marks of their respective owners. PixelGBA is unaffiliated with them. No ROMs or BIOS images are included.
