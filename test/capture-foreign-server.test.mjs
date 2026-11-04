import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CLI_SPAWN_TIMEOUT_MS, childTimeoutError, mkNonGitTmp, rmTmp } from './helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

function startCapture(cwd, args = [], env = {}) {
  const child = spawn(process.execPath, [path.join(root, 'bin/styleproof-map.mjs'), ...args], {
    cwd,
    env: { ...process.env, CI: '', BASE_URL: '', STYLEPROOF_WORKERS: '1', ...env },
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(childTimeoutError('styleproof-map', args, CLI_SPAWN_TIMEOUT_MS, output));
    }, CLI_SPAWN_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status: status ?? (signal === 'SIGINT' ? 130 : 143), signal, output });
    });
  });
  return { child, done };
}

const runCapture = (cwd, args, env) => startCapture(cwd, args, env).done;
const wrappers = (dir) => fs.readdirSync(dir).filter((name) => name.startsWith('.styleproof-capture-'));

async function fixture(t) {
  const dir = mkNonGitTmp('styleproof-foreign-server-');
  const server = http.createServer((_req, res) => res.end('foreign page'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  };
  t.after(async () => {
    await stop();
    rmTmp(dir);
  });
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.mkdirSync(path.join(dir, 'node_modules/@playwright'), { recursive: true });
  fs.symlinkSync(
    path.join(root, 'node_modules/@playwright/test'),
    path.join(dir, 'node_modules/@playwright/test'),
    'dir',
  );
  fs.mkdirSync(path.join(dir, 'e2e'));
  const marker = path.join(dir, 'playwright-launched');
  fs.writeFileSync(
    path.join(dir, 'e2e/styleproof.spec.ts'),
    `
import { test } from '@playwright/test';
import fs from 'node:fs';
test('styleproof capture', () => fs.writeFileSync(${JSON.stringify(marker)}, 'ran'));
`,
  );
  fs.writeFileSync(
    path.join(dir, 'server.mjs'),
    `
import http from 'node:http';
http.createServer((_req, res) => res.end('own server')).listen(${port}, '127.0.0.1');
`,
  );
  const config = path.join(dir, 'playwright.styleproof.config.ts');
  const options = `testDir: './e2e', webServer: [{ command: ${JSON.stringify(`"${process.execPath}" server.mjs`)}, url: ${JSON.stringify(url)}, reuseExistingServer: true }]`;
  fs.writeFileSync(config, `export default { ${options} };`);
  return { dir, config, options, marker, port, url, stop };
}

test('capture refuses a foreign server, permits both external opt-ins, and permits a free port', async (t) => {
  const { dir, config, options, marker, url, stop } = await fixture(t);
  const stale = path.join(dir, `.styleproof-capture-2147483647-${randomUUID()}.config.mjs`);
  fs.writeFileSync(stale, '// interrupted capture');
  const refused = await runCapture(dir);
  process.stdout.write(`foreign server: capture exit=${refused.status}, capture test ran=${fs.existsSync(marker)}\n`);
  assert.notEqual(refused.status, 0, refused.output);
  assert.match(refused.output, new RegExp(`a server is already running at ${url}`));
  assert.match(refused.output, /this commit's build would not be the one captured/);
  assert.match(refused.output, /stop that server or pass --external-server/i);
  assert.match(refused.output, /styleproof ci or the Action, set BASE_URL/);
  assert.equal(fs.existsSync(marker), false, 'capture tests must not run');
  assert.deepEqual(wrappers(dir), [], 'stale and completed wrappers are removed');

  const secret = ['fixture', 'credential'].join('-');
  const privateUrl = new URL(url);
  privateUrl.username = 'fixture';
  privateUrl.password = secret;
  privateUrl.searchParams.set('token', secret);
  fs.writeFileSync(config, `export default { ${options.replace(url, privateUrl.href)} };`);
  const privateRefusal = await runCapture(dir);
  assert.notEqual(privateRefusal.status, 0, privateRefusal.output);
  assert.match(privateRefusal.output, /a server is already running at/);
  assert.equal(privateRefusal.output.includes(secret), false, 'URL credentials and query data stay private');

  fs.writeFileSync(
    config,
    `export default { ${options.replace('reuseExistingServer: true', 'reuseExistingServer: false')} };`,
  );
  for (const [args, env] of [
    [['--external-server'], {}],
    [[], { BASE_URL: url }],
  ]) {
    const external = await runCapture(dir, args, env);
    assert.equal(external.status, 0, external.output);
    assert.equal(fs.existsSync(marker), true);
    fs.unlinkSync(marker);
    assert.deepEqual(wrappers(dir), []);
  }
  await stop();
  const free = await runCapture(dir);
  assert.equal(free.status, 0, free.output);
  assert.equal(fs.existsSync(marker), true);
  assert.deepEqual(wrappers(dir), []);
});

for (const kind of ['CommonJS __dirname', 'extensionless import', 'enum']) {
  test(`capture uses Playwright's loader for ${kind}`, async (t) => {
    const { dir, config, options, marker, port, url, stop } = await fixture(t);
    await stop();
    fs.writeFileSync(path.join(dir, 'e2e/routes.ts'), `export const PORT = ${port};`);
    const source =
      kind === 'CommonJS __dirname'
        ? `import path from 'node:path'; export default { ${options.replace("'./e2e'", "path.join(__dirname, 'e2e')")} };`
        : kind === 'extensionless import'
          ? `import { PORT } from './e2e/routes'; export default { ${options.replace(JSON.stringify(url), "'http://127.0.0.1:' + PORT")} };`
          : `enum Server { Port = ${port} } export default { ${options.replace(JSON.stringify(url), "'http://127.0.0.1:' + Server.Port")} };`;
    fs.writeFileSync(config, source);
    const result = await runCapture(dir);
    assert.equal(result.status, 0, result.output);
    assert.equal(fs.existsSync(marker), true, 'Playwright loaded the config and ran the capture test');
    assert.deepEqual(wrappers(dir), []);
  });
}

function serverRunning(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.destroy();
      resolve(true);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(500, () => request.destroy());
  });
}

