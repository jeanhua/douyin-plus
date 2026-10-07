/**
 * 生成扩展图标（无第三方依赖，纯手写 PNG 编码）。
 *
 * 图案：青 (#25F4EE) / 粉 (#FE2C55) 对角分割底 + 白色双八分音符（♫）。
 *  - 对角分割复刻抖音的双色视觉语言，比叠加色边更干净、缩小时更稳
 *  - 白色音符压在分割线上，两种底色都能形成足够对比
 *  - 16/32 像素自动加粗笔画，保证任务栏小尺寸下仍能辨认
 *  - 每个尺寸独立渲染（不做缩放），小尺寸用更高的超采样倍率
 *
 * 用法：node tools/make-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 抖音品牌色
const CYAN = [37, 244, 238];
const PINK = [254, 44, 85];
const WHITE = [255, 255, 255];
/** 音符描边色：接近抖音深色主题底色，用来把白音符从青底上"托"出来 */
const RING = [22, 24, 35];
const RING_ALPHA = 0.32;
/** 描边宽度（像素），随尺寸略增以保证小尺寸可见 */
const OUTLINE = 1.3;

const SIZES = [16, 32, 48, 128];
const OUT_DIR = path.join(__dirname, '..', 'icons');

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
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function distToSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq ? ((x - ax) * dx + (y - ay) * dy) / lenSq : 0;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function inEllipse(x, y, cx, cy, rx, ry, rot) {
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  const dx = x - cx;
  const dy = y - cy;
  const ex = dx * cos - dy * sin;
  const ey = dx * sin + dy * cos;
  return (ex / rx) ** 2 + (ey / ry) ** 2 <= 1;
}

/**
 * 双八分音符：左符头低、右符头高，两条符干由顶部斜梁相连。
 * 笔画参数化，小尺寸下加粗、收紧，避免两个符头糊在一起。
 */
function makeNote(bold, spread) {
  const b = bold || 1;
  const sp = spread === undefined ? 1 : spread;
  const headR = 0.098 * b;
  const headRx = headR * 1.18;
  const headRy = headR;
  const stemW = 0.025 * b;
  const beamW = 0.044 * b;
  const tilt = -0.32;

  const h1 = { x: 0.5 - 0.185 * sp, y: 0.705 };
  const h2 = { x: 0.5 + 0.175 * sp, y: 0.605 };
  const stem1X = h1.x + headRx * 0.66;
  const stem2X = h2.x + headRx * 0.66;
  const stem1Top = 0.285;
  const stem2Top = 0.185;

  return function inNote(x, y) {
    if (inEllipse(x, y, h1.x, h1.y, headRx, headRy, tilt)) return true;
    if (inEllipse(x, y, h2.x, h2.y, headRx, headRy, tilt)) return true;
    if (distToSegment(x, y, stem1X, h1.y - headR * 0.4, stem1X, stem1Top) <= stemW) return true;
    if (distToSegment(x, y, stem2X, h2.y - headR * 0.4, stem2X, stem2Top) <= stemW) return true;
    if (distToSegment(x, y, stem1X, stem1Top + beamW * 0.5, stem2X, stem2Top + beamW * 0.5) <= beamW) return true;
    return false;
  };
}

/**
 * 单八分音符：符头 + 符干 + 右上小旗。
 * 16px 下双音符的六个细节会糊成一团，改用单音符保持可读。
 */
function makeSingleNote(bold) {
  const b = bold || 1;
  const headRx = 0.165 * b;
  const headRy = 0.132 * b;
  const head = { x: 0.395, y: 0.735 };
  const stemX = head.x + headRx * 0.72;
  const stemTop = 0.205;
  const stemW = 0.038 * b;

  return function inNote(x, y) {
    if (inEllipse(x, y, head.x, head.y, headRx * 1.12, headRy, -0.30)) return true;
    if (distToSegment(x, y, stemX, head.y - 0.03, stemX, stemTop) <= stemW) return true;
    // 小旗：顶端向右下的两段折线
    if (distToSegment(x, y, stemX, stemTop + 0.02, stemX + 0.20, stemTop + 0.115) <= stemW * 1.15) return true;
    if (distToSegment(x, y, stemX + 0.20, stemTop + 0.115, stemX + 0.155, stemTop + 0.245) <= stemW * 1.05) return true;
    return false;
  };
}

