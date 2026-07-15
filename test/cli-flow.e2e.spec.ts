import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadStyleMap } from '../dist/index.js';

// Every test here builds its own fixture (mkdtemp / own page); none reads another
// test's output. Declare the file parallel so its tests spread across workers —
// serial-in-one-worker made this file the long pole of the e2e wall time.
test.describe.configure({ mode: 'parallel' });

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const INIT = path.join(root, 'bin/styleproof-init.mjs');
const MAP = path.join(root, 'bin/styleproof-map.mjs');
const DIFF = path.join(root, 'bin/styleproof-diff.mjs');
const PLAYWRIGHT_BIN = path.join(root, 'node_modules/.bin');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function commandEnv(env: NodeJS.ProcessEnv = {}) {
  const merged = { ...process.env, PATH: `${PLAYWRIGHT_BIN}${path.delimiter}${process.env.PATH}`, CI: '1', ...env };
  for (const key of ['GITHUB_BASE_REF', 'GITHUB_SHA', 'GITHUB_HEAD_SHA', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH']) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) delete merged[key];
  }
  return merged;
}

function run(cwd: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: commandEnv(env),
  });
}

// Non-blocking variant: use when an HTTP server hosted IN THIS PROCESS must keep
// serving while the CLI runs (spawnSync blocks the event loop, starving it).
function runAsync(
  cwd: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: commandEnv(env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function git(cwd: string, args: string[]) {
  const result = run(cwd, 'git', args);
  expect(result.status, result.stderr).toBe(0);
  return result;
}

function writeFixtureApp(dir: string, port: number) {
  fs.mkdirSync(path.join(dir, 'node_modules/@playwright'), { recursive: true });
  fs.symlinkSync(root, path.join(dir, 'node_modules/styleproof'), 'dir');
  fs.symlinkSync(
    path.join(root, 'node_modules/@playwright/test'),
    path.join(dir, 'node_modules/@playwright/test'),
    'dir',
  );
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        type: 'module',
        scripts: {
          build: 'node -e ""',
          start: `node server.mjs ${port}`,
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(dir, 'server.mjs'),
    `import http from 'node:http';
const port = Number(process.argv[2]);
http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(\`<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; color: rgb(0, 0, 0); }
    main { padding: 32px; }
  </style></head><body><main>StyleProof fixture</main></body></html>\`);
}).listen(port, '127.0.0.1');
`,
  );
}

test('styleproof-init → styleproof-map → styleproof-diff works in a generated app', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-cli-flow-'));
  const port = await freePort();
  try {
    writeFixtureApp(app, port);
    git(app, ['init', '-q']);
    git(app, ['config', 'user.email', 'styleproof@example.test']);
    git(app, ['config', 'user.name', 'StyleProof Test']);
    git(app, ['checkout', '-qb', 'main']);
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-cli-flow-remote-'));
    git(remote, ['init', '--bare', '-q']);
    git(app, ['remote', 'add', 'origin', remote]);

    const init = run(app, process.execPath, [INIT, '--base-url', `http://127.0.0.1:${port}`]);
    expect(init.status, init.stderr).toBe(0);
    expect(init.stdout).toContain('created e2e/styleproof.spec.ts');
    git(app, ['add', '-A']);
    git(app, ['commit', '-qm', 'styleproof setup']);

    const baseMap = run(app, process.execPath, [MAP], { STYLEPROOF_UPLOAD: '1' });
    expect(baseMap.status, baseMap.stderr + baseMap.stdout).toBe(0);
    // Crawl-by-default keys the root '/' as `index`; a link-less single-page app still
    // captures it (the crawl always covers `from`).
    expect(
      fs.readdirSync(path.join(app, '.styleproof/maps/current')).some((file) => /^index@\d+\.json\.gz$/.test(file)),
    ).toBe(true);

    git(app, ['checkout', '-qb', 'feature']);
    fs.writeFileSync(path.join(app, 'feature.txt'), 'feature');
    git(app, ['add', '-A']);
    git(app, ['commit', '-qm', 'feature']);

    const headMap = run(app, process.execPath, [MAP], { STYLEPROOF_UPLOAD: '1' });
    expect(headMap.status, headMap.stderr + headMap.stdout).toBe(0);

    const diff = run(app, process.execPath, [DIFF]);
    expect(diff.status, diff.stderr + diff.stdout).toBe(0);
    expect(diff.stdout).toContain('0 changed surfaces across 1 captured surface(s)');
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

test('styleproof-capture --crawl --require-full-coverage: exit 0 when covered, exit 4 on residue', async () => {
  const CAPTURE = path.join(root, 'bin/styleproof-capture.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-cov-cli-'));
  const covered = path.join(dir, 'covered.html');
  const withDead = path.join(dir, 'dead.html');
  const page = (extraCss: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; } .card { padding: 20px; background: rgb(240,240,245); }
      .modal { display: none; position: fixed; inset: 20% 25%; background: rgb(250,250,255); }
      .modal.open { display: block; } ${extraCss}
      button { cursor: pointer; }
    </style></head><body>
      <main class="card"><button id="open">Open</button></main>
      <div class="modal" id="m">modal content</div>
      <script>document.getElementById('open').onclick = () => document.getElementById('m').classList.add('open');</script>
    </body></html>`;
  fs.writeFileSync(covered, page(''));
  fs.writeFileSync(withDead, page('.ghost { color: rgb(9,9,9); }'));
  try {
    const ok = run(dir, 'node', [
      CAPTURE,
      'file://' + covered,
      '--crawl',
      '--no-screenshots',
      '--out',
      path.join(dir, 'a'),
      '--require-full-coverage',
    ]);
    expect(ok.stdout).toContain('✓ coverage: all');
    expect(ok.status, 'fully covered page exits 0').toBe(0);

    const gap = run(dir, 'node', [
      CAPTURE,
      'file://' + withDead,
      '--crawl',
      '--no-screenshots',
      '--out',
      path.join(dir, 'b'),
      '--require-full-coverage',
    ]);
    expect(gap.stdout).toContain('ghost');
    expect(gap.status, 'coverage residue exits 4').toBe(4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A page whose ONLY stylesheet is served cross-origin with no CORS header: the
// browser applies it but the CSSOM can't read it (`sheet.cssRules` throws). This
// is the exact condition the fail-loud contract is about — the crawl must not
// silently sweep a single 1280px width, and --require-full-coverage must not
// certify completeness while blind to the sheet's whole vocabulary.
function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

async function serveCrossOriginStyleApp(pagePort: number, cssPort: number) {
  const cssServer = http.createServer((_req, res) => {
    // No Access-Control-Allow-Origin → cross-origin CSSOM read throws.
    res.setHeader('content-type', 'text/css');
    res.end('.card{padding:20px} @media (min-width: 700px){ .card{padding:40px} }');
  });
  const pageServer = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(
      `<!doctype html><html><head><meta charset="utf-8">` +
        `<link rel="stylesheet" href="http://127.0.0.1:${cssPort}/styles.css">` +
        `</head><body><main class="card">hello</main></body></html>`,
    );
  });
  await Promise.all([listen(cssServer, cssPort), listen(pageServer, pagePort)]);
  return () => {
    cssServer.close();
    pageServer.close();
  };
}

test('styleproof-capture --crawl: fails loud on an unreadable cross-origin stylesheet (no silent 1280-only sweep)', async () => {
  const CAPTURE = path.join(root, 'bin/styleproof-capture.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-xorigin-'));
  const pagePort = await freePort();
  const cssPort = await freePort();
  const stop = await serveCrossOriginStyleApp(pagePort, cssPort);
  try {
    // No --widths → breakpoint detection runs, hits the unreadable sheet, and MUST throw.
    const res = await runAsync(dir, 'node', [
      CAPTURE,
      `http://127.0.0.1:${pagePort}/`,
      '--crawl',
      '--no-screenshots',
      '--out',
      path.join(dir, 'a'),
    ]);
    expect(res.status, 'crawl exits non-zero when breakpoints are undetectable').not.toBe(0);
    expect(res.stderr + res.stdout).toMatch(/unreadable|cross-origin/i);
    // The message advises pinning --widths, matching the one-shot path.
    expect(res.stderr + res.stdout).toMatch(/widths/);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('styleproof-capture --crawl --require-full-coverage: exit 4 with named residue for an unreadable cross-origin sheet', async () => {
  const CAPTURE = path.join(root, 'bin/styleproof-capture.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-xorigin-cov-'));
  const pagePort = await freePort();
  const cssPort = await freePort();
  const stop = await serveCrossOriginStyleApp(pagePort, cssPort);
  try {
    // Pin --widths so breakpoint detection is skipped and the crawl reaches the
    // coverage check: the cross-origin sheet is unreadable, so its class
    // vocabulary can't be proven covered → residue → exit 4.
    const res = await runAsync(dir, 'node', [
      CAPTURE,
      `http://127.0.0.1:${pagePort}/`,
      '--crawl',
      '--no-screenshots',
      '--widths',
      '1280',
      '--out',
      path.join(dir, 'a'),
      '--require-full-coverage',
    ]);
    expect(res.stdout, 'unreadable sheet named as residue').toMatch(/stylesheet\(s\) unreadable/);
    expect(res.stdout).toMatch(new RegExp(`127\\.0\\.0\\.1:${cssPort}`));
    expect(res.status, 'unreadable-sheet residue exits 4').toBe(4);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// An append-generator: each click appends a node with a BRAND-NEW class, so the
// structural fingerprint never repeats — dedup can NOT terminate the crawl. Only
// the --max-depth cap can. This proves the cap binds (the audit found no test
// that did). Without the cap this crawl recurses until maxStates; with a small
// cap it stops at a bounded, predictable surface count.
async function serveAppendGeneratorApp(port: number) {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>` +
        `<button id="add">Add</button><div id="list"></div>` +
        `<script>let n=0;document.getElementById('add').onclick=()=>{` +
        `const d=document.createElement('div');n++;d.className='row-'+n;d.textContent='row '+n;` +
        `document.getElementById('list').appendChild(d);};</script>` +
        `</body></html>`,
    );
  });
  await listen(server, port);
  return () => server.close();
}

test('styleproof-capture --crawl: the depth cap binds on an append-generator (dedup alone would not terminate)', async () => {
  const CAPTURE = path.join(root, 'bin/styleproof-capture.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-append-'));
  const port = await freePort();
  const stop = await serveAppendGeneratorApp(port);
  try {
    // Depth 3: every appended row is a fresh identity, so each click opens a new
    // surface — the crawl would run to maxStates if nothing bound it. The cap
    // stops it at a small, finite count. maxStates default is 100000, so a
    // completed crawl with a handful of surfaces proves the DEPTH cap terminated
    // it, not the state ceiling.
    const res = await runAsync(dir, 'node', [
      CAPTURE,
      `http://127.0.0.1:${port}/`,
      '--crawl',
      '--no-screenshots',
      '--max-depth',
      '3',
      '--out',
      path.join(dir, 'a'),
    ]);
    expect(res.status, res.stderr + res.stdout).toBe(0); // terminated, did not hang
    const surfaces = fs.readdirSync(path.join(dir, 'a')).filter((f) => f.endsWith('.json.gz')).length;
    // base + one surface per depth level (1..3) = 4. Bounded and small — proof the
    // cap terminated an otherwise-unbounded append chain.
    expect(surfaces, 'depth cap bounds the append chain to a small finite count').toBeLessThanOrEqual(5);
    expect(surfaces, 'the crawl did drive into the append chain').toBeGreaterThan(1);
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A real multi-page app served over HTTP with a nav linking / → /pricing → /about,
// plus one @media band. Proves crawl-by-default captures the WHOLE surface out of the box.
function writeMultiPageApp(dir: string, port: number) {
  fs.mkdirSync(path.join(dir, 'node_modules/@playwright'), { recursive: true });
  fs.symlinkSync(root, path.join(dir, 'node_modules/styleproof'), 'dir');
  fs.symlinkSync(
    path.join(root, 'node_modules/@playwright/test'),
    path.join(dir, 'node_modules/@playwright/test'),
    'dir',
  );
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { build: 'node -e ""', start: `node server.mjs ${port}` } }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'server.mjs'),
    `import http from 'node:http';
const port = Number(process.argv[2]);
const nav = '<nav><a href="/">Home</a> <a href="/pricing">Pricing</a> <a href="/about">About</a></nav>';
const pages = { '/': '<h1>Home</h1>', '/pricing': '<h1>Pricing</h1>', '/about': '<h1>About</h1>' };
http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  res.setHeader('content-type', 'text/html');
  res.end(\`<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:system-ui} nav{padding:16px;background:rgb(240,240,245)} nav a{margin-right:12px}
    main{padding:32px} h1{color:rgb(20,20,30)}
    @media (min-width: 700px){ main{padding:48px} }
  </style></head><body>\${nav}<main>\${pages[url] ?? '<h1>404</h1>'}</main></body></html>\`);
}).listen(port, '127.0.0.1');
`,
  );
}

// The CLI crawl must follow the nav too: `styleproof-capture --crawl` on a
// multi-page site captures every same-origin page it links to, each keyed by
// route, with class coverage aggregated across the pages that share the CSS.
// (Before this pinned it, the CLI crawl drove controls but silently dropped
// links — a 3-page site reported "1/1 surfaces, coverage ✓".)
test('styleproof-capture --crawl follows same-origin nav links across pages', async () => {
  const CAPTURE = path.join(root, 'bin/styleproof-capture.mjs');
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-multipage-cli-'));
  const port = await freePort();
  try {
    writeMultiPageApp(app, port);
    const server = spawn('node', ['server.mjs', String(port)], { cwd: app });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const out = path.join(app, 'maps');
      const result = await runAsync(app, process.execPath, [
        CAPTURE,
        `http://127.0.0.1:${port}/`,
        '--crawl',
        '--no-screenshots',
        '--widths',
        '1280',
        '--out',
        out,
        '--require-full-coverage',
      ]);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const files = fs.readdirSync(out);
      expect(
        files.some((f) => /^base@1280\.json\.gz$/.test(f)),
        'entry page captured',
      ).toBe(true);
      for (const key of ['pricing', 'about']) {
        expect(
          files.some((f) => f === `${key}@1280.json.gz`),
          `${key} captured via its nav link`,
        ).toBe(true);
      }
      expect(result.stdout).toContain('across 3 page(s)');
      // Pages share the stylesheet; coverage aggregates across them instead of
      // flagging per-page "missing" classes that render elsewhere.
      expect(result.stdout).toMatch(/✓ coverage \(3 pages\)/);

      // Opt-out: --no-follow-links keeps the old single-page behaviour.
      const solo = path.join(app, 'solo');
      const soloRun = await runAsync(app, process.execPath, [
        CAPTURE,
        `http://127.0.0.1:${port}/`,
        '--crawl',
        '--no-follow-links',
        '--no-screenshots',
        '--widths',
        '1280',
        '--out',
        solo,
      ]);
      expect(soloRun.status, soloRun.stderr + soloRun.stdout).toBe(0);
      expect(fs.readdirSync(solo).some((f) => /pricing|about/.test(f))).toBe(false);
    } finally {
      server.kill();
    }
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

// A same-origin href can still 302 off-origin (SSO, /out?url=…). External
// content is nondeterministic and must never enter a map: the CLI sweep skips
// the page loudly and continues; a spec-driven capture fails naming the surface.
test('crawls never capture an off-origin redirect target', async () => {
  const CAPTURE = path.join(root, 'bin/styleproof-capture.mjs');
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-redirect-'));
  const port = await freePort();
  try {
    fs.writeFileSync(
      path.join(app, 'server.mjs'),
      `import http from 'node:http';
const port = Number(process.argv[2]);
http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/away') { res.statusCode = 302; res.setHeader('location', 'https://example.com/'); return res.end(); }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><html><head><style>.k{color:rgb(20,20,30)}</style></head><body>' +
    '<nav><a href="/">Home</a> <a href="/away">Away</a></nav><h1 class="k">Home</h1></body></html>');
}).listen(port, '127.0.0.1');
`,
    );
    const server = spawn('node', ['server.mjs', String(port)], { cwd: app });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const out = path.join(app, 'maps');
      const result = await runAsync(app, process.execPath, [
        CAPTURE,
        `http://127.0.0.1:${port}/`,
        '--crawl',
        '--no-screenshots',
        '--widths',
        '1280',
        '--out',
        out,
      ]);
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain('redirected off-origin');
      expect(result.stdout).toContain('page skipped');
      const files = fs.readdirSync(out);
      expect(
        files.some((f) => /^away@/.test(f)),
        'external page must not be captured',
      ).toBe(false);
      expect(
        files.some((f) => /^base@1280\.json\.gz$/.test(f)),
        'entry page still captured',
      ).toBe(true);

      // An entry URL that itself redirects off-origin is a broken run, not a skip.
      const entryRedirect = await runAsync(app, process.execPath, [
        CAPTURE,
        `http://127.0.0.1:${port}/away`,
        '--crawl',
        '--no-screenshots',
        '--widths',
        '1280',
        '--out',
        path.join(app, 'maps2'),
      ]);
      expect(entryRedirect.status).toBe(3);
      expect(entryRedirect.stderr).toContain('redirected off-origin');
    } finally {
      server.kill();
    }
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

// Spec-driven counterpart: a crawl-discovered surface that redirects off-origin
// FAILS the capture naming the surface — a gate capture must never silently
// swallow (or silently skip) a surface it cannot truthfully record.
test('styleproof-map fails loudly when a crawled link redirects off-origin', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-redirect-map-'));
  const port = await freePort();
  try {
    writeMultiPageApp(app, port);
    // Add an off-origin redirect route + a nav link to it.
    const server = path.join(app, 'server.mjs');
    fs.writeFileSync(
      server,
      fs
        .readFileSync(server, 'utf8')
        .replace(
          "const url = req.url.split('?')[0];",
          "const url = req.url.split('?')[0];\n  if (url === '/away') { res.statusCode = 302; res.setHeader('location', 'https://example.com/'); return res.end(); }",
        )
        .replace('<a href="/about">About</a>', '<a href="/about">About</a> <a href="/away">Away</a>'),
    );
    git(app, ['init', '-q']);
    git(app, ['config', 'user.email', 'styleproof@example.test']);
    git(app, ['config', 'user.name', 'StyleProof Test']);
    git(app, ['checkout', '-qb', 'main']);
    const init = run(app, process.execPath, [INIT, '--base-url', `http://127.0.0.1:${port}`]);
    expect(init.status, init.stderr).toBe(0);
    git(app, ['add', '-A']);
    git(app, ['commit', '-qm', 'styleproof setup']);

    const map = run(app, process.execPath, [MAP]);
    expect(map.status, 'a surface that cannot be truthfully captured must fail the capture').not.toBe(0);
    expect(map.stdout + map.stderr).toContain('redirected off-origin');
    const mapsDir = path.join(app, '.styleproof/maps/current');
    const files = fs.existsSync(mapsDir) ? fs.readdirSync(mapsDir) : [];
    expect(
      files.some((f) => /^away@/.test(f)),
      'external page must not be captured',
    ).toBe(false);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

// Captures must parallelize ACROSS WORKERS even when the consumer's config pins
// `fullyParallel: false` for its behaviour suite (a real consumer shape, where
// 150 serial surface×width captures made a ~25-minute CI step). The capture
// describe declares parallel mode itself; this pins that a parallel run still
// produces a complete bundle — every surface, ledger, and manifest present.
test('explicit-surface capture fans out across workers under fullyParallel:false', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-parallel-'));
  const port = await freePort();
  try {
    writeMultiPageApp(app, port);
    git(app, ['init', '-q']);
    git(app, ['config', 'user.email', 'styleproof@example.test']);
    git(app, ['config', 'user.name', 'StyleProof Test']);
    git(app, ['checkout', '-qb', 'main']);
    const init = run(app, process.execPath, [INIT, '--base-url', `http://127.0.0.1:${port}`]);
    expect(init.status, init.stderr).toBe(0);
    // The serial-consumer shape: behaviour suite pins fullyParallel:false + workers.
    const configPath = path.join(app, 'playwright.styleproof.config.ts');
    const config = fs.readFileSync(configPath, 'utf8');
    expect(config).toContain('fullyParallel: true');
    fs.writeFileSync(configPath, config.replace('fullyParallel: true', 'fullyParallel: false,\n  workers: 4'));
    // Explicit surfaces (one test per surface × width) — the parallelized shape.
    fs.writeFileSync(
      path.join(app, 'e2e/styleproof.spec.ts'),
      `import { defineStyleMapCapture } from 'styleproof';
defineStyleMapCapture({
  surfaces: [
    { key: 'index', widths: [1280, 600], go: async (page) => { await page.goto('/'); } },
    { key: 'pricing', widths: [1280, 600], go: async (page) => { await page.goto('/pricing'); } },
    { key: 'about', widths: [1280, 600], go: async (page) => { await page.goto('/about'); } },
  ],
  screenshots: false,
  dir: process.env.STYLEMAP_DIR,
});
`,
    );
    git(app, ['add', '-A']);
    git(app, ['commit', '-qm', 'styleproof setup']);

    const map = run(app, process.execPath, [MAP]);
    expect(map.status, map.stderr + map.stdout).toBe(0);
    // Playwright reports the worker fan-out; a serial run would say "1 worker".
    // eslint-disable-next-line no-control-regex
    const plainStdout = map.stdout.replace(/\u001b\[[0-9;]*m/g, '');
    expect(plainStdout).toMatch(/using [2-9] workers/);
    const mapsDir = path.join(app, '.styleproof/maps/current');
    const files = fs.readdirSync(mapsDir);
    for (const key of ['index', 'pricing', 'about']) {
      for (const width of [1280, 600]) {
        expect(files.includes(`${key}@${width}.json.gz`), `${key}@${width} captured`).toBe(true);
      }
    }
    expect(files.includes('styleproof-coverage.json'), 'ledger written').toBe(true);
    expect(files.includes('styleproof-manifest.json'), 'manifest written').toBe(true);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

test('zero-config: init on a multi-page app crawls and captures every page — no spec editing', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-zeroconfig-'));
  const port = await freePort();
  try {
    writeMultiPageApp(app, port);
    git(app, ['init', '-q']);
    git(app, ['config', 'user.email', 'styleproof@example.test']);
    git(app, ['config', 'user.name', 'StyleProof Test']);
    git(app, ['checkout', '-qb', 'main']);

    const init = run(app, process.execPath, [INIT, '--base-url', `http://127.0.0.1:${port}`]);
    expect(init.status, init.stderr).toBe(0);
    // The generated spec CRAWLS — no hand-listed surface array to maintain.
    const spec = fs.readFileSync(path.join(app, 'e2e/styleproof.spec.ts'), 'utf8');
    expect(spec).toContain('defineCrawlCapture');
    expect(spec).not.toMatch(/key: 'home'/);

    git(app, ['add', '-A']);
    git(app, ['commit', '-qm', 'styleproof setup']);

    // Capture with ZERO edits to the generated spec.
    const map = run(app, process.execPath, [MAP]);
    expect(map.status, map.stderr + map.stdout).toBe(0);

    const mapsDir = path.join(app, '.styleproof/maps/current');
    const files = fs.readdirSync(mapsDir);
    // The crawl discovered and captured EVERY page the nav links to — index (the root),
    // pricing, and about — with nothing hand-listed.
    for (const key of ['index', 'pricing', 'about']) {
      expect(
        files.some((f) => new RegExp(`^${key}@\\d+\\.json\\.gz$`).test(f)),
        `${key} captured by the crawl`,
      ).toBe(true);
    }
    // Multi-width too: the @media (min-width:700px) band is swept automatically (no widths listed).
    const widths = new Set(
      files.filter((f) => f.endsWith('.json.gz')).map((f) => f.replace(/^.*@(\d+)\.json\.gz$/, '$1')),
    );
    expect(widths.size, 'auto-detected more than one @media band').toBeGreaterThan(1);

    // Inventory-by-default: each surface's nav affordances are harvested, so a removed
    // nav item gates — out of the box, no opt-in.
    const indexFile = files.find((f) => /^index@\d+\.json\.gz$/.test(f))!;
    const indexMap = loadStyleMap(path.join(mapsDir, indexFile));
    expect(
      indexMap.inventory?.some((i) => /pricing/.test(i.key)),
      'nav inventory harvested by default',
    ).toBe(true);

    // Coverage provenance: the capture writes the ledger into the bundle so the gate can
    // state its completeness basis. A crawl declares no registry → `expected: null`
    // (honestly "not asserted": it captured what the nav links to, not proven-every-route).
    const ledger = JSON.parse(fs.readFileSync(path.join(mapsDir, 'styleproof-coverage.json'), 'utf8'));
    expect(ledger.expected, 'crawl records completeness as not-asserted').toBe(null);
    // Determinism proven: this is a recording run (no replay) → selfCheck on → self-checked.
    expect(ledger.determinism, 'a recording run records determinism as self-checked').toBe('self-checked');
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

// Overwrite the generated crawl spec with one carrying `expected`, keeping the config
// styleproof-init wrote (its `@playwright/test` import resolves against the app's linked
// node_modules). Drives it through styleproof-map (which runs Playwright), proving the
// crawl coverage guard fails end-to-end on an unowned rendered link, then passes once
// `expected` covers it.
function writeCrawlSpecWithExpected(dir, expected) {
  fs.writeFileSync(
    path.join(dir, 'e2e/styleproof.spec.ts'),
    `import { defineCrawlCapture } from 'styleproof';
defineCrawlCapture({
  from: '/',
  widths: [1280],
  screenshots: false,
  expected: ${JSON.stringify(expected)},
  dir: process.env.STYLEMAP_DIR,
});
`,
  );
}

test('crawl coverage guard: a rendered link with no `expected` owner fails the capture, covering it passes', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-crawl-cov-'));
  const port = await freePort();
  try {
    // The nav links / → /pricing → /about, so the rendered link set is {index, pricing, about}.
    writeMultiPageApp(app, port);
    git(app, ['init', '-q']);
    git(app, ['config', 'user.email', 'styleproof@example.test']);
    git(app, ['config', 'user.name', 'StyleProof Test']);
    git(app, ['checkout', '-qb', 'main']);
    const init = run(app, process.execPath, [INIT, '--base-url', `http://127.0.0.1:${port}`]);
    expect(init.status, init.stderr).toBe(0);

    // Phase 1: `expected` omits `about`, which the nav DOES render → new route with no owner.
    writeCrawlSpecWithExpected(app, ['index', 'pricing']);
    const gap = run(app, process.execPath, [MAP], { STYLEMAP_DIR: 'current' });
    expect(gap.status, 'an unowned rendered link fails the capture run').not.toBe(0);
    const gapOut = gap.stdout + gap.stderr;
    expect(gapOut).toContain('styleproof crawl coverage gap');
    expect(gapOut).toContain('new route(s) with no owner');
    expect(gapOut).toContain('about');

    // Phase 2: `expected` now covers every rendered link → the guard passes and it captures.
    writeCrawlSpecWithExpected(app, ['index', 'pricing', 'about']);
    const ok = run(app, process.execPath, [MAP], { STYLEMAP_DIR: 'current' });
    expect(ok.status, ok.stderr + ok.stdout).toBe(0);
    // The declared universe travels in the ledger now (not null, unlike a bare crawl).
    const ledger = JSON.parse(
      fs.readFileSync(path.join(app, '.styleproof/maps/current/styleproof-coverage.json'), 'utf8'),
    );
    expect(ledger.expected).toEqual(['index', 'pricing', 'about']);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pre-push hook dogfood: the ONE place the real scaffolded `.githooks/pre-push`
// is executed the way git executes it (refspecs on stdin), driving the full
// production flow — miss → capture → publish to the styleproof-maps branch keyed
// by the PUSHED SHA, re-run → restore hit (no recapture), docs-only push → skip —
// and then the CI side of the contract: a FRESH clone restores that SHA's bundle
// from the store and a two-directory diff proves the roundtrip is byte-faithful.
// Everything else in the repo asserts the hook's TEXT; this asserts its BEHAVIOR.
// ---------------------------------------------------------------------------

/** The hook invokes `npx styleproof-map` / `npx styleproof-diff` (the npm PM form).
 *  Give npx real local binaries to resolve: shims in the app's node_modules/.bin
 *  that exec this checkout's bins, so no registry install is ever attempted. */
function writeBinShims(app: string) {
  const bin = path.join(app, 'node_modules/.bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['styleproof-map', 'styleproof-diff']) {
    const shim = path.join(bin, name);
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, `bin/${name}.mjs`)}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
}

/** Symlink this checkout into `dir` the same way writeFixtureApp does, so the
 *  compatibility key (which resolves @playwright/test through the consumer's
 *  node_modules) computes identically in the CI-side clone. */
function linkNodeModules(dir: string) {
  fs.mkdirSync(path.join(dir, 'node_modules/@playwright'), { recursive: true });
  fs.symlinkSync(root, path.join(dir, 'node_modules/styleproof'), 'dir');
  fs.symlinkSync(
    path.join(root, 'node_modules/@playwright/test'),
    path.join(dir, 'node_modules/@playwright/test'),
    'dir',
  );
}

/** Run the scaffolded pre-push hook exactly as git would: `sh .githooks/pre-push
 *  <remote> <url>` with one `<local-ref> <local-oid> <remote-ref> <remote-oid>`
 *  line per pushed ref on stdin. */
function runPrePushHook(app: string, remoteUrl: string, stdinLines: string) {
  return spawnSync('sh', ['.githooks/pre-push', 'origin', remoteUrl], {
    cwd: app,
    encoding: 'utf8',
    input: stdinLines,
    env: commandEnv(),
  });
}

test('pre-push hook dogfood: capture→publish→docs-skip→fresh-clone restore by SHA', async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-dogfood-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-dogfood-remote-'));
  const ci = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-dogfood-ci-'));
  const port = await freePort();
  const zero = '0'.repeat(40);
  try {
    writeFixtureApp(app, port);
    writeBinShims(app);
    // Real apps never track node_modules; without this the clone would already
    // carry the committed symlinks and linkNodeModules would EEXIST.
    fs.writeFileSync(path.join(app, '.gitignore'), 'node_modules/\n');
    git(app, ['init', '-q']);
    git(app, ['config', 'user.email', 'styleproof@example.test']);
    git(app, ['config', 'user.name', 'StyleProof Test']);
    git(app, ['checkout', '-qb', 'main']);
    git(remote, ['init', '--bare', '-q']);
    git(app, ['remote', 'add', 'origin', remote]);

    const init = run(app, process.execPath, [INIT, '--base-url', `http://127.0.0.1:${port}`]);
    expect(init.status, init.stderr).toBe(0);
    expect(fs.existsSync(path.join(app, '.githooks/pre-push'))).toBe(true);
    fs.writeFileSync(path.join(app, 'README.md'), '# dogfood\n');
    git(app, ['add', '-A']);
    git(app, ['commit', '-qm', 'app + styleproof setup']);
    const headSha = run(app, 'git', ['rev-parse', 'HEAD']).stdout.trim();

    // 1. First push of the branch (remote oid all-zeros): the docs-only check must
    //    NOT swallow it; the store is empty, so the hook restore misses, captures
    //    for real, and publishes under the pushed SHA.
    const firstPush = runPrePushHook(app, remote, `refs/heads/main ${headSha} refs/heads/main ${zero}\n`);
    expect(firstPush.status, firstPush.stderr + firstPush.stdout).toBe(0);
    expect(firstPush.stderr).toContain(`uploaded ${headSha.slice(0, 12)}`);
    const stored = git(remote, ['ls-tree', '-r', '--name-only', 'styleproof-maps']).stdout;
    expect(stored).toContain(`${headSha}/`);
    expect(stored).toMatch(new RegExp(`${headSha}/[0-9a-f]{16}/index@\\d+\\.json\\.gz`));
    expect(stored).toMatch(new RegExp(`${headSha}/[0-9a-f]{16}/styleproof-manifest\\.json`));

    // 2. Re-run for the same SHA: the SHA-keyed store must serve it back — a
    //    restore HIT, not a second capture (the whole latency win of the flow).
    const rePush = runPrePushHook(app, remote, `refs/heads/main ${headSha} refs/heads/main ${zero}\n`);
    expect(rePush.status, rePush.stderr + rePush.stdout).toBe(0);
    expect(rePush.stdout).toContain(`restored ${headSha.slice(0, 12)}`);
    expect(rePush.stderr).not.toContain('uploaded');

    // 3. A docs-only push (README edit) skips capture entirely and publishes
    //    nothing — CI recaptures on the miss, so skipping is always safe.
    fs.writeFileSync(path.join(app, 'README.md'), '# dogfood (edited)\n');
    git(app, ['add', '-A']);
    git(app, ['commit', '-qm', 'docs: readme']);
    const docsSha = run(app, 'git', ['rev-parse', 'HEAD']).stdout.trim();
    const docsPush = runPrePushHook(app, remote, `refs/heads/main ${docsSha} refs/heads/main ${headSha}\n`);
    expect(docsPush.status, docsPush.stderr + docsPush.stdout).toBe(0);
    expect(docsPush.stderr).toContain('docs-only push');
    expect(git(remote, ['ls-tree', '-r', '--name-only', 'styleproof-maps']).stdout).not.toContain(`${docsSha}/`);

    // 4. The CI side of the contract. Complete what git does after a passing
    //    hook — the push itself — then a FRESH clone (no local maps, no capture)
    //    restores the pushed SHA's bundle from the store branch...
    git(app, ['push', '-q', 'origin', 'main']);
    git(ci, ['clone', '-q', '-b', 'main', remote, 'checkout']);
    const ciApp = path.join(ci, 'checkout');
    linkNodeModules(ciApp);
    const mapRoot = path.join(ci, 'stylemaps');
    const restore = run(ciApp, process.execPath, [
      MAP,
      '--restore',
      '--sha',
      headSha,
      '--dir',
      'head',
      '--base-dir',
      mapRoot,
    ]);
    expect(restore.status, restore.stderr + restore.stdout).toBe(0);
    expect(restore.stdout).toContain(`restored ${headSha.slice(0, 12)}`);

    // ...and the restored bundle diffs CLEAN against what the hook captured —
    // the store roundtrip changed nothing (exit 0, not merely "compatible").
    const diff = run(ciApp, process.execPath, [
      DIFF,
      path.join(app, '.styleproof/maps/current'),
      path.join(mapRoot, 'head'),
    ]);
    expect(diff.status, diff.stderr + diff.stdout).toBe(0);
    expect(diff.stdout).toContain('0 changed surfaces');
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(ci, { recursive: true, force: true });
  }
});
