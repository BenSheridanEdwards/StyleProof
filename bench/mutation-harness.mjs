// Mutation harness: score StyleProof's detection against known edits to a real app.
//
//   npm run bench:mutate -- <target.json> [--only id,id] [--log file] [--keep-workdir]
//   npm run bench:mutate -- --history [--log file]
//
// A target config (see bench/mutation-targets/demo.json and
// bench/mutation-harness.md) names an external app, how to serve it, which
// pages to capture, and a list of deterministic find/replace mutations, each
// with the element it must surface on. The harness copies the app to a temp
// working copy (the target itself is read-only), serves the copy, captures a
// baseline, then for each mutation: edit the copy → capture → diff against
// the baseline (style + advisory content layers) → score → revert.
//
// Scores: detection (a finding lands on the expected element, with an expected
// prop), precision (share of findings that are expected), false-positive rate
// (mutations with any stray finding), and runtime. Every run is appended to
// .styleproof/mutation-runs.jsonl with the StyleProof version + commit, so
// `--history` lines versions up. A dev tool for iteration — never a CI gate.
import { chromium } from '@playwright/test';
import { execFileSync, execSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureStyleMap } from '../dist/capture.js';
import { injectPathOf } from '../dist/capture/browser.js';
import { diffContentMaps, diffStyleMaps } from '../dist/diff.js';
import {
  applyMutation,
  formatHistory,
  formatRun,
  normalizeFindings,
  scoreMutation,
  summarizeRun,
  validateTarget,
} from './mutation-harness/score.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `usage: node bench/mutation-harness.mjs <target.json> [--only id,id] [--log file] [--keep-workdir]
       node bench/mutation-harness.mjs --history [--log file]`;

function parseArgs(argv) {
  const args = { log: path.join(ROOT, '.styleproof', 'mutation-runs.jsonl'), history: false, keepWorkdir: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--history') args.history = true;
    else if (a === '--keep-workdir') args.keepWorkdir = true;
    else if (a === '--only') args.only = argv[++i]?.split(',').filter(Boolean);
    else if (a === '--log') args.log = path.resolve(argv[++i] ?? '');
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!a.startsWith('-') && !args.config) args.config = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const git = (cwd, ...cmd) => {
  try {
    return execFileSync('git', ['-C', cwd, ...cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Copy the target into `workdir`, skipping excluded names; `link` entries become symlinks to the target. */
function copyTarget(root, workdir, { exclude, link }) {
  const skip = new Set(exclude);
  const linked = new Set(link.map((l) => path.normalize(l)));
  fs.cpSync(root, workdir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(root, src);
      return rel === '' || (!linked.has(rel) && !rel.split(path.sep).some((s) => skip.has(s)));
    },
  });
  for (const l of linked) {
    if (fs.existsSync(path.join(root, l))) fs.symlinkSync(path.join(root, l), path.join(workdir, l), 'dir');
  }
}

/** Resolve a mutation's file inside the working copy; refuse anything that would write through to the target. */
function workingFile(workdir, rel) {
  const file = path.resolve(workdir, rel);
  const real = fs.realpathSync(file);
  if (!real.startsWith(fs.realpathSync(workdir) + path.sep))
    throw new Error(`refusing to mutate ${rel}: it resolves outside the working copy (a linked dir?)`);
  return file;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Start the static server or the target's own dev server in the working copy; resolves once the URL answers. */
async function startServer(serve, workdir) {
  const port = await freePort();
  const child = serve.static
    ? spawn(
        process.execPath,
        [path.join(ROOT, 'scripts', 'serve-static.mjs'), path.join(workdir, serve.static), port],
        {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
    : spawn(serve.command.replaceAll('{port}', String(port)), {
        cwd: workdir,
        shell: true,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
  let output = '';
  const keep = (chunk) => (output = (output + chunk).slice(-4000));
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  let exited = null;
  child.on('exit', (code) => (exited = code));
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  };

  const url = serve.static ? `http://127.0.0.1:${port}` : serve.url.replaceAll('{port}', String(port));
  const deadline = Date.now() + serve.readyTimeoutMs;
  for (;;) {
    if (exited !== null) throw new Error(`server exited (code ${exited}) before ${url} answered:\n${output}`);
    try {
      await fetch(url);
      break;
    } catch {
      if (Date.now() > deadline) {
        stop();
        throw new Error(`server did not answer ${url} within ${serve.readyTimeoutMs} ms:\n${output}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    url: url.replace(/\/$/, ''),
    settle: () => new Promise((r) => setTimeout(r, serve.settleMs)),
    stop,
  };
}

/**
 * Capture every page × width. With `expect`, also resolve its selectors to the
 * same element paths the capture records, so findings can be attributed.
 */
async function captureAll(page, target, baseUrl, expect) {
  const maps = {};
  const targetPaths = {};
  const allowPaths = {};
  const resolve = (selectors) =>
    page.evaluate(
      (sels) =>
        sels.flatMap((s) => [...globalThis.document.querySelectorAll(s)].map((el) => globalThis.__spPathOf(el))),
      selectors,
    );
  for (const width of target.widths) {
    await page.setViewportSize({ width, height: 900 });
    for (const p of target.pages) {
      const surface = `${p.key}@${width}`;
      await page.goto(baseUrl + p.path, { waitUntil: 'load' });
      maps[surface] = await captureStyleMap(page, { ignore: target.ignore });
      if (expect?.selector) {
        await page.evaluate(injectPathOf);
        targetPaths[surface] = await resolve([expect.selector]);
        allowPaths[surface] = await resolve(expect.allow ?? []);
      }
    }
  }
  return { maps, targetPaths, allowPaths };
}

function diffAll(base, head) {
  return Object.keys(base).flatMap((surface) =>
    normalizeFindings(
      surface,
      diffStyleMaps(base[surface], head[surface]),
      diffContentMaps(base[surface], head[surface]),
    ),
  );
}

async function run(args) {
  const configPath = path.resolve(args.config);
  const target = validateTarget(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  const root = path.resolve(path.dirname(configPath), target.root);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`target root not found: ${root}`);
  let mutations = target.mutations;
  if (args.only) {
    const unknown = args.only.filter((id) => !mutations.some((m) => m.id === id));
    if (unknown.length) throw new Error(`--only: unknown mutation id(s): ${unknown.join(', ')}`);
    mutations = mutations.filter((m) => args.only.includes(m.id));
  }

  // Read-only guard: fingerprint every target file a mutation names, check again at the end.
  const touched = [...new Set(mutations.map((m) => path.resolve(root, m.file)))];
  const before = touched.map(sha256);

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-mutate-'));
  let server;
  let browser;
  const cleanup = () => {
    server?.stop();
    if (!args.keepWorkdir) fs.rmSync(workdir, { recursive: true, force: true });
  };
  const onSignal = () => {
    cleanup();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);

  const results = [];
  let baselineMs;
  try {
    copyTarget(root, workdir, target.copy);
    // Fail before the slow part: every mutation must apply cleanly to its file.
    for (const m of mutations) applyMutation(fs.readFileSync(workingFile(workdir, m.file), 'utf8'), m);
    if (target.prepare) execSync(target.prepare, { cwd: workdir, stdio: 'inherit' });
    server = await startServer(target.serve, workdir);
    browser = await chromium.launch();
    const page = await browser.newPage();

    // A baseline is only useful if it reads itself clean: capture twice, require zero findings.
    const baselineStart = Date.now();
    const { maps: base } = await captureAll(page, target, server.url);
    const { maps: again } = await captureAll(page, target, server.url);
    const noise = diffAll(base, again);
    if (noise.length) {
      const examples = noise.slice(0, 5).map((f) => `  ${f.surface} ${f.layer} ${f.path} ${f.props.join(',')}`);
      throw new Error(
        `baseline is not deterministic — re-capture produced ${noise.length} finding(s); add \`ignore\` selectors:\n${examples.join('\n')}`,
      );
    }
    baselineMs = Date.now() - baselineStart;
    console.log(`baseline: ${Object.keys(base).length} surface(s), self-diff clean, ${baselineMs} ms`);

    for (const mutation of mutations) {
      const file = workingFile(workdir, mutation.file);
      const original = fs.readFileSync(file, 'utf8');
      const start = Date.now();
      fs.writeFileSync(file, applyMutation(original, mutation));
      try {
        await server.settle();
        const { maps, targetPaths, allowPaths } = await captureAll(page, target, server.url, mutation.expect);
        const result = scoreMutation(mutation, diffAll(base, maps), targetPaths, allowPaths);
        results.push({ ...result, runtimeMs: Date.now() - start });
      } finally {
        fs.writeFileSync(file, original);
        await server.settle();
      }
    }
  } finally {
    await browser?.close();
    process.off('SIGINT', onSignal);
    cleanup();
    if (args.keepWorkdir) console.log(`working copy kept: ${workdir}`);
  }

  const changed = touched.filter((file, i) => sha256(file) !== before[i]);
  if (changed.length) throw new Error(`target was modified during the run (must be read-only): ${changed.join(', ')}`);

  const totals = { ...summarizeRun(results), baselineMs };
  console.log(formatRun(target.name, results, totals).join('\n'));

  const entry = {
    at: new Date().toISOString(),
    styleproof: {
      version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
      commit: git(ROOT, 'rev-parse', '--short', 'HEAD'),
      dirty: Boolean(git(ROOT, 'status', '--porcelain')),
    },
    target: { name: target.name, commit: git(root, 'rev-parse', '--short', 'HEAD') },
    totals,
    mutations: results,
  };
  fs.mkdirSync(path.dirname(args.log), { recursive: true });
  fs.appendFileSync(args.log, JSON.stringify(entry) + '\n');
  console.log(`\nlogged → ${path.relative(process.cwd(), args.log)}`);
}

function history(args) {
  if (!fs.existsSync(args.log)) {
    console.log(`no runs logged yet (${path.relative(process.cwd(), args.log)})`);
    return;
  }
  const entries = fs
    .readFileSync(args.log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  console.log(formatHistory(entries).join('\n'));
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.history && !args.config)) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }
  if (args.history) history(args);
  else await run(args);
} catch (e) {
  console.error(`mutation harness: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}
