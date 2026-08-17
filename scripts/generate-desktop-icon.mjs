import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";

const size = 256;
const output = path.resolve("build", "desktop", "icon.ico");
const rgba = Buffer.alloc(size * size * 4);

function clamp(v, min = 0, max = 1) {
  return Math.min(max, Math.max(min, v));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function sdRoundedRect(x, y, cx, cy, w, h, r) {
  const dx = Math.abs(x - cx) - (w - r);
  const dy = Math.abs(y - cy) - (h - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - r;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function sdHexagon(px, py, cx, cy, radius) {
  const points = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  let minDist = Infinity;
  for (let i = 0; i < 6; i++) {
    const next = (i + 1) % 6;
    const dist = distanceToSegment(px, py, points[i][0], points[i][1], points[next][0], points[next][1]);
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

function isInsideHex(px, py, cx, cy, radius) {
  const dx = Math.abs(px - cx);
  const dy = Math.abs(py - cy);
  const h = radius * Math.sin(Math.PI / 3);
  return dx <= radius && dy <= h && radius * h - radius * dy - h * dx >= 0;
}

// Generate pixels with anti-aliasing and rich gradients
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const offset = (y * size + x) * 4;

    // Squircle background
    const distSquircle = sdRoundedRect(x, y, 128, 128, 120, 120, 54);
    const alphaSquircle = 1 - smoothstep(-0.5, 0.5, distSquircle);

    if (alphaSquircle <= 0) {
      rgba.set([0, 0, 0, 0], offset);
      continue;
    }

    // Gradient background: #160e2b -> #08070e
    const bgGradT = (x + y) / (size * 2);
    let r = Math.round(22 * (1 - bgGradT) + 8 * bgGradT);
    let g = Math.round(14 * (1 - bgGradT) + 7 * bgGradT);
    let b = Math.round(43 * (1 - bgGradT) + 14 * bgGradT);

    // Border glow on squircle
    if (distSquircle >= -3 && distSquircle <= 0) {
      const borderAlpha = 1 - Math.abs(distSquircle + 1.5) / 1.5;
      r = Math.round(r * (1 - borderAlpha) + 167 * borderAlpha);
      g = Math.round(g * (1 - borderAlpha) + 139 * borderAlpha);
      b = Math.round(b * (1 - borderAlpha) + 250 * borderAlpha);
    }

    // Circuit conduits
    const line1 = distanceToSegment(x, y, 128, 138, 90, 78);
    const line2 = distanceToSegment(x, y, 128, 138, 166, 78);
    const line3 = distanceToSegment(x, y, 128, 138, 128, 194);
    const minLine = Math.min(line1, line2, line3);
    if (minLine < 3) {
      const lineAlpha = (1 - minLine / 3) * 0.45;
      r = Math.round(r * (1 - lineAlpha) + 139 * lineAlpha);
      g = Math.round(g * (1 - lineAlpha) + 92 * lineAlpha);
      b = Math.round(b * (1 - lineAlpha) + 246 * lineAlpha);
    }

    // Top-Left Satellite (90, 78, r=26)
    const insideSat1 = isInsideHex(x, y, 90, 78, 26);
    const edgeSat1 = sdHexagon(x, y, 90, 78, 26);
    if (insideSat1) {
      r = 20; g = 14; b = 40;
    }
    if (edgeSat1 < 2.5) {
      const edgeAlpha = 1 - edgeSat1 / 2.5;
      r = Math.round(r * (1 - edgeAlpha) + 167 * edgeAlpha);
      g = Math.round(g * (1 - edgeAlpha) + 139 * edgeAlpha);
      b = Math.round(b * (1 - edgeAlpha) + 250 * edgeAlpha);
    }

    // Top-Right Satellite (166, 78, r=26)
    const insideSat2 = isInsideHex(x, y, 166, 78, 26);
    const edgeSat2 = sdHexagon(x, y, 166, 78, 26);
    if (insideSat2) {
      r = 20; g = 14; b = 40;
    }
    if (edgeSat2 < 2.5) {
      const edgeAlpha = 1 - edgeSat2 / 2.5;
      r = Math.round(r * (1 - edgeAlpha) + 129 * edgeAlpha);
      g = Math.round(g * (1 - edgeAlpha) + 140 * edgeAlpha);
      b = Math.round(b * (1 - edgeAlpha) + 248 * edgeAlpha);
    }

    // Bottom Sentry (128, 194, r=26)
    const insideSat3 = isInsideHex(x, y, 128, 194, 26);
    const edgeSat3 = sdHexagon(x, y, 128, 194, 26);
    if (insideSat3) {
      r = 20; g = 14; b = 40;
    }
    if (edgeSat3 < 2.5) {
      const edgeAlpha = 1 - edgeSat3 / 2.5;
      r = Math.round(r * (1 - edgeAlpha) + 167 * edgeAlpha);
      g = Math.round(g * (1 - edgeAlpha) + 139 * edgeAlpha);
      b = Math.round(b * (1 - edgeAlpha) + 250 * edgeAlpha);
    }

    // Central Queen Hexagon (128, 134, r=38)
    const insideQueen = isInsideHex(x, y, 128, 134, 38);
    const edgeQueen = sdHexagon(x, y, 128, 134, 38);
    if (insideQueen) {
      const qGrad = clamp((y - 96) / 76);
      r = Math.round(124 * (1 - qGrad) + 76 * qGrad);
      g = Math.round(58 * (1 - qGrad) + 29 * qGrad);
      b = Math.round(237 * (1 - qGrad) + 149 * qGrad);

      // Inner verified nucleus (r=16)
      const insideNucleus = isInsideHex(x, y, 128, 134, 16);
      if (insideNucleus) {
        r = 221; g = 214; b = 254;
      }
    }
    if (edgeQueen < 3.5) {
      const edgeAlpha = 1 - edgeQueen / 3.5;
      r = Math.round(r * (1 - edgeAlpha) + 221 * edgeAlpha);
      g = Math.round(g * (1 - edgeAlpha) + 214 * edgeAlpha);
      b = Math.round(b * (1 - edgeAlpha) + 254 * edgeAlpha);
    }

    const a = Math.round(alphaSquircle * 255);
    rgba.set([r, g, b, a], offset);
  }
}

const scanlines = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y += 1) rgba.copy(scanlines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
const png = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  chunk("IHDR", Buffer.concat([u32(size), u32(size), Buffer.from([8, 6, 0, 0, 0])])),
  chunk("IDAT", deflateSync(scanlines, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = 0;
header[7] = 0;
header[8] = 0;
header[9] = 0;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, Buffer.concat([header, png]));
console.log(`Generated: ${output}`);

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  return Buffer.concat([u32(data.length), name, data, u32(crc32(Buffer.concat([name, data])))]);
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

