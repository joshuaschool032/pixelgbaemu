import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8")
  .replace(/<script src="(?:cheats-db|app)\.js"><\/script>/g, "");
const presets = readFileSync(new URL("../../cheats-db.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../../app.js", import.meta.url), "utf8");

function createApp(setup = null) {
  const dom = new JSDOM(html, {
    url: "https://pixelgba.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  Object.defineProperty(window, "indexedDB", { configurable: true, value: new IDBFactory() });
  Object.defineProperty(window, "IDBKeyRange", { configurable: true, value: IDBKeyRange });
  Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
  window.TextEncoder = TextEncoder;
  window.TextDecoder = TextDecoder;
  window.confirm = () => true;
  if (setup) setup(window);
  window.eval(presets);
  window.eval(app);
  return dom;
}

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function makeHeaderRom(gameCode = "BPEE", revision = 0) {
  const rom = new Uint8Array(1024);
  new TextEncoder().encodeInto("TEST GAME", rom.subarray(0xa0, 0xac));
  new TextEncoder().encodeInto(gameCode, rom.subarray(0xac, 0xb0));
  new TextEncoder().encodeInto("01", rom.subarray(0xb0, 0xb2));
  rom[0xbc] = revision;
  return rom;
}

function blobArrayBuffer(window, blob) {
  return new Promise((resolve, reject) => {
    const reader = new window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function makeStoredZip(name, data) {
  const filename = Buffer.from(name);
  const bytes = Buffer.from(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(bytes.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const offset = local.length + filename.length + bytes.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + filename.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([local, filename, bytes, central, filename, eocd]);
}

test("app initializes five slots and accessible tabs", async (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  await wait(10);
  const { document } = dom.window;
  assert.equal(document.querySelectorAll("#slotGrid .slot").length, 5);
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  assert.equal(tabs.length, 4);
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  tabs[1].click();
  assert.equal(tabs[1].getAttribute("aria-selected"), "true");
  assert.equal(document.querySelector("#view-cheats").hidden, false);
  assert.equal(document.querySelector("#view-library").hidden, true);
});

test("battery signature sees changes beyond byte 64", (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  const a = new Uint8Array(128 * 1024);
  const b = a.slice();
  b[5000] = 123;
  assert.notEqual(dom.window.PixelGBA.bytesSig(a), dom.window.PixelGBA.bytesSig(b));
});

test("ROM identity is content-based instead of filename-based", async (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  const file = (value) => ({
    name: "same-name.gba",
    arrayBuffer: async () => Uint8Array.from([value, 2, 3, 4]).buffer,
  });
  const first = await dom.window.PixelGBA.identifyRom(file(1));
  const repeat = await dom.window.PixelGBA.identifyRom(file(1));
  const different = await dom.window.PixelGBA.identifyRom(file(9));
  assert.match(first.gid, /^sha256-[0-9a-f]{64}$/);
  assert.equal(first.gid, repeat.gid);
  assert.notEqual(first.gid, different.gid);
  assert.equal(first.legacyGid, different.legacyGid);
});

test("full save-state slots return null instead of overwriting slot five", (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  const keys = Array.from({ length: 5 }, (_, index) => `game:${index + 1}`);
  assert.equal(dom.window.PixelGBA.nextFreeSlot(keys, "game"), null);
  assert.equal(dom.window.PixelGBA.nextFreeSlot(keys.slice(0, 3), "game"), 4);
});

test("custom cheat validation honors the selected type", (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  const api = dom.window.PixelGBA;
  assert.equal(api.validateCode("12345678 12345678", "gs"), null);
  assert.match(api.validateCode("12345678 1234", "gs"), /16 hex digits/);
  assert.equal(api.validateCode("12345678 1234", "cb"), null);
  assert.match(api.validateCode("1234567Z 1234", "cb"), /Only hex digits/);
});

test("library renders every ROM and uses semantic controls", (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  dom.window.PixelGBA.state.roms = Array.from({ length: 12 }, (_, index) => ({
    name: `Game ${index}.gba`, gid: `hash-${index}`, size: 1024, lastPlayed: index,
  }));
  dom.window.PixelGBA.renderLibrary();
  assert.equal(dom.window.document.querySelectorAll("#recentList .recent-item").length, 12);
  assert.equal(dom.window.document.querySelectorAll("#recentList .r-play").length, 12);
  assert.equal(dom.window.document.querySelectorAll("#recentList .r-purge").length, 12);
});

test("legacy filename-keyed metadata and cheats migrate to the content hash", async (t) => {
  const oldGid = "legacy-name";
  const oldCheats = [{ desc: "Old cheat", code: "12345678 1234", checked: true }];
  const dom = createApp((window) => {
    window.localStorage.setItem("pgba.roms", JSON.stringify([{ name: "Legacy Name.gba", gid: oldGid, size: 4, lastPlayed: 1 }]));
    window.localStorage.setItem("pgba.cheats." + oldGid, JSON.stringify(oldCheats));
  });
  t.after(() => dom.window.close());
  const api = dom.window.PixelGBA;
  const file = { name: "Legacy Name.gba", size: 4, arrayBuffer: async () => Uint8Array.from([7, 7, 7, 7]).buffer };
  api.startGame(file);
  for (let i = 0; i < 30 && !api.state.current; i++) await wait(10);
  assert.match(api.state.current.gid, /^sha256-/);
  assert.equal(dom.window.localStorage.getItem("pgba.cheats." + oldGid), null);
  assert.deepEqual(JSON.parse(dom.window.localStorage.getItem("pgba.cheats." + api.state.current.gid)), oldCheats);
  assert.equal(api.state.roms.some((rom) => rom.gid === oldGid), false);
  await api.stopGame({ silent: true });
  await wait(100); // allow the intentional background ROM-cache write to settle
});

test("boot guard remains active and rejects a concurrent launch", async (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  const api = dom.window.PixelGBA;
  const file = { name: "guard.gba", size: 4, arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer };
  api.startGame(file);
  const launchId = api.state.launchId;
  assert.equal(api.state.starting, true);
  await api.startGame(file);
  assert.equal(api.state.launchId, launchId);
  assert.equal(api.state.starting, true);
  await api.stopGame({ silent: true });
  assert.equal(api.state.starting, false);
});

test("raw and ZIP-wrapped copies share the extracted ROM identity", async (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  const rom = makeHeaderRom();
  const zip = makeStoredZip("folder/renamed.gba", rom);
  const rawIdentity = await dom.window.PixelGBA.identifyRom({ name: "original.gba", arrayBuffer: async () => rom.buffer });
  const zipIdentity = await dom.window.PixelGBA.identifyRom({ name: "collection.zip", arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) });
  assert.equal(zipIdentity.gid, rawIdentity.gid);
  assert.equal(zipIdentity.name, "renamed.gba");
  assert.equal(zipIdentity.header.gameCode, "BPEE");
  assert.ok(zipIdentity.legacyGids.some((gid) => gid !== zipIdentity.gid));
});

test("ROM preparation honors cancellation before expensive transforms", async (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  const controller = new dom.window.AbortController();
  controller.abort();
  await assert.rejects(
    dom.window.PixelGBA.identifyRom({ name: "cancel.gba", size: 1024, stream: () => new Blob([makeHeaderRom()]).stream() }, { signal: controller.signal }),
    (error) => error.name === "AbortError"
  );
});

test("cheat presets use exact cartridge code and revision", (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  const emerald = dom.window.PixelGBA.parseGbaHeader(makeHeaderRom("BPEE", 0));
  const revised = dom.window.PixelGBA.parseGbaHeader(makeHeaderRom("BPEE", 1));
  const regional = dom.window.PixelGBA.parseGbaHeader(makeHeaderRom("BPEP", 0));
  assert.equal(dom.window.PIXELGBA_PRESETS.match("renamed.gba", emerald)?.id, "emerald");
  assert.equal(dom.window.PIXELGBA_PRESETS.match("pokemon emerald.gba", revised), null);
  assert.equal(dom.window.PIXELGBA_PRESETS.match("pokemon emerald.gba", regional), null);
});

test("wrapped states verify game metadata and checksum while raw states remain supported", async (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  const api = dom.window.PixelGBA;
  const state = Uint8Array.from([9, 8, 7, 6]);
  const blob = await api.packStateFile(state, { gameId: "sha256-test", romName: "test.gba" });
  const blobBuffer = await blobArrayBuffer(dom.window, blob);
  const parsed = await api.unpackStateFile(blobBuffer);
  assert.equal(parsed.wrapped, true);
  assert.equal(parsed.metadata.gameId, "sha256-test");
  assert.deepEqual([...new Uint8Array(parsed.data)], [...state]);
  const corrupted = new Uint8Array(blobBuffer.slice(0));
  corrupted[corrupted.length - 1] ^= 1;
  await assert.rejects(api.unpackStateFile(corrupted), /checksum/);
  const raw = await api.unpackStateFile(state);
  assert.equal(raw.wrapped, false);
});

test("full backups round-trip database binaries and reject tampering", async (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  const api = dom.window.PixelGBA;
  await api.storage.put("saves", "game", { data: Uint8Array.from([1, 2, 3]).buffer, at: 5 });
  await api.storage.put("states", "game:1", { data: Uint8Array.from([4, 5]).buffer, at: 6 });
  const backup = await api.createBackupDocument();
  const restored = await api.validateBackupDocument(backup);
  assert.deepEqual([...new Uint8Array(restored.saves[0][1].data)], [1, 2, 3]);
  backup.payload.saves[0][1].data.__pixelgbaBytes = "AAAA";
  await assert.rejects(api.validateBackupDocument(backup), /manifest checksum/);
});

test("quota failures never mark a battery save as persisted", async (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  const api = dom.window.PixelGBA;
  api.state.current = { name: "quota.gba", gid: "quota-game" };
  api.state.running = true;
  dom.window.EJS_emulator = {
    gameManager: {
      saveSaveFiles() {},
      getSaveFile: () => Uint8Array.from([1, 2, 3, 4]),
      getSaveFilePath: () => "/data/saves/quota.sav",
    },
  };
  const originalPut = api.storage.put;
  api.storage.put = async () => { throw new dom.window.DOMException("full", "QuotaExceededError"); };
  await assert.rejects(api.syncSaveNow({ force: true }), /full/);
  assert.equal(api.state.lastSaveSig, null);
  assert.match(dom.window.document.querySelector("#toasts").textContent, /could not be persisted/i);
  api.storage.put = originalPut;
});

test("library search, sort and favorites keep every game reachable", (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  const api = dom.window.PixelGBA;
  api.state.roms = [
    { name: "Zelda.gba", gid: "z", lastPlayed: 1 },
    { name: "Metroid.gba", gid: "m", lastPlayed: 2, favorite: true },
  ];
  api.renderLibrary();
  dom.window.document.querySelector("#librarySearch").value = "metr";
  dom.window.document.querySelector("#librarySearch").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(dom.window.document.querySelectorAll("#recentList .recent-item").length, 1);
  dom.window.document.querySelector("#librarySearch").value = "";
  dom.window.document.querySelector("#librarySearch").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(dom.window.document.querySelectorAll("#recentList .recent-item").length, 2);
  dom.window.document.querySelector("#libraryFavorites").click();
  assert.equal(dom.window.document.querySelectorAll("#recentList .recent-item").length, 1);
});

test("overlapping battery sync requests serialize and retain rolling copies", async (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  const api = dom.window.PixelGBA;
  api.state.current = { name: "history.gba", gid: "history-game" };
  api.state.running = true;
  let value = 0;
  dom.window.EJS_emulator = {
    gameManager: {
      saveSaveFiles() {},
      getSaveFile: () => Uint8Array.from([++value, 2, 3, 4]),
      getSaveFilePath: () => "/data/saves/history.sav",
    },
  };
  await Promise.all([api.syncSaveNow(), api.syncSaveNow()]);
  const record = await api.storage.get("saves", "history-game");
  assert.deepEqual([...new Uint8Array(record.data)], [2, 2, 3, 4]);
  assert.equal(record.history.length, 1);
  assert.deepEqual([...new Uint8Array(record.history[0].data)], [1, 2, 3, 4]);
});

test("storage health reports quota and can request persistence", async (t) => {
  let persistCalls = 0;
  const dom = createApp((window) => {
    Object.defineProperty(window.navigator, "storage", { configurable: true, value: {
      estimate: async () => ({ usage: 25 * 1024 * 1024, quota: 100 * 1024 * 1024 }),
      persisted: async () => false,
      persist: async () => { persistCalls++; return true; },
    } });
  });
  t.after(() => dom.window.close());
  await dom.window.PixelGBA.refreshStorageHealth();
  assert.match(dom.window.document.querySelector("#storageUsed").textContent, /25\.00 MB used/);
  assert.match(dom.window.document.querySelector("#storageQuota").textContent, /75\.00 MB available of 100\.00 MB/);
  assert.equal(dom.window.document.querySelector("#storageProgress").value, 25);
  dom.window.document.querySelector("#btnPersistStorage").click();
  await wait(10);
  assert.equal(persistCalls, 1);
});

test("PWA install prompt is exposed only after the browser offers it", async (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  const button = dom.window.document.querySelector("#btnInstallApp");
  assert.equal(button.hidden, true);
  let prompted = 0;
  const event = new dom.window.Event("beforeinstallprompt", { cancelable: true });
  event.prompt = () => { prompted++; };
  event.userChoice = Promise.resolve({ outcome: "accepted" });
  dom.window.dispatchEvent(event);
  assert.equal(button.hidden, false);
  button.click();
  await wait(10);
  assert.equal(prompted, 1);
  assert.equal(button.hidden, true);
});

test("preset entries require per-code verification and pinned provenance", (t) => {
  const dom = createApp();
  t.after(() => dom.window.close());
  const presetButtons = [...dom.window.document.querySelectorAll("#presetGames .preset-game")];
  const games = dom.window.PIXELGBA_PRESETS.games;
  assert.ok(games.every((game) => game.cheats.every((cheat) => typeof cheat.verified === "boolean")));

  presetButtons.find((button) => button.textContent.includes("Sapphire")).click();
  assert.ok([...dom.window.document.querySelectorAll("#presetList input")].every((input) => input.disabled));
  assert.match(dom.window.document.querySelector("#presetNote").textContent, /disabled until/);

  presetButtons.find((button) => button.textContent.includes("Emerald")).click();
  assert.match(dom.window.document.querySelector("#presetNote a").href, /github\.com\/.+\/blob\/[0-9a-f]{40}\//);
  assert.match(dom.window.document.querySelector("#presetNote").textContent, /BPEE revision 0/);
  const emerald = games.find((game) => game.id === "emerald");
  const inputs = [...dom.window.document.querySelectorAll("#presetList input")];
  assert.deepEqual(inputs.map((input) => input.disabled), [...emerald.cheats].map((cheat) => !cheat.verified));
  assert.equal(dom.window.document.querySelectorAll("#presetList .tag-warn").length, emerald.cheats.filter((cheat) => !cheat.verified).length);
});