// ---------------------------------------------------------------- 渲染

/** 笔画随尺寸调整：小尺寸加粗，16px 直接用单音符 */
function noteFor(size) {
  if (size <= 16) return makeSingleNote(1.18);
  if (size <= 32) return makeNote(1.24, 0.94);
  if (size <= 48) return makeNote(1.08, 0.98);
  return makeNote(1, 1);
}

function render(size, inNote) {
  const cornerRadius = 0.225;
  const out = Buffer.alloc(size * size * 4);

  // 越小越需要超采样，否则边缘锯齿会吃掉笔画
  const SS = size <= 20 ? 8 : size <= 48 ? 6 : 5;
  const step = 1 / (SS * size);

  // 白色音符在青底上对比度不足，尤其小尺寸；
  // 用"音符向外扩张一圈"的方式给白色区域加一圈底色描边。
  const outlineInNote = (x, y) => {
    const d = OUTLINE / size;
    return (
      inNote(x, y) ||
      inNote(x + d, y) ||
      inNote(x - d, y) ||
      inNote(x, y + d) ||
      inNote(x, y - d) ||
      inNote(x + d * 0.7, y + d * 0.7) ||
      inNote(x - d * 0.7, y - d * 0.7) ||
      inNote(x + d * 0.7, y - d * 0.7) ||
      inNote(x - d * 0.7, y + d * 0.7)
    );
  };

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let cyanHits = 0;
      let whiteHits = 0;
      let ringHits = 0;
      let total = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) * step;
          const y = (py * SS + sy + 0.5) * step;
          total++;

          if (!inRoundRect(x, y, 0, 0, 1, 1, cornerRadius)) continue;
          bgHits++;
          // 沿主对角线分割：左上青、右下粉
          if (x + y < 1) cyanHits++;
          if (inNote(x, y)) whiteHits++;
          else if (outlineInNote(x, y)) ringHits++;
        }
      }

      const idx = (py * size + px) * 4;

      if (!bgHits) {
        out[idx] = PINK[0];
        out[idx + 1] = PINK[1];
        out[idx + 2] = PINK[2];
        out[idx + 3] = 0;
        continue;
      }

      // 底色在分割线附近做一次均值混合，得到抗锯齿的对角边缘
      const inv = 1 / bgHits;
      const cyanRatio = cyanHits * inv;
      const whiteRatio = whiteHits * inv;
      const ringRatio = ringHits * inv;

      let r = CYAN[0] * cyanRatio + PINK[0] * (1 - cyanRatio);
      let g = CYAN[1] * cyanRatio + PINK[1] * (1 - cyanRatio);
      let b = CYAN[2] * cyanRatio + PINK[2] * (1 - cyanRatio);

      // 先压一层深色描边，再叠白色音符
      if (ringRatio) {
        r = r * (1 - ringRatio * RING_ALPHA) + RING[0] * (ringRatio * RING_ALPHA);
        g = g * (1 - ringRatio * RING_ALPHA) + RING[1] * (ringRatio * RING_ALPHA);
        b = b * (1 - ringRatio * RING_ALPHA) + RING[2] * (ringRatio * RING_ALPHA);
      }
      r = r * (1 - whiteRatio) + WHITE[0] * whiteRatio;
      g = g * (1 - whiteRatio) + WHITE[1] * whiteRatio;
      b = b * (1 - whiteRatio) + WHITE[2] * whiteRatio;

      out[idx] = Math.round(r);
      out[idx + 1] = Math.round(g);
      out[idx + 2] = Math.round(b);
      out[idx + 3] = Math.round((bgHits / total) * 255);
    }
  }
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, render(size, noteFor(size)));
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`wrote ${path.relative(process.cwd(), file)} (${png.length} bytes)`);
}
