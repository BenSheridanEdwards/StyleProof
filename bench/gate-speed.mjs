// Benchmark: the committed-map gate (CI diffs precomputed maps) vs the classic
// flow (CI captures BOTH base and head in a browser, then diffs).
//
//   npm run bench         # builds, then runs this
//
// It measures two real costs and projects them to a sample app:
//   - capture: one in-browser captureStyleMap of a representative fixture — the
//     cost the committed-map model moves to pre-push and skips in CI (×2 sides);
//   - diff: one diffStyleMaps of two maps — the committed-map model's whole CI cost.
//
// The numbers are for THIS fixture on THIS machine; real apps vary. The point is
// the order of magnitude: a browser capture is milliseconds-to-seconds, a diff is
// microseconds, and the committed-map CI also skips the build+serve entirely.
import { chromium } from '@playwright/test';
import { captureStyleMap } from '../dist/capture.js';
import { diffStyleMaps } from '../dist/diff.js';

const SURFACES = 10; // a smallish app
const WIDTHS = 3; // one viewport per @media band
const CAPTURES = SURFACES * WIDTHS;

// A representative page: ~30 cards × a few elements each, with hover + breakpoints.
const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box} body{margin:0;font-family:sans-serif}
  .card{padding:16px;border:1px solid #ccc;margin:8px;border-radius:8px;background:#fff}
  .card h2{font-size:18px;color:#222} .card p{color:#555}
  .btn{background:#0066cc;color:#fff;padding:8px 16px;border:0;border-radius:4px}
  .btn:hover{background:#004488} .btn:focus{outline:3px solid #88f}
  @media (min-width:768px){.card{padding:24px}}
  @media (min-width:1024px){.card{display:flex;gap:16px}}
</style></head><body><main>
  ${Array.from({ length: 30 }, (_, i) => `<div class="card"><h2>Card ${i}</h2><p>Body copy ${i}</p><button class="btn">Action ${i}</button></div>`).join('')}
</main></body></html>`;

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (n) => (n < 1 ? n.toFixed(3) : n < 100 ? n.toFixed(1) : Math.round(n).toString());
const human = (millis) => (millis >= 1000 ? `${(millis / 1000).toFixed(1)} s` : `${Math.round(millis)} ms`);

console.log(`StyleProof gate speed — ${SURFACES} surfaces × ${WIDTHS} widths = ${CAPTURES} captures\n`);

// --- capture cost (one in-browser captureStyleMap) ---
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto('data:text/html,' + encodeURIComponent(fixture), { waitUntil: 'load' });
const captureTimes = [];
let map;
for (let i = 0; i < 5; i++) {
  const t = performance.now();
  map = await captureStyleMap(page);
  captureTimes.push(performance.now() - t);
}
await browser.close();
const captureMs = median(captureTimes);

// --- diff cost (one diffStyleMaps) — the committed-map CI's whole compute ---
// Two near-identical maps (a realistic PR: one surface changed) so the diff does
// real work, not an early-out on reference equality.
const map2 = structuredClone(map);
const firstEl = Object.keys(map2.elements)[0];
if (firstEl) map2.elements[firstEl].style['background-color'] = 'rgb(1, 2, 3)';
const diffRuns = 2000;
const dt = performance.now();
for (let i = 0; i < diffRuns; i++) diffStyleMaps(map, map2);
const diffMs = (performance.now() - dt) / diffRuns;

// --- projection ---
const classicCompare = 2 * CAPTURES * captureMs; // capture base + head, every PR
const committedCompare = CAPTURES * diffMs; // diff precomputed maps, every PR
const speedup = classicCompare / committedCompare;

console.log(`  per surface×width  capture (browser)   ≈ ${ms(captureMs)} ms`);
console.log(`                     diff (precomputed)  ≈ ${ms(diffMs)} ms\n`);
console.log(`  classic CI    capture base+head, then diff`);
console.log(
  `                2 × ${CAPTURES} × ${ms(captureMs)} ms   ≈ ${human(classicCompare)}   (+ build & serve, NOT counted)`,
);
console.log(`  committed-map CI   diff precomputed maps`);
console.log(`                ${CAPTURES} × ${ms(diffMs)} ms          ≈ ${human(committedCompare)}\n`);
console.log(`  compare-step speedup ≈ ${Math.round(speedup)}×  — and committed-map CI also skips the build + serve.`);
