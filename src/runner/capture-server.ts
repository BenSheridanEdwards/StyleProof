import fs from 'node:fs';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

/** Resolve the same explicit config (or default config directory) the Playwright CLI uses. */
export function capturePlaywrightConfig(args: readonly string[], cwd: string): string | undefined {
  let configPath = '.';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' || arg === '-c') configPath = args[++i];
    else if (arg.startsWith('--config=')) configPath = arg.slice('--config='.length);
    else if (arg.startsWith('-c')) configPath = arg.slice(2);
  }
  const location = path.resolve(cwd, configPath);
  if (!fs.existsSync(location)) throw new Error(`Playwright config does not exist: ${location}`);
  if (!fs.statSync(location).isDirectory()) return location;
  return ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs']
    .map((ext) => path.join(location, `playwright.config.${ext}`))
    .find((file) => fs.existsSync(file));
}

/** Translate Playwright's webServer ownership error without exposing URL credentials or query data. */
export function captureServerRefusal(output: string): string | undefined {
  const match = /\b(https?:\/\/\S+) is already used\b/.exec(stripVTControlCharacters(output));
  if (!match) return undefined;
  const address = new URL(match[1]);
  return (
    `a server is already running at ${address.origin}${address.pathname}, so this commit's build would not be the one captured; ` +
    'stop that server or pass --external-server to capture it deliberately. ' +
    'For styleproof ci or the Action, set BASE_URL to opt into that server.'
  );
}
