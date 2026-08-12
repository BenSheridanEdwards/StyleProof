import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crawlAndCapture } from '../dist/crawl-surfaces.js';

/**
 * Protected-route / auth-boundary confidence (issue #390).
 * Unauthenticated crawl must report incomplete-auth and block.
 * Environment-backed setup unlocks the protected surface and clears the wall
 * when the gate leaves the DOM (realistic post-login navigation).
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

test('unauthenticated protected page → incomplete-auth blocked; setup clears wall and reaches vault', async ({
  page,
}) => {
  // Gate removes itself after a correct unlock so the landed state is no longer
  // an auth wall (mirrors a real login → app navigation).
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
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
  const file = path.join(os.tmpdir(), `styleproof-auth-conf-${Math.random().toString(36).slice(2)}.html`);
  const outBlind = path.join(os.tmpdir(), `styleproof-auth-blind-${Math.random().toString(36).slice(2)}`);
  const outSetup = path.join(os.tmpdir(), `styleproof-auth-setup-${Math.random().toString(36).slice(2)}`);
  const outExclude = path.join(os.tmpdir(), `styleproof-auth-ex-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, html);
  const url = 'file://' + file;
  try {
    const blind = await crawlAndCapture(page, baseOpts(url, outBlind));
    expect(blind.confidence.status).toBe('incomplete-auth');
    expect(blind.confidence.blocked).toBe(true);
    expect(blind.confidence.certifiesFully).toBe(false);
    expect(blind.confidence.unacknowledged.length).toBeGreaterThan(0);
    const blob = JSON.stringify(blind.confidence);
    expect(blob).not.toContain('open-sesame');
    expect(blob).not.toMatch(/value["']?\s*:/);
    // Protected classes remain unreachable without setup.
    expect(blind.coverage.missing).toEqual(expect.arrayContaining(['open']));

    const steps = [
      { action: 'fill' as const, selector: '#pw', value: 'open-sesame' },
      { action: 'click' as const, selector: '#unlock' },
      { action: 'waitFor' as const, selector: '.vault.open' },
    ];
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
    fs.rmSync(outBlind, { recursive: true, force: true });
    fs.rmSync(outSetup, { recursive: true, force: true });
    fs.rmSync(outExclude, { recursive: true, force: true });
  }
});
