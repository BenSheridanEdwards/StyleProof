import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { watchBrowserProgress } from '../dist/browser-stall.js';
import { childTimeoutError } from './helpers.mjs';

// Chrome can stay alive yet stop answering: a frozen renderer, or a page script that never yields.
// page.evaluate has no timeout, so styleproof-capture used to wait forever with Chrome as its child.
// The stall deadline fails the run closed with exit 3 instead.
test.describe.configure({ mode: 'parallel' });

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURE = path.join(root, 'bin/styleproof-capture.mjs');
// Longer than a browser launch on a loaded runner; every freeze below happens after launch.
const STALL_MS = 20_000;
// A stalled browser holds the event loop open, so exitWhenDrained's forced exit ends the run.
const FORCED_EXIT_MS = 10_000;
// Kill bound for the CLI itself: hitting it means the stall deadline did not end the run.
const HARD_BOUND_MS = 100_000;
const STALL_MESSAGE = `styleproof-capture: capture failed: the browser stopped responding: no progress for ${STALL_MS / 1000}s`;

// One button: the crawl captures `base`, then clicks the button in-page and settles.
const pageWithButton = (onclick: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; } .card { padding: 20px; background: rgb(240,240,245); }
    .modal { display: none; } .modal.open { display: block; }
  </style></head><body>
    <main class="card"><button id="open">Open</button></main>
    <div class="modal" id="m">modal content</div>
    <script>document.getElementById('open').onclick = () => { ${onclick} };</script>
  </body></html>`;

type CaptureRun = { status: number | null; stdout: string; stderr: string; stalledAt: number; endedAt: number };

function runCrawl(dir: string, url: string, onSpawn: (pid: number) => void = () => {}): Promise<CaptureRun> {
  const args = [CAPTURE, url, '--crawl', '--no-screenshots', '--out', path.join(dir, 'out')];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: dir,
      env: { ...process.env, STYLEPROOF_STALL_TIMEOUT_MS: String(STALL_MS) },
    });
    onSpawn(child.pid ?? 0);
    let stdout = '';
    let stderr = '';
    let stalledAt = 0;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stalledAt === 0 && stderr.includes('stopped responding')) stalledAt = Date.now();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(childTimeoutError(process.execPath, args, HARD_BOUND_MS, stdout + stderr));
    }, HARD_BOUND_MS);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, stalledAt, endedAt: Date.now() });
    });
  });
}

/** Every process below `rootPid` (POSIX ps). */
function descendants(rootPid: number): { pid: number; command: string }[] {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
  const found: { pid: number; command: string }[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const row of rows.filter((r) => r.ppid === parent)) {
      found.push(row);
      queue.push(row.pid);
    }
  }
  return found;
}

/** A killed process can linger as a zombie until it is reaped; that is not alive. */
function isAlive(pid: number): boolean {
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const stat = ps.stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
}

/** Cleanup after a failure: a SIGKILLed CLI leaves its stopped Chrome behind. Already gone is fine. */
function killAll(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already exited */
    }
  }
}

test('styleproof-capture --crawl exits 3, named, when the renderer freezes mid-crawl', async () => {
  test.skip(process.platform === 'win32', 'SIGSTOP is POSIX-only');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-stall-renderer-'));
  let cliPid = 0;
  let chrome: { pid: number; command: string }[] = [];
  let frozen: { pid: number; command: string }[] = [];
  let frozenAt = 0;
  // The click pings /freeze, and the test stops every renderer right then: the browser process
  // stays alive and answering while the crawl settles the click with page.evaluate, which the
  // frozen page never answers. Without the deadline that evaluate waits forever.
  const html = pageWithButton("fetch('/freeze'); document.getElementById('m').classList.add('open');");
  const server = http.createServer((req, res) => {
    if (req.url === '/freeze' && frozenAt === 0) {
      frozenAt = Date.now();
      chrome = descendants(cliPid);
      frozen = chrome.filter((p) => p.command.includes('--type=renderer'));
      for (const p of frozen) process.kill(p.pid, 'SIGSTOP');
    }
    res.writeHead(req.url === '/' ? 200 : 204, { 'content-type': 'text/html' });
    res.end(req.url === '/' ? html : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const result = await runCrawl(dir, url, (pid) => (cliPid = pid));
    expect(frozen.length, `no renderer to freeze; output: ${result.stdout}${result.stderr}`).toBeGreaterThan(0);
    expect(result.stdout, 'the crawl captured base before it clicked').toContain('base (');
    expect(result.stderr).toContain(STALL_MESSAGE);
    expect(result.status, result.stdout + result.stderr).toBe(3);
    // The deadline runs from the last call the browser answered, which is at the freeze.
    expect(result.stalledAt - frozenAt).toBeGreaterThanOrEqual(STALL_MS - 1_000);
    expect(result.stalledAt - frozenAt).toBeLessThan(STALL_MS + 5_000);
    expect(result.endedAt - result.stalledAt).toBeLessThan(FORCED_EXIT_MS + 5_000);
    // The CLI's exit takes the frozen browser with it: no orphaned, stopped renderer is left behind.
    await expect.poll(() => frozen.filter((p) => isAlive(p.pid)).map((p) => p.pid), { timeout: 5_000 }).toEqual([]);
  } finally {
    killAll(chrome.filter((p) => isAlive(p.pid)).map((p) => p.pid));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('styleproof-capture --crawl exits 3, named, when a page script never yields', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-stall-script-'));
  try {
    // The crawl clicks in-page, so the click itself runs the endless loop on the renderer's main thread.
    const page = path.join(dir, 'page.html');
    fs.writeFileSync(page, pageWithButton('for (;;) {}'));
    const result = await runCrawl(dir, 'file://' + page);
    expect(result.stdout, 'the crawl captured base before it clicked').toContain('base (');
    expect(result.stderr).toContain(STALL_MESSAGE);
    expect(result.status, result.stdout + result.stderr).toBe(3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The deadline counts Playwright's own report of each call the browser answered. If that report
// stopped arriving, every run longer than the deadline would fail: this pins it on a real browser.
test('a run that outlasts the stall deadline is not capped while the browser keeps answering', async () => {
  const watch = watchBrowserProgress(1_500);
  const browser = await chromium.launch({ logger: watch.logger });
  try {
    const page = await browser.newPage();
    const started = Date.now();
    const answered = await watch.race(
      (async () => {
        let calls = 0;
        while (Date.now() - started < 4_500) {
          calls += await page.evaluate(() => 1);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return calls;
      })(),
    );
    expect(answered).toBeGreaterThan(10);
    await expect(watch.race(page.evaluate(() => new Promise(() => {})))).rejects.toThrow(
      'the browser stopped responding: no progress for 1.5s',
    );
  } finally {
    await browser.close();
  }
});
