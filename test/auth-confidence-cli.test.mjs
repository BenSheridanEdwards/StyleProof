import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CAPTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'styleproof-capture.mjs');

/** Async spawn so an in-process HTTP fixture can keep serving (spawnSync blocks the loop). */
function runCaptureAsync(args, { timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CAPTURE, ...args], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
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

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('CLI exit 2: empty auth-boundary exclusion reason', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-auth-cli-ex-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ '/login': '   ' }));
  try {
    const res = spawnSync(
      process.execPath,
      [CAPTURE, 'http://127.0.0.1:9/', '--crawl', '--auth-boundary-exclude', bad],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env },
      },
    );
    assert.equal(res.status, 2, res.stderr + res.stdout);
    assert.match(`${res.stderr}${res.stdout}`, /non-empty reason/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exit 5 password wall; exit 0 plain page; exit 0 with reasoned ack', async () => {
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
    assert.equal(plainRes.status, 0, plainRes.stderr + plainRes.stdout);
    assert.match(plainRes.stdout, /crawl confidence: complete/);

    const wallRes = await runCaptureAsync([`${base}/wall`, ...common, '--out', outWall]);
    assert.equal(wallRes.status, 5, wallRes.stderr + wallRes.stdout);
    assert.match(wallRes.stdout, /incomplete-auth/);
    assert.match(wallRes.stdout, /unacknowledged/);

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
    assert.equal(ackRes.status, 0, ackRes.stderr + ackRes.stdout);
    assert.match(ackRes.stdout, /incomplete-auth/);
    assert.match(ackRes.stdout, /acknowledged/);
    assert.doesNotMatch(ackRes.stdout, /unacknowledged \(fail closed\)/);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
