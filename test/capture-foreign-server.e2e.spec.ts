import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { loadStyleMap } from '../dist/index.js';
import { spawnSyncToCompletion } from './helpers.mjs';
import { nodeTestEnv } from '../scripts/run-node-test.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const CLI = path.join(root, 'bin/styleproof.mjs');
const PLAYWRIGHT_BIN = path.join(root, 'node_modules/.bin');

// Ports are handed to child processes/servers only AFTER this returns, so the
// obvious "bind :0, close, reuse the number" probe races the other workers under
// `workers: '100%'` — a sibling can grab the port inside the close→rebind window
// (a rare, unreproducible e2e flake). Instead each worker owns a DISJOINT range
// keyed by Playwright's TEST_PARALLEL_INDEX and hands out sequential candidates,
// binding each once only to skip ports held by unrelated processes. No two
// workers ever probe the same port, so the close→rebind window cannot race.
// The ranges also sit below every OS's ephemeral port range (Linux starts at
// 32768, macOS and Windows at 49152). Inside it, the OS can hand a probed port to
// any outgoing connection or listen(0) before the child server binds it (#798).
const EPHEMERAL_PORT_FLOOR = 32768;
const PORTS_PER_WORKER = 200;
const WORKER_PORT_BASE =
  Number(process.env.STYLEPROOF_E2E_PORT_BASE ?? 29200) +
  Number(process.env.TEST_PARALLEL_INDEX ?? 0) * PORTS_PER_WORKER;
