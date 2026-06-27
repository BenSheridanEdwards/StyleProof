import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
  if (!Object.prototype.hasOwnProperty.call(env, 'GITHUB_BASE_REF')) delete merged.GITHUB_BASE_REF;
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

    const init = run(app, process.execPath, [INIT, '--base-url', `http://127.0.0.1:${port}`]);
    expect(init.status, init.stderr).toBe(0);
    expect(init.stdout).toContain('created e2e/styleproof.spec.ts');

    const baseMap = run(app, process.execPath, [MAP]);
    expect(baseMap.status, baseMap.stderr + baseMap.stdout).toBe(0);
    expect(fs.readdirSync(path.join(app, 'stylemaps/current')).some((file) => /^home@\d+\.json\.gz$/.test(file))).toBe(
      true,
    );

    git(app, ['add', '-A']);
    git(app, ['commit', '-qm', 'base maps']);
    git(app, ['checkout', '-qb', 'feature']);

    const headMap = run(app, process.execPath, [MAP]);
    expect(headMap.status, headMap.stderr + headMap.stdout).toBe(0);

    const diff = run(app, process.execPath, [DIFF]);
    expect(diff.status, diff.stderr + diff.stdout).toBe(0);
    expect(diff.stdout).toContain('0 changed surfaces across 1 captured surface(s)');
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});
