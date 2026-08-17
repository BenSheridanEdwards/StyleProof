import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Real capture-CLI process exits for auth confidence (issue #390).
 * Must run after Playwright Chromium is installed — not under `npm test`
 * (CI installs the browser only for the e2e step).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const CAPTURE = path.join(root, 'bin', 'styleproof-capture.mjs');
const PLAYWRIGHT_BIN = path.join(root, 'node_modules', '.bin');

function commandEnv(env: NodeJS.ProcessEnv = {}) {
  return {
    ...process.env,
    PATH: `${PLAYWRIGHT_BIN}${path.delimiter}${process.env.PATH ?? ''}`,
    CI: '1',
    ...env,
  };
}

/** Async spawn so an in-process HTTP fixture can keep serving. */
function runCaptureAsync(args: string[], { timeout = 120_000 } = {}) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CAPTURE, ...args], {
      env: commandEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: root,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: 124, stdout, stderr: stderr + '\n[test timeout]' });
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status: status ?? 1, stdout, stderr });
    });
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('expected TCP address');
      resolve(addr.port);
    });
  });
}

test('styleproof-capture --crawl: exit 5 password wall; exit 0 plain; exit 0 reasoned ack', async () => {
  const plain = `<!doctype html><html><head><meta charset="utf-8"><style>.ok{color:blue}</style></head>
<body><main class="ok">hello</main></body></html>`;
  const wall = `<!doctype html><html><head><meta charset="utf-8"><style>.gate{padding:8px}</style></head>
<body><main class="gate"><form action="/login" method="post">
<input id="pw" type="password" autocomplete="current-password" name="pw">
</form></main></body></html>`;

  const server = http.createServer((req, res) => {
    const u = (req.url ?? '/').split('?')[0];
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (u === '/wall') return res.end(wall);
    return res.end(plain);
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-auth-cli-run-'));
  const outPlain = path.join(rootDir, 'plain');
  const outWall = path.join(rootDir, 'wall');
  const outAck = path.join(rootDir, 'ack');
  const exclude = path.join(rootDir, 'exclude.json');
  const common = [
    '--crawl',
    '--no-follow-links',
    '--no-data-states',
    '--workers',
    '1',
    '--max-depth',
    '1',
    '--no-screenshots',
    '--widths',
    '800',
  ];
  // The confidence ledger (#399) must travel with the bundle in every outcome —
  // including the fail-closed exit 5, whose bundle must still state its walls.
  const readLedger = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'styleproof-confidence.json'), 'utf8'));
  try {
    const plainRes = await runCaptureAsync([`${base}/`, ...common, '--out', outPlain]);
    expect(plainRes.status, plainRes.stderr + plainRes.stdout).toBe(0);
    expect(plainRes.stdout).toMatch(/crawl confidence: complete/);
    const plainLedger = readLedger(outPlain);
    expect(plainLedger.basis).toBe('unasserted');
    expect(plainLedger.entries.length).toBeGreaterThan(0);
    expect(plainLedger.entries.every((e: { status: string }) => e.status === 'unproven-determinism')).toBe(true);

    const wallRes = await runCaptureAsync([`${base}/wall`, ...common, '--out', outWall]);
    expect(wallRes.status, wallRes.stderr + wallRes.stdout).toBe(5);
    expect(wallRes.stdout).toMatch(/incomplete-auth/);
    expect(wallRes.stdout).toMatch(/unacknowledged/);
    const wallLedger = readLedger(outWall);
    const inaccessible = wallLedger.entries.filter((e: { status: string }) => e.status === 'inaccessible');
    expect(inaccessible.length).toBeGreaterThan(0);
    expect(inaccessible[0].producer).toBe('auth-boundary');
    expect(inaccessible[0].reason).toMatch(/authentication boundary/);

    const keyMatch = wallRes.stdout.match(/unacknowledged:\s+(\S+)/);
    const key = keyMatch ? keyMatch[1].replace(/\($/, '') : '/wall';
    fs.writeFileSync(
      exclude,
      JSON.stringify({
        [key]: 'fixture password wall outside certification scope',
        '/wall': 'fixture password wall outside certification scope',
        '/wall·password-input': 'fixture password wall outside certification scope',
      }),
    );

    const ackRes = await runCaptureAsync([
      `${base}/wall`,
      ...common,
      '--out',
      outAck,
      '--auth-boundary-exclude',
      exclude,
    ]);
    expect(ackRes.status, ackRes.stderr + ackRes.stdout).toBe(0);
    expect(ackRes.stdout).toMatch(/incomplete-auth/);
    expect(ackRes.stdout).toMatch(/acknowledged/);
    expect(ackRes.stdout).not.toMatch(/unacknowledged \(fail closed\)/);
    const ackLedger = readLedger(outAck);
    const excluded = ackLedger.entries.filter((e: { status: string }) => e.status === 'excluded-with-reason');
    expect(excluded.length).toBeGreaterThan(0);
    expect(excluded[0].producer).toBe('auth-boundary');
    expect(excluded[0].reason).toMatch(/outside certification scope/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('styleproof-capture --crawl ignores stale maps when reusing an output directory', async () => {
  const html = '<!doctype html><main>fresh</main>';
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  const port = await listen(server);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-crawl-reuse-'));
  const userFile = path.join(out, 'notes.txt');
  try {
    fs.writeFileSync(path.join(out, 'old@800.json'), '{}');
    fs.writeFileSync(userFile, 'keep this user file');
    const result = await runCaptureAsync([
      `http://127.0.0.1:${port}/`,
      '--crawl',
      '--no-follow-links',
      '--no-data-states',
      '--workers',
      '1',
      '--max-depth',
      '1',
      '--no-screenshots',
      '--widths',
      '800',
      '--out',
      out,
    ]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const ledger = JSON.parse(fs.readFileSync(path.join(out, 'styleproof-confidence.json'), 'utf8'));
    expect(ledger.entries.map((entry: { surface: string }) => entry.surface)).toEqual(['base']);
    expect(fs.readFileSync(userFile, 'utf8')).toBe('keep this user file');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('styleproof-capture plain URL clears stale crawl artifacts from a reused output directory', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<main>plain</main>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-plain-reuse-'));
  try {
    fs.writeFileSync(path.join(out, 'old@800.json'), '{}');
    fs.writeFileSync(
      path.join(out, 'styleproof-confidence.json'),
      JSON.stringify({
        version: 1,
        basis: 'asserted',
        entries: [{ surface: 'old', status: 'captured', producer: 'capture' }],
      }),
    );

    const result = await runCaptureAsync([
      `http://127.0.0.1:${addr.port}/`,
      '--widths',
      '800',
      '--no-screenshots',
      '--out',
      out,
    ]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(fs.existsSync(path.join(out, 'old@800.json'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'styleproof-confidence.json'))).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('styleproof-capture --crawl records linked pages left queued by --max-states', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      req.url === '/secret'
        ? '<!doctype html><main>secret</main>'
        : '<!doctype html><main>home <a href="/secret">Secret</a></main>',
    );
  });
  const port = await listen(server);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-crawl-max-states-confidence-'));
  try {
    const result = await runCaptureAsync([
      `http://127.0.0.1:${port}/`,
      '--crawl',
      '--no-data-states',
      '--workers',
      '1',
      '--max-depth',
      '1',
      '--max-states',
      '1',
      '--no-screenshots',
      '--widths',
      '800',
      '--out',
      out,
    ]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toMatch(/--max-states reached: 1 linked page\(s\) left uncrawled/);
    expect(result.stdout).not.toMatch(/crawl confidence: complete/);
    expect(result.stdout).toMatch(/crawl confidence: incomplete-unknown/);
    const ledger = JSON.parse(fs.readFileSync(path.join(out, 'styleproof-confidence.json'), 'utf8'));
    expect(ledger.entries).toContainEqual({
      surface: 'page:secret',
      status: 'unknown',
      producer: 'capture',
      reason: 'linked page was discovered but left uncrawled because --max-states was reached',
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('styleproof-capture --until-covered keeps discovered-but-uncaptured surfaces in confidence', async () => {
  const html = `<!doctype html><style>
    .base { color: rgb(1, 2, 3) }
    .panel { display: block }
    .trigger { padding: 4px }
  </style><body class="base"><main class="panel">
    <button class="trigger" type="button"
      onclick="document.querySelector('main').append(document.createElement('section'))">Open</button>
  </main></body>`;
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  const port = await listen(server);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-until-covered-confidence-'));
  try {
    const result = await runCaptureAsync([
      `http://127.0.0.1:${port}/`,
      '--crawl',
      '--until-covered',
      '--no-follow-links',
      '--no-data-states',
      '--workers',
      '1',
      '--max-depth',
      '1',
      '--no-screenshots',
      '--widths',
      '800',
      '--out',
      out,
    ]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toMatch(/1\/2 surface\(s\)/);
    const ledger = JSON.parse(fs.readFileSync(path.join(out, 'styleproof-confidence.json'), 'utf8'));
    expect(ledger.entries).toEqual([
      {
        surface: 'base',
        status: 'unproven-determinism',
        producer: 'determinism',
        reason: 'captured without self-check or replay — the styles could have drifted unnoticed',
      },
      {
        surface: 'open',
        status: 'unknown',
        producer: 'capture',
        reason: 'crawl stopped before this discovered surface was captured',
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(out, { recursive: true, force: true });
  }
});
