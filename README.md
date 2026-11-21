# PixelGBA

PixelGBA is a static, browser-based Game Boy Advance emulator UI built around EmulatorJS 4.2.3 and its mGBA core. It provides a local ROM library, five save-state slots, battery-save import/export and automatic persistence, screenshots, and per-game cheat lists. ROMs and saves stay in browser storage; no game or BIOS content is included.

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

## Deployment

The app is intentionally flat and needs no production build. Serve every tracked runtime file from one directory over HTTPS. For GitHub Pages, deploy the repository root from the default branch. Open `check.html` after deploying to verify every required runtime asset.

A service worker caches the local app and engine files after the first complete visit. Once installation succeeds, the UI and bundled engine can load offline. Browser storage and service-worker caches remain origin-specific; changing the deployment URL creates a separate library.

## Browser support

Use a current Chromium, Firefox, or Safari release with WebAssembly, IndexedDB, WebGL, and ES2020 support. Private browsing, sandboxed iframes, enterprise policies, and low-storage conditions can disable persistence. iOS may evict site data under storage pressure, so export important `.sav` files.

## Storage and data safety

- ROM contents are identified by SHA-256, not filename. Different revisions and ROM hacks therefore receive separate saves, states, and cheats.
- Older filename-keyed data is migrated when that ROM is loaded for the first time after upgrading.
- ROM blobs, battery saves, and states use IndexedDB. Library metadata and UI/engine settings use localStorage.
- Battery saves are checked across the complete file every eight seconds, when the page is hidden, when pausing, and before teardown. Browsers cannot guarantee completion of asynchronous writes after a tab is force-closed.
- **Remove from library (`×`)** deletes only the cached ROM/library entry and keeps saves, states, and cheats.
- **Delete game data (`🗑`)** removes the ROM and all PixelGBA data for that content hash after confirmation.
- Deleting a running battery save stops the game first so the core cannot immediately recreate it.
- Export `.sav` files regularly. Save states are core/version-specific and are not a substitute for battery-save backups.

## Architecture

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css` | Static application shell and responsive UI |
| `app.js` | Lifecycle, storage, migration, saves, states, cheats, and accessibility |
| `cheats-db.js` | Pokémon preset data and legacy filename helper |
| `loader.js` | EmulatorJS bootstrap plus documented flat-path/storage compatibility patches |
| `emulator.min.*` | Vendored EmulatorJS runtime |
| `mgba-*.data` | Vendored modern and legacy mGBA core archives |
| `extract*`, `libunrar*` | Vendored archive extraction workers |
| `sw.js` | Same-origin offline asset cache |
| `check.html` | Deployment asset self-check |
| `vendor-lock.json` | Version, source, license, and SHA-256 manifest for vendored artifacts |

The content hash is the canonical game ID. Storage keys prefixed with `pgba.` belong to the PixelGBA layer; per-game EmulatorJS settings use an `ejs-pgba-` prefix. The destructive cleanup paths intentionally avoid deleting unrelated IndexedDB databases on shared origins such as `github.io`.

## Development

Node.js 20 or later is recommended.

```sh
npm ci
npm run check       # syntax, references, runtime files, and vendor hashes
npm test            # unit and DOM integration tests
npm run test:e2e    # Playwright browser smoke test
npm run test:all
```

The Playwright smoke test uses a pinned compressed headless Chromium from the npm registry, so it does not need a separate browser download. The end-to-end fixture is a tiny project-generated GBA program that loops forever and contains no commercial game data.

## Updating vendored dependencies

1. Review the upstream release and license changes.
2. Replace the complete related artifact set together; do not mix loader, runtime, localization, and core versions casually.
3. Reapply and document the readable PixelGBA patches in `loader.js`.
4. Update `vendor-lock.json`, including SHA-256 digests and exact source URLs.
5. Update `THIRD_PARTY_NOTICES.md` and files under `LICENSES/` when needed.
6. Run `npm run test:all` and `check.html` from a real deployment.

The mGBA archive metadata points to the `EmulatorJS/mgba` fork and the core build system is in `EmulatorJS/build`. See `THIRD_PARTY_NOTICES.md` for the source correspondence and rebuild caveat.

## Troubleshooting

- **Network Error immediately after choosing a ROM:** do not use `file://`; run one of the local servers and use its HTTP URL.
- **A cached game will not reopen:** browser quota eviction may have removed its ROM blob. Choose the original file again; content-hash matching reconnects it to existing data.
- **Save does not appear:** make an in-game save, leave the game running for at least eight seconds, then check the Saves tab. Export before closing if the UI reports a storage error.
- **Black screen:** run `check.html`, try an uncompressed `.gba`, and verify WebGL is enabled.
- **State import rejected:** states must match the game and compatible core build. Free one of the five slots before importing.

## License

PixelGBA is distributed under GNU GPL version 3. See `LICENSE`. Bundled components retain their own licenses and notices; see `THIRD_PARTY_NOTICES.md`, `LICENSES/`, and `vendor-lock.json`.
