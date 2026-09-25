// Canonicalize a computed-style value so two spellings of the SAME value never read as a
// change (`rgba(8, 18, 32, 0.62)` vs `#0812209e`, comma spacing in a font list).
//
// SAFETY BAR: only ever collapse values that are PROVABLY equal. A token we can't parse
// with confidence is left exactly as-is, so a real change always still diffs. Colors are
// parsed to a single rgba() form; everything else only has its comma/whitespace runs
// normalized (never inside quotes).

export type Rgba = { r: number; g: number; b: number; a: number };

const clamp255 = (n: number) => Math.min(255, Math.max(0, Math.round(n)));
// 3 dp reunites a hex round-trip (0.62 → 0x9e → 0.6196…) without merging 0.62 and 0.625.
const roundAlpha = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;

function fromHex(hex: string): Rgba | null {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if ((h.length !== 6 && h.length !== 8) || !/^[0-9a-fA-F]+$/.test(h)) return null;
  const at = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: at(0), g: at(2), b: at(4), a: h.length === 8 ? at(6) / 255 : 1 };
}

/** One channel: a plain number, or a percentage of `max` (alpha is `max: 1`). */
function channel(tok: string, max: number): number | null {
  const t = tok.trim();
  const n = t.endsWith('%') ? (Number(t.slice(0, -1)) / 100) * max : Number(t);
  return Number.isFinite(n) ? n : null;
}

// Hue sextant → which of (c, x, 0) lands in r, g, b.
const HUE_SEXTANTS: [number, number, number][] = [
  [0, 1, 2],
  [1, 0, 2],
  [2, 0, 1],
  [2, 1, 0],
  [1, 2, 0],
  [0, 2, 1],
];

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h = ((h % 360) + 360) % 360;
  s = Math.min(1, Math.max(0, s));
  l = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const cx0 = [c, x, 0];
  const [ri, gi, bi] = HUE_SEXTANTS[Math.min(5, Math.floor(h / 60))];
  return { r: (cx0[ri] + m) * 255, g: (cx0[gi] + m) * 255, b: (cx0[bi] + m) * 255 };
}

/** `rgb(...)`/`hsl(...)` inner args, split on commas or the modern space + optional `/ alpha`. */
function args(inner: string): string[] {
  if (inner.includes(',')) return inner.split(',');
  return inner.replace('/', ' ').split(/\s+/).filter(Boolean);
}

/** Parse a value that IS a colour (`#hex`, `rgb[a]()`, `hsl[a]()`); anything else, including a
 *  colour embedded in a gradient/shadow, is null so it never stands in for the whole value. */
export function parseColor(token: string): Rgba | null {
  const t = token.trim();
  if (t.startsWith('#')) return fromHex(t);
  const fn = t.match(/^(rgba?|hsla?)\(([^()]*)\)$/i);
  if (!fn) return null;
  const parts = args(fn[2]);
  if (parts.length < 3) return null;
  const a = parts.length >= 4 ? channel(parts[3], 1) : 1;
  if (a === null) return null;
  if (fn[1].toLowerCase().startsWith('rgb')) {
    const [r, g, b] = parts.slice(0, 3).map((p) => channel(p, 255));
    if (r === null || g === null || b === null) return null;
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a };
  }
  const h = Number(parts[0].replace(/deg$/i, '').trim());
  const s = channel(parts[1], 1);
  const l = channel(parts[2], 1);
  if (!Number.isFinite(h) || s === null || l === null) return null;
  const { r, g, b } = hslToRgb(h, s, l);
  return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a };
}

const COLOR_TOKEN = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/gi;

function canonColor(token: string): string {
  const c = parseColor(token);
  return c ? `rgba(${c.r}, ${c.g}, ${c.b}, ${roundAlpha(c.a)})` : token;
}

type Seg = { text: string; quoted: boolean };

/** Index just past the quote closing the string opened at `open`; a backslash escapes the next char. */
function closingQuoteEnd(value: string, open: number): number {
  const quote = value[open];
  for (let i = open + 1; i < value.length; i++) {
    if (value[i] === '\\') i++;
    else if (value[i] === quote) return i + 1;
  }
  return value.length;
}

/** Split into quoted and unquoted segments so a `content: "#fff"` (or `"\"#fff"`) is never rewritten. */
function splitQuoted(value: string): Seg[] {
  const segs: Seg[] = [];
  let buf = '';
  for (let i = 0; i < value.length;) {
    const ch = value[i];
    if (ch !== '"' && ch !== "'") {
      buf += ch;
      i++;
      continue;
    }
    if (buf) segs.push({ text: buf, quoted: false });
    buf = '';
    const stop = closingQuoteEnd(value, i);
    segs.push({ text: value.slice(i, stop), quoted: true });
    i = stop;
  }
  if (buf) segs.push({ text: buf, quoted: false });
  return segs;
}

const outsideQuotes = (value: string, rewrite: (text: string) => string): string =>
  splitQuoted(value)
    .map((seg) => (seg.quoted ? seg.text : rewrite(seg.text)))
    .join('');

/** Rewrite every parseable colour to one `rgba(...)` form and normalize comma/whitespace runs outside quotes. */
export function canonicalizeStyleValue(value: string): string {
  const colours = outsideQuotes(value, (text) => text.replace(COLOR_TOKEN, canonColor));
  return outsideQuotes(colours, (text) => text.replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ')).trim();
}

/** Two computed-style values are equal if they canonicalize to the same string. */
export function styleValuesEqual(a: string, b: string): boolean {
  return a === b || canonicalizeStyleValue(a) === canonicalizeStyleValue(b);
}
