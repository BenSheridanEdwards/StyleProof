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
  for (const key of ['GITHUB_BASE_REF', 'GITHUB_SHA', 'GITHUB_HEAD_SHA']) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) delete merged[key];
  }
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
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-cli-flow-remote-'));
    git(remote, ['init', '--bare', '-q']);
    git(app, ['remote', 'add', 'origin', remote]);

    const init = run(app, process.execPath, [INIT, '--base-url', `http://127.0.0.1:${port}`]);
    expect(init.status, init.stderr).toBe(0);
    expect(init.stdout).toContain('created e2e/styleproof.spec.ts');
    git(app, ['add', '-A']);
    git(app, ['commit', '-qm', 'styleproof setup']);

    const baseMap = run(app, process.execPath, [MAP], { STYLEPROOF_UPLOAD: '1' });
    expect(baseMap.status, baseMap.stderr + baseMap.stdout).toBe(0);
    expect(
      fs.readdirSync(path.join(app, '.styleproof/maps/current')).some((file) => /^home@\d+\.json\.gz$/.test(file)),
    ).toBe(true);

    git(app, ['checkout', '-qb', 'feature']);
    fs.writeFileSync(path.join(app, 'feature.txt'), 'feature');
    git(app, ['add', '-A']);
    git(app, ['commit', '-qm', 'feature']);

    const headMap = run(app, process.execPath, [MAP], { STYLEPROOF_UPLOAD: '1' });
    expect(headMap.status, headMap.stderr + headMap.stdout).toBe(0);

    const diff = run(app, process.execPath, [DIFF]);
    expect(diff.status, diff.stderr + diff.stdout).toBe(0);
    expect(diff.stdout).toContain('0 changed surfaces across 1 captured surface(s)');
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});

test('styleproof-capture --crawl --require-full-coverage: exit 0 when covered, exit 4 on residue', async () => {
  const CAPTURE = path.join(root, 'bin/styleproof-capture.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-cov-cli-'));
  const covered = path.join(dir, 'covered.html');
  const withDead = path.join(dir, 'dead.html');
  const page = (extraCss: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; } .card { padding: 20px; background: rgb(240,240,245); }
      .modal { display: none; position: fixed; inset: 20% 25%; background: rgb(250,250,255); }
      .modal.open { display: block; } ${extraCss}
      button { cursor: pointer; }
    </style></head><body>
      <main class="card"><button id="open">Open</button></main>
      <div class="modal" id="m">modal content</div>
      <script>document.getElementById('open').onclick = () => document.getElementById('m').classList.add('open');</script>
    </body></html>`;
  fs.writeFileSync(covered, page(''));
  fs.writeFileSync(withDead, page('.ghost { color: rgb(9,9,9); }'));
  try {
    const ok = run(dir, 'node', [
      CAPTURE,
      'file://' + covered,
      '--crawl',
      '--no-screenshots',
      '--out',
      path.join(dir, 'a'),
      '--require-full-coverage',
    ]);
    expect(ok.stdout).toContain('✓ coverage: all');
    expect(ok.status, 'fully covered page exits 0').toBe(0);

    const gap = run(dir, 'node', [
      CAPTURE,
      'file://' + withDead,
      '--crawl',
      '--no-screenshots',
      '--out',
      path.join(dir, 'b'),
      '--require-full-coverage',
    ]);
    expect(gap.stdout).toContain('ghost');
    expect(gap.status, 'coverage residue exits 4').toBe(4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
