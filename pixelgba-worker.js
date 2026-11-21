"use strict";

const decoder = new TextDecoder();
const bytesOf = (value) => value instanceof Uint8Array ? value : new Uint8Array(value);
const ownBuffer = (value) => {
  const bytes = bytesOf(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
const sendProgress = (id, value, label) => postMessage({ id, progress: value, label });

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", ownBuffer(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function extractZip(bytes, id) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("ZIP directory was not found");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const candidates = [];
  for (let index = 0; index < count; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Invalid ZIP directory");
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    if (/\.(gba|agb|bin|rom)$/i.test(name) && !name.endsWith("/")) candidates.push({
      name,
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      size: view.getUint32(offset + 24, true),
      localOffset: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (!candidates.length) throw new Error("The archive contains no GBA ROM");
  candidates.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
  const entry = candidates[0];
  if (view.getUint32(entry.localOffset, true) !== 0x04034b50) throw new Error("Invalid ZIP entry");
  const start = entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true) + view.getUint16(entry.localOffset + 28, true);
  const compressed = bytes.slice(start, start + entry.compressedSize);
  sendProgress(id, 35, "Extracting ROM…");
  let data;
  if (entry.method === 0) data = compressed;
  else if (entry.method === 8 && typeof DecompressionStream !== "undefined") {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    data = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    const error = new Error("Bundled extractor required"); error.fallback = true; throw error;
  }
  if (entry.size && data.length !== entry.size) throw new Error("ZIP entry size mismatch");
  return { name: entry.name, data };
}

async function prepareRom(payload, id) {
  const raw = new Uint8Array(payload.buffer);
  const isZip = raw[0] === 0x50 && raw[1] === 0x4b;
  if (!isZip && /\.(7z|rar)$/i.test(payload.filename)) return { fallback: true, buffer: ownBuffer(raw) };
  let extracted = { name: payload.filename, data: raw };
  try { if (isZip) extracted = await extractZip(raw, id); }
  catch (error) {
    if (error.fallback) return { fallback: true, buffer: ownBuffer(raw) };
    throw error;
  }
  sendProgress(id, 65, "Identifying cartridge…");
  const rom = bytesOf(extracted.data);
  const romHash = await sha256(rom);
  const rawHash = rom === raw ? romHash : await sha256(raw);
  sendProgress(id, 100, "ROM ready");
  return { fallback: false, name: extracted.name, buffer: ownBuffer(rom), gid: "sha256-" + romHash, rawGid: "sha256-" + rawHash };
}

function toBase64(value) {
  const bytes = bytesOf(value); let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function fromBase64(value) {
  const binary = atob(value); const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
async function encodeValue(value) {
  const isBuffer = Object.prototype.toString.call(value) === "[object ArrayBuffer]";
  if (isBuffer || ArrayBuffer.isView(value)) {
    const bytes = bytesOf(isBuffer ? value : ownBuffer(value));
    return { __pixelgbaBytes: toBase64(bytes), byteLength: bytes.length, sha256: await sha256(bytes) };
  }
  if (Array.isArray(value)) return Promise.all(value.map(encodeValue));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value)) output[key] = await encodeValue(child);
    return output;
  }
  return value;
}
async function decodeValue(value, depth = 0) {
  if (depth > 12) throw new Error("Backup nesting is invalid");
  if (value && typeof value === "object" && typeof value.__pixelgbaBytes === "string") {
    const bytes = fromBase64(value.__pixelgbaBytes);
    if (bytes.length !== value.byteLength || await sha256(bytes) !== value.sha256) throw new Error("A backup binary checksum does not match");
    return ownBuffer(bytes);
  }
  if (Array.isArray(value)) return Promise.all(value.map((child) => decodeValue(child, depth + 1)));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value)) output[key] = await decodeValue(child, depth + 1);
    return output;
  }
  return value;
}
async function transformEntries(entries, transform, id, label) {
  const output = [];
  for (let index = 0; index < entries.length; index++) {
    output.push([entries[index][0], await transform(entries[index][1])]);
    sendProgress(id, Math.round((index + 1) / Math.max(1, entries.length) * 100), label);
  }
  return output;
}

self.addEventListener("message", async (event) => {
  const { id, type, payload } = event.data || {};
  if (!id) return;
  try {
    let result;
    if (type === "prepareRom") result = await prepareRom(payload, id);
    else if (type === "encodeEntries") result = await transformEntries(payload.entries, encodeValue, id, "Encoding backup…");
    else if (type === "decodeEntries") result = await transformEntries(payload.entries, decodeValue, id, "Verifying backup…");
    else throw new Error("Unknown worker task");
    const transfers = [];
    if (type === "prepareRom" && result.buffer) transfers.push(result.buffer);
    postMessage({ id, result }, transfers);
  } catch (error) {
    postMessage({ id, error: error && error.message ? error.message : "Worker operation failed" });
  }
});
