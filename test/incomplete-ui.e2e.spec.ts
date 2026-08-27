import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crawlAndCapture } from '../dist/crawl-surfaces.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const captureCli = path.join(root, 'bin', 'styleproof-capture.mjs');

function runCapture(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [captureCli, ...args], {
      cwd: root,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.on('close', (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

const baseOpts = (url: string, out: string) => ({
  url,
  out,
  ignore: [] as string[],
  widths: [720],
  height: 700,
  screenshots: false,
  maxDepth: 4,
  maxActionsPerState: 20,
  maxStates: 10,
  resetStorage: true,
  dataStates: false,
  workers: 1,
});

const BLOCKED_UI_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font-family: sans-serif; }
  main { padding: 20px; }
  form { display: grid; gap: 8px; }
  details { margin-top: 16px; }
</style></head><body><main>
  <form id="contact">
    <label>Email <input id="email" type="email" required></label>
    <button id="send" type="submit" disabled>Send</button>
    <button id="css-blocked" type="button" style="pointer-events:none">Continue</button>
    </form>
  <details id="faq"><summary>Questions</summary><p>Hidden answer</p></details>
  <form id="hidden-form" style="display:none"><input required><button disabled>Hidden</button></form>
</main></body></html>`;

test('crawl names privacy-safe incomplete UI on a non-auth form', async ({ page }) => {
  const fixturePath = path.join(os.tmpdir(), `styleproof-incomplete-ui-${Math.random().toString(36).slice(2)}.html`);
  const out = path.join(os.tmpdir(), `styleproof-incomplete-ui-out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(fixturePath, BLOCKED_UI_HTML);
  try {
    const report = await crawlAndCapture(page, baseOpts(pathToFileURL(fixturePath).href, out));
    expect(report.incompleteUi).toEqual([
      {
        surface: 'base',
        diagnostics: expect.arrayContaining([
          { kind: 'form', reason: 'form-present', selector: '#contact' },
          { kind: 'required-empty', reason: 'required-input-empty', selector: '#email' },
          { kind: 'blocked-control', reason: 'disabled-control', selector: '#send' },
          { kind: 'blocked-control', reason: 'pointer-events-none', selector: '#css-blocked' },
          { kind: 'closed-disclosure', reason: 'details-closed', selector: '#faq' },
        ]),
      },
    ]);
    const serialized = JSON.stringify(report.incompleteUi);
    expect(serialized).not.toContain('Hidden answer');
    expect(serialized).not.toContain('hidden-form');
    expect(serialized).not.toMatch(/"value"|"text"/);
  } finally {
    fs.rmSync(fixturePath, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('capture CLI persists incomplete UI and fails closed', async () => {
  const fixturePath = path.join(
    os.tmpdir(),
    `styleproof-incomplete-ui-cli-${Math.random().toString(36).slice(2)}.html`,
  );
  const out = path.join(os.tmpdir(), `styleproof-incomplete-ui-cli-out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(fixturePath, BLOCKED_UI_HTML);
  try {
    const result = await runCapture([
      pathToFileURL(fixturePath).href,
      '--crawl',
      '--no-follow-links',
      '--no-data-states',
      '--workers',
      '1',
      '--max-depth',
      '1',
      '--no-screenshots',
      '--widths',
      '720',
      '--out',
      out,
    ]);
    expect(result.status).toBe(6);
    expect(result.stdout).toContain('incomplete UI');
    const ledger = JSON.parse(fs.readFileSync(path.join(out, 'styleproof-confidence.json'), 'utf8'));
    expect(ledger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: 'base·incomplete-ui',
          status: 'inaccessible',
          producer: 'incomplete-ui',
        }),
      ]),
    );
    expect(JSON.stringify(ledger)).not.toContain('Hidden answer');
  } finally {
    fs.rmSync(fixturePath, { force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('reasoned incomplete-UI exclusion keeps scope limited without blocking', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-incomplete-ui-exclude-'));
  const fixturePath = path.join(rootDir, 'page.html');
  const out = path.join(rootDir, 'maps');
  const exclude = path.join(rootDir, 'exclude.json');
  fs.writeFileSync(fixturePath, BLOCKED_UI_HTML);
  fs.writeFileSync(exclude, JSON.stringify({ base: 'Contact workflow is outside this certification scope.' }));
  try {
    const result = await runCapture([
      pathToFileURL(fixturePath).href,
      '--crawl',
      '--no-follow-links',
      '--no-data-states',
      '--workers',
      '1',
      '--max-depth',
      '1',
      '--no-screenshots',
      '--widths',
      '720',
      '--incomplete-ui-exclude',
      exclude,
      '--out',
      out,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('scope explicitly limited');
    const ledger = JSON.parse(fs.readFileSync(path.join(out, 'styleproof-confidence.json'), 'utf8'));
    expect(ledger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: 'base·incomplete-ui',
          status: 'excluded-with-reason',
          producer: 'incomplete-ui',
          reason: 'Contact workflow is outside this certification scope.',
        }),
      ]),
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
