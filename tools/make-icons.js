/**
 * 生成扩展图标（无第三方依赖，纯手写 PNG 编码）。
 *
 * 图案：品牌红渐变圆角方块 + 白色对话气泡，气泡内挖空一个加号。
 * 语义：气泡代表弹幕/评论，加号代表"增强"，同时呼应名字里的 plus。
 * 加号是挖空而非叠加，小尺寸下轮廓依然清晰。
 *
 * 用法：node tools/make-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** 渐变端点（左上 → 右下），取自抖音品牌红 */
const GRAD_FROM = [255, 82, 112];
const GRAD_TO = [150, 16, 70];
const WHITE = [255, 255, 255];

const SIZES = [16, 32, 48, 128];
const OUT_DIR = path.join(__dirname, '..', 'icons');
const SS = 6; // 超采样倍数

// ---------------------------------------------------------------- PNG 编码

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------- 几何（归一化 0..1）

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inTriangle(x, y, ax, ay, bx, by, cx, cy) {
  const v0x = cx - ax;
  const v0y = cy - ay;
  const v1x = bx - ax;
  const v1y = by - ay;
  const v2x = x - ax;
  const v2y = y - ay;
  const den = v0x * v1y - v1x * v0y;
  if (!den) return false;
  const u = (v2x * v1y - v1x * v2y) / den;
  const v = (v0x * v2y - v2x * v0y) / den;
  return u >= 0 && v >= 0 && u + v <= 1;
}

/** 气泡主体 + 左下角尾巴 */
function inBubble(x, y) {
  if (inRoundRect(x, y, 0.14, 0.18, 0.86, 0.66, 0.15)) return true;
  return inTriangle(x, y, 0.26, 0.58, 0.23, 0.86, 0.51, 0.60);
}

/** 加号（会被从气泡里挖掉），中心与气泡视觉重心对齐 */
function inPlus(x, y) {
  const cx = 0.5;
  const cy = 0.42;
  const arm = 0.155;
  const half = 0.046;
  const horizontal = Math.abs(x - cx) <= arm && Math.abs(y - cy) <= half;
  const vertical = Math.abs(x - cx) <= half && Math.abs(y - cy) <= arm;
  return horizontal || vertical;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------- 渲染

function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const step = 1 / (SS * size);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let covered = 0;
      let white = 0;
      let total = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) * step;
          const y = (py * SS + sy + 0.5) * step;
          total++;
          if (!inRoundRect(x, y, 0, 0, 1, 1, 0.235)) continue;
          covered++;
          if (inBubble(x, y) && !inPlus(x, y)) white++;
        }
      }

      const alpha = covered / total;
      const ratio = covered ? white / covered : 0;
      const t = Math.min(1, Math.max(0, (px / size + py / size) / 2));
      const idx = (py * size + px) * 4;

      for (let c = 0; c < 3; c++) {
        const base = lerp(GRAD_FROM[c], GRAD_TO[c], t);
        out[idx + c] = Math.round(lerp(base, WHITE[c], ratio));
      }
      out[idx + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, render(size));
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`wrote ${path.relative(process.cwd(), file)} (${png.length} bytes)`);
}
