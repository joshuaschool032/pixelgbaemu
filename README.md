# PixelGBA

PixelGBA is an installable, offline-first Game Boy Advance emulator UI built around EmulatorJS 4.2.3 and its mGBA core. It provides a searchable local ROM library, validated save states, battery-save history, complete backup/restore, storage-health guidance, privacy-safe diagnostics, screenshots, and revision-scoped cheat lists. ROMs and saves stay in browser storage; no game or BIOS content is included.

## Quick start

### Windows

Double-click `serve.bat`, then open <http://127.0.0.1:8080/> if the browser does not open automatically.

### macOS or Linux

```sh
./serve.sh
# then open http://127.0.0.1:8080/
```

You can also use Node directly:

```sh
node serve.js 8080
```

Do not open `index.html` through `file://`; browser security rules prevent the emulator from loading its WASM/core assets that way. The launchers bind only to `127.0.0.1`, so they do not expose the directory to the local network.

## Installation and deployment

On supporting desktop/Android browsers, open **Help → Install & storage health → Install PixelGBA**. On iPhone/iPad, use **Share → Add to Home Screen**. The manifest uses generated 192/512 px maskable icons and standalone display mode.

The runtime remains static, but generated icons and `build-info.js` are treated as build artifacts. `npm run build:pages` validates them and creates an exact deployment directory in `.pages/`. The **Deploy GitHub Pages** workflow tests the app, uploads that exact artifact, deploys it on `main`, then checks every deployed asset and build ID. Configure the repository's Pages source as **GitHub Actions**.

A service worker caches the local app and engine files after the first complete visit. Its cache key comes from the generated `build-info.js` content manifest. A deployed update waits and shows an **Update and reload** prompt instead of mixing old UI files with a new runtime during a game. Browser storage and service-worker caches remain origin-specific; changing the deployment URL creates a separate library.

## Browser support

Use a current Chromium, Firefox, or Safari release with WebAssembly, IndexedDB, WebGL, and ES2020 support. Private browsing, sandboxed iframes, enterprise policies, and low-storage conditions can disable persistence. iOS may evict site data under storage pressure, so export important `.sav` files.

## Storage and data safety

- Archives are extracted before SHA-256 identification, so a raw ROM and the same cartridge inside ZIP, 7z, or RAR storage share saves and settings. Different revisions and ROM hacks remain separate.
- Older filename-keyed and archive-hash-keyed data is migrated when that ROM is loaded for the first time after upgrading.
- ROM blobs, battery saves, and states use IndexedDB. Library metadata, favorites, backup reminders, and UI/engine settings use localStorage.
- **Help → Install & storage health** shows quota use, warns near 80%/100 MB free, requests persistent storage where available, and reminds active libraries to make a full backup every 30 days.
- Battery saves sync on the emulator's SRAM flush event, with complete-file polling every eight seconds as a fallback. Writes are serialized and two previous copies are retained for recovery.
- PixelGBA `.pgstate` exports include the ROM hash, cartridge header, core/runtime version, size, timestamp, and checksum. Legacy raw `.state` imports remain supported.
- **Export full backup** creates one checksummed file containing cached ROMs, battery saves/history, states, cheats, favorites, and settings. Restore validates all binary records before replacing PixelGBA data.
- **Remove from library (`×`)** deletes only the cached ROM/library entry and keeps saves, states, and cheats.
- **Delete game data (`🗑`)** removes the ROM and all PixelGBA data for that content hash after confirmation.
- Deleting a running battery save stops the game first so the core cannot immediately recreate it.
- Export `.sav` files regularly. Save states are core/version-specific and are not a substitute for battery-save backups.

## Architecture

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `config.js` | Static application shell, responsive UI, and flat runtime paths |
| `app.js` | Lifecycle, storage, migration, saves, PWA/install UI, diagnostics, cheats, and accessibility |
| `manifest.webmanifest`, `assets/` | Install metadata and reproducibly generated PWA icons |
| `pixelgba-worker.js` | Cancellable ROM hashing/ZIP extraction and backup encoding/checksum work |
| `cheats-db.js` | Header/revision-scoped Pokémon presets, device types, and pinned provenance |
| `loader.js` | EmulatorJS bootstrap plus documented flat-path/storage compatibility patches |
| `emulator.min.*` | Vendored EmulatorJS runtime |
| `mgba-*.data` | Vendored modern and legacy mGBA core archives |
| `extract*`, `libunrar*` | Vendored archive extraction workers |
| `sw.js`, `build-info.js` | Versioned same-origin offline cache and generated asset manifest |
| `check.html` | Deployment asset self-check |
| `SECURITY.md` | Tested CSP/header baseline and optional cross-origin isolation |
| `docs/DEVICE_TEST_MATRIX.md` | Physical Safari/Firefox/Android/controller release checklist |
| `docs/CHEAT_PROVENANCE.md` | Region/revision support and immutable cheat-source links |
| `vendor-lock.json` | Version, source, license, and SHA-256 manifest for vendored artifacts |

The content hash is the canonical game ID. Storage keys prefixed with `pgba.` belong to the PixelGBA layer; per-game EmulatorJS settings use an `ejs-pgba-` prefix. The destructive cleanup paths intentionally avoid deleting unrelated IndexedDB databases on shared origins such as `github.io`.

## Development

Node.js 20 or later is recommended.

