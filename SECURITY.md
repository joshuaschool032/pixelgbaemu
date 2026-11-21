# Security and deployment headers

PixelGBA processes untrusted ROM/archive bytes locally. Keep the application and every runtime asset on one trusted origin, serve it over HTTPS, and never add third-party analytics or ROM-upload endpoints without a separate security/privacy review.

## Recommended baseline

`serve.js` sends the tested baseline below. Configure equivalent headers at a production CDN when supported:

```text
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=(), gamepad=(self), fullscreen=(self), screen-wake-lock=(self)
Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:
```

EmulatorJS creates blob workers/scripts and its WebAssembly loader currently requires eval allowances. Removing those directives without replacing the upstream loader breaks the emulator. The policy still blocks third-party scripts, network connections, frames, plug-ins, and form submission to another origin.

GitHub Pages does not support repository-defined response headers. The app remains functional there, but deployments requiring enforced CSP or cross-origin isolation should use a host/CDN that supports custom response headers.

## Optional cross-origin isolation

Cross-origin isolation can support future threaded cores. With the local server:

```sh
PIXELGBA_CROSS_ORIGIN_ISOLATED=1 node serve.js 8080
```

This adds:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Test installation, pop-up behavior, every runtime asset, and any embedding environment before enabling it. The current mGBA configuration does not require isolation.

## Reporting

Do not attach ROMs, saves, states, cheats, full backups, or browser profiles to a bug or security report. Use **Help → Export diagnostic report**; it intentionally omits those records, filenames, URLs, detailed user-agent strings, and hardware renderer information.