let nextPortOffset = 0;
async function freePort(): Promise<number> {
  if (WORKER_PORT_BASE + PORTS_PER_WORKER > EPHEMERAL_PORT_FLOOR) {
    throw new Error(`worker port range ${WORKER_PORT_BASE}+ reaches the OS ephemeral range at ${EPHEMERAL_PORT_FLOOR}`);
  }
  for (let attempts = 0; attempts < PORTS_PER_WORKER; attempts++) {
    const candidate = WORKER_PORT_BASE + (nextPortOffset++ % PORTS_PER_WORKER);
    const usable = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(candidate, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (usable) return candidate;
  }
  throw new Error(`no free port in this worker's range ${WORKER_PORT_BASE}-${WORKER_PORT_BASE + PORTS_PER_WORKER - 1}`);
}

// Poll until a spawned server accepts connections, instead of sleeping a fixed interval
// that a loaded CI runner can outlast. Bounded so a server that never binds fails loudly.
async function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    if (Date.now() > deadline)
      throw new Error(`server on 127.0.0.1:${port} did not accept connections in ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function commandEnv(env: NodeJS.ProcessEnv = {}) {
  // Apply the same V8 teardown-deadlock mitigation as the unit harness to
  // nested Playwright runners and all of their CLI/server children.
  const merged = {
    ...nodeTestEnv(process.env),
    PATH: `${PLAYWRIGHT_BIN}${path.delimiter}${process.env.PATH}`,
    CI: '1',
    ...env,
  };
  for (const key of ['GITHUB_BASE_REF', 'GITHUB_SHA', 'GITHUB_HEAD_SHA', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH']) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) delete merged[key];
  }
  return merged;
}

// Bounded: a blocking spawnSync cannot be interrupted by the test timeout, so a hung
// CLI would hold this worker forever. One past the bound is killed and fails by name.
function run(cwd: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSyncToCompletion(command, args, {
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
  // Give the generated crawler a real nav link immediately. A link-less fixture
  // spends its entire 15 s hydration allowance waiting before each capture,
  // needlessly consuming the bounded CLI runtime under parallel browser load.
  fs.writeFileSync(
    path.join(dir, 'server.mjs'),
    `import http from 'node:http';
const port = Number(process.argv[2]);
http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(\`<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; color: rgb(0, 0, 0); }
    main { padding: 32px; }
  </style></head><body><nav><a href="/">Home</a></nav><main>StyleProof fixture</main></body></html>\`);
}).listen(port, '127.0.0.1');
`,
  );
}

function scaffold(app: string, port: number) {
  writeFixtureApp(app, port);
  git(app, ['init', '-q']);
  git(app, ['config', 'user.email', 'styleproof@example.test']);
  git(app, ['config', 'user.name', 'StyleProof Test']);
  const setup = run(app, process.execPath, [
    CLI,
    'setup',
    '--skip-install',
    '--skip-browser',
    '--base-url',
    `http://127.0.0.1:${port}`,
  ]);
  expect(setup.status, setup.stdout + setup.stderr).toBe(0);
  return fs.readFileSync(path.join(app, 'playwright.styleproof.config.ts'), 'utf8');
}

function expectNoWrappers(app: string) {
  expect(fs.readdirSync(app).filter((name) => /^\.styleproof-(capture|external)-/.test(name))).toEqual([]);
}

function promiseConfig(source: string) {
  return (
    source.replace('export default defineConfig(', 'const config = defineConfig(') +
    '\nexport default Promise.resolve(config);\n'
  );
}

for (const exported of ['object', 'promise']) {
  test(`${exported} config: capture refuses a foreign server before writing a map, then captures its own build`, async () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-foreign-server-e2e-'));
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    let foreign: ReturnType<typeof spawn> | undefined;
    try {
      const source = scaffold(app, port);
      const generated = exported === 'promise' ? promiseConfig(source) : source;
      const configPath = path.join(app, 'playwright.styleproof.config.ts');
      // Existing consumer-owned configs must be protected even when they still allow reuse.
      fs.writeFileSync(
        configPath,
        generated.replace('reuseExistingServer: false', 'reuseExistingServer: !process.env.CI'),
      );
      const check = run(app, process.execPath, [CLI, 'init', '--check', '--base-url', url]);
      expect(check.status, check.stdout + check.stderr).toBe(0);
      git(app, ['add', '-A']);
      git(app, ['commit', '-qm', 'fixture setup']);

      fs.writeFileSync(
        path.join(app, 'foreign.mjs'),
        `import http from 'node:http';
http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><html><head><style>body { color: rgb(123, 45, 67); }</style></head><body><nav><a href="/">Foreign</a></nav><main>Different application</main></body></html>');
}).listen(${port}, '127.0.0.1');`,
      );
      foreign = spawn(process.execPath, ['foreign.mjs'], { cwd: app, stdio: 'ignore', env: commandEnv() });
      await waitForPort(port);

      const capture = run(app, process.execPath, [CLI, 'capture'], { CI: '', BASE_URL: '' });
      const mapDir = path.join(app, '.styleproof/maps/current');
      const maps = fs.existsSync(mapDir) ? fs.readdirSync(mapDir).filter((name) => name.endsWith('.json.gz')) : [];
      // Keep the unfixed symptom visible in red output: main captures the foreign page successfully.
      const foreignColour = maps.some((name) =>
        Object.values(loadStyleMap(path.join(mapDir, name)).elements).some(
          (element) => element.style.color === 'rgb(123, 45, 67)',
        ),
      );
      process.stdout.write(
        `foreign server: capture exit=${capture.status}, maps=${maps.length}, foreign colour captured=${foreignColour}\n`,
      );
      expect(capture.status, capture.stdout + capture.stderr).not.toBe(0);
      expect(capture.stderr).toContain(`a server is already running at ${url}`);
      expect(capture.stderr).toContain("this commit's build would not be the one captured");
      expect(capture.stderr).toContain('stop that server or pass --external-server');
      expect(maps).toEqual([]);
      expect(capture.stderr).toContain('styleproof ci or the Action, set BASE_URL');
      expectNoWrappers(app);

      // Opt-in must also work with a new scaffold, which explicitly disables server reuse.
      fs.writeFileSync(configPath, generated);
      const deliberate = run(app, process.execPath, [CLI, 'capture', '--external-server'], { CI: '', BASE_URL: '' });
      expect(deliberate.status, deliberate.stdout + deliberate.stderr).toBe(0);
      const externalMap = loadStyleMap(path.join(mapDir, 'index@1280.json.gz'));
      expect(Object.values(externalMap.elements).some((element) => element.style.color === 'rgb(123, 45, 67)')).toBe(
        true,
      );
      expectNoWrappers(app);
      process.stdout.write('deliberate external server: capture exit=0, foreign colour captured=true\n');

      const baseUrl = run(app, process.execPath, [CLI, 'capture'], { BASE_URL: url });
      expect(baseUrl.status, baseUrl.stdout + baseUrl.stderr).toBe(0);
      expect(
        Object.values(loadStyleMap(path.join(mapDir, 'index@1280.json.gz')).elements).some(
          (element) => element.style.color === 'rgb(123, 45, 67)',
        ),
      ).toBe(true);
      expectNoWrappers(app);
      process.stdout.write('BASE_URL external server: capture exit=0, foreign colour captured=true\n');

      // Keep the ESM capture spec in its own package while testing a CommonJS config.
      fs.writeFileSync(path.join(app, 'e2e/package.json'), JSON.stringify({ type: 'module' }));
      const packagePath = path.join(app, 'package.json');
      const commonjsPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      commonjsPackage.type = 'commonjs';
      fs.writeFileSync(packagePath, JSON.stringify(commonjsPackage));
      const commonjs = run(app, process.execPath, [CLI, 'capture', '--external-server'], { CI: '', BASE_URL: '' });
      expect(commonjs.status, commonjs.stdout + commonjs.stderr).toBe(0);
      expectNoWrappers(app);
      process.stdout.write('CommonJS external server: capture exit=0\n');

      foreign.kill();
      await once(foreign, 'exit');
      foreign = undefined;
      fs.writeFileSync(configPath, generated);
      const ownCapture = run(app, process.execPath, [CLI, 'capture'], { CI: '', BASE_URL: '' });
      expect(ownCapture.status, ownCapture.stdout + ownCapture.stderr).toBe(0);
      expect(fs.readdirSync(mapDir).filter((name) => name.endsWith('.json.gz'))).toEqual(['index@1280.json.gz']);
      expectNoWrappers(app);
      expect(generated).toContain('reuseExistingServer: false');
      process.stdout.write('own build: capture exit=0, maps=1\n');
    } finally {
      if (foreign && foreign.exitCode === null) {
        foreign.kill();
        await once(foreign, 'exit');
      }
      fs.rmSync(app, { recursive: true, force: true });
    }
  });
}

