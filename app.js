/* ==========================================================================
   PixelGBA — app logic
   Wraps EmulatorJS 4.2.3 (mGBA core, shipped as pinned flat-file assets) and adds:
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
  const baseName = (name) => String(name).replace(/\.(gba|agb|bin|zip|7z|rar|rom)$/i, "");
  const PRESETS = window.PIXELGBA_PRESETS;
  const legacyGidOf = (filename) => PRESETS.slug(filename);

  /**
   * A fast whole-buffer fingerprint used for frequent battery-save comparisons.
   * Four independent 32-bit accumulators make accidental collisions vanishingly
   * unlikely while still avoiding an async digest every eight seconds.
   */
  function bytesSig(bytes) {
    if (!bytes) return "0";
    const u8 = bytes instanceof Uint8Array
      ? bytes
      : new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength || undefined);
    let a = 0x811c9dc5, b = 0x9e3779b9, c = 0x85ebca6b, d = 0xc2b2ae35;
    for (let i = 0; i < u8.length; i++) {
      const value = u8[i];
      a = Math.imul(a ^ value, 0x01000193);
      b = Math.imul(b ^ (value + i), 0x85ebca6b);
      c = Math.imul(c + value, 0xc2b2ae35) ^ (c >>> 13);
      d = Math.imul(d ^ value, 0x27d4eb2d) + i;
    }
    return [a, b, c, d].map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("") + ":" + u8.length;
  }

  const hex = (buffer) => Array.from(new Uint8Array(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength || undefined), (b) => b.toString(16).padStart(2, "0")).join("");
  const asBytes = (value) => value instanceof Uint8Array
    ? value
    : new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength || undefined);
  const ownBuffer = (value) => {
    const bytes = asBytes(value);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  };
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  async function digestHex(value) {
    const bytes = asBytes(value);
    try {
      if (!window.crypto || !window.crypto.subtle) throw new Error("SubtleCrypto unavailable");
      return hex(await window.crypto.subtle.digest("SHA-256", ownBuffer(bytes)));
    } catch (error) {
      return "fp-" + bytesSig(bytes).replace(":", "-");
    }
  }

  async function contentId(value) {
    const digest = await digestHex(value);
    return digest.startsWith("fp-") ? digest : "sha256-" + digest;
  }

  const engineGameName = (filename, gid) => {
    const clean = baseName(filename).replace(/[^a-z0-9._ -]+/gi, "_").trim().slice(0, 80) || "game";
    return clean + "-" + gid + ".gba";
  };

  function parseGbaHeader(value) {
    const bytes = asBytes(value);
    if (bytes.length < 0xbe) return null;
    const ascii = (start, length) => textDecoder.decode(bytes.slice(start, start + length)).replace(/[\0\xff]+/g, "").trim();
    const gameCode = ascii(0xac, 4).toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(gameCode)) return null;
    return {
      title: ascii(0xa0, 12),
      gameCode,
      makerCode: ascii(0xb0, 2).toUpperCase(),
      revision: bytes[0xbc],
    };
  }

  let runtimeBundlePromise = null;
  function ensureRuntimeBundle() {
    if (window.EJS_COMPRESSION) return Promise.resolve();
    if (runtimeBundlePromise) return runtimeBundlePromise;
    runtimeBundlePromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = (window.PIXELGBA_FLAT_PATHS && window.PIXELGBA_FLAT_PATHS["emulator.min.js"]) || "emulator.min.js";
      script.dataset.pgbaRuntime = "1";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Could not load the archive extractor runtime"));
      document.head.appendChild(script);
    }).catch((error) => { runtimeBundlePromise = null; throw error; });
    return runtimeBundlePromise;
  }

  async function extractWithBundledRuntime(bytes) {
    await ensureRuntimeBundle();
    const bridge = {
      downloadFile: async (path, _progress, _cors, options = {}) => {
        const filename = String(path).split("/").pop();
        const mapped = (window.PIXELGBA_FLAT_PATHS && window.PIXELGBA_FLAT_PATHS[filename]) || filename;
        const response = await fetch(new URL(mapped, location.href));
        if (!response.ok) return -1;
        return { data: options.responseType === "text" ? await response.text() : await response.arrayBuffer() };
      },
      startGameError(message) { throw new Error(message || "Archive extraction failed"); },
    };
    return new window.EJS_COMPRESSION(bridge).decompress(bytes, () => {});
  }

  async function extractZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("ZIP directory was not found");
    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const candidates = [];
    for (let index = 0; index < count; index++) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Invalid ZIP directory");
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const size = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = textDecoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
      if (/\.(gba|agb|bin|rom)$/i.test(name) && !name.endsWith("/")) {
        candidates.push({ name, method, compressedSize, size, localOffset });
      }
      offset += 46 + nameLength + extraLength + commentLength;
    }
    if (!candidates.length) throw new Error("The archive contains no GBA ROM");
    candidates.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
    const entry = candidates[0];
    if (view.getUint32(entry.localOffset, true) !== 0x04034b50) throw new Error("Invalid ZIP entry");
    const localNameLength = view.getUint16(entry.localOffset + 26, true);
    const localExtraLength = view.getUint16(entry.localOffset + 28, true);
    const start = entry.localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(start, start + entry.compressedSize);
    let data;
    if (entry.method === 0) data = compressed;
    else if (entry.method === 8 && typeof DecompressionStream !== "undefined") {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      data = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      throw new Error("ZIP compression requires the bundled extractor");
    }
    if (entry.size && data.length !== entry.size) throw new Error("ZIP entry size mismatch");
    return { name: entry.name, data };
  }

  async function extractArchiveRom(rawBytes, filename) {
    const isZip = rawBytes[0] === 0x50 && rawBytes[1] === 0x4b;
    if (isZip) {
      try { return await extractZip(rawBytes); } catch (error) {
        console.warn("Native ZIP extraction failed; using bundled extractor", error);
      }
    }
    if (!isZip && !/\.(7z|rar)$/i.test(filename)) return { name: filename, data: rawBytes };
    const files = await extractWithBundledRuntime(rawBytes);
    const candidates = Object.entries(files || {})
      .filter(([name, data]) => /\.(gba|agb|bin|rom)$/i.test(name) && data && asBytes(data).length)
      .map(([name, data]) => ({ name, data: asBytes(data) }))
      .sort((a, b) => b.data.length - a.data.length || a.name.localeCompare(b.name));
    if (!candidates.length) throw new Error("The archive contains no GBA ROM");
    return candidates[0];
  }

  /** Hash the extracted cartridge so raw, ZIP, 7z and RAR copies share one identity. */
  async function identifyRom(file) {
    const rawBuffer = await file.arrayBuffer();
    const rawBytes = new Uint8Array(rawBuffer);
    const extracted = await extractArchiveRom(rawBytes, file.name);
    const romBytes = asBytes(extracted.data);
    const gid = await contentId(romBytes);
    const rawGid = romBytes === rawBytes ? gid : await contentId(rawBytes);
    const romName = String(extracted.name || file.name).split(/[\\/]/).pop() || "game.gba";
    const legacyGids = [...new Set([legacyGidOf(file.name), legacyGidOf(romName), rawGid])].filter((id) => id && id !== gid);
    return {
      gid,
      legacyGid: legacyGids[0] || null,
      legacyGids,
      buffer: ownBuffer(romBytes),
      name: romName,
      sourceName: file.name,
      header: parseGbaHeader(romBytes),
      archived: rawBytes.length !== romBytes.length || romName !== file.name,
    };
  }

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
    const DB_VERSION = 2;
    function open(kind) {
      const spec = DBS[kind];
      if (cache[kind]) return cache[kind];
      if (!window.indexedDB) return Promise.reject(new Error("IndexedDB unavailable"));
      cache[kind] = new Promise((resolve, reject) => {
        const req = indexedDB.open(spec.name, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(spec.store)) db.createObjectStore(spec.store);
        };
        req.onsuccess = () => {
          req.result.onversionchange = () => req.result.close();
          resolve(req.result);
        };
        req.onerror = () => {
          delete cache[kind];
          reject(req.error || new Error("Could not open IndexedDB"));
        };
        req.onblocked = () => {
          delete cache[kind];
          reject(new Error("IndexedDB upgrade was blocked by another tab"));
        };
      });
      return cache[kind];
    }
    async function tx(kind, mode, fn) {
      const db = await open(kind);
      return new Promise((resolve, reject) => {
        const t = db.transaction([DBS[kind].store], mode);
        const store = t.objectStore(DBS[kind].store);
        let out;
        let r;
        try { r = fn(store); } catch (error) { reject(error); return; }
        if (r) r.onsuccess = () => (out = r.result);
        if (r) r.onerror = () => reject(r.error || new Error("IndexedDB request failed"));
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error || new Error("IndexedDB transaction failed"));
        t.onabort = () => reject(t.error || new Error("IndexedDB transaction aborted"));
      });
    }
    return {
      get: (kind, key) => tx(kind, "readonly", (s) => s.get(key)),
      put: (kind, key, val) => tx(kind, "readwrite", (s) => s.put(val, key)),
      del: (kind, key) => tx(kind, "readwrite", (s) => s.delete(key)),
      clear: async (kind) => {
        try { await tx(kind, "readwrite", (s) => s.clear()); } catch (e) { console.warn(e); }
        try { const db = await cache[kind]; db && db.close(); } catch (e) {}
        delete cache[kind];
      },
      keys: (kind) => tx(kind, "readonly", (s) => s.getAllKeys()),
      entries: async (kind) => {
        const keys = await tx(kind, "readonly", (s) => s.getAllKeys());
        const values = await Promise.all(keys.map((key) => tx(kind, "readonly", (s) => s.get(key))));
        return keys.map((key, index) => [key, values[index]]);
      },
      deletePrefix: async (kind, prefix) => {
        const keys = await tx(kind, "readonly", (s) => s.getAllKeys());
        await Promise.all(keys.filter((key) => String(key).startsWith(prefix)).map((key) => tx(kind, "readwrite", (s) => s.delete(key))));
      },
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
        set(k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
        setRaw(k, v) { try { window.localStorage.setItem(k, String(v)); return true; } catch (e) { return false; } },
        del(k) { try { window.localStorage.removeItem(k); } catch (e) {} },
        raw: (k) => { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
        allKeys: () => { try { return Object.keys(window.localStorage); } catch (e) { return []; } },
        persistent: true,
      };
    }
    return {
      get(k, d) { return k in mem ? mem[k] : d; },
      set(k, v) { mem[k] = v; return true; },
      setRaw(k, v) { try { mem[k] = JSON.parse(v); } catch (e) { mem[k] = v; } return true; },
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
  const K_LIBRARY_SORT = "pgba.librarySort";
  const STATE_MAGIC = "PIXELGBA_STATE_V1\n";
  const BACKUP_FORMAT = "pixelgba-backup-v1";
  const CORE_ID = "mgba";
  const EMULATOR_VERSION = "4.2.3";

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
    launchId: 0,
    bootTimer: null,
    storageWarned: false,
    libraryQuery: "",
    librarySort: store.get(K_LIBRARY_SORT, "recent"),
    favoritesOnly: false,
    saveSyncQueue: Promise.resolve(),
    saveEventHandler: null,
  };

  if (!Array.isArray(S.roms)) S.roms = [];

  function persist(key, value, label = "settings") {
    const ok = store.set(key, value);
    if (!ok && !S.storageWarned) {
      S.storageWarned = true;
      toast("Could not persist " + label + " — browser storage may be full or blocked", "warn", 6500);
    }
    return ok;
  }

  /* FLAT BUILD: all engine files live next to index.html (no subfolders),
     so dataPath is the page itself and EJS_paths maps the usual names. */
  const FLAT_PATHS = window.PIXELGBA_FLAT_PATHS || null;
  const ENGINE = {
    dataPath: FLAT_PATHS ? new URL("./", location.href).href : new URL("emulatorjs/", location.href).href,
    loader: FLAT_PATHS ? new URL("loader.js", location.href).href : new URL("emulatorjs/loader.js", location.href).href,
  };

  /* ------------------------------------------------------------- view tabs */
  const tabs = $$(".tab");
  function activateTab(tab, { focus = false } = {}) {
    tabs.forEach((item) => {
      const active = item === tab;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", String(active));
      item.tabIndex = active ? 0 : -1;
    });
    $$(".view").forEach((view) => {
      const active = view.id === "view-" + tab.dataset.view;
      view.classList.toggle("is-active", active);
      view.hidden = !active;
    });
    if (focus) tab.focus();
    if (tab.dataset.view === "saves") renderSaves();
    if (tab.dataset.view === "cheats") renderCheats();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateTab(tab));
    tab.addEventListener("keydown", (event) => {
      let next = null;
      if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
      else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === "Home") next = tabs[0];
      else if (event.key === "End") next = tabs[tabs.length - 1];
      if (next) { event.preventDefault(); activateTab(next, { focus: true }); }
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

  async function migrateLegacyIdentity(identity, filename) {
    const newGid = identity.gid;
    const oldGids = [...new Set(identity.legacyGids || [identity.legacyGid])]
      .filter((gid) => gid && gid !== newGid);
    if (!oldGids.length) return;

    const moveRecord = async (kind, from, to) => {
      const oldValue = await IDB.get(kind, from).catch(() => null);
      if (!oldValue) return;
      const existing = await IDB.get(kind, to).catch(() => null);
      if (!existing) await IDB.put(kind, to, oldValue);
      await IDB.del(kind, from).catch(() => {});
    };

    for (const oldGid of oldGids) {
      await moveRecord("saves", oldGid, newGid);
      await moveRecord("saves", "__rom__" + oldGid, "__rom__" + newGid);
      const stateKeys = await IDB.keys("states").catch(() => []);
      for (const key of stateKeys.filter((key) => String(key).startsWith(oldGid + ":"))) {
        await moveRecord("states", key, newGid + String(key).slice(oldGid.length));
      }

      const oldCheats = store.raw(K_CHEATS(oldGid));
      if (oldCheats && !store.raw(K_CHEATS(newGid))) store.setRaw(K_CHEATS(newGid), oldCheats);
      if (oldCheats) store.del(K_CHEATS(oldGid));

      // EmulatorJS includes EJS_gameID in its per-game settings key. Preserve
      // controls/settings from filename/archive-keyed versions on first load.
      const oldEnginePrefix = "ejs-pgba-" + oldGid + "-";
      for (const key of store.allKeys().filter((key) => key.startsWith(oldEnginePrefix))) {
        const suffix = key.slice(oldEnginePrefix.length);
        const core = suffix.split("-")[0] || "gba";
        const target = "ejs-pgba-" + newGid + "-" + core + "-" + engineGameName(identity.name || filename, newGid) + "-settings";
        if (!store.raw(target)) store.setRaw(target, store.raw(key));
        store.del(key);
      }
    }

    const oldSet = new Set(oldGids);
    S.roms = S.roms
      .map((rom) => oldSet.has(rom.gid) ? { ...rom, gid: newGid, name: identity.name || rom.name, header: identity.header || rom.header } : rom)
      .filter((rom, index, all) => all.findIndex((candidate) => candidate.gid === rom.gid) === index);
    persist(K_ROMS, S.roms, "the ROM library");

    const last = store.get(K_LASTROM, null);
    if (last && oldSet.has(last.gid)) persist(K_LASTROM, { ...last, gid: newGid, name: identity.name || last.name, header: identity.header || last.header }, "the last played game");
  }

  function seedPresetCheats(gid, presetId) {
    if (!gid || !presetId || store.raw(K_CHEATS(gid))) return;
    const preset = store.raw(K_CHEATS("preset:" + presetId));
    if (preset) store.setRaw(K_CHEATS(gid), preset);
  }

  /* ========================================================================
     LIBRARY — ROM list rendered from localStorage metadata
     ===================================================================== */
  function renderLibrary() {
    const query = S.libraryQuery.trim().toLowerCase();
    const filtered = S.roms.filter((rom) => {
      const haystack = [rom.name, rom.header && rom.header.title, rom.header && rom.header.gameCode].filter(Boolean).join(" ").toLowerCase();
      return (!query || haystack.includes(query)) && (!S.favoritesOnly || rom.favorite);
    });
    const sorted = filtered.slice().sort((a, b) => {
      if (S.librarySort === "title") return baseName(a.name).localeCompare(baseName(b.name), undefined, { sensitivity: "base" });
      if (S.librarySort === "added") return (b.addedAt || b.lastPlayed || 0) - (a.addedAt || a.lastPlayed || 0);
      return (b.lastPlayed || 0) - (a.lastPlayed || 0);
    });
    const list = $("#recentList");
    $("#romCount").textContent = sorted.length === S.roms.length ? String(S.roms.length) : sorted.length + "/" + S.roms.length;
    list.innerHTML = "";
    if (!sorted.length) {
      list.innerHTML = '<div class="empty-state">' + (S.roms.length ? "No games match this filter." : "Your locally cached games appear here.") + "</div>";
      return;
    }
    for (const rom of sorted) {
      const row = document.createElement("div");
      row.className = "recent-item";
      const headerMeta = rom.header && rom.header.gameCode
        ? " · " + esc(rom.header.gameCode) + " rev " + Number(rom.header.revision || 0)
        : "";
      row.innerHTML =
        '<button type="button" class="r-favorite" aria-pressed="' + String(!!rom.favorite) + '" aria-label="' + (rom.favorite ? "Remove " : "Add ") + esc(baseName(rom.name)) + ' ' + (rom.favorite ? "from favorites" : "to favorites") + '" title="Favorite">' + (rom.favorite ? "★" : "☆") + "</button>" +
        '<button type="button" class="r-play" title="Play ' + esc(rom.name) + '">' +
        '<span class="r-ico" aria-hidden="true">GBA</span>' +
        '<span class="r-copy"><span class="r-name">' + esc(baseName(rom.name)) + "</span>" +
        '<span class="r-meta">' + fmtBytes(rom.size) + " · " + fmtWhen(rom.lastPlayed) + headerMeta +
        (rom.cached === false ? " · file not cached" : "") + "</span></span></button>" +
        '<button type="button" class="r-del" aria-label="Remove ' + esc(baseName(rom.name)) + ' from library" title="Remove from library; saves are kept">×</button>' +
        '<button type="button" class="r-purge" aria-label="Delete ' + esc(baseName(rom.name)) + ' and all local data" title="Delete game and all local data">🗑</button>';
      $(".r-favorite", row).addEventListener("click", () => {
        rom.favorite = !rom.favorite;
        persist(K_ROMS, S.roms, "the ROM library");
        renderLibrary();
      });
      $(".r-play", row).addEventListener("click", () => launchStoredRom(rom));
      $(".r-del", row).addEventListener("click", async () => {
        S.roms = S.roms.filter((r) => r.gid !== rom.gid);
        persist(K_ROMS, S.roms, "the ROM library");
        await IDB.del("saves", "__rom__" + rom.gid).catch(() => {});
        renderLibrary();
        toast("Removed " + baseName(rom.name) + " from the library; saves and states were kept", "info", 5000);
      });
      $(".r-purge", row).addEventListener("click", () => deleteGameData(rom));
      list.appendChild(row);
    }
  }

  async function launchStoredRom(rom) {
    // ROM blobs are cached in IndexedDB so the library can relaunch without re-picking the file.
    const cached = await IDB.get("saves", "__rom__" + rom.gid).catch(() => null);
    if (!cached || !cached.data) {
      toast("That ROM isn't cached anymore — pick the file again from your PC", "warn", 5200);
      $("#romInput").click();
      return;
    }
    const blob = new Blob([cached.data], { type: "application/octet-stream" });
    await startGame(new File([blob], rom.name, { lastModified: rom.lastPlayed || Date.now() }));
  }

  async function rememberRom(file, identity) {
    const previous = S.roms.find((rom) => rom.gid === identity.gid);
    const rec = {
      name: identity.name || file.name,
      sourceName: identity.sourceName || file.name,
      gid: identity.gid,
      size: identity.buffer.byteLength,
      lastPlayed: Date.now(),
      addedAt: previous?.addedAt || Date.now(),
      favorite: !!previous?.favorite,
      header: identity.header || null,
      cached: true,
    };
    try {
      await IDB.put("saves", "__rom__" + identity.gid, { data: identity.buffer, name: rec.name, sourceName: rec.sourceName, header: rec.header, at: Date.now() });
    } catch (error) {
      rec.cached = false;
      console.warn("Could not cache ROM blob", error);
      toast("The game can run, but it could not be cached for Play again — browser storage may be full", "warn", 6500);
    }
    S.roms = S.roms.filter((rom) => rom.gid !== identity.gid && rom.gid !== identity.legacyGid);
    S.roms.unshift(rec);
    persist(K_ROMS, S.roms, "the ROM library");
    return rec;
  }

  async function deleteEngineSaveRecords(paths) {
    const wanted = new Set(paths.filter(Boolean));
    if (!wanted.size || !window.indexedDB) return;
    let names = ["EM_FS_" + location.pathname];
    try {
      if (indexedDB.databases) names = (await indexedDB.databases()).map((db) => db.name).filter((name) => name && name.startsWith("EM_FS_"));
    } catch (error) {}
    await Promise.all(names.map((name) => new Promise((resolve) => {
      const req = indexedDB.open(name);
      req.onerror = () => resolve();
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("FILE_DATA")) { db.close(); resolve(); return; }
        const tx = db.transaction("FILE_DATA", "readwrite");
        const objectStore = tx.objectStore("FILE_DATA");
        for (const path of wanted) objectStore.delete(path);
        tx.oncomplete = tx.onerror = tx.onabort = () => { db.close(); resolve(); };
      };
    })));
  }

  async function deleteOwnedEngineFilesystem() {
    if (!window.indexedDB) return;
    const directory = location.pathname.endsWith("/") ? location.pathname : location.pathname.replace(/[^/]*$/, "");
    const ownedNames = new Set(["EM_FS_" + location.pathname, "EM_FS_" + directory]);
    let names = [...ownedNames];
    try {
      if (indexedDB.databases) names = (await indexedDB.databases()).map((db) => db.name).filter((name) => ownedNames.has(name));
    } catch (error) {}
    await Promise.all(names.filter(Boolean).map((name) => new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    })));
  }

  function deleteEngineSettings(gid) {
    store.allKeys().filter((key) => key.startsWith("ejs-pgba-" + gid + "-")).forEach((key) => store.del(key));
  }

  async function deleteGameData(rom) {
    if (!confirm("Delete " + baseName(rom.name) + " and all of its cached ROM data, battery saves, states, cheats and settings? This cannot be undone.")) return;
    const save = await IDB.get("saves", rom.gid).catch(() => null);
    let livePath = null;
    if (S.current && S.current.gid === rom.gid) {
      livePath = saveFilePath();
      await stopGame({ silent: true });
    }
    await IDB.del("saves", rom.gid).catch(() => {});
    await IDB.del("saves", "__rom__" + rom.gid).catch(() => {});
    await IDB.deletePrefix("states", rom.gid + ":").catch(() => {});
    await deleteEngineSaveRecords([livePath, save && save.enginePath]);
    store.del(K_CHEATS(rom.gid));
    deleteEngineSettings(rom.gid);
    S.roms = S.roms.filter((item) => item.gid !== rom.gid);
    persist(K_ROMS, S.roms, "the ROM library");
    if (S.current && S.current.gid === rom.gid) {
      S.current = null;
      const last = store.get(K_LASTROM, null);
      if (last && last.gid === rom.gid) store.del(K_LASTROM);
    }
    renderLibrary(); renderSaves(); renderCheats(); renderBootHint();
    toast("Deleted " + baseName(rom.name) + " and all of its local data", "warn", 5200);
  }

  /* ---- input wiring ---- */
  $("#librarySearch").addEventListener("input", (event) => {
    S.libraryQuery = event.target.value;
    renderLibrary();
  });
  $("#librarySort").value = ["recent", "title", "added"].includes(S.librarySort) ? S.librarySort : "recent";
  $("#librarySort").addEventListener("change", (event) => {
    S.librarySort = event.target.value;
    persist(K_LIBRARY_SORT, S.librarySort, "the library sort order");
    renderLibrary();
  });
  $("#libraryFavorites").addEventListener("click", (event) => {
    S.favoritesOnly = !S.favoritesOnly;
    event.currentTarget.setAttribute("aria-pressed", String(S.favoritesOnly));
    event.currentTarget.classList.toggle("is-active", S.favoritesOnly);
    renderLibrary();
  });
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
  $("#dropZone").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      $("#romInput").click();
    }
  });

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
    if (!/\.(gba|agb|bin|zip|7z|rar)$/i.test(f.name)) {
      toast("That's not a GBA ROM — expected .gba / .agb / .bin / .zip / .7z / .rar", "error");
      return;
    }
    startGame(f);
  });

  /* ========================================================================
     EMULATOR LIFECYCLE
     ===================================================================== */
  /**
   * Run the EmulatorJS loader. Its bootstrap must re-run for every session; the
   * patched loader reuses the already-evaluated engine bundle and stylesheet.
   */
  function runLoader() {
    return new Promise((resolve, reject) => {
      document.querySelectorAll("script[data-pgba-loader]").forEach((script) => script.remove());
      const script = document.createElement("script");
      script.src = ENGINE.loader;
      script.dataset.pgbaLoader = "1";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Could not load engine script"));
      document.head.appendChild(script);
    });
  }

  function emulator() { return window.EJS_emulator || null; }
  function gameManager() { const e = emulator(); return e && e.gameManager ? e.gameManager : null; }
  function disposeStaleEmulator(emu) {
    if (!emu) return;
    try { emu.gamepad && emu.gamepad.terminate && emu.gamepad.terminate(); } catch (e) {}
    try { emu.callEvent && emu.callEvent("exit"); } catch (e) {}
    try { emu.pgbaDisposeListeners && emu.pgbaDisposeListeners(); } catch (e) {}
  }

  async function startGame(file) {
    if (S.starting) { toast("A game is already booting…", "warn"); return; }
    if (IS_FILE) {
      showEnvBanner("file");
      toast("Can't run from file:// — double-click serve.bat (Windows) or run ./serve.sh, then open http://localhost:8080", "error", 9000);
      return;
    }
    const ok = /\.(gba|agb|bin|zip|7z|rar)$/i.test(file.name || "");
    if (!ok) { toast("Please choose a .gba ROM file", "error"); return; }

    S.starting = true;
    const launchId = ++S.launchId;
    let identity;
    try {
      pill("Reading game…", true);
      identity = await identifyRom(file);
      if (launchId !== S.launchId) return;
    } catch (error) {
      S.starting = false;
      pill("Could not read game", false);
      toast("Could not read that ROM file", "error");
      return;
    }

    await stopGame({ silent: true, keepOverlay: true, preserveLaunch: true });
    if (launchId !== S.launchId) return;
    S.starting = true;
    await migrateLegacyIdentity(identity, file.name).catch((error) => console.warn("Legacy storage migration failed", error));
    const romFile = new File([identity.buffer], identity.name || file.name, {
      type: "application/octet-stream",
      lastModified: file.lastModified || Date.now(),
    });

    S.current = {
      name: romFile.name,
      sourceName: file.name,
      gid: identity.gid,
      size: identity.buffer.byteLength,
      lastPlayed: Date.now(),
      header: identity.header || null,
    };
    S.lastSaveSig = null;
    S.savedSave = null;
    S.savedSaveAt = 0;
    persist(K_LASTROM, S.current, "the last played game");

    // Preselect the matching Pokémon preset and carry over cheats configured
    // before the ROM was loaded.
    const match = PRESETS.match(romFile.name, identity.header);
    if (match) {
      S.presetId = match.id;
      persist(K_LASTPRESET, match.id, "the selected cheat preset");
      seedPresetCheats(identity.gid, match.id);
    }

    rememberRom(file, identity).then(renderLibrary).catch((error) => console.warn(error));
    renderLibrary();

    boot.hide();
    pill("Loading engine…", true);
    $("#toolbarHint").textContent = "Booting " + baseName(romFile.name) + "…";
    renderSaves(); renderCheats();

    /* --- EmulatorJS globals (read by loader.js) --- */
    window.EJS_player = "#game";
    window.EJS_core = "mgba";
    window.EJS_pathtodata = ENGINE.dataPath;
    window.EJS_gameUrl = romFile;
    // The core derives its IDBFS save path from gameName. Include the content ID so
    // same-named revisions cannot collide in EmulatorJS's own filesystem either.
    window.EJS_gameName = engineGameName(romFile.name, S.current.gid);
    const expectedGameId = "pgba-" + S.current.gid;
    window.EJS_gameID = expectedGameId;
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
        if (launchId !== S.launchId || !emu || !emu.config || emu.config.gameId !== expectedGameId) {
          disposeStaleEmulator(emu);
          return;
        }
        // pause-time save sync
        const origToggle = emu.togglePlaying.bind(emu);
        emu.togglePlaying = (dontUpdate) => {
          origToggle(dontUpdate);
          if (emu.paused) syncSaveNow().catch(() => {});
        };
        // EmulatorJS emits this whenever the core flushes SRAM. Polling remains a
        // fallback, while this hook persists normal in-game saves immediately.
        S.saveEventHandler = (bytes) => {
          if (!S.saveFlushInProgress) syncSaveNow({ fromEvent: true, bytes }).catch(() => {});
        };
        emu.on && emu.on("saveSaveFiles", S.saveEventHandler);
        // theme the emulator menu bar to match PixelGBA
        emu.setColor && emu.setColor("#8b7bff");
      } catch (e) { console.warn(e); }
    };

    window.EJS_onGameStart = () => {
      const emu = emulator();
      if (launchId !== S.launchId || !emu || !emu.config || emu.config.gameId !== expectedGameId) {
        disposeStaleEmulator(emu);
        return;
      }
      if (S.bootTimer) clearTimeout(S.bootTimer);
      S.bootTimer = null;
      S.running = true;
      S.starting = false;
      boot.hide();
      pill("Playing · " + baseName(romFile.name), false);
      $("#toolbarHint").textContent = baseName(romFile.name) + " · " + fmtBytes(identity.buffer.byteLength);
      restoreBatterySave().then(() => {
        if (launchId === S.launchId) applyEnabledCheats();
      });
      startSavePoll();
      renderLibrary(); renderSaves(); renderCheats(); renderBootHint();
      toast("Loaded " + baseName(romFile.name), "success");
    };

    try {
      await runLoader();
      if (launchId !== S.launchId) return;
      S.engineLoaded = true;
    } catch (e) {
      if (launchId !== S.launchId) return;
      S.starting = false;
      boot.show();
      pill("Engine failed to load", false);
      toast("Could not load the bundled emulator engine. Run the self-check to find a missing asset.", "error", 7000);
      return;
    }

    if (IS_FILE) showEnvBanner("file");
    else if (IS_FRAMED) showEnvBanner("preview");

    // Watchdog: if the core never starts, surface a hint instead of a silent black screen.
    if (S.bootTimer) clearTimeout(S.bootTimer);
    S.bootTimer = setTimeout(() => {
      if (launchId === S.launchId && S.starting && !S.running) {
        S.starting = false;
        boot.show();
        pill("Failed to start", false);
        if (IS_FRAMED || IS_FILE) {
          showEnvBanner(IS_FILE ? "file" : "preview");
          toast(IS_FILE
            ? "Opened from file:// — run serve.bat (Windows) or ./serve.sh, then use http://localhost:8080"
            : "Embedded previews block the emulator's engine files. Open the address in a normal browser tab.", "warn", 9000);
        } else {
          toast("The core didn't start. Try unzipping the ROM, or run the self-check.", "error", 7000);
        }
      }
    }, IS_FRAMED ? 12000 : 30000);
  }

  async function stopGame({ silent = false, keepOverlay = false, preserveLaunch = false } = {}) {
    if (!preserveLaunch) S.launchId++;
    if (S.bootTimer) clearTimeout(S.bootTimer);
    S.bootTimer = null;
    stopSavePoll();
    const emu = emulator();
    const shouldExit = !!(emu && emu.started && emu.gameManager);
    if (emu) {
      try { await syncSaveNow({ force: true }); } catch (e) {}
      try { emu.setVolume(0); } catch (e) {}
      try { emu.pause(true); } catch (e) {}
      try { emu.gamepad && emu.gamepad.terminate && emu.gamepad.terminate(); } catch (e) {}
      try { if (S.saveEventHandler && emu.off) emu.off("saveSaveFiles", S.saveEventHandler); } catch (e) {}
      S.saveEventHandler = null;
      try {
        if (shouldExit && emu.callEvent) emu.callEvent("exit");
        else if (emu.gameManager) emu.gameManager.toggleMainLoop(0);
        if (emu.pgbaDisposeListeners) emu.pgbaDisposeListeners();
      } catch (e) { console.warn("Engine teardown failed", e); }
      // EmulatorJS aborts and unmounts its WASM filesystem one second after exit.
      if (shouldExit) await sleep(1050);
      try { emu.functions = {}; } catch (e) {}
    }
    if (window.EJS_emulator === emu) window.EJS_emulator = null;
    const host = $("#game");
    if (host) { host.innerHTML = ""; host.classList.remove("ejs_parent"); host.removeAttribute("tabindex"); }
    S.running = false;
    if (!preserveLaunch) S.starting = false;
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

  /* ========================================================================
     BATTERY SAVE (.sav) — auto sync in/out
     ===================================================================== */
  function saveFilePath() {
    const gm = gameManager();
    if (!gm) return null;
    try { return gm.getSaveFilePath(); } catch (e) { return null; }
  }

  async function performSaveSync({ force = false, fromEvent = false, bytes: suppliedBytes = null } = {}) {
    const gm = gameManager();
    const current = S.current;
    if (!gm || !S.running || !current) return;
    let bytes = suppliedBytes ? asBytes(suppliedBytes) : null;
    try {
      if (!fromEvent) {
        S.saveFlushInProgress = true;
        gm.saveSaveFiles && gm.saveSaveFiles();
      }
      if (!bytes || !bytes.length) bytes = gm.getSaveFile(false);
    } catch (e) {
      return;
    } finally {
      S.saveFlushInProgress = false;
    }
    if (!bytes || !bytes.length) return;
    const sig = bytesSig(bytes);
    if (!force && sig === S.lastSaveSig) return;
    const copy = bytes.slice(); // detach from WASM heap
    const savedAt = Date.now();
    let enginePath = null;
    try { enginePath = gm.getSaveFilePath(); } catch (e) {}
    try {
      const previous = await IDB.get("saves", current.gid).catch(() => null);
      const previousSig = previous && previous.data ? (previous.sig || bytesSig(new Uint8Array(previous.data))) : null;
      if (sig === previousSig) {
        if (S.current && S.current.gid === current.gid) {
          S.lastSaveSig = sig;
          S.savedSave = copy;
          S.savedSaveAt = previous.at || savedAt;
          renderSavPanel();
        }
        return;
      }
      const history = previous && previous.data
        ? [{ data: previous.data, at: previous.at || savedAt, sig: previousSig }, ...(previous.history || [])].slice(0, 2)
        : [];
      await IDB.put("saves", current.gid, {
        data: copy.buffer,
        at: savedAt,
        name: current.name,
        enginePath,
        sig,
        history,
      });
      if (S.current && S.current.gid === current.gid) {
        S.lastSaveSig = sig;
        S.savedSave = copy;
        S.savedSaveAt = savedAt;
        renderSavPanel();
      }
    } catch (e) {
      console.warn("save sync failed", e);
      toast("Battery save could not be persisted — export it before closing this page", "error", 7000);
      throw e;
    }
  }

  function syncSaveNow(options = {}) {
    // Serialize reads/writes so a core event, poll and visibility flush cannot race
    // and overwrite a newer save with an older snapshot.
    S.saveSyncQueue = S.saveSyncQueue.catch(() => {}).then(() => performSaveSync(options));
    return S.saveSyncQueue;
  }

  async function restoreBatterySave() {
    const gm = gameManager();
    const current = S.current;
    if (!gm || !current) return;
    const rec = await IDB.get("saves", current.gid).catch(() => null);
    if (!rec || !rec.data || gameManager() !== gm || !S.current || S.current.gid !== current.gid) return;
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
  const finalSaveFlush = () => {
    // Browsers do not wait for asynchronous IndexedDB work during unload. The
    // visibility/pagehide hooks start the write as early as the platform allows.
    if (S.running) syncSaveNow({ force: true }).catch(() => {});
  };
  window.addEventListener("pagehide", finalSaveFlush);
  window.addEventListener("beforeunload", finalSaveFlush);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && S.running) syncSaveNow().catch(() => {});
  });

  /* ========================================================================
     SAVE STATES
     ===================================================================== */
  const stateKey = (slot) => (S.current ? S.current.gid : null) + ":" + slot;
  function nextFreeSlot(keys, gid, max = 5) {
    for (let slot = 1; slot <= max; slot++) if (!keys.includes(gid + ":" + slot)) return slot;
    return null;
  }

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
      thumb,
      at: Date.now(),
      size: state.byteLength,
      name: S.current.name,
      metadata: { gameId: S.current.gid, core: CORE_ID, emulatorVersion: EMULATOR_VERSION, romHeader: S.current.header || null },
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
  async function packStateFile(data, metadata = {}) {
    const bytes = asBytes(data);
    const header = {
      format: "pixelgba-state-v1",
      gameId: metadata.gameId,
      romName: metadata.romName || "game.gba",
      romHeader: metadata.romHeader || null,
      core: CORE_ID,
      emulatorVersion: EMULATOR_VERSION,
      createdAt: metadata.createdAt || Date.now(),
      byteLength: bytes.length,
      sha256: await digestHex(bytes),
    };
    return new Blob([STATE_MAGIC, JSON.stringify(header), "\n", bytes], { type: "application/x-pixelgba-state" });
  }

  async function unpackStateFile(buffer) {
    const bytes = asBytes(buffer);
    const magic = textEncoder.encode(STATE_MAGIC);
    const wrapped = bytes.length > magic.length && magic.every((value, index) => bytes[index] === value);
    if (!wrapped) return { data: ownBuffer(bytes), metadata: null, wrapped: false };
    let newline = -1;
    for (let index = magic.length; index < Math.min(bytes.length, magic.length + 65_536); index++) {
      if (bytes[index] === 10) { newline = index; break; }
    }
    if (newline < 0) throw new Error("State metadata is incomplete");
    let metadata;
    try { metadata = JSON.parse(textDecoder.decode(bytes.slice(magic.length, newline))); }
    catch (error) { throw new Error("State metadata is invalid"); }
    const data = bytes.slice(newline + 1);
    if (metadata.format !== "pixelgba-state-v1" || metadata.byteLength !== data.length) throw new Error("State length does not match its metadata");
    if (metadata.sha256 !== await digestHex(data)) throw new Error("State checksum does not match");
    return { data: ownBuffer(data), metadata, wrapped: true };
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
    const blob = await packStateFile(bestRec.data, {
      gameId: S.current.gid,
      romName: S.current.name,
      romHeader: S.current.header,
      createdAt: bestRec.at,
    });
    downloadBlob(blob, baseName(S.current.name) + "-slot" + String(best).split(":")[1] + ".pgstate");
    toast("Exported validated PixelGBA state", "success");
  }

  async function importStateFile(file) {
    if (!S.current) { toast("Load the matching game first, then import its state", "warn", 5000); return; }
    if (!S.running) { toast("Start the game first, then import a state", "warn", 5000); return; }
    const current = S.current;
    const keys = await IDB.keys("states").catch(() => []);
    const free = nextFreeSlot(keys, current.gid);
    if (free === null) {
      toast("All five slots are occupied — delete a slot before importing", "warn", 6000);
      return;
    }
    let parsed;
    try {
      const buf = await file.arrayBuffer();
      if (!buf.byteLength || buf.byteLength > 64 * 1024 * 1024) throw new Error("State file size is invalid");
      parsed = await unpackStateFile(buf);
    } catch (error) {
      toast(error.message || "Could not read that state file", "error", 6000);
      return;
    }
    if (parsed.metadata) {
      if (parsed.metadata.gameId !== current.gid) {
        toast("That state belongs to a different ROM; no slot was changed", "error", 6500);
        return;
      }
      if (parsed.metadata.core !== CORE_ID || parsed.metadata.emulatorVersion !== EMULATOR_VERSION) {
        toast("That state was created by an incompatible core version; no slot was changed", "error", 6500);
        return;
      }
    }
    try {
      emulator().gameManager.loadState(new Uint8Array(parsed.data));
    } catch (error) {
      toast("That state is corrupt or incompatible; no slot was changed", "error", 6000);
      return;
    }
    const rec = {
      data: parsed.data,
      thumb: "",
      at: Date.now(),
      size: parsed.data.byteLength,
      name: file.name,
      metadata: parsed.metadata,
    };
    try {
      await IDB.put("states", current.gid + ":" + free, rec);
      toast("State imported into slot " + free + " and loaded" + (parsed.wrapped ? " (checksum verified)" : " (legacy raw state)"), "success");
      renderSaves();
    } catch (error) {
      toast("The state loaded, but browser storage could not save it", "error", 6000);
    }
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
  function setCheatList(list) { persist(K_CHEATS(cheatListKey()), list, "the cheat list"); }

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
  function validateCode(code, type = null) {
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
      const valid = type === "gs" ? digits.length === 16 : type === "cb" ? (digits.length === 12 || digits.length === 16) : (digits.length === 12 || digits.length === 16);
      if (!valid) {
        if (type === "gs") return "Each GameShark / Action Replay line needs 16 hex digits (8+8) — this one has " + digits.length;
        if (type === "cb") return "Each CodeBreaker line needs 12 or 16 hex digits — this one has " + digits.length;
        return "Each line needs 12 or 16 hex digits — this one has " + digits.length;
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
      item = { desc, code: norm, checked: !!on, custom: !!meta.custom, tag: meta.tag || "", type: meta.type || "" };
      list.push(item);
    } else {
      item.checked = !!on;
      if (meta.tag) item.tag = meta.tag;
      if (meta.type) item.type = meta.type;
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
    const matched = S.current ? PRESETS.match(S.current.name, S.current.header) : null;
    const activeId = S.presetId || (matched && matched.id) || "emerald";
    for (const g of PRESETS.games) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "preset-game" + (g.id === activeId ? " is-active" : "");
      b.style.setProperty("--dot", g.accent);
      b.innerHTML = "<i></i>" + esc(g.title.replace("Pokémon ", ""));
      b.addEventListener("click", () => {
        S.presetId = g.id;
        persist(K_LASTPRESET, g.id, "the selected cheat preset");
        renderCheats();
      });
      picker.appendChild(b);
    }

    const game = PRESETS.games.find((g) => g.id === activeId) || PRESETS.games[0];
    const mismatchNote = S.current && S.current.header && !matched
      ? "No preset exactly matches cartridge " + S.current.header.gameCode + " revision " + S.current.header.revision + ". Presets below are manual and may be incompatible. "
      : "";
    $("#presetNote").textContent = mismatchNote + (game.note || "");

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

  $("#ccType").addEventListener("change", (event) => {
    $("#ccHint").textContent = event.target.value === "gs"
      ? "GameShark / Action Replay: exactly 8+8 hex digits per line"
      : "CodeBreaker: 8+4 or 8+8 hex digits per line";
  });

  $("#customCheatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#ccName").value.trim();
    const code = $("#ccCode").value.trim();
    const type = $("#ccType").value;
    if (!name) { $("#ccName").focus(); return; }
    const err = validateCode(code, type);
    if (err) { toast(err, "error"); $("#ccCode").focus(); return; }
    const norm = normalizeCode(code);
    if (getCheatList().some((c) => normalizeCode(c.code) === norm)) {
      toast("That cheat code is already in the list", "warn");
      return;
    }
    toggleCheat(name, norm, true, { custom: true, type });
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
    const current = S.current;
    const currentGid = current && current.gid;
    const badge = $("#stateGameBadge");
    badge.textContent = current ? baseName(current.name) : "no game loaded";
    const grid = $("#slotGrid");
    grid.innerHTML = "";

    const keys = current ? await IDB.keys("states").catch(() => []) : [];
    if ((S.current && S.current.gid) !== currentGid) return;
    for (let slot = 1; slot <= 5; slot++) {
      const key = current ? current.gid + ":" + slot : null;
      const rec = key && keys.includes(key) ? await IDB.get("states", key).catch(() => null) : null;
      if ((S.current && S.current.gid) !== currentGid) return;
      const el = document.createElement("div");
      el.className = "slot" + (rec ? "" : " is-empty");
      el.innerHTML =
        '<div class="thumb">' + (rec && !rec.thumb ? "🎞" : "") + "</div>" +
        '<div class="s-body"><div class="s-title">Slot ' + slot + "</div>" +
        '<div class="s-meta">' + (rec ? fmtWhen(rec.at) + " · " + fmtBytes(rec.size) : "empty") + "</div>" +
        '<div class="s-actions">' +
        '<button type="button" class="btn btn-ghost" data-act="save" ' + (S.running ? "" : "disabled") + ">Save</button>" +
        '<button type="button" class="btn btn-ghost" data-act="load" ' + (rec && S.running ? "" : "disabled") + ">Load</button>" +
        (rec ? '<button type="button" class="btn btn-ghost" data-act="del" aria-label="Delete slot ' + slot + '" title="Delete slot">×</button>' : "") +
        "</div></div>";
      if (rec && rec.thumb) $(".thumb", el).style.backgroundImage = 'url("' + rec.thumb.replace(/"/g, "%22") + '")';
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

  function wireSavImport(buttons, input) {
    for (const btn of buttons) {
      $(btn).addEventListener("click", () => {
        if (!S.current) { toast("Load the matching game first", "warn", 4500); return; }
        $(input).click();
      });
    }
    $(input).addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f || !S.current) return;
      const buf = await f.arrayBuffer();
      if (buf.byteLength < 512 || buf.byteLength > 16 * 1024 * 1024) { toast("That doesn't look like a .sav file", "error"); return; }
      const current = S.current;
      try {
        const existing = await IDB.get("saves", current.gid).catch(() => null);
        const history = existing && existing.data
          ? [{ data: existing.data, at: existing.at || Date.now(), sig: existing.sig || bytesSig(new Uint8Array(existing.data)) }, ...(existing.history || [])].slice(0, 2)
          : [];
        await IDB.put("saves", current.gid, { data: buf, at: Date.now(), name: current.name, enginePath: S.running ? saveFilePath() : null, sig: bytesSig(new Uint8Array(buf)), history });
        if (!S.current || S.current.gid !== current.gid) return;
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
  wireSavImport(["#btnImportSav", "#btnQuickImportSav"], "#savInput");

  $("#btnRestoreSav").addEventListener("click", async () => {
    if (!S.current) { toast("Load a game first", "warn"); return; }
    await syncSaveNow({ force: true }).catch(() => {});
    const current = S.current;
    const rec = await IDB.get("saves", current.gid).catch(() => null);
    const previous = rec && rec.history && rec.history[0];
    if (!previous || !previous.data) { toast("No previous automatic save copy is available yet", "warn", 5000); return; }
    if (!confirm("Restore the previous battery save from " + fmtWhen(previous.at) + "? The current save will remain as a rolling backup.")) return;
    const currentCopy = { data: rec.data, at: rec.at, sig: rec.sig || bytesSig(new Uint8Array(rec.data)) };
    const restored = {
      ...rec,
      data: previous.data,
      at: Date.now(),
      sig: previous.sig || bytesSig(new Uint8Array(previous.data)),
      history: [currentCopy, ...(rec.history || []).slice(1)].slice(0, 2),
    };
    try {
      await IDB.put("saves", current.gid, restored);
      S.savedSave = new Uint8Array(restored.data);
      S.savedSaveAt = restored.at;
      S.lastSaveSig = restored.sig;
      if (S.running) await restoreBatterySave();
      renderSavPanel();
      toast("Previous battery save restored", "success");
    } catch (error) {
      toast("Could not restore the previous save", "error");
    }
  });

  $("#btnDeleteSav").addEventListener("click", async () => {
    if (!S.current) return;
    const current = S.current;
    if (!confirm("Delete the stored .sav for " + baseName(current.name) + "?" + (S.running ? " The running game will be stopped so it cannot recreate the save." : "") + " Export it first if you might want it back.")) return;
    const existing = await IDB.get("saves", current.gid).catch(() => null);
    const livePath = S.running ? saveFilePath() : null;
    if (S.running) await stopGame({ silent: true });
    await IDB.del("saves", current.gid).catch(() => {});
    await deleteEngineSaveRecords([livePath, existing && existing.enginePath]);
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

  function bytesToBase64(value) {
    const bytes = asBytes(value);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function encodeBackupValue(value) {
    const isBuffer = Object.prototype.toString.call(value) === "[object ArrayBuffer]";
    if (isBuffer || ArrayBuffer.isView(value)) {
      const bytes = asBytes(value);
      return { __pixelgbaBytes: bytesToBase64(bytes), byteLength: bytes.length, sha256: await digestHex(bytes) };
    }
    if (Array.isArray(value)) return Promise.all(value.map(encodeBackupValue));
    if (value && typeof value === "object") {
      const result = {};
      for (const [key, child] of Object.entries(value)) result[key] = await encodeBackupValue(child);
      return result;
    }
    return value;
  }

  async function decodeBackupValue(value, depth = 0) {
    if (depth > 12) throw new Error("Backup nesting is invalid");
    if (value && typeof value === "object" && typeof value.__pixelgbaBytes === "string") {
      const bytes = base64ToBytes(value.__pixelgbaBytes);
      if (bytes.length !== value.byteLength || await digestHex(bytes) !== value.sha256) throw new Error("A backup binary checksum does not match");
      return ownBuffer(bytes);
    }
    if (Array.isArray(value)) return Promise.all(value.map((child) => decodeBackupValue(child, depth + 1)));
    if (value && typeof value === "object") {
      const result = {};
      for (const [key, child] of Object.entries(value)) result[key] = await decodeBackupValue(child, depth + 1);
      return result;
    }
    return value;
  }

  async function createBackupDocument() {
    if (S.running) await syncSaveNow({ force: true }).catch(() => {});
    const local = store.allKeys()
      .filter((key) => key.startsWith("pgba.") || key.startsWith("ejs-pgba-") || key === "ejs-settings")
      .map((key) => [key, store.raw(key)]);
    const saves = [];
    for (const [key, value] of await IDB.entries("saves").catch(() => [])) saves.push([String(key), await encodeBackupValue(value)]);
    const states = [];
    for (const [key, value] of await IDB.entries("states").catch(() => [])) states.push([String(key), await encodeBackupValue(value)]);
    const payload = { schema: 1, appVersion: "1.2.0", local, saves, states };
    const payloadText = JSON.stringify(payload);
    return {
      format: BACKUP_FORMAT,
      createdAt: Date.now(),
      payloadSha256: await digestHex(textEncoder.encode(payloadText)),
      payload,
    };
  }

  async function validateBackupDocument(documentValue) {
    if (!documentValue || documentValue.format !== BACKUP_FORMAT || !documentValue.payload) throw new Error("This is not a PixelGBA backup");
    const payloadText = JSON.stringify(documentValue.payload);
    if (documentValue.payloadSha256 !== await digestHex(textEncoder.encode(payloadText))) throw new Error("The backup manifest checksum does not match");
    const payload = documentValue.payload;
    if (payload.schema !== 1 || !Array.isArray(payload.local) || !Array.isArray(payload.saves) || !Array.isArray(payload.states)) throw new Error("The backup schema is unsupported");
    if (payload.local.length + payload.saves.length + payload.states.length > 10_000) throw new Error("The backup contains too many records");
    const safeLocal = payload.local.map(([key, raw]) => {
      if (typeof key !== "string" || typeof raw !== "string" || !(key.startsWith("pgba.") || key.startsWith("ejs-pgba-") || key === "ejs-settings")) throw new Error("The backup contains an unsafe settings key");
      return [key, raw];
    });
    const decodeEntries = async (entries) => {
      const output = [];
      for (const entry of entries) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || entry[0].length > 256) throw new Error("The backup contains an invalid database key");
        output.push([entry[0], await decodeBackupValue(entry[1])]);
      }
      return output;
    };
    return { local: safeLocal, saves: await decodeEntries(payload.saves), states: await decodeEntries(payload.states) };
  }

  async function exportFullBackup() {
    try {
      const backup = await createBackupDocument();
      downloadBlob(new Blob([JSON.stringify(backup)], { type: "application/json" }), "pixelgba-backup-" + tsName() + ".pgbackup");
      toast("Full backup exported with checksums", "success");
    } catch (error) {
      console.warn("backup export failed", error);
      toast("Could not export the full backup", "error", 6000);
    }
  }

  async function restoreFullBackup(file) {
    if (!file || file.size > 768 * 1024 * 1024) { toast("That backup is too large to restore safely", "error"); return; }
    let decoded;
    try {
      decoded = await validateBackupDocument(JSON.parse(await file.text()));
    } catch (error) {
      toast(error.message || "That backup is invalid", "error", 7000);
      return;
    }
    if (!confirm("Restore this verified PixelGBA backup? Current PixelGBA ROMs, saves, states, cheats and settings on this site will be replaced.")) return;
    try {
      await stopGame({ silent: true });
      await deleteOwnedEngineFilesystem();
      store.allKeys()
        .filter((key) => key.startsWith("pgba.") || key.startsWith("ejs-pgba-") || key === "ejs-settings")
        .forEach((key) => store.del(key));
      await IDB.clear("saves");
      await IDB.clear("states");
      for (const [key, raw] of decoded.local) {
        if (!store.setRaw(key, raw)) throw new Error("Browser settings storage is full");
      }
      for (const [key, value] of decoded.saves) await IDB.put("saves", key, value);
      for (const [key, value] of decoded.states) await IDB.put("states", key, value);
      toast("Backup restored — reloading…", "success");
      setTimeout(() => location.reload(), 800);
    } catch (error) {
      console.warn("backup restore failed", error);
      toast("Restore stopped because browser storage rejected a record. Keep the backup file and free site storage before retrying.", "error", 9000);
    }
  }

  $("#btnExportBackup").addEventListener("click", exportFullBackup);
  $("#btnImportBackup").addEventListener("click", () => $("#backupInput").click());
  $("#backupInput").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (file) restoreFullBackup(file);
  });

  /* ========================================================================
     HELP → wipe everything
     ===================================================================== */
  $("#btnWipe").addEventListener("click", async () => {
    if (!confirm("Delete ALL ROMs, saves, states, cheats and PixelGBA emulator settings stored on this device? This cannot be undone.")) return;
    await stopGame({ silent: true });
    const saveKeys = await IDB.keys("saves").catch(() => []);
    const enginePaths = [];
    for (const key of saveKeys.filter((key) => !String(key).startsWith("__rom__"))) {
      const rec = await IDB.get("saves", key).catch(() => null);
      if (rec && rec.enginePath) enginePaths.push(rec.enginePath);
    }
    await deleteEngineSaveRecords(enginePaths);
    await deleteOwnedEngineFilesystem();
    store.allKeys()
      .filter((key) => key.startsWith("pgba.") || key.startsWith("ejs-pgba-") || key === "ejs-settings")
      .forEach((key) => store.del(key));
    await IDB.clear("saves");
    await IDB.clear("states");
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
  activateTab(tabs.find((tab) => tab.classList.contains("is-active")) || tabs[0]);
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    let waitingWorker = null;
    let applyingUpdate = false;
    const showUpdate = (worker) => {
      waitingWorker = worker;
      $("#updateBanner").hidden = false;
    };
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (applyingUpdate) location.reload();
    });
    $("#btnApplyUpdate").addEventListener("click", () => {
      if (!waitingWorker) return;
      applyingUpdate = true;
      waitingWorker.postMessage({ type: "SKIP_WAITING" });
    });
    $("#updateClose").addEventListener("click", () => { $("#updateBanner").hidden = true; });
    navigator.serviceWorker.register(new URL("sw.js", location.href)).then((registration) => {
      if (registration.waiting) showUpdate(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdate(worker);
        });
      });
      registration.update().catch(() => {});
    }).catch((error) => console.warn("Offline cache registration failed", error));
  }
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
    identifyRom,
    parseGbaHeader,
    packStateFile,
    unpackStateFile,
    createBackupDocument,
    validateBackupDocument,
    bytesSig,
    nextFreeSlot,
    renderLibrary,
    deleteGameData,
    storage: IDB,
    version: "1.2.0",
  };
})();
