import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { Rect } from '../capture.js';
import { fillRect, type RGB } from '../png-util.js';
import { type Box } from './geometry.js';

/** A crop plus the document-space origin it was taken from. */
export type Crop = { png: PNG; ox: number; oy: number };

/** Fixed-size crop centred on the box, clamped to the image. */
export function cropPng(src: PNG, box: Box, w: number, h: number): Crop {
  const ox = Math.max(0, Math.min(Math.round(box.x + box.w / 2 - w / 2), src.width - w));
  const oy = Math.max(0, Math.min(Math.round(box.y + box.h / 2 - h / 2), src.height - h));
  const cw = Math.min(w, src.width);
  const ch = Math.min(h, src.height);
  const out = new PNG({ width: cw, height: ch });
  PNG.bitblt(src, out, Math.max(0, ox), Math.max(0, oy), cw, ch, 0, 0);
  return { png: out, ox, oy };
}

// Lossless but lean: opaque output, max deflate, adaptive filtering. Never lossy —
// these images are eyeballed for intentional change.
const PNG_OPTS = { deflateLevel: 9, filterType: -1, colorType: 2, inputColorType: 6 } as const;
export function writePng(file: string, png: PNG): void {
  fs.writeFileSync(file, PNG.sync.write(png, PNG_OPTS));
}

export function readPng(file: string): PNG | null {
  return fs.existsSync(file) ? PNG.sync.read(fs.readFileSync(file)) : null;
}

/** Path-safe, report-unique crop stem: `hero@1280` + `3` → `crops/hero-1280-3`. */
export const cropStem = (surface: string, suffix: string): string =>
  `crops/${surface.replace(/[^a-z0-9-]/gi, '-')}-${suffix}`;

// A magenta no real UI palette uses, drawn hollow so the UI underneath stays visible.
const HILITE: RGB = [255, 0, 200];
function strokeRect(png: PNG, x: number, y: number, w: number, h: number, t = 2): void {
  fillRect(png, x, y, w, t, HILITE);
  fillRect(png, x, y + h - t, w, t, HILITE);
  fillRect(png, x, y, t, h, HILITE);
  fillRect(png, x + w - t, y, t, h, HILITE);
}

/** Clone a crop and outline each rect (page coords mapped via the crop origin). */
export function annotateCrop(crop: Crop, rects: Rect[]): { png: PNG; highlighted: boolean } {
  const out = new PNG({ width: crop.png.width, height: crop.png.height });
  PNG.bitblt(crop.png, out, 0, 0, crop.png.width, crop.png.height, 0, 0);
  let highlighted = false;
  for (const [rx, ry, rw, rh] of rects) {
    if (rw <= 0 || rh <= 0) continue;
    const left = Math.max(0, rx - crop.ox);
    const top = Math.max(0, ry - crop.oy);
    const right = Math.min(crop.png.width, rx - crop.ox + rw);
    const bottom = Math.min(crop.png.height, ry - crop.oy + rh);
    if (right <= left || bottom <= top) continue;
    strokeRect(out, left, top, right - left, bottom - top, Math.min(2, right - left, bottom - top));
    highlighted = true;
  }
  return { png: out, highlighted };
}

const LABEL_COLOR: RGB = [139, 148, 158];
const LABEL_SCALE = 2;
const GLYPH_W = 5 * LABEL_SCALE;
const GLYPHS: Record<string, readonly string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
};

function directionLabel(label: string, fallback: 'BEFORE' | 'AFTER'): string {
  const normalized = label.trim().toUpperCase();
  if (/^BASE(?:\s|:|$)/.test(normalized)) return 'BASE';
  if (/^HEAD(?:\s|:|$)/.test(normalized)) return 'HEAD';
  return fallback;
}

const labelWidth = (label: string): number => label.length * GLYPH_W + (label.length - 1) * LABEL_SCALE;

function drawLabel(canvas: PNG, label: string, x: number, width: number): void {
  const startX = x + Math.floor((width - labelWidth(label)) / 2);
  for (let i = 0; i < label.length; i++) {
    const glyph = GLYPHS[label[i]];
    if (!glyph) continue;
    const glyphX = startX + i * (GLYPH_W + LABEL_SCALE);
    for (let row = 0; row < glyph.length; row++) {
      for (let col = 0; col < glyph[row].length; col++) {
        if (glyph[row][col] !== '1') continue;
        fillRect(canvas, glyphX + col * LABEL_SCALE, 3 + row * LABEL_SCALE, LABEL_SCALE, LABEL_SCALE, LABEL_COLOR);
      }
    }
  }
}

/** One before|after image: both crops on a dark canvas with a divider and direction labels. */
export function compositePair(before: PNG, after: PNG, leftLabel = 'before', rightLabel = 'after'): PNG {
  const PAD = 20;
  const GAP = 28;
  const w = Math.max(before.width, after.width);
  const h = Math.max(before.height, after.height);
  const left = directionLabel(leftLabel, 'BEFORE');
  const right = directionLabel(rightLabel, 'AFTER');
  const panelWidth = Math.max(w, labelWidth(left) + 8, labelWidth(right) + 8);
  const width = PAD + panelWidth + GAP + panelWidth + PAD;
  const canvas = new PNG({ width, height: PAD + h + PAD });
  fillRect(canvas, 0, 0, width, canvas.height, [13, 17, 23]); // GitHub dark
  const rightX = PAD + panelWidth + GAP;
  const offset = Math.floor((panelWidth - w) / 2);
  drawLabel(canvas, left, PAD, panelWidth);
  drawLabel(canvas, right, rightX, panelWidth);
  PNG.bitblt(before, canvas, 0, 0, before.width, before.height, PAD + offset, PAD);
  PNG.bitblt(after, canvas, 0, 0, after.width, after.height, rightX + offset, PAD);
  fillRect(canvas, PAD + panelWidth + GAP / 2 - 1, PAD, 2, h, [48, 54, 61]); // divider
  return canvas;
}

// Nearest-neighbour so the zoom invents no colours that weren't captured.
function scalePng(src: PNG, s: number): PNG {
  if (s <= 1) return src;
  const out = new PNG({ width: src.width * s, height: src.height * s });
  for (let y = 0; y < out.height; y++) {
    const sy = Math.floor(y / s);
    for (let x = 0; x < out.width; x++) {
      const si = (sy * src.width + Math.floor(x / s)) << 2;
      const oi = (y * out.width + x) << 2;
      out.data.set(src.data.subarray(si, si + 4), oi);
    }
  }
  return out;
}

/** Magnified crop of the box with the change rects outlined (stroke scaled to stay visible). */
export function zoomCrop(src: PNG, box: Box, rects: Rect[], factor: number): PNG {
  const crop = cropPng(src, box, box.w, box.h);
  const scaled = scalePng(crop.png, factor);
  const t = Math.max(2, factor);
  for (const [rx, ry, rw, rh] of rects) {
    strokeRect(scaled, (rx - crop.ox) * factor, (ry - crop.oy) * factor, rw * factor, rh * factor, t);
  }
  return scaled;
}

/** Write a before|after composite under `outDir`. */
export function writeComposite(outDir: string, rel: string, pair: [PNG, PNG], labels: [string, string]): void {
  writePng(path.join(outDir, rel), compositePair(pair[0], pair[1], ...labels));
}
