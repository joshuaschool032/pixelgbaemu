import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputs = [[180, "assets/apple-touch-icon.png"], [192, "assets/icon-192.png"], [512, "assets/icon-512.png"]];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return out;
}
function roundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}
function icon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const samples = [[.25,.25],[.75,.25],[.25,.75],[.75,.75]];
  const colors = {
    bg: [7, 10, 20], shell: [124, 108, 255], shell2: [91, 75, 214], screen: [11, 16, 32], glass: [28, 39, 66], green: [163, 230, 53], pink: [244, 114, 182]
  };
  const sampleColor = (x, y) => {
    if (roundedRect(x, y, .14*size, .18*size, .86*size, .82*size, .15*size)) {
      if (roundedRect(x, y, .25*size, .29*size, .75*size, .61*size, .055*size)) {
        if (roundedRect(x, y, .3*size, .34*size, .7*size, .56*size, .025*size)) return colors.glass;
        return colors.screen;
      }
      if ((x-.36*size)**2+(y-.7*size)**2 < (.045*size)**2) return colors.green;
      if ((x-.64*size)**2+(y-.7*size)**2 < (.045*size)**2) return colors.pink;
      const mix = Math.max(0, Math.min(1, (x + y - .32*size) / (1.36*size)));
      return colors.shell.map((value, index) => Math.round(value * (1-mix) + colors.shell2[index] * mix));
    }
    return colors.bg;
  };
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1); raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const total = [0,0,0];
      for (const [dx,dy] of samples) {
        const color = sampleColor(x+dx,y+dy);
        for (let channel=0; channel<3; channel++) total[channel] += color[channel];
      }
      const offset = row + 1 + x*4;
      raw[offset] = Math.round(total[0]/samples.length);
      raw[offset+1] = Math.round(total[1]/samples.length);
      raw[offset+2] = Math.round(total[2]/samples.length);
      raw[offset+3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size,0); ihdr.writeUInt32BE(size,4); ihdr[8]=8; ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR",ihdr), chunk("IDAT",deflateSync(raw,{level:9})), chunk("IEND",Buffer.alloc(0))]);
}

let stale = false;
for (const [size, relative] of outputs) {
  const data = icon(size); const target = resolve(root, relative);
  if (process.argv.includes("--check")) {
    if (!existsSync(target) || !readFileSync(target).equals(data)) { console.error(`${relative} is stale; run npm run build:icons`); stale = true; }
  } else {
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, data); console.log(`Wrote ${relative}`);
  }
}
if (stale) process.exit(1);