```sh
npm ci
npm run build:icons # reproducibly regenerate PWA PNG icons
npm run build:meta  # regenerate build-info.js after changing a cached asset
npm run build:pages # validate and assemble the exact static Pages artifact
npm run check       # generated metadata/icons, syntax, references, provenance, vendor hashes
npm test            # unit and DOM integration tests
npm run test:e2e    # desktop + mobile Chromium smoke tests using packaged Chromium
npm run test:e2e:cross-browser # Firefox + WebKit (requires Playwright browsers)
npm run test:all
```

The default Playwright smoke test uses a pinned compressed headless Chromium from the npm registry, so it does not need a separate browser download. CI runs Firefox and WebKit in Playwright's version-matched browser container, also avoiding runtime CDN downloads. Both validate deployment and responsive UI; their Linux headless builds skip the core boot because the container has no compatible mGBA WebGL context. Desktop/mobile Chromium perform the real mGBA, mocked-gamepad, save restore/delete, and repeated teardown cycles. Unit coverage adds archive identity, storage-quota failures, backup checksums, and save serialization. The end-to-end fixture is a tiny project-generated GBA program that loops forever and contains no commercial game data.

Dependabot proposes monthly grouped updates for browser/DOM testing packages and GitHub Actions. EmulatorJS runtime upgrades remain manual because its loader, runtime, core, provenance, and patched hashes must move together.

## Performance and cancellation

Raw/ZIP ROM inspection and SHA-256 hashing run in `pixelgba-worker.js`; 7z/RAR continue through the bundled EmulatorJS extraction workers. Full-backup binary encoding and restore checksum verification also run off the UI thread. The operation banner reports progress and terminates the worker when **Cancel** is selected. Browsers without dedicated workers retain a tested main-thread fallback.

## Diagnostics, compatibility, and security

**Help → Export diagnostic report** includes app/build/runtime versions, broad capability booleans, storage totals, service-worker state, and up to ten allowlisted error categories. It intentionally excludes ROM/save/cheat data, filenames, URLs, free-form error text, full user-agent strings, stacks, and GPU renderer identifiers.

Headless automation cannot establish physical iOS storage eviction, sleep/wake saves, controller reconnects, touch latency, or actual Safari GPU behavior. Follow `docs/DEVICE_TEST_MATRIX.md` and submit the structured device-report issue form before marking a release tested on real hardware. Unrecorded combinations remain explicitly “Not yet recorded.”

`serve.js` sends the tested CSP, permissions, referrer, MIME-sniffing, and resource-policy headers. See `SECURITY.md` for deployment equivalents, GitHub Pages limitations, and opt-in COOP/COEP isolation. The CSP permits only same-origin network resources but retains the blob/eval allowances required by the current EmulatorJS loader.

## Cheat provenance

Preset auto-selection requires an exact GBA game code and revision. Every interactive entry records region, revision, device format, and an immutable pinned GitHub cross-reference. Source matching does not claim physical-device verification. Unmatched legacy entries remain visible but disabled with a **source needed** label; the entire Sapphire list remains disabled until an independent revision-specific source is recorded. See `docs/CHEAT_PROVENANCE.md`.

## Updating vendored dependencies

1. Review the upstream release and license changes.
2. Replace the complete related artifact set together; do not mix loader, runtime, localization, and core versions casually.
3. Reapply and document the readable PixelGBA patches in `loader.js`.
4. Update `vendor-lock.json`, including SHA-256 digests and exact source URLs.
5. Update `THIRD_PARTY_NOTICES.md` and files under `LICENSES/` when needed.
6. Run `npm run build:meta` so the offline cache receives a new content-derived version.
7. Run `npm run test:all`, `npm run build:pages`, and `check.html` from a real deployment.
8. Complete the physical-device matrix for release-critical browser/device combinations.

The mGBA archive metadata points to the `EmulatorJS/mgba` fork and the core build system is in `EmulatorJS/build`. See `THIRD_PARTY_NOTICES.md` for the source correspondence and rebuild caveat.

## Troubleshooting

- **Network Error immediately after choosing a ROM:** do not use `file://`; run one of the local servers and use its HTTP URL.
- **A cached game will not reopen:** browser quota eviction may have removed its ROM blob. Choose the original file again; content-hash matching reconnects it to existing data.
- **Save does not appear:** make an in-game save, leave the game running for at least eight seconds, then check the Saves tab. Export before closing if the UI reports a storage error.
- **Black screen:** run `check.html`, try an uncompressed `.gba`, and verify WebGL is enabled.
- **State import rejected:** validated states must match the ROM hash and exact compatible core build. Legacy raw states are attempted by the core. Free one of the five slots before importing.
- **Browser storage was evicted or you are moving devices:** restore a full `.pgbackup` exported from the Help tab.
- **A cheat still appears to have an effect after switching it off:** PixelGBA resets and rebuilds the core cheat table immediately. Continuous patches stop, but items, money, flags, or progress already written into game memory/save data are not reversible; restore an earlier `.sav`, state, or full backup if needed.
- **An update is available:** finish saving, then choose **Update and reload**. The waiting worker never replaces runtime assets in the middle of a session.

## License

PixelGBA is distributed under GNU GPL version 3. See `LICENSE`. Bundled components retain their own licenses and notices; see `THIRD_PARTY_NOTICES.md`, `LICENSES/`, and `vendor-lock.json`.
