import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { loadSetupSteps } from '../dist/capture-url.js';
import { runSetup } from '../dist/crawl/page.js';
import { applyStateRecipe } from '../dist/state-recipes.js';

const TOKEN = 'sp-secret-token-1144';

test('a failed setup step does not leak an interpolated secret from its url', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-1144-'));
  try {
    const file = path.join(dir, 'setup.json');
    fs.writeFileSync(file, JSON.stringify([{ action: 'goto', url: 'https://app.example/login?token=${SP_TOKEN}' }]));
    const steps = loadSetupSteps(file, { SP_TOKEN: TOKEN });
    const page = {
      goto: async (url: string) => {
        throw new Error(`page.goto: net::ERR_CONNECTION_REFUSED at ${url}`);
      },
    };
    const error = await runSetup(page as never, steps).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(inspect(error, { depth: 5 })).not.toContain(TOKEN);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused state recipe does not put the live page label in its error', async ({ browser }) => {
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.setContent('<button id="danger">Delete account for alice@example.com</button>');
    const error = await applyStateRecipe(page, { action: 'hover', selector: '#danger', stateKey: 'danger' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain('alice@example.com');
  } finally {
    await ctx.close();
  }
});
