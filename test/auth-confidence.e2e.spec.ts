import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { crawlAndCapture } from '../dist/crawl-surfaces.js';
import { loadSetupSteps } from '../dist/capture-url.js';

/**
 * Protected-route / auth-boundary confidence (issue #390).
 * Unauthenticated crawl must report incomplete-auth and block.
 * Environment-backed setup unlocks the protected surface and clears the wall
 * when the gate leaves the DOM (realistic post-login navigation).
 * Auth is re-observed on every newly recorded crawl state (late-mounted gates).
 * Intermediate HTTP auth redirects are dropped only when setup leaves the wall.
 */

const baseOpts = (url: string, out: string) => ({
  url,
  out,
  ignore: [] as string[],
  widths: [900],
  height: 700,
  screenshots: false,
  maxDepth: 8,
  maxActionsPerState: 50,
  maxStates: 20,
  resetStorage: true,
  dataStates: false,
  workers: 1,
});

const GATE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: sans-serif; }
    .gate { padding: 20px; background: rgb(240,240,245); }
    .vault { display: none; padding: 20px; background: rgb(220,245,220); }
    .vault.open { display: block; }
    .vault-detail { display: none; background: rgb(200,235,200); padding: 10px; }
    .vault-detail.open { display: block; }
    button { cursor: pointer; }
  </style></head><body>
    <main class="gate" id="gate">
      <form action="/auth/login" method="post">
        <input id="user" type="text" autocomplete="username" name="user">
        <input id="pw" type="password" autocomplete="current-password" name="pw">
        <button type="button" id="unlock">Sign in</button>
      </form>
    </main>
    <div class="vault" id="v">
      vault content
      <button id="more">Show detail</button>
      <div class="vault-detail" id="vd">detail panel</div>
    </div>
    <script>
      document.getElementById('unlock').onclick = () => {
        if (document.getElementById('pw').value === 'open-sesame') {
          document.getElementById('gate').remove();
          document.getElementById('v').classList.add('open');
        }
      };
      document.getElementById('more').onclick = () => document.getElementById('vd').classList.add('open');
    </script>
  </body></html>`;

test('unauthenticated protected page → incomplete-auth blocked; env setup clears wall and reaches vault', async ({
  page,
}) => {
  const file = path.join(os.tmpdir(), `styleproof-auth-conf-${Math.random().toString(36).slice(2)}.html`);
  const setupFile = path.join(os.tmpdir(), `styleproof-auth-setup-${Math.random().toString(36).slice(2)}.json`);
  const outBlind = path.join(os.tmpdir(), `styleproof-auth-blind-${Math.random().toString(36).slice(2)}`);
  const outSetup = path.join(os.tmpdir(), `styleproof-auth-setup-out-${Math.random().toString(36).slice(2)}`);
  const outExclude = path.join(os.tmpdir(), `styleproof-auth-ex-${Math.random().toString(36).slice(2)}`);
  const secret = 'open-sesame';
  fs.writeFileSync(file, GATE_HTML);
  // Environment-backed setup: secret lives in env, not the setup file or maps.
  fs.writeFileSync(
    setupFile,
    JSON.stringify([
      { action: 'fill', selector: '#pw', value: '${AUTH_E2E_PASS}' },
      { action: 'click', selector: '#unlock' },
      { action: 'waitFor', selector: '.vault.open' },
    ]),
  );
  const url = 'file://' + file;
  try {
    const blind = await crawlAndCapture(page, baseOpts(url, outBlind));
    expect(blind.confidence.status).toBe('incomplete-auth');
    expect(blind.confidence.blocked).toBe(true);
    expect(blind.confidence.certifiesFully).toBe(false);
    expect(blind.confidence.unacknowledged.length).toBeGreaterThan(0);
    const blob = JSON.stringify(blind.confidence);
    expect(blob).not.toContain(secret);
    expect(blob).not.toMatch(/value["']?\s*:/);
    // Protected classes remain unreachable without setup.
    expect(blind.coverage.missing).toEqual(expect.arrayContaining(['open']));

    const setupRaw = fs.readFileSync(setupFile, 'utf8');
    expect(setupRaw).toContain('${AUTH_E2E_PASS}');
    expect(setupRaw).not.toContain(secret);
    const steps = loadSetupSteps(setupFile, { AUTH_E2E_PASS: secret });
    expect(steps.some((s) => s.value === secret)).toBe(true);

    const unlocked = await crawlAndCapture(page, { ...baseOpts(url, outSetup), setup: steps });
    expect(unlocked.confidence.status).toBe('complete');
    expect(unlocked.confidence.blocked).toBe(false);
    expect(unlocked.confidence.certifiesFully).toBe(true);
    expect(unlocked.confidence.authBoundaries).toEqual([]);
    // Protected vault surface is reached (class "open" rendered).
    expect(unlocked.coverage.renderedClasses).toEqual(expect.arrayContaining(['open', 'vault']));
    expect(
      unlocked.surfaces.some((s) => s.key.includes('detail')),
      'nested control behind the gate crawled after setup',
    ).toBe(true);
    // Serialized confidence / log-relevant structures must never contain the secret.
    const unlockedBlob = JSON.stringify({
      confidence: unlocked.confidence,
      surfaces: unlocked.surfaces,
      coverage: unlocked.coverage,
    });
    expect(unlockedBlob).not.toContain(secret);
    // Setup file on disk still has only the env reference.
    expect(fs.readFileSync(setupFile, 'utf8')).not.toContain(secret);

    // Reasoned exclusion: still incomplete-auth (not full certification) but not blocked.
    const limited = await crawlAndCapture(page, {
      ...baseOpts(url, outExclude),
      authBoundaryExclude: {
        // file:// pages redact to a path; match by diagnostic reason suffix via full keys seen in blind
        ...Object.fromEntries(
          blind.confidence.unacknowledged.map((u) => [u.key, 'fixture login wall outside certification scope']),
        ),
      },
    });
    expect(limited.confidence.status).toBe('incomplete-auth');
    expect(limited.confidence.blocked).toBe(false);
    expect(limited.confidence.certifiesFully).toBe(false);
    expect(limited.confidence.acknowledged.length).toBeGreaterThan(0);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(setupFile, { force: true });
    fs.rmSync(outBlind, { recursive: true, force: true });
    fs.rmSync(outSetup, { recursive: true, force: true });
    fs.rmSync(outExclude, { recursive: true, force: true });
  }
});

test('late-mounted password form during crawl → incomplete-auth blocked', async ({ page }) => {
  // Entry has no auth wall; clicking "Sign in" mounts a password form.
  // Entry-only observation would false-complete — must re-observe on new states.
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font-family: sans-serif; }
    .home { padding: 20px; background: rgb(250,250,250); }
    .auth-panel { display: none; padding: 20px; background: rgb(240,240,245); }
    .auth-panel.open { display: block; }
    button { cursor: pointer; }
  </style></head><body>
    <main class="home" id="home">
      <h1>Welcome</h1>
      <button id="open-auth" type="button">Sign in</button>
    </main>
    <div class="auth-panel" id="auth">
      <form action="/auth/login" method="post">
        <input id="user" type="text" autocomplete="username" name="user">
        <input id="pw" type="password" autocomplete="current-password" name="pw">
        <button type="button" id="submit">Submit</button>
      </form>
    </div>
    <script>
      document.getElementById('open-auth').onclick = () => {
        document.getElementById('auth').classList.add('open');
      };
    </script>
  </body></html>`;
  const file = path.join(os.tmpdir(), `styleproof-auth-late-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-auth-late-out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, html);
  const url = 'file://' + file;
  try {
    const report = await crawlAndCapture(page, baseOpts(url, out));
    expect(report.confidence.status).toBe('incomplete-auth');
    expect(report.confidence.blocked).toBe(true);
    expect(report.confidence.certifiesFully).toBe(false);
    expect(report.confidence.unacknowledged.length).toBeGreaterThan(0);
    const reasons = report.confidence.authBoundaries.flatMap((b) => b.diagnostics.map((d) => d.reason));
    expect(reasons).toEqual(expect.arrayContaining(['password-input']));
    expect(JSON.stringify(report.confidence)).not.toMatch(/value["']?\s*:/);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

test('HTTP auth redirect without setup stays incomplete-auth; setup drops sticky redirect', async ({ page }) => {
  const secret = 'open-sesame';
  const loginBody = `<!doctype html><html><head><meta charset="utf-8"><style>
    .gate { padding: 16px; background: rgb(240,240,245); }
    .vault { display: none; padding: 16px; background: rgb(220,245,220); }
    .vault.open { display: block; }
    button { cursor: pointer; }
  </style></head><body>
    <main class="gate" id="gate">
      <form action="/login" method="post">
        <input id="pw" type="password" autocomplete="current-password" name="pw">
        <button type="button" id="unlock">Sign in</button>
      </form>
    </main>
    <div class="vault" id="v">vault after login</div>
    <script>
      document.getElementById('unlock').onclick = () => {
        if (document.getElementById('pw').value === '${secret}') {
          document.getElementById('gate').remove();
          document.getElementById('v').classList.add('open');
          history.replaceState(null, '', '/vault');
        }
      };
    </script>
  </body></html>`;

  const server = http.createServer((req, res) => {
    const u = (req.url ?? '/').split('?')[0];
    if (u === '/protected') {
      res.statusCode = 302;
      res.setHeader('location', '/login');
      res.end();
      return;
    }
    if (u === '/login' || u === '/vault') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(loginBody);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const setupFile = path.join(os.tmpdir(), `styleproof-auth-redir-setup-${Math.random().toString(36).slice(2)}.json`);
  const outBlind = path.join(os.tmpdir(), `styleproof-auth-redir-blind-${Math.random().toString(36).slice(2)}`);
  const outSetup = path.join(os.tmpdir(), `styleproof-auth-redir-setup-out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(
    setupFile,
    JSON.stringify([
      { action: 'fill', selector: '#pw', value: '${AUTH_E2E_PASS}' },
      { action: 'click', selector: '#unlock' },
      { action: 'waitFor', selector: '.vault.open' },
    ]),
  );
  try {
    const blind = await crawlAndCapture(page, baseOpts(`${base}/protected`, outBlind));
    expect(blind.confidence.status).toBe('incomplete-auth');
    expect(blind.confidence.blocked).toBe(true);
    const reasons = blind.confidence.authBoundaries.flatMap((b) => b.diagnostics.map((d) => d.reason));
    expect(reasons).toEqual(expect.arrayContaining(['auth-route-redirect']));
    expect(JSON.stringify(blind.confidence)).not.toContain(secret);

    const steps = loadSetupSteps(setupFile, { AUTH_E2E_PASS: secret });
    const unlocked = await crawlAndCapture(page, {
      ...baseOpts(`${base}/protected`, outSetup),
      setup: steps,
    });
    // Setup left the auth boundary: intermediate redirect must not sticky.
    expect(unlocked.confidence.status).toBe('complete');
    expect(unlocked.confidence.blocked).toBe(false);
    expect(unlocked.confidence.certifiesFully).toBe(true);
    expect(unlocked.confidence.authBoundaries).toEqual([]);
    expect(unlocked.coverage.renderedClasses).toEqual(expect.arrayContaining(['open', 'vault']));
    const blob = JSON.stringify(unlocked.confidence);
    expect(blob).not.toContain(secret);
    expect(blob).not.toMatch(/auth-route-redirect/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(setupFile, { force: true });
    fs.rmSync(outBlind, { recursive: true, force: true });
    fs.rmSync(outSetup, { recursive: true, force: true });
  }
});
