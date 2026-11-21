/* ==========================================================================
   PixelGBA — app logic
   Wraps EmulatorJS 4.2.3 (mGBA core, shipped locally in ./emulatorjs) and adds:
     • ROM library (IndexedDB-backed, offline)
     • Save states in 5 slots per game, with screenshots
     • Battery (.sav) auto-sync + import/export
     • Live cheat engine with Pokémon presets
   ========================================================================== */
(() => {
  "use strict";

  /* ---------------------------------------------------------------- utils */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtBytes = (n) => {
    if (!n && n !== 0) return "—";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  };
  const fmtWhen = (t) => {
    if (!t) return "—";
    const d = new Date(t);
    const diff = (Date.now() - t) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + " min ago";
    if (diff < 86400) return Math.floor(diff / 3600) + " h ago";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const baseName = (name) => String(name).replace(/\.(gba|agb|bin|zip|7z|rom)$/i, "");
  const PRESETS = window.PIXELGBA_PRESETS;
  const gidOf = (filename) => PRESETS.slug(filename);

  /* EmulatorJS asks for a screen wake lock; embedded/preview contexts deny it.
     Swallow the rejection so it doesn't surface as an unhandled error. */
  if (navigator.wakeLock && navigator.wakeLock.request) {
    const origRequest = navigator.wakeLock.request.bind(navigator.wakeLock);
    navigator.wakeLock.request = (...args) =>
      origRequest(...args).catch(() => ({ release: () => Promise.resolve(), addEventListener: () => {} }));
  }

  /* ---------------------------------------------------------------- toasts */
  const toastBox = $("#toasts");
  function toast(msg, kind = "info", ms = 3800) {
    const el = document.createElement("div");
    el.className = "toast " + (kind === "success" ? "ok" : kind === "warn" ? "warn" : kind === "error" ? "err" : "");
    el.innerHTML = "<i></i><div>" + esc(msg) + "</div>";
    toastBox.appendChild(el);
    setTimeout(() => { el.classList.add("is-out"); setTimeout(() => el.remove(), 240); }, ms);
  }

  /* --------------------------------------------------------- IndexedDB io */
  const IDB = (() => {
    const DBS = {
      saves: { name: "PixelGBA-saves", store: "saves" },
      states: { name: "PixelGBA-states", store: "states" },
    };
    const cache = {};
    function open(kind) {
      const spec = DBS[kind];
      if (cache[kind]) return cache[kind];
      cache[kind] = new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
        const req = indexedDB.open(spec.name, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(spec.store)) db.createObjectStore(spec.store);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return cache[kind];
    }
    async function tx(kind, mode, fn) {
      const db = await open(kind);
      return new Promise((resolve, reject) => {
        const t = db.transaction([DBS[kind].store], mode);
        const store = t.objectStore(DBS[kind].store);
        let out;
        const r = fn(store);
        if (r) r.onsuccess = () => (out = r.result);
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    }
    return {
      get: (kind, key) => tx(kind, "readonly", (s) => s.get(key)),
      put: (kind, key, val) => tx(kind, "readwrite", (s) => s.put(val, key)),
      del: (kind, key) => tx(kind, "readwrite", (s) => s.delete(key)),
      clear: async (kind) => {
        try { await tx(kind, "readwrite", (s) => s.clear()); } catch (e) { console.warn(e); }
        try { indexedDB.deleteDatabase(DBS[kind].name); } catch (e) {}
        delete cache[kind];
      },
      keys: (kind) => tx(kind, "readonly", (s) => s.getAllKeys()),
    };
  })();

  /* ----------------------------------------------------------- localStore */
  /** localStorage can throw outright in sandboxed/embedded contexts — never let that break the app. */
  /** Detect embedded/sandboxed contexts where the engine can't fetch its own files. */
  const IS_FRAMED = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
  const IS_FILE = location.protocol === "file:";

  /** Explain *why* nothing can load, instead of letting the engine show a cryptic "Network Error". */
  function showEnvBanner(kind) {
    const el = $("#envBanner");
    const body = $("#envBannerBody");
    if (!el || !body) return;
    if (kind === "file") {
      body.innerHTML =
        "<b>Opened straight from disk.</b> You double-clicked <code>index.html</code>, so the browser refuses to let the " +
        "emulator read its own engine files — that red “Network Error” is this, not a missing file.<br>" +
        "<b>Fix:</b> double-click <code>serve.bat</code> (Windows) or run <code>./serve.sh</code>, then use " +
        "<code>http://localhost:8080</code>. Or open your GitHub Pages address.";
    } else {
      body.innerHTML =
        "<b>Preview mode.</b> This page is embedded in a sandboxed frame, so the emulator's engine files are blocked here. " +
        "Open the same address in a normal browser tab to play.";
    }
    el.hidden = false;
    const close = $("#envClose");
    if (close && !close.dataset.wired) {
      close.dataset.wired = "1";
      close.addEventListener("click", () => { el.hidden = true; });
    }
  }

  const store = (() => {
    const mem = Object.create(null);
    let usable = false;
    try { const k = "__pgba_probe__"; window.localStorage.setItem(k, "1"); window.localStorage.removeItem(k); usable = true; } catch (e) {}
    if (usable) {
      return {
        get(k, d) { try { const v = window.localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
        set(k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
        del(k) { try { window.localStorage.removeItem(k); } catch (e) {} },
        raw: (k) => { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
        allKeys: () => { try { return Object.keys(window.localStorage); } catch (e) { return []; } },
        persistent: true,
      };
    }
    return {
      get(k, d) { return k in mem ? mem[k] : d; },
      set(k, v) { mem[k] = v; },
      del(k) { delete mem[k]; },
      raw: (k) => (k in mem ? JSON.stringify(mem[k]) : null),
      allKeys: () => Object.keys(mem),
      persistent: false,
    };
  })();
  const NOSTORE = () => toast("Your browser is blocking local storage here, so saves and settings won't survive a reload — open PixelGBA in a normal tab for full persistence.", "warn", 6500);
  if (!store.persistent && !IS_FRAMED) setTimeout(NOSTORE, 1500);
  const K_ROMS = "pgba.roms";
  const K_CHEATS = (gid) => "pgba.cheats." + gid;
  const K_LASTPRESET = "pgba.lastPreset";
  const K_LASTROM = "pgba.lastRom";

  /* -------------------------------------------------------------- app state */
  const S = {
    engineLoaded: false,
    engineLoading: null,
    roms: store.get(K_ROMS, []),
    current: null,          // { name, gid, size, lastPlayed }
    running: false,
    starting: false,
    presetId: store.get(K_LASTPRESET, null),
    currentSlot: 1,
    savePoll: null,
    lastSaveSig: null,
    savedSave: null,
    savedSaveAt: 0,
  };

  /* FLAT BUILD: all engine files live next to index.html (no subfolders),
     so dataPath is the page itself and EJS_paths maps the usual names. */
  const FLAT_PATHS = window.PIXELGBA_FLAT_PATHS || null;
  const ENGINE = {
    dataPath: FLAT_PATHS ? new URL("./", location.href).href : new URL("emulatorjs/", location.href).href,
    loader: FLAT_PATHS ? new URL("loader.js", location.href).href : new URL("emulatorjs/loader.js", location.href).href,
  };

  /* ------------------------------------------------------------- view tabs */
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
      $$(".view").forEach((v) => v.classList.toggle("is-active", v.id === "view-" + tab.dataset.view));
      if (tab.dataset.view === "saves") renderSaves();
      if (tab.dataset.view === "cheats") renderCheats();
    });
  });

  /* ------------------------------------------------------------ engine pill */
  function pill(text, busy) {
    const el = $("#enginePill");
    el.classList.toggle("is-busy", !!busy);
    $("span", el).textContent = text;
  }

  /* ------------------------------------------------------------- boot views */
  const boot = {
    show() { $("#bootScreen").classList.remove("is-hidden"); },
    hide() { $("#bootScreen").classList.add("is-hidden"); },
  };

  /* ========================================================================
     LIBRARY — ROM list rendered from localStorage metadata
     ===================================================================== */
  function renderLibrary() {
    S.roms.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
    const list = $("#recentList");
    $("#romCount").textContent = String(S.roms.length);
    list.innerHTML = "";
    for (const rom of S.roms.slice(0, 8)) {
      const row = document.createElement("div");
      row.className = "recent-item";
      row.title = "Play " + rom.name;
      row.innerHTML =
        '<span class="r-ico">GBA</span>' +
        '<div style="min-width:0"><div class="r-name">' + esc(baseName(rom.name)) + "</div>" +
        '<div class="r-meta">' + fmtBytes(rom.size) + " · " + fmtWhen(rom.lastPlayed) + "</div></div>" +
        '<button class="r-del" title="Remove from list">×</button>';
      row.addEventListener("click", async (e) => {
        if (e.target.closest(".r-del")) {
          S.roms = S.roms.filter((r) => r.gid !== rom.gid);
          store.set(K_ROMS, S.roms);
          await IDB.del("saves", rom.gid).catch(() => {});
          renderLibrary(); renderSaves(); renderCheats();
          toast("Removed " + baseName(rom.name) + " and its saved data", "warn");
          return;
        }
        await launchStoredRom(rom);
      });
      list.appendChild(row);
    }
  }

  async function launchStoredRom(rom) {
    // ROM blobs are cached in IndexedDB so the library can relaunch without re-picking the file.
    let file = await IDB.get("saves", "__rom__" + rom.gid).catch(() => null);
    if (!file) {
      toast("That ROM isn't cached anymore — pick the file again from your PC", "warn", 5200);
      $("#romInput").click();
      return;
    }
    const blob = new Blob([file.data], { type: "application/octet-stream" });
    startGame(new File([blob], rom.name, { lastModified: rom.lastPlayed || Date.now() }));
  }

  async function rememberRom(file) {
    const gid = gidOf(file.name);
    const rec = { name: file.name, gid, size: file.size, lastPlayed: Date.now() };
    S.roms = S.roms.filter((r) => r.gid !== gid);
    S.roms.unshift(rec);
    store.set(K_ROMS, S.roms);
    try {
      const buf = await file.arrayBuffer();
      await IDB.put("saves", "__rom__" + gid, { data: buf, name: file.name, at: Date.now() });
    } catch (e) {
      console.warn("Could not cache ROM blob", e);
    }
    return rec;
  }

  /* ---- input wiring ---- */
  $("#romInput").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (f) startGame(f);
  });
  $("#bootBrowse").addEventListener("click", () => $("#romInput").click());
  $("#bootPlayAgain").addEventListener("click", async () => {
    const rom = S.current || S.roms[0] || store.get(K_LASTROM, null);
    if (!rom || !rom.gid) { $("#romInput").click(); return; }
    const cached = await IDB.get("saves", "__rom__" + rom.gid).catch(() => null);
    if (!cached || !cached.data) {
      toast("That ROM isn't cached anymore — pick the file again", "warn", 4500);
      $("#romInput").click();
      return;
    }
    startGame(new File([new Blob([cached.data])], rom.name, { type: "application/octet-stream" }));
  });

  /** Reflect the last-played game on the boot overlay. */
  function renderBootHint() {
    const btn = $("#bootPlayAgain");
    const rom = S.current || S.roms[0] || store.get(K_LASTROM, null);
    if (rom && rom.name) {
      btn.hidden = false;
      btn.querySelector("span").textContent = "Play " + baseName(rom.name);
    } else {
      btn.hidden = true;
    }
  }
  $("#dropZone").addEventListener("click", () => $("#romInput").click());

  ["dragenter", "dragover"].forEach((ev) =>
    window.addEventListener(ev, (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
      e.preventDefault();
      $("#dropZone").classList.add("is-over");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    window.addEventListener(ev, (e) => {
      if (ev === "dragleave" && e.target !== document.documentElement) return;
      $("#dropZone").classList.remove("is-over");
    })
  );
  window.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    if (!/\.(gba|agb|bin|zip|7z)$/i.test(f.name)) {
      toast("That's not a GBA ROM — expected .gba / .agb / .bin / .zip", "error");
      return;
    }
    startGame(f);
  });

  /* ========================================================================
     EMULATOR LIFECYCLE
     ===================================================================== */
  /**
   * Run the EmulatorJS loader. Its bootstrap is an IIFE that must re-run for every
   * new session (it's what creates window.EJS_emulator), but the engine bundle it
   * injects declares globals/classes that can only be evaluated once. So: re-run the
   * loader, and short-circuit re-appending an already-loaded emulator.min.js.
   */
  function runLoader() {
    return new Promise((resolve, reject) => {
      document.querySelectorAll("script[data-pgba-loader]").forEach((s) => s.remove());
      const head = document.head;
      const nativeAppend = head.appendChild.bind(head);
      const alreadyLoaded = !!window.EmulatorJS;
      if (alreadyLoaded) {
        head.appendChild = function (el) {
          if (el && el.tagName === "SCRIPT" && /emulator\.min\.js/.test(el.src || "")) {
            setTimeout(() => el.onload && el.onload(), 0);   // satisfy the loader's promise
            return el;                                        // ...without re-evaluating it
          }
          return nativeAppend(el);
        };
      }
      const restore = () => { head.appendChild = nativeAppend; };
      const s = document.createElement("script");
      s.src = ENGINE.loader;
      s.dataset.pgbaLoader = "1";
      s.onload = () => { restore(); resolve(); };
      s.onerror = () => { restore(); reject(new Error("Could not load engine script")); };
      nativeAppend(s);
    });
  }

  function emulator() { return window.EJS_emulator || null; }
  function gameManager() { const e = emulator(); return e && e.gameManager ? e.gameManager : null; }

  async function startGame(file) {
    if (S.starting) { toast("A game is already booting…", "warn"); return; }
    if (IS_FILE) {
      showEnvBanner("file");
      toast("Can't run from file:// — double-click serve.bat (Windows) or ./serve.sh, then open http://localhost:8080", "error", 9000);
      return;
    }
    const ok = /\.(gba|agb|bin|zip|7z)$/i.test(file.name || "");
    if (!ok) { toast("Please choose a .gba ROM file", "error"); return; }

    S.starting = true;
    await stopGame({ silent: true, keepOverlay: true });

    S.current = { name: file.name, gid: gidOf(file.name), size: file.size, lastPlayed: Date.now() };
    S.lastSaveSig = null;
    S.savedSave = null;
    S.savedSaveAt = 0;
    store.set(K_LASTROM, S.current);

    // preselect the matching Pokémon preset
    const match = PRESETS.match(file.name);
    if (match) { S.presetId = match.id; store.set(K_LASTPRESET, match.id); }

    rememberRom(file).catch(() => {});
    renderLibrary();

    boot.hide();
    pill("Loading engine…", true);
    $("#toolbarHint").textContent = "Booting " + baseName(file.name) + "…";
    renderSaves(); renderCheats();

    /* --- EmulatorJS globals (read by loader.js) --- */
    window.EJS_player = "#game";
    window.EJS_core = "mgba";
    window.EJS_pathtodata = ENGINE.dataPath;
    window.EJS_gameUrl = file;
    window.EJS_gameName = file.name;
    window.EJS_gameID = "pgba-" + S.current.gid;
    window.EJS_biosUrl = "";
    window.EJS_language = "en-US";
    window.EJS_disableAutoLang = true;
    if (FLAT_PATHS) {
      window.EJS_paths = FLAT_PATHS;
      // the loader fetches "localization/<lang>.json" without consulting EJS_paths —
      // pre-load the flat copy so it never 404s.
      try {
        const langJson = await (await fetch("en-US.json")).json();
        window.EJS_language = "en-US";
        window.EJS_disableAutoLang = true;
        window.__PGBA_LANG = langJson;
      } catch (e) { console.warn("language preload failed", e); }
    }
    window.EJS_startOnLoaded = true;
    window.EJS_alignStartButton = "center";
    window.EJS_color = "#8b7bff";
    window.EJS_backgroundColor = "#05060c";
    window.EJS_volume = 0.75;
    window.EJS_defaultOptions = { "save-state-location": "browser" };
    window.EJS_Buttons = {
      cheat: false,            // we run our own cheat panel
      saveState: false,        // our Saves tab handles slots
      loadState: false,
      exitEmulation: false,    // our Stop button handles this
      contextMenu: false,
      screenRecord: false,
      settings: true,
      restart: true,
      playPause: true,
      fullscreen: true,
      saveSavFiles: true,      // export .sav straight from the toolbar
      loadSavFiles: true,      // import .sav
      gamepad: true,
      mute: true,
      volumeSlider: true,
    };

    window.EJS_ready = () => {
      try {
        const emu = emulator();
        // pause-time save sync
        const origToggle = emu.togglePlaying.bind(emu);
        emu.togglePlaying = (dontUpdate) => {
          origToggle(dontUpdate);
          if (emu.paused) syncSaveNow().catch(() => {});
        };
        // theme the emulator menu bar to match PixelGBA
        emu.setColor && emu.setColor("#8b7bff");
      } catch (e) { console.warn(e); }
    };

    window.EJS_onGameStart = () => {
      S.running = true;
      S.starting = false;
      boot.hide();
      pill("Playing · " + baseName(file.name), false);
      $("#toolbarHint").textContent = baseName(file.name) + " · " + fmtBytes(file.size);
      restoreBatterySave().then(() => {
        applyEnabledCheats();
      });
      startSavePoll();
      renderLibrary(); renderSaves(); renderCheats(); renderBootHint();
      toast("Loaded " + baseName(file.name), "success");
    };

    try {
      await runLoader();
      S.engineLoaded = true;
    } catch (e) {
      S.starting = false;
      boot.show();
      pill("Engine failed to load", false);
      toast("Could not load the local emulator engine. Check that the emulatorjs/ folder is present.", "error", 7000);
      return;
    }

    if (IS_FILE) showEnvBanner("file");
    else if (IS_FRAMED) showEnvBanner("preview");

    // watchdog: if the core never starts, surface a hint instead of a silent black screen
    setTimeout(() => {
      if (S.starting && !S.running) {
        S.starting = false;
        boot.show();
        pill("Failed to start", false);
        if (IS_FRAMED || IS_FILE) {
          showEnvBanner(IS_FILE ? "file" : "preview");
          toast(IS_FILE
            ? "Opened from file:// — run serve.bat (Windows) or ./serve.sh, then use http://localhost:8080"
            : "Embedded previews block the emulator's engine files. Open the address in a normal browser tab.", "warn", 9000);
        } else {
          toast("The core didn't start. Try unzipping the ROM, or reload the page.", "error", 7000);
        }
      }
    }, IS_FRAMED ? 12000 : 30000);
  }

  async function stopGame({ silent = false, keepOverlay = false } = {}) {
    stopSavePoll();
    const emu = emulator();
    if (emu) {
      try { await syncSaveNow(); } catch (e) {}
      try { emu.setVolume(0); } catch (e) {}
      try { emu.pause(true); } catch (e) {}
      try { emu.gameManager.toggleMainLoop(0); } catch (e) {}
    }
    window.EJS_emulator = null;
    const host = $("#game");
    if (host) host.innerHTML = "";
    S.running = false;
    S.starting = false;
    if (!keepOverlay) {
      boot.show();
      renderBootHint();
      pill("Engine ready · offline", false);
      $("#toolbarHint").textContent = S.current ? "Stopped " + baseName(S.current.name) : "No game loaded";
    }
    renderSaves(); renderCheats();
    if (!silent && S.current) toast("Game stopped — your save is stored", "info");
  }

  function restartGame() {
    const gm = gameManager();
    if (!gm) { toast("No game is running", "warn"); return; }
    syncSaveNow().catch(() => {});
    gm.restart();
    toast("Restarting…", "info");
  }

  $("#btnRestart").addEventListener("click", restartGame);
  $("#btnStop").addEventListener("click", () => stopGame());
  $("#btnShot").addEventListener("click", async () => {
    const emu = emulator();
    if (!emu || !S.running) { toast("Start a game first", "warn"); return; }
    try {
      const { blob } = await grabFrame(emu);
      if (!blob) throw new Error("no frame");
      downloadBlob(blob, baseName(S.current.name) + "-" + tsName() + ".png");
      toast("Screenshot saved", "success");
    } catch (e) { toast("Screenshot failed — try again while the game is visible", "error"); }
  });

  function downloadBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const tsName = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

  /** Canvas element of the running emulator (newer EmulatorJS builds hide it behind frontend). */
  function emuCanvas(emu) {
    if (emu.frontend && emu.frontend.canvas) return emu.frontend.canvas;
    return document.querySelector("#game canvas.ejs_canvas") || document.querySelector("#game canvas");
  }

  /** Downscale an image data URL through a 2D canvas (safe: it's not the WebGL canvas). */
  function shrinkDataURL(url, maxW, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const w = Math.min(maxW, img.naturalWidth);
          const h = Math.max(1, Math.round(w * img.naturalHeight / img.naturalWidth));
          const cv = document.createElement("canvas");
          cv.width = w; cv.height = h;
          const g = cv.getContext("2d");
          g.imageSmoothingEnabled = false;
          g.drawImage(img, 0, 0, w, h);
          resolve(cv.toDataURL("image/jpeg", quality));
        } catch (e) { resolve(""); }
      };
      img.onerror = () => resolve("");
      img.src = url;
    });
  }

  const isPNG = (bytes) => bytes && bytes.length > 200 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e;

  /** Grab a PNG from the core's own framebuffer — exact GBA resolution, always real pixels. */
  async function coreShotBlob(emu) {
    try {
      const bytes = await Promise.race([
        emu.gameManager.screenshot(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
      ]);
      if (isPNG(bytes)) return new Blob([bytes], { type: "image/png" });
    } catch (e) {}
    return null;
  }

  /** Fallback: grab the live display frame through a video-capture track (works with WebGL canvases). */
  async function captureStreamBlob(emu) {
    const c = emuCanvas(emu);
    if (!c || !c.captureStream || typeof window.ImageCapture === "undefined") return null;
    let stream = null;
    try {
      stream = c.captureStream(30);
      const track = stream.getVideoTracks()[0];
      const frame = await new ImageCapture(track).grabFrame();
      const cv = document.createElement("canvas");
      cv.width = frame.width || c.width;
      cv.height = frame.height || c.height;
      cv.getContext("2d").drawImage(frame, 0, 0);
      return await new Promise((res) => cv.toBlob(res, "image/png"));
    } catch (e) {
      return null;
    } finally {
      try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    }
  }

  /** Last resort: copy the (2D-capable) live canvas. */
  async function canvasBlob(emu) {
    const c = emuCanvas(emu);
    if (!c || !c.width) return null;
    try {
      const cv = document.createElement("canvas");
      cv.width = c.width; cv.height = c.height;
      cv.getContext("2d").drawImage(c, 0, 0);
      return await new Promise((res) => cv.toBlob(res, "image/png"));
    } catch (e) { return null; }
  }

  /** Best-effort frame: core framebuffer → capture stream → canvas copy. */
  async function grabFrame(emu, { maxW = 0, quality = 0.8 } = {}) {
    const blob = (await coreShotBlob(emu)) || (await captureStreamBlob(emu)) || (await canvasBlob(emu));
    if (!blob) return { blob: null, thumb: "" };
    let thumb = "";
    if (maxW) {
      const url = await blobToDataURL(blob);
      if (url) thumb = await shrinkDataURL(url, maxW, quality);
    }
    return { blob, thumb };
  }

  async function dataURLtoBlob(url) {
    const [head, b64] = url.split(",");
    const mime = (head.match(/data:([^;]+)/) || [])[1] || "image/png";
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }

  /* ========================================================================
     BATTERY SAVE (.sav) — auto sync in/out
     ===================================================================== */
  function saveFilePath() {
    const gm = gameManager();
    if (!gm) return null;
    try { return gm.getSaveFilePath(); } catch (e) { return null; }
  }

  function bytesSig(u8) {
    if (!u8) return "0";
    let h = u8.length;
    const n = Math.min(u8.length, 64);
    for (let i = 0; i < n; i++) h = (h * 31 + u8[i]) | 0;
    return h + ":" + u8.length;
  }

  async function syncSaveNow({ force = false } = {}) {
    const gm = gameManager();
    if (!gm || !S.running || !S.current) return;
    let bytes;
    try { bytes = gm.getSaveFile(); } catch (e) { return; }
    if (!bytes || !bytes.length) return;
    const sig = bytesSig(bytes);
    if (!force && sig === S.lastSaveSig) return;
    const copy = bytes.slice(); // detach from WASM heap
    S.lastSaveSig = sig;
    S.savedSave = copy;
    S.savedSaveAt = Date.now();
    try {
      await IDB.put("saves", S.current.gid, { data: copy.buffer, at: S.savedSaveAt, name: S.current.name });
      renderSavPanel();
    } catch (e) {
      console.warn("save sync failed", e);
    }
  }

  async function restoreBatterySave() {
    const gm = gameManager();
    if (!gm || !S.current) return;
    const rec = await IDB.get("saves", S.current.gid).catch(() => null);
    if (!rec || !rec.data) return;
    try {
      const path = saveFilePath();
      if (!path) return;
      const u8 = new Uint8Array(rec.data);
      // write into the core's virtual FS at the path it expects, then reload it
      const parts = path.split("/");
      let cp = "";
      for (let i = 0; i < parts.length - 1; i++) {
        if (!parts[i]) continue;
        cp += "/" + parts[i];
        if (!gm.FS.analyzePath(cp).exists) gm.FS.mkdir(cp);
      }
      if (gm.FS.analyzePath(path).exists) gm.FS.unlink(path);
      gm.FS.writeFile(path, u8);
      gm.loadSaveFiles();
      S.savedSave = u8;
      S.savedSaveAt = rec.at || Date.now();
      S.lastSaveSig = bytesSig(u8);
      renderSavPanel();
      toast("Battery save restored (" + fmtBytes(u8.length) + ")", "success", 2600);
    } catch (e) {
      console.warn("restore save failed", e);
      toast("Could not inject the existing .sav — you can import it manually in Saves", "warn", 5000);
    }
  }

  function startSavePoll() {
    stopSavePoll();
    S.savePoll = setInterval(() => {
      if (S.running && !(emulator() && emulator().paused)) syncSaveNow().catch(() => {});
      renderSavPanel();
    }, 8000);
  }
  function stopSavePoll() {
    if (S.savePoll) clearInterval(S.savePoll);
    S.savePoll = null;
  }
  window.addEventListener("beforeunload", () => {
    // best-effort synchronous flush of the battery save
    if (S.running) { try { syncSaveNow({ force: true }); } catch (e) {} }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && S.running) syncSaveNow().catch(() => {});
  });

  /* ========================================================================
     SAVE STATES
     ===================================================================== */
  const stateKey = (slot) => (S.current ? S.current.gid : null) + ":" + slot;

  async function captureState(slot) {
    const emu = emulator();
    if (!emu || !S.running) { toast("Start a game first", "warn"); return; }
    let state;
    try { state = emu.gameManager.getState(); } catch (e) {
      toast("This core can't save states here", "error");
      return;
    }
    let thumb = "";
    try {
      const frame = await grabFrame(emu, { maxW: 320, quality: 0.72 });
      thumb = frame.thumb || "";
    } catch (e) {}
    const rec = {
      data: state.buffer.slice(state.byteOffset, state.byteOffset + state.byteLength),
      thumb, at: Date.now(), size: state.byteLength, name: S.current.name,
    };
    try {
      await IDB.put("states", stateKey(slot), rec);
      renderSaves();
      toast("Saved state to slot " + slot, "success");
    } catch (e) {
      toast("Storage is full — delete some states and try again", "error", 6000);
    }
  }

  async function applyState(slot) {
    const emu = emulator();
    if (!emu || !S.running) { toast("Start a game first", "warn"); return; }
    const rec = await IDB.get("states", stateKey(slot)).catch(() => null);
    if (!rec || !rec.data) { toast("Slot " + slot + " is empty", "warn"); return; }
    try {
      emu.gameManager.loadState(new Uint8Array(rec.data));
      S.currentSlot = slot;
      toast("Loaded slot " + slot + " · " + fmtWhen(rec.at), "success");
    } catch (e) {
      toast("Could not load that state", "error");
    }
  }

  async function deleteState(slot) {
    if (!S.current) return;
    await IDB.del("states", stateKey(slot)).catch(() => {});
    renderSaves();
    toast("Slot " + slot + " cleared", "info");
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }
  async function dataURLToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return res.blob();
  }

  async function exportLatestState() {
    if (!S.current) { toast("No game loaded", "warn"); return; }
    const keys = await IDB.keys("states").catch(() => []);
    const mine = keys.filter((k) => String(k).startsWith(S.current.gid + ":"));
    if (!mine.length) { toast("No states saved for this game", "warn"); return; }
    let best = null, bestRec = null;
    for (const k of mine) {
      const rec = await IDB.get("states", k);
      if (rec && (!bestRec || rec.at > bestRec.at)) { best = k; bestRec = rec; }
    }
    const blob = new Blob([bestRec.data], { type: "application/octet-stream" });
    downloadBlob(blob, baseName(S.current.name) + "-slot" + String(best).split(":")[1] + ".state");
    toast("Exported latest state", "success");
  }

  async function importStateFile(file) {
    if (!S.current) { toast("Load the matching game first, then import its state", "warn", 5000); return; }
    if (!S.running) { toast("Start the game first, then import a state", "warn", 5000); return; }
    const buf = await file.arrayBuffer();
    // pick the next free slot
    const keys = await IDB.keys("states").catch(() => []);
    let free = 1;
    while (keys.includes(S.current.gid + ":" + free) && free < 5) free++;
    const rec = { data: buf, thumb: "", at: Date.now(), size: buf.byteLength, name: file.name };
    await IDB.put("states", stateKey(free), rec);
    try {
      emulator().gameManager.loadState(new Uint8Array(buf));
      toast("State imported into slot " + free + " and loaded", "success");
    } catch (e) {
      toast("State imported to slot " + free + " (could not auto-load)", "warn");
    }
    renderSaves();
  }

  /* ========================================================================
     CHEATS — storage + engine bridge
     ===================================================================== */
  function cheatListKey() {
    if (S.current) return S.current.gid;
    if (S.presetId) return "preset:" + S.presetId;
    return "preset:emerald";
  }
  function getCheatList() { return store.get(K_CHEATS(cheatListKey()), []); }
  function setCheatList(list) { store.set(K_CHEATS(cheatListKey()), list); }

  /** Canonical form: one line per code line, "XXXXXXXX YYYYYYYY"/"XXXXXXXX YYYY", upper-case hex. */
  function normalizeCode(code) {
    return String(code)
      .split(/\r?\n/)
      .map((line) => line.replace(/[\s\-]/g, "").toUpperCase())
      .filter(Boolean)
      .map((hex) => (hex.length > 8 ? hex.slice(0, 8) + " " + hex.slice(8) : hex))
      .join("\n");
  }

  /** Returns an error string, or null when the code is well-formed. */
  function validateCode(code) {
    const raw = String(code).trim();
    if (!raw) return "Enter at least one line of hex code";
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return "Enter at least one line of hex code";
    for (const line of lines) {
      if (/[^0-9a-fA-F\s\-]/.test(line)) {
        const bad = (line.match(/[^0-9a-fA-F\s\-]/g) || []).slice(0, 3).join(" ");
        return "Only hex digits (0-9, A-F) are allowed — found “" + bad + "”";
      }
      const digits = line.replace(/[\s\-]/g, "");
      if (digits.length !== 12 && digits.length !== 16) {
        return "Each line needs 12 or 16 hex digits (GameShark 8+8, CodeBreaker 8+4) — this one has " + digits.length;
      }
    }
    return null;
  }

  function findEngineCheat(code) {
    const emu = emulator();
    if (!emu || !Array.isArray(emu.cheats)) return -1;
    const norm = normalizeCode(code);
    return emu.cheats.findIndex((c) => normalizeCode(c.code) === norm);
  }

  function engineAddCheat(desc, code, on) {
    const emu = emulator();
    if (!emu) return;
    if (!Array.isArray(emu.cheats)) emu.cheats = [];
    let idx = findEngineCheat(code);
    if (idx === -1) {
      emu.cheats.push({ desc, code, checked: false, custom: true });
      idx = emu.cheats.length - 1;
    }
    emu.cheats[idx].desc = desc;
    emu.cheats[idx].checked = !!on;
    try { emu.cheatChanged(!!on, emu.cheats[idx].code, idx); } catch (e) { console.warn(e); }
    try { emu.saveSettings && emu.saveSettings(); } catch (e) {}
    try { emu.frontend && emu.frontend.updateCheatUI && emu.frontend.updateCheatUI(); } catch (e) {}
  }

  function engineSetCheat(code, on) {
    const emu = emulator();
    if (!emu) return;
    const idx = findEngineCheat(code);
    if (idx === -1) return;
    emu.cheats[idx].checked = !!on;
    try { emu.cheatChanged(!!on, emu.cheats[idx].code, idx); } catch (e) {}
    try { emu.saveSettings && emu.saveSettings(); } catch (e) {}
    try { emu.frontend && emu.frontend.updateCheatUI && emu.frontend.updateCheatUI(); } catch (e) {}
  }

  function applyEnabledCheats() {
    const list = getCheatList();
    for (const c of list) if (c.checked) engineAddCheat(c.desc, c.code, true);
  }

  /** Toggle a cheat (by unique normalized code) to on/off. Returns the new state. */
  function toggleCheat(desc, code, on, meta = {}) {
    const norm = normalizeCode(code);
    const list = getCheatList();
    let item = list.find((c) => normalizeCode(c.code) === norm);
    if (!item) {
      item = { desc, code: norm, checked: !!on, custom: !!meta.custom, tag: meta.tag || "" };
      list.push(item);
    } else {
      item.checked = !!on;
      if (meta.tag) item.tag = meta.tag;
    }
    setCheatList(list);
    if (S.running) engineAddCheat(item.desc, item.code, item.checked);
    else if (S.current) toast("Saved — cheats switch on when the game starts", "info", 2600);
    renderCheats();
    return item.checked;
  }

  function removeCheat(code) {
    const norm = normalizeCode(code);
    const list = getCheatList().filter((c) => normalizeCode(c.code) !== norm);
    setCheatList(list);
    if (S.running) engineSetCheat(norm, false);
    renderCheats();
  }

  function cheatIsOn(code) {
    const norm = normalizeCode(code);
    const item = getCheatList().find((c) => normalizeCode(c.code) === norm);
    return !!(item && item.checked);
  }

  /* ---- cheat UI ---- */
  function renderCheats() {
    const badge = $("#cheatGameBadge");
    if (S.current) badge.textContent = baseName(S.current.name);
    else badge.textContent = "no game loaded — pre-configure below";

    // preset pills
    const picker = $("#presetGames");
    picker.innerHTML = "";
    const matched = S.current ? PRESETS.match(S.current.name) : null;
    const activeId = S.presetId || (matched && matched.id) || "emerald";
    for (const g of PRESETS.games) {
      const b = document.createElement("button");
      b.className = "preset-game" + (g.id === activeId ? " is-active" : "");
      b.style.setProperty("--dot", g.accent);
      b.innerHTML = "<i></i>" + esc(g.title.replace("Pokémon ", ""));
      b.addEventListener("click", () => {
        S.presetId = g.id;
        store.set(K_LASTPRESET, g.id);
        renderCheats();
      });
      picker.appendChild(b);
    }

    const game = PRESETS.games.find((g) => g.id === activeId) || PRESETS.games[0];
    $("#presetNote").textContent = game.note || "";

    const plist = $("#presetList");
    plist.innerHTML = "";
    for (const c of game.cheats) {
      const row = document.createElement("div");
      row.className = "preset-cheat";
      const on = cheatIsOn(c.code);
      row.innerHTML =
        '<label class="switch"><input type="checkbox" ' + (on ? "checked" : "") + ' /><span></span></label>' +
        '<div class="pc-body"><div class="pc-name">' + esc(c.name) +
        (c.tag ? ' <span class="tag">' + esc(c.tag) + "</span>" : "") + "</div>" +
        '<div class="pc-code">' + esc(normalizeCode(c.code)) + "</div>" +
        (c.note ? '<div class="pc-note">' + esc(c.note) + "</div>" : "") +
        "</div>";
      const cb = $("input", row);
      cb.addEventListener("change", () => {
        toggleCheat(c.name, c.code, cb.checked, { tag: c.tag });
      });
      plist.appendChild(row);
    }

    // active list
    const list = getCheatList();
    $("#cheatCount").textContent = String(list.length);
    const al = $("#activeList");
    al.innerHTML = "";
    if (!list.length) {
      al.innerHTML = '<div class="empty-state">Nothing enabled yet. Flip a preset switch, or add your own code.</div>';
    } else {
      for (const c of list) {
        const row = document.createElement("div");
        row.className = "active-cheat" + (c.checked ? " is-on" : "");
        row.innerHTML =
          '<label class="switch"><input type="checkbox" ' + (c.checked ? "checked" : "") + (S.running ? "" : " disabled") + ' /><span></span></label>' +
          '<div class="ac-body"><div class="ac-name">' + esc(c.desc) +
          (c.custom ? ' <span class="tag">custom</span>' : "") +
          (c.tag ? ' <span class="tag">' + esc(c.tag) + "</span>" : "") + "</div>" +
          '<div class="ac-code">' + esc(normalizeCode(c.code)) + "</div></div>" +
          '<button class="ac-del" title="Remove">×</button>';
        $("input", row).addEventListener("change", (e) => {
          toggleCheat(c.desc, c.code, e.target.checked, { custom: c.custom, tag: c.tag });
        });
        $(".ac-del", row).addEventListener("click", () => removeCheat(c.code));
        al.appendChild(row);
      }
    }

    $("#btnReapply").disabled = !S.running;
    $("#btnClearCheats").disabled = !list.length;
  }

  $("#customCheatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#ccName").value.trim();
    const code = $("#ccCode").value.trim();
    if (!name) { $("#ccName").focus(); return; }
    const err = validateCode(code);
    if (err) { toast(err, "error"); $("#ccCode").focus(); return; }
    const norm = normalizeCode(code);
    if (getCheatList().some((c) => normalizeCode(c.code) === norm && c.desc === name)) {
      toast("That cheat is already in the list", "warn");
      return;
    }
    toggleCheat(name, norm, true, { custom: true });
    $("#ccName").value = "";
    $("#ccCode").value = "";
    toast("Cheat added and switched on", "success");
  });

  $("#btnReapply").addEventListener("click", () => {
    if (!S.running) { toast("Start a game first", "warn"); return; }
    applyEnabledCheats();
    toast("Re-applied enabled cheats", "success");
  });
  $("#btnClearCheats").addEventListener("click", () => {
    setCheatList([]);
    for (const c of (emulator()?.cheats || [])) engineSetCheat(c.code, false);
    renderCheats();
    toast("Cheat list cleared", "info");
  });

  /* ========================================================================
     RENDER: SAVES
     ===================================================================== */
  async function renderSaves() {
    const badge = $("#stateGameBadge");
    badge.textContent = S.current ? baseName(S.current.name) : "no game loaded";
    const grid = $("#slotGrid");
    grid.innerHTML = "";

    const keys = S.current ? await IDB.keys("states").catch(() => []) : [];
    for (let slot = 1; slot <= 5; slot++) {
      const key = S.current ? S.current.gid + ":" + slot : null;
      const rec = key && keys.includes(key) ? await IDB.get("states", key).catch(() => null) : null;
      const el = document.createElement("div");
      el.className = "slot" + (rec ? "" : " is-empty");
      const thumbStyle = rec && rec.thumb ? 'style="background-image:url(' + rec.thumb + ')"' : "";
      el.innerHTML =
        '<div class="thumb" ' + thumbStyle + ">" + (rec && !rec.thumb ? "🎞" : "") + "</div>" +
        '<div class="s-body"><div class="s-title">Slot ' + slot + "</div>" +
        '<div class="s-meta">' + (rec ? fmtWhen(rec.at) + " · " + fmtBytes(rec.size) : "empty") + "</div>" +
        '<div class="s-actions">' +
        '<button class="btn btn-ghost" data-act="save" ' + (S.running ? "" : "disabled") + ">Save</button>" +
        '<button class="btn btn-ghost" data-act="load" ' + (rec && S.running ? "" : "disabled") + ">Load</button>" +
        (rec ? '<button class="btn btn-ghost" data-act="del" title="Delete slot">×</button>' : "") +
        "</div></div>";
      $('[data-act="save"]', el).addEventListener("click", () => captureState(slot));
      $('[data-act="load"]', el).addEventListener("click", () => applyState(slot));
      const del = $('[data-act="del"]', el);
      if (del) del.addEventListener("click", () => deleteState(slot));
      grid.appendChild(el);
    }
    renderSavPanel();
  }

  function renderSavPanel() {
    const name = $("#savName"), info = $("#savInfo"), badge = $("#savStatus");
    if (!S.current) {
      name.textContent = "No .sav stored yet";
      info.textContent = "Play and save in-game — the file appears here automatically.";
      badge.textContent = "—";
      return;
    }
    const has = !!S.savedSave;
    name.textContent = has ? baseName(S.current.name) + ".sav" : "No .sav yet for " + baseName(S.current.name);
    info.textContent = has
      ? fmtBytes(S.savedSave.length) + " · synced " + fmtWhen(S.savedSaveAt)
      : "Save inside the game (Start → SAVE) and it syncs here within seconds.";
    badge.textContent = has ? "synced" : (S.running ? "waiting for in-game save" : "—");
  }

  /* save tab buttons */
  $("#btnExportSav").addEventListener("click", async () => {
    if (!S.current) { toast("No game loaded", "warn"); return; }
    await syncSaveNow({ force: true }).catch(() => {});
    let data = S.savedSave;
    if (!data) {
      const rec = await IDB.get("saves", S.current.gid).catch(() => null);
      if (rec && rec.data) data = new Uint8Array(rec.data);
    }
    if (!data) { toast("No battery save yet — save in-game first", "warn"); return; }
    downloadBlob(new Blob([data], { type: "application/octet-stream" }), baseName(S.current.name) + ".sav");
    toast("Exported .sav", "success");
  });

  function wireSavImport(btn, input) {
    $(btn).addEventListener("click", () => {
      if (!S.current) { toast("Load the matching game first", "warn", 4500); return; }
      $(input).click();
    });
    $(input).addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      const buf = await f.arrayBuffer();
      if (buf.byteLength < 512) { toast("That doesn't look like a .sav file", "error"); return; }
      try {
        await IDB.put("saves", S.current.gid, { data: buf, at: Date.now(), name: S.current.name });
        S.savedSave = new Uint8Array(buf);
        S.savedSaveAt = Date.now();
        S.lastSaveSig = bytesSig(S.savedSave);
        if (S.running) await restoreBatterySave();
        renderSavPanel();
        toast("Imported " + f.name + " (" + fmtBytes(buf.byteLength) + ")", "success");
      } catch (err) {
        toast("Could not store that save", "error");
      }
    });
  }
  wireSavImport("#btnImportSav", "#savInput");
  wireSavImport("#btnQuickImportSav", "#savInput");

  $("#btnDeleteSav").addEventListener("click", async () => {
    if (!S.current) return;
    if (!confirm("Delete the stored .sav for " + baseName(S.current.name) + "? Export it first if you might want it back.")) return;
    await IDB.del("saves", S.current.gid).catch(() => {});
    S.savedSave = null; S.savedSaveAt = 0; S.lastSaveSig = null;
    renderSavPanel();
    toast("Stored .sav deleted", "warn");
  });

  $("#btnExportState").addEventListener("click", exportLatestState);
  $("#btnImportState").addEventListener("click", () => $("#stateInput").click());
  $("#btnQuickLoadState").addEventListener("click", () => $("#stateInput").click());
  $("#stateInput").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (f) importStateFile(f);
  });

  /* ========================================================================
     HELP → wipe everything
     ===================================================================== */
  $("#btnWipe").addEventListener("click", async () => {
    if (!confirm("Delete ALL ROMs, saves, states and cheat lists stored by PixelGBA on this computer?")) return;
    await stopGame({ silent: true });
    store.allKeys().filter((k) => k.startsWith("pgba.")).forEach((k) => store.del(k));
    await IDB.clear("saves"); await IDB.clear("states");
    toast("Local data cleared — reloading…", "warn");
    setTimeout(() => location.reload(), 800);
  });

  /* ========================================================================
     KEYBOARD SHORTCUTS (outside the emulator frame)
     ===================================================================== */
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (!S.running) {
      if (e.key === "F1") { e.preventDefault(); toast("Load a game to use in-emulator shortcuts", "info"); }
      return;
    }
    if (e.key === "F2") { e.preventDefault(); captureState(S.currentSlot); }
    else if (e.key === "F3") { e.preventDefault(); applyState(S.currentSlot); }
    else if (e.key === "F4") { e.preventDefault(); S.currentSlot = (S.currentSlot % 5) + 1; toast("Quick-save slot → " + S.currentSlot, "info", 1500); }
  });

  /* ========================================================================
     BOOT
     ===================================================================== */
  renderLibrary();
  renderSaves();
  renderCheats();
  renderSavPanel();
  renderBootHint();
  if (IS_FILE) showEnvBanner("file");
  else if (IS_FRAMED) showEnvBanner("preview");
  pill("Engine ready · offline", false);

  // restore preset selection from the last played ROM, if any
  const last = store.get(K_LASTROM, null);
  if (last && last.name) {
    S.current = null;
    $("#toolbarHint").textContent = "Last played: " + baseName(last.name) + " — drop the file to continue";
  }

  /* dev/debug handle (also used by the automated smoke test) */
  window.PixelGBA = {
    state: S,
    startGame,
    stopGame,
    emulator,
    captureState,
    applyState,
    syncSaveNow,
    restoreBatterySave,
    toggleCheat,
    getCheatList,
    validateCode,
    normalizeCode,
    version: "1.0.0",
  };
})();
