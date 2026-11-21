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
  window.confirm = () => true;
  if (setup) setup(window);
  window.eval(presets);
  window.eval(app);
  return dom;
}

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

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
