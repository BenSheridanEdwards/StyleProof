// Canonicalize a computed-style value so two spellings of the SAME value don't read as a
// change. Browsers and build tools serialize identical values differently — a Chromium
// bump rewrites `rgba(8, 18, 32, 0.62)` as `#0812209e`, a Tailwind migration reformats a
// font list's comma spacing — and StyleProof would otherwise report every one of those as
// a diff, drowning a re-baseline in changes that aren't changes.
//
// SAFETY BAR: only ever collapse values that are PROVABLY equal. A token we can't parse
// with confidence is left exactly as-is, so a real change always still diffs. Colors are
// parsed to a single rgba() form; everything else only has its comma/whitespace runs
// normalized (never inside quotes).

type Rgba = { r: number; g: number; b: number; a: number };

const clamp255 = (n: number) => Math.min(255, Math.max(0, Math.round(n)));
// Round alpha so the hex round-trip matches the decimal source: 0.62 → 0x9e (158) →
// 158/255 = 0.6196… → 0.62 again. 3 dp is enough to reunite them without collapsing
// genuinely different alphas (0.62 vs 0.625 stay apart).
const roundAlpha = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;

function fromHex(hex: string): Rgba | null {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length !== 6 && h.length !== 8) return null;
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

// Parse one channel: a plain number, or a percentage of `max`. Alpha is just `max: 1`
// (`50%` → 0.5, `0.5` → 0.5).
function channel(tok: string, max: number): number | null {
  const t = tok.trim();
  if (t.endsWith('%')) {
    const n = Number(t.slice(0, -1));
    return Number.isFinite(n) ? (n / 100) * max : null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h = ((h % 360) + 360) % 360;
  s = Math.min(1, Math.max(0, s));
  l = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

// Split `rgb(...)`/`hsl(...)` inner args on commas or the modern space + optional `/ alpha`.
function args(inner: string): string[] {
  if (inner.includes(',')) return inner.split(',');
  return inner.replace('/', ' ').split(/\s+/).filter(Boolean);
}

function parseColor(token: string): Rgba | null {
  const t = token.trim();
  if (t.startsWith('#')) return fromHex(t);
  const fn = t.match(/^(rgba?|hsla?)\((.*)\)$/i);
  if (!fn) return null;
  const kind = fn[1].toLowerCase();
  const parts = args(fn[2]);
  if (parts.length < 3) return null;
  const a = parts.length >= 4 ? channel(parts[3], 1) : 1;
  if (a === null) return null;
  if (kind.startsWith('rgb')) {
    const r = channel(parts[0], 255);
    const g = channel(parts[1], 255);
    const b = channel(parts[2], 255);
    if (r === null || g === null || b === null) return null;
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a };
  }
  // hsl / hsla
  const h = Number(parts[0].replace(/deg$/i, '').trim());
  const s = channel(parts[1], 1); // s/l are percentages → 0..1
  const l = channel(parts[2], 1);
  if (!Number.isFinite(h) || s === null || l === null) return null;
  const { r, g, b } = hslToRgb(h, s, l);
  return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a };
}

const COLOR_TOKEN = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/gi;

/**
 * Canonicalize a computed-style value: rewrite every parseable color to one `rgba(...)`
 * form and normalize comma/whitespace runs outside quotes. Unparseable colors and quoted
 * strings are left untouched, so only provably-equal values ever collapse.
 */
export function canonicalizeStyleValue(value: string): string {
  // Colours first — but never inside a quoted string (a content: value could hold "#fff"),
  // so operate only on the unquoted segments.
  const segments = splitQuoted(value);
  const canon = segments
    .map((seg) => (seg.quoted ? seg.text : seg.text.replace(COLOR_TOKEN, (m) => canonColor(m))))
    .join('');
  // Normalize comma spacing and collapse whitespace runs — again, only outside quotes.
  return splitQuoted(canon)
    .map((seg) => (seg.quoted ? seg.text : seg.text.replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ')))
    .join('')
    .trim();
}

function canonColor(token: string): string {
  const c = parseColor(token);
  if (!c) return token;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${roundAlpha(c.a)})`;
}

type Seg = { text: string; quoted: boolean };
function splitQuoted(value: string): Seg[] {
  const segs: Seg[] = [];
  let i = 0;
  let buf = '';
  while (i < value.length) {
    const ch = value[i];
    if (ch === '"' || ch === "'") {
      if (buf) {
        segs.push({ text: buf, quoted: false });
        buf = '';
      }
      const end = value.indexOf(ch, i + 1);
      const stop = end === -1 ? value.length : end + 1;
      segs.push({ text: value.slice(i, stop), quoted: true });
      i = stop;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf) segs.push({ text: buf, quoted: false });
  return segs;
}

/** Two computed-style values are equal if they canonicalize to the same string. */
export function styleValuesEqual(a: string, b: string): boolean {
  return a === b || canonicalizeStyleValue(a) === canonicalizeStyleValue(b);
}
