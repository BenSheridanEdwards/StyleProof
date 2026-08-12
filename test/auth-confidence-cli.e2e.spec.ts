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
  try {
    const plainRes = await runCaptureAsync([`${base}/`, ...common, '--out', outPlain]);
    expect(plainRes.status, plainRes.stderr + plainRes.stdout).toBe(0);
    expect(plainRes.stdout).toMatch(/crawl confidence: complete/);

    const wallRes = await runCaptureAsync([`${base}/wall`, ...common, '--out', outWall]);
    expect(wallRes.status, wallRes.stderr + wallRes.stdout).toBe(5);
    expect(wallRes.stdout).toMatch(/incomplete-auth/);
    expect(wallRes.stdout).toMatch(/unacknowledged/);

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
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