for (const [signal, status] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  test(`capture removes its wrapper and stops its server on ${signal}`, async (t) => {
    const { dir, marker, url, stop } = await fixture(t);
    await stop();
    const spec = path.join(dir, 'e2e/styleproof.spec.ts');
    const original = fs.readFileSync(spec, 'utf8');
    fs.appendFileSync(
      spec,
      `
test('styleproof capture interrupt', async () => { fs.writeFileSync(${JSON.stringify(marker)}, 'waiting'); await new Promise(() => {}); });
`,
    );
    // Cooperative cleanup for the unfixed SIGTERM case, which leaves the server alive.
    const stopFile = path.join(dir, 'stop-owned-server');
    fs.appendFileSync(
      path.join(dir, 'server.mjs'),
      `
import { existsSync } from 'node:fs';
setInterval(() => { if (existsSync(${JSON.stringify(stopFile)})) process.exit(0); }, 25).unref();
`,
    );
    const { child, done } = startCapture(dir);
    try {
      const deadline = Date.now() + 30_000;
      while ((!fs.existsSync(marker) || fs.readFileSync(marker, 'utf8') !== 'waiting') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(fs.readFileSync(marker, 'utf8'), 'waiting', 'capture reached the interruptible test');
      assert.equal(wrappers(dir).length, 1);
      child.kill(signal);
      const result = await done;
      assert.equal(result.status, status, result.output);
      assert.equal(result.signal, signal, 'CI must observe the original signal');
      assert.deepEqual(wrappers(dir), [], 'interrupt leaves no wrapper in the project');
      assert.equal(await serverRunning(url), false, 'Playwright stops the server it started');
      fs.writeFileSync(spec, original);
      const next = await runCapture(dir);
      assert.equal(next.status, 0, next.output);
      assert.deepEqual(wrappers(dir), []);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
      await done;
      fs.writeFileSync(stopFile, 'stop');
      const deadline = Date.now() + 5000;
      while (await serverRunning(url)) {
        assert.ok(Date.now() < deadline, 'owned server cleanup completed');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
}

test('capture awaits a promise config and refuses its busy server', async (t) => {
  const { dir, config, options, marker, url, stop } = await fixture(t);
  const setupMarker = path.join(dir, 'global-setup-ran');
  fs.writeFileSync(
    path.join(dir, 'setup.mjs'),
    `import fs from 'node:fs'; export default () => fs.writeFileSync(${JSON.stringify(setupMarker)}, 'ran');`,
  );
  fs.writeFileSync(
    config,
    `export default Promise.resolve({ ${options}, use: { baseURL: ${JSON.stringify(url)} }, globalSetup: './setup.mjs' });`,
  );
  const busy = await runCapture(dir);
  assert.notEqual(busy.status, 0, busy.output);
  assert.match(busy.output, /a server is already running at/);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(wrappers(dir), []);
  await stop();
  fs.writeFileSync(
    path.join(dir, 'e2e/styleproof.spec.ts'),
    `import { test } from '@playwright/test'; import fs from 'node:fs'; test('styleproof capture', ({ baseURL }) => fs.writeFileSync(${JSON.stringify(marker)}, baseURL));`,
  );
  const capture = await runCapture(dir);
  assert.equal(capture.status, 0, capture.output);
  assert.equal(fs.readFileSync(marker, 'utf8'), url, 'promise config baseURL is honoured');
  assert.equal(fs.readFileSync(setupMarker, 'utf8'), 'ran', 'promise config globalSetup is honoured');
  assert.deepEqual(wrappers(dir), []);
});

test('capture preserves Playwright rejection of a function config', async (t) => {
  const { dir, config, options, marker, stop } = await fixture(t);
  await stop();
  fs.writeFileSync(config, `export default () => ({ ${options} });`);
  const capture = await runCapture(dir);
  assert.notEqual(capture.status, 0, capture.output);
  assert.match(capture.output, /must export a single object/);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(wrappers(dir), []);
});

test('capture reports a missing config without a stack trace', async (t) => {
  const { dir, marker, stop } = await fixture(t);
  await stop();
  const capture = await runCapture(dir, ['--', '--config', 'missing.ts']);
  assert.equal(capture.status, 2, capture.output);
  assert.match(capture.output, /missing\.ts|does not exist/);
  assert.doesNotMatch(capture.output, /\n\s+at |file:\/\//);
  assert.equal(fs.existsSync(marker), false);
});

test(
  'capture explains the writable config directory requirement',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async (t) => {
    const { dir, stop } = await fixture(t);
    await stop();
    fs.mkdirSync(path.join(dir, '.styleproof/maps/current'), { recursive: true });
    fs.chmodSync(dir, 0o555);
    try {
      const capture = await runCapture(dir);
      assert.equal(capture.status, 2, capture.output);
      assert.match(capture.output, /Playwright config directory must be writable/);
      assert.ok(capture.output.includes(dir));
      assert.doesNotMatch(capture.output, /\n\s+at |file:\/\//);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    assert.deepEqual(wrappers(dir), []);
  },
);
