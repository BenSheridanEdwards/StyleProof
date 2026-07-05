import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadStyleMap } from '../dist/index.js';

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
  for (const key of ['GITHUB_BASE_REF', 'GITHUB_SHA', 'GITHUB_HEAD_SHA']) {
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
