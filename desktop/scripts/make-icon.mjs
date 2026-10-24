import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = [9, 9, 9];
const BORDER = [48, 48, 48];
const AMBER = [243, 194, 75];
const SAMPLES = 4;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) {
    return false;
  }
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function shade(u, v, size) {
  const borderWidth = size >= 32 ? Math.max(1.5, size * 0.012) / size : 0;
  const plate = insideRoundedRect(u, v, 0, 0, 1, 1, 0.22);
  if (!plate) {
    return null;
  }
  if (insideRoundedRect(u, v, 0.25, 0.6, 0.75, 0.73, 0.035)) {
    return AMBER;
  }
  const inner = insideRoundedRect(u, v, borderWidth, borderWidth, 1 - borderWidth, 1 - borderWidth, 0.22 - borderWidth);
  return inner ? PAGE : BORDER;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sum = [0, 0, 0];
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const color = shade((x + (sx + 0.5) / SAMPLES) / size, (y + (sy + 0.5) / SAMPLES) / size, size);
          if (color) {
            covered += 1;
            sum[0] += color[0];
            sum[1] += color[1];
            sum[2] += color[2];
          }
        }
      }
      const offset = (y * size + x) * 4;
      if (covered > 0) {
        pixels[offset] = Math.round(sum[0] / covered);
        pixels[offset + 1] = Math.round(sum[1] / covered);
        pixels[offset + 2] = Math.round(sum[2] / covered);
        pixels[offset + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * 255);
      }
    }
  }
  return pixels;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const pixels = render(size);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

const assets = path.join(root, "assets");
mkdirSync(assets, { recursive: true });
writeFileSync(path.join(assets, "icon.png"), png(256));
writeFileSync(path.join(assets, "icon.ico"), ico(ICO_SIZES.map((size) => ({ size, data: png(size) }))));
console.log("wrote assets/icon.png and assets/icon.ico");