for (const kind of ['CommonJS __dirname', 'extensionless import', 'enum', 'promise export']) {
  test(`capture loads ${kind} config with Playwright and leaves no wrapper`, async () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-config-loader-e2e-'));
    const port = await freePort();
    try {
      let generated = scaffold(app, port);
      const packagePath = path.join(app, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      delete packageJson.type;
      fs.writeFileSync(packagePath, JSON.stringify(packageJson));
      // Keep the ESM capture spec in its own package while Playwright compiles the CommonJS config.
      fs.writeFileSync(path.join(app, 'e2e/package.json'), JSON.stringify({ type: 'module' }));
      if (kind === 'CommonJS __dirname') {
        generated =
          `import path from 'node:path';\n` +
          generated.replace('testDir: "./e2e"', "testDir: path.join(__dirname, 'e2e')");
      } else if (kind === 'extensionless import') {
        fs.writeFileSync(path.join(app, 'e2e/routes.ts'), `export const PORT = ${port};`);
        generated =
          `import { PORT } from ${JSON.stringify('./e2e/routes')};\n` +
          generated.replaceAll(`"http://127.0.0.1:${port}"`, "('http://127.0.0.1:' + PORT)");
      } else if (kind === 'promise export') {
        generated = promiseConfig(generated);
      } else {
        generated =
          `enum Server { Port = ${port} }\n` +
          generated.replaceAll(`"http://127.0.0.1:${port}"`, "('http://127.0.0.1:' + Server.Port)");
      }
      fs.writeFileSync(path.join(app, 'playwright.styleproof.config.ts'), generated);
      git(app, ['add', '-A']);
      git(app, ['commit', '-qm', 'fixture setup']);
      const capture = run(app, process.execPath, [CLI, 'capture'], { BASE_URL: '' });
      expect(capture.status, capture.stdout + capture.stderr).toBe(0);
      const mapDir = path.join(app, '.styleproof/maps/current');
      expect(fs.readdirSync(mapDir).filter((name) => name.endsWith('.json.gz'))).toEqual(['index@1280.json.gz']);
      expectNoWrappers(app);
      const dirty = git(app, ['status', '--porcelain', '--untracked-files=all']);
      expect(dirty.stdout, 'capture leaves the committed project clean').toBe('');
      process.stdout.write(`${kind}: capture exit=0, maps=1, project clean=true\n`);
    } finally {
      fs.rmSync(app, { recursive: true, force: true });
    }
  });
}

test("capture rejects a function export with Playwright's original config error", async () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-function-config-e2e-'));
  try {
    const generated = scaffold(app, await freePort());
    fs.writeFileSync(
      path.join(app, 'playwright.styleproof.config.ts'),
      generated.replace('export default defineConfig(', 'const config = defineConfig(') +
        '\nexport default () => config;\n',
    );
    const capture = run(app, process.execPath, [CLI, 'capture'], { BASE_URL: '' });
    expect(capture.status, capture.stdout + capture.stderr).not.toBe(0);
    expect(capture.stdout + capture.stderr).toContain('must export a single object');
    const mapDir = path.join(app, '.styleproof/maps/current');
    expect(fs.existsSync(mapDir) ? fs.readdirSync(mapDir).filter((name) => name.endsWith('.json.gz')) : []).toEqual([]);
    expectNoWrappers(app);
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});
