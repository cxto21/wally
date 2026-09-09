/**
 * Wally Extension — Icon Generator
 *
 * Generates simple placeholder PNG icons for development.
 * Run: node generate-icons.mjs
 *
 * Creates: icon16.png, icon32.png, icon48.png, icon128.png
 * Each is a solid colored square with a white "W" centered.
 * Can be replaced with proper branding later.
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { deflateSync } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));

function createPNG(size, bgColor, textColor) {
  const width = size;
  const height = size;
  const pixels = new Uint8Array(width * height * 4);

  // Fill background
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = bgColor[0];
    pixels[i * 4 + 1] = bgColor[1];
    pixels[i * 4 + 2] = bgColor[2];
    pixels[i * 4 + 3] = 255;
  }

  const w = width;
  const h = height;
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const r = Math.floor(Math.min(w, h) * 0.35);

  function setPixel(x, y, color) {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      const idx = (y * w + x) * 4;
      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
      pixels[idx + 3] = 255;
    }
  }

  function drawLine(x0, y0, x1, y1, color, thickness) {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0, y = y0;

    while (true) {
      for (let tx = -Math.floor(thickness / 2); tx <= Math.floor(thickness / 2); tx++) {
        for (let ty = -Math.floor(thickness / 2); ty <= Math.floor(thickness / 2); ty++) {
          setPixel(x + tx, y + ty, color);
        }
      }
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  // "W" shape: four strokes forming the letter
  const stroke = Math.max(2, Math.floor(w / 8));
  const topY = cy - r;
  const botY = cy + r;
  const leftX = cx - r;
  const rightX = cx + r;
  const midLeftX = cx - Math.floor(r * 0.35);
  const midRightX = cx + Math.floor(r * 0.35);
  const midBotY = botY - Math.floor(r * 0.25);

  drawLine(leftX, topY, midLeftX, midBotY, textColor, stroke);
  drawLine(midLeftX, midBotY, cx, topY + Math.floor(r * 0.3), textColor, stroke);
  drawLine(cx, topY + Math.floor(r * 0.3), midRightX, midBotY, textColor, stroke);
  drawLine(midRightX, midBotY, rightX, topY, textColor, stroke);

  // Build PNG
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  ihdr[9] = 6;  ihdr[10] = 0;  ihdr[11] = 0;  ihdr[12] = 0;

  const rawData = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    rawData[y * (1 + w * 4)] = 0;
    for (let x = 0; x < w; x++) {
      const srcIdx = (y * w + x) * 4;
      const dstIdx = y * (1 + w * 4) + 1 + x * 4;
      rawData[dstIdx] = pixels[srcIdx];
      rawData[dstIdx + 1] = pixels[srcIdx + 1];
      rawData[dstIdx + 2] = pixels[srcIdx + 2];
      rawData[dstIdx + 3] = pixels[srcIdx + 3];
    }
  }

  const compressed = deflateSync(rawData);

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    const table = [];
    for (let i = 0; i < 256; i++) {
      let t = i;
      for (let j = 0; j < 8; j++) {
        t = (t & 1) ? (0xEDB88320 ^ (t >>> 1)) : (t >>> 1);
      }
      table[i] = t;
    }
    for (let i = 0; i < buf.length; i++) {
      c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([len, typeAndData, crc]);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Orange (#FF6B35) background, white text
const bgColor = [0xFF, 0x6B, 0x35];
const textColor = [0xFF, 0xFF, 0xFF];

for (const size of [16, 32, 48, 128]) {
  const png = createPNG(size, bgColor, textColor);
  const outPath = join(__dirname, 'icons', `icon${size}.png`);
  writeFileSync(outPath, png);
  console.log(`Generated ${outPath} (${png.length} bytes)`);
}
