#!/usr/bin/env node
/**
 * Scaffold a styleproof capture spec into a project.
 *
 *   styleproof-init [--dir <path>] [--base-url <url>] [--force] [-h|--help]
 *
 * Writes:
 *   - <dir> (default e2e/styleproof.spec.ts): a starter capture spec with a
 *     minimal settle() helper (triggers scroll-reveal content; StyleProof itself
 *     handles fonts, animation freeze, and the settle). For a detected Next.js app it derives BOTH the
 *     surfaces AND the `expected` coverage guard from the same `discoverNextRoutes()`
 *     call, so a static route added later is captured and expected together —
 *     auto-covered, never a guard failure; the guard fails only on genuine
 *     divergence (a dynamic route, a hand-maintained registry, or a route dropped
 *     from surfaces but still expected). Otherwise it writes one sample surface
 *     plus a commented guard block to wire to your own route registry.
 *   - playwright.styleproof.config.ts: a dedicated production-build Playwright
 *     config for StyleProof captures, so an existing app Playwright config is
 *     never disturbed or accidentally reused.
 *   - .github/workflows/styleproof.yml: restores reusable maps from the
 *     styleproof-maps branch and only captures in CI when the maps are missing.
 *   - .github/workflows/styleproof-approve.yml: the issue_comment handler that
 *     flips the StyleProof status when a reviewer ticks "Approve all changes".
 *     The report workflow runs with `require-approval: true`, so without this the
 *     approval checkbox is inert. GitHub only runs issue_comment workflows from the
 *     default branch, so it takes effect once the init PR merges.
 *
 * Idempotent: re-running never overwrites an existing spec (use --force) and
 * never touches an existing app playwright.config.ts or an existing workflow.
 * Exit 0 = done (or nothing to do), 2 = usage error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Import from the leaf module, not the barrel: styleproof-init only scaffolds
// files and never captures. Pulling `../dist/index.js` here dragged the whole
// library — capture, crawler, report, and six Playwright-importing modules —
// into a tiny scaffolder's load path, and that oversized concurrent module
// graph is what made init's tests flake in CI. routes.js needs only fs + path.
import { discoverNextRoutes } from '../dist/routes.js';
import { isHelpArg, showHelpAndExit } from '../dist/cli-errors.js';

const HELP = `styleproof-init — scaffold a styleproof capture spec

usage: styleproof-init [options]

options:
  --dir <path>        spec output path (default: e2e/styleproof.spec.ts)
  --base-url <url>    baseURL for a generated playwright.styleproof.config.ts
                      (default: http://localhost:3000)
  --force             overwrite the spec if it already exists
  --hook              (re)write ONLY the pre-push hook, overwriting an existing one —
                      the upgrade path after a styleproof release changes the hook
  --upgrade           refresh every MACHINE-OWNED generated file (pre-push hook,
                      report workflow, approval workflow) to this release's
                      templates; never touches the spec or playwright config
  --check             report drift between the machine-owned files and this
                      release's templates without writing; exit 1 if any differ —
                      run it in CI to learn when --upgrade is due
  -h, --help          show this help

--upgrade/--check interpolate the spec path into the templates: pass the same
--dir you scaffolded with if your spec is not at the default location.

What it writes:
  - the spec at --dir, with a minimal settle() helper (scroll-reveal only).
    In a Next.js app it discovers your routes at run time and derives both the
    surfaces and the \`expected\` coverage guard from that one call, so a new static
    route is auto-covered (captured + expected together); the guard fails only when
    the two diverge. Otherwise it writes one sample surface + a commented guard block.
  - playwright.styleproof.config.ts, a dedicated production-build Playwright config
  - .github/workflows/styleproof.yml, a cache-first PR report workflow
  - .github/workflows/styleproof-approve.yml, the "Approve all changes" gate
    (active once merged to your default branch)

After running, build and upload this commit's map outside CI when possible:
  npx styleproof-map

To certify a refactor:
  npx styleproof-map
  npx styleproof-diff
`;

const argv = process.argv.slice(2);
let specPath = 'e2e/styleproof.spec.ts';
let baseUrl = 'http://localhost:3000';
let force = false;
let hookOnly = false;
let upgrade = false;
let checkOnly = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (isHelpArg(a)) showHelpAndExit(HELP);
  else if (a === '--dir') specPath = argv[++i];
  else if (a.startsWith('--dir=')) specPath = a.slice(6);
  else if (a === '--base-url') baseUrl = argv[++i];
  else if (a.startsWith('--base-url=')) baseUrl = a.slice(11);
  else if (a === '--force') force = true;
  else if (a === '--hook') hookOnly = true;
  else if (a === '--upgrade') upgrade = true;
  else if (a === '--check') checkOnly = true;
  else {
    console.error(`unknown argument: ${a}\n`);
    process.stderr.write(HELP);
    process.exit(2);
  }
}
if (!specPath) {
  console.error('--dir requires a path');
  process.exit(2);
}

// Captures read whatever is in front of them, so the page must be settled and
// deterministic first — this helper is shared by both spec variants below.
const SETTLE = `// StyleProof settles the page for you before it reads — it waits out in-flight data
// and fonts, freezes animations/transitions, and blurs focus. The one thing it can't
// know about is *scroll-reveal* content: elements an IntersectionObserver mounts (or
// fades in) only once they're scrolled into view. settle() triggers that — it scrolls
// the page so those reveals fire, forces common reveal markers to their final state so
// nothing is caught mid-fade, then returns to the top. Tune the selectors to match
// your project. No reveal-on-scroll content? Delete settle() and use the one-liner
// \`go: (page) => page.goto('/')\`.
async function settle(page: Page) {
  await page.addStyleTag({
    content: \`.reveal, [data-reveal], .fade-in, .animate-in {
      opacity: 1 !important;
      transform: none !important;
      visibility: visible !important;
    }\`,
  });
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
}`;

const HEADER = `/**
 * styleproof capture spec (generated by \`styleproof-init\`).
 *
 * Each surface is one deterministic page state. Omit \`widths\` and StyleProof
 * detects your @media breakpoints from the loaded CSS and sweeps one viewport per
 * band — no config. Capture against a PRODUCTION build — dev servers inject styles.
 *
 *   npx styleproof-map   # capture this commit into the local cache and map store
 *   npx styleproof-diff  # compare cached base/head maps by commit SHA
 */`;

// Next.js detected: derive BOTH surfaces and the coverage guard from the app's
// routes AT RUN TIME, from one `discoverNextRoutes()` call — so a static page added
// later is a captured surface AND `expected` in the same step (auto-covered, never a
// guard failure), with no static list to drift. The guard fires only when the two
// diverge (a dynamic route, a hand-maintained registry, or a route dropped from
// surfaces but still expected).
const NEXT_SPEC = `import type { Page } from '@playwright/test';
import { defineStyleMapCapture, discoverNextRoutes, type Surface } from 'styleproof';

${HEADER}

${SETTLE}

// Routes discovered from your Next.js app (app/ + pages/) at RUN TIME. Both SURFACES
// and \`expected\` below come from this one list, so a static route you add later is
// captured and expected together — covered automatically, with no surface list to
// keep in sync. Edit freely; this is your spec. Static routes each get a capture;
// dynamic [param] routes can't be navigated without a value, so they're listed in
// \`exclude\` until you add a surface with a concrete param.
const ROUTES = discoverNextRoutes();

const SURFACES: Surface[] = ROUTES.filter((r) => !r.dynamic).map((r) => ({
  key: r.key,
  go: async (page) => {
    await page.goto(r.path);
    await settle(page);
  },
  ignore: [], // e.g. ['.live-feed', '.ad-slot'] for nondeterministic regions
  // No widths → StyleProof detects your @media breakpoints from the loaded CSS and
  // sweeps one viewport per band. Pass an explicit array (e.g. 1280, 768, 390) to pin them (or to
  // cover a JS-only matchMedia breakpoint that has no CSS @media rule).
}));

defineStyleMapCapture({
  surfaces: SURFACES,
  // Coverage guard: every \`expected\` route must be a captured surface or excluded, or
  // the suite fails (it runs without STYLEMAP_DIR — a static check, no browser). Since
  // both sides come from ROUTES, static routes never trip it; it fires when they
  // diverge — a dynamic route (excluded below), or a route you drop from SURFACES.
  expected: ROUTES.map((r) => r.key),
  exclude: Object.fromEntries(
    ROUTES.filter((r) => r.dynamic).map((r) => [r.key, \`dynamic route (\${r.path}) — add a surface with a concrete param\`]),
  ),
  inventory: true, // also fail the diff when a nav item / route the UI used to offer disappears
  dir: process.env.STYLEMAP_DIR,
});
`;

// Non-Next project: crawl every surface the nav links to, so ANY app captures its
// whole reachable surface out of the box with nothing to hand-list. The crawl reads
// the rendered nav; the surface set can't drift from it.
const GENERIC_SPEC = `import type { Page } from '@playwright/test';
import { defineCrawlCapture } from 'styleproof';

${HEADER}

${SETTLE}

// Zero-config capture: crawl every surface your nav links to from '/'. The surface set
// is DISCOVERED from the rendered nav, so it can't drift from it — no hand-listed
// \`surfaces\` array to maintain, and a page you add to the nav is captured automatically.
// The root (/) is always captured, plus every same-origin <a href> it links to.
defineCrawlCapture({
  from: '/',
  settle, // trigger scroll-reveal per surface (StyleProof handles fonts/animation/network itself)
  // No \`widths\` → StyleProof detects each surface's @media breakpoints and sweeps one
  // viewport per band. Pass an array (e.g. [1440, 768, 390]) to pin them.
  inventory: true, // also fail the diff when a nav item / route the UI used to offer disappears
  ignore: [], // e.g. ['.live-feed', '.ad-slot'] for nondeterministic regions
  dir: process.env.STYLEMAP_DIR,
  // A single-route SPA whose views are ?tab= / client-routed? Keep only those:
  //   match: /\\?tab=/,
  // Turn the crawl into a coverage guard: reconcile the rendered nav against a route
  // registry, both directions — a new linked route with no \`expected\` entry fails, and
  // an \`expected\` route the nav stopped linking fails. (Runs inside the capture, so it
  // fires when you capture, not in every test run.) List conditionally-rendered links
  // (auth / feature-flag) in \`exclude\` so they can't flake the guard either direction:
  //   expected: ['index', 'pricing'],
  //   exclude: { admin: 'feature-flagged, renders only for staff' },
  // Certify menus, dialogs, tabs, and form-error states on every surface as variants:
  //   variants: [{ key: 'menu-open', go: async (page) => { await page.getByRole('button', { name: /menu/i }).click(); } }],
});
`;

const PACKAGE_MANAGERS = {
  npm: {
    label: 'npm',
    run: (script) => `npm run ${script}`,
    exec: (command) => `npx ${command}`,
    install: 'npm ci',
    setup: `      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm`,
  },
  yarn: {
    label: 'Yarn v1',
    run: (script) => `npx -y yarn@1.22.22 ${script}`,
    exec: (command) => `npx -y yarn@1.22.22 ${command}`,
    install: 'npx -y yarn@1.22.22 install --frozen-lockfile --non-interactive',
    setup: `      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: yarn
          cache-dependency-path: yarn.lock`,
  },
  pnpm: {
    label: 'pnpm',
    run: (script) => `pnpm run ${script}`,
    exec: (command) => `pnpm exec ${command}`,
    install: 'pnpm install --frozen-lockfile',
    setup: `      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml
      - run: corepack enable`,
  },
  bun: {
    label: 'Bun',
    run: (script) => `bun run ${script}`,
    exec: (command) => `bunx ${command}`,
    install: 'bun install --frozen-lockfile',
    setup: `      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - uses: oven-sh/setup-bun@v2`,
  },
};

function detectPackageManager(root) {
  if (fs.existsSync(path.join(root, 'bun.lock')) || fs.existsSync(path.join(root, 'bun.lockb'))) {
    return PACKAGE_MANAGERS.bun;
  }
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return PACKAGE_MANAGERS.pnpm;
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return PACKAGE_MANAGERS.yarn;
  return PACKAGE_MANAGERS.npm;
}

const PM = detectPackageManager(process.cwd());

function readPackageJson(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

function hasDep(pkg, name) {
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
}

function scriptIncludes(pkg, script, text) {
  return typeof pkg.scripts?.[script] === 'string' && pkg.scripts[script].includes(text);
}

function portFromBaseUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.port) return parsed.port;
    return parsed.protocol === 'https:' ? '443' : '80';
  } catch {
    return '3000';
  }
}

function productionServerCommand(root, base) {
  const pkg = readPackageJson(root);
  const port = portFromBaseUrl(base);
  const build = pkg.scripts?.build ? `${PM.run('build')} && ` : '';
  const looksLikeVite =
    hasDep(pkg, 'vite') || scriptIncludes(pkg, 'dev', 'vite') || scriptIncludes(pkg, 'build', 'vite');
  const looksLikeNext =
    hasDep(pkg, 'next') || scriptIncludes(pkg, 'dev', 'next') || scriptIncludes(pkg, 'build', 'next');

  if (looksLikeVite) return `${build}${PM.exec(`vite preview --host 127.0.0.1 --port ${port}`)}`;
  if (looksLikeNext) {
    const start = pkg.scripts?.start ? PM.run('start') : PM.exec(`next start -p ${port}`);
    return `${build}${start}`;
  }
  if (pkg.scripts?.start) return `${build}${PM.run('start')}`;
  if (pkg.scripts?.preview) return `${build}${PM.run('preview')}`;
  return `${PM.run('build')} && ${PM.run('start')}`;
}

function configTestDir(spec) {
  const dir = path.dirname(path.resolve(process.cwd(), spec));
  const rel = path.relative(process.cwd(), dir).replace(/\\/g, '/');
  return rel ? `./${rel}` : '.';
}

const CONFIG = `import { defineConfig, devices } from '@playwright/test';

// Generated by styleproof-init.
//
// Capture against a PRODUCTION build, never a dev server. Dev servers (\`next dev\`,
// \`vite\`, …) JIT-compile each route on first request — slow and TIMING-VARIABLE
// under parallel CI load, so a capture can settle on the loading state on one run and
// the loaded state on the next: phantom diffs and self-check flakes. A built-and-served
// app serves precompiled routes at consistent timing. (StyleProof's settle waits for
// in-flight data either way, but a production build removes the variance at the source.)
export default defineConfig({
  testDir: ${JSON.stringify(configTestDir(specPath))},
  testMatch: ${JSON.stringify(path.basename(specPath))},
  timeout: 120_000,
  // Capture surfaces in PARALLEL. StyleProof generates one test per surface × width,
  // each an isolated page writing a uniquely-keyed file (\`<key>@<width>.json.gz\`), with
  // per-page record/replay and frozen clock — so they're independent and safe to run
  // concurrently. Without this, all surfaces sit in one spec file and capture serially;
  // with it they fan out across workers, a near-linear speedup on a multi-surface app.
  // (\`--shard\` splits them across CI machines too; they write disjoint files into one
  // dir.) Tune \`workers\` to your machine if needed.
  fullyParallel: true,
  use: {
    baseURL: process.env.BASE_URL || '${baseUrl}',
  },
  // Build once, then serve THAT production build for the captures — so you can't
  // accidentally capture a dev server. styleproof-init detected the production
  // serve command from your package scripts/dependencies; tune it here if your
  // framework needs a custom preview command.
  webServer: {
    command: '${productionServerCommand(process.cwd(), baseUrl)}',
    url: process.env.BASE_URL || '${baseUrl}',
    env: { PORT: '${portFromBaseUrl(baseUrl)}' },
    reuseExistingServer: !process.env.CI,
    timeout: 600_000, // a cold production build can take a few minutes
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`;

const CI_PATH = '.github/workflows/styleproof.yml';
const CI_WORKFLOW = `name: StyleProof

# Cache-first v4 flow:
# - run \`styleproof-map\` locally after committing to build/upload this commit's map
#   outside CI when possible;
# - CI restores base/head maps from the styleproof-maps branch and generates the
#   report without a browser;
# - on a head-only miss, CI captures/publishes only the head; on a base miss it
#   recaptures/publishes the pair in one pinned environment.
on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

permissions:
  contents: write
  issues: write
  pull-requests: write
  statuses: write

jobs:
  styleproof:
    # Report on open/update; the prune job below handles close.
    if: github.event.action != 'closed'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # need base/head commits for cache fallback capture
${PM.setup}
      - run: ${PM.install}
      - id: maps
        name: Restore or capture StyleProof maps
        shell: bash
        run: |
          # Cache-first, in one packaged command: restore both exact-SHA bundles
          # from the styleproof-maps branch; on a miss, capture in this pinned
          # environment and publish for reuse. The rules — restore exit-code
          # triage, the cold-path base rebuild under the head's exact StyleProof
          # release, HAR replay for the head — live in styleproof-ci, so this
          # step updates with the release instead of drifting per repo. It still
          # sets base-hit / head-hit / capture-needed for steps that branch on
          # steps.maps.outputs.*, and it invokes the installed release directly.
          PATH="$PWD/node_modules/.bin:$PATH" node node_modules/styleproof/bin/styleproof-ci.mjs --base "\${{ github.event.pull_request.base.sha }}" --head "\${{ github.event.pull_request.head.sha }}" --spec ${specPath} --base-dir "\${{ runner.temp }}/styleproof-maps"
      - uses: BenSheridanEdwards/StyleProof@v4
        with:
          baseline-dir: \${{ runner.temp }}/styleproof-maps/base
          fresh-dir: \${{ runner.temp }}/styleproof-maps/head
          require-approval: true

  prune:
    # PR closed: drop its pr-<n>/ folder from the report branch so the branch
    # never grows without bound. Keep BRANCH in sync with the report-branch
    # input above (default: styleproof-reports).
    if: github.event.action == 'closed'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Prune this PR's report folder
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
          BRANCH: styleproof-reports
          PR: \${{ github.event.pull_request.number }}
        run: |
          set -euo pipefail
          REMOTE="https://x-access-token:\${GH_TOKEN}@github.com/\${{ github.repository }}.git"
          if ! git ls-remote --exit-code "$REMOTE" "refs/heads/$BRANCH" >/dev/null 2>&1; then
            echo "No $BRANCH branch yet — nothing to prune."; exit 0
          fi
          TMP="$(mktemp -d)"
          # Blobless clone keeps this fast; a very large report branch may prefer
          # a --no-checkout plumbing rewrite instead.
          git clone --filter=blob:none --single-branch --branch "$BRANCH" "$REMOTE" "$TMP"
          cd "$TMP"
          if [ ! -d "pr-$PR" ]; then
            echo "No pr-$PR/ folder — nothing to prune."; exit 0
          fi
          git config user.name  "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git rm -r --quiet "pr-$PR"
          git commit -m "chore(styleproof): prune report for closed PR #$PR"
          git push origin "$BRANCH"
      - name: Prune this PR's head map from the map store
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
          BRANCH: styleproof-maps
          REPO: \${{ github.repository }}
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
          DEFAULT_BRANCH: \${{ github.event.repository.default_branch }}
        run: |
          set -euo pipefail
          # The map store grows one \`<sha>/\` folder per pushed commit and never shrank.
          # On close, drop this PR's head-SHA maps — UNLESS that SHA landed on the default
          # branch (a fast-forward / rebase merge), where it is now the base-tip map every
          # later PR restores. A squash / merge-commit close orphans the head SHA, so it is
          # safe to reclaim. Fail safe: any uncertainty keeps the map.
          status="$(gh api "repos/$REPO/compare/$HEAD_SHA...$DEFAULT_BRANCH" --jq .status 2>/dev/null || echo unknown)"
          case "$status" in
            ahead|identical|behind|unknown)
              echo "Head $HEAD_SHA is on $DEFAULT_BRANCH (or status unknown: '$status') — keeping its map."
              exit 0 ;;
          esac
          REMOTE="https://x-access-token:\${GH_TOKEN}@github.com/$REPO.git"
          if ! git ls-remote --exit-code "$REMOTE" "refs/heads/$BRANCH" >/dev/null 2>&1; then
            echo "No $BRANCH branch yet — nothing to prune."; exit 0
          fi
          TMP="$(mktemp -d)"
          # Blobless + no-checkout: fetch the tree metadata only, then sparse-checkout just
          # this one SHA's folder — never download every cached bundle's blobs to delete one.
          git clone --filter=blob:none --no-checkout --single-branch --branch "$BRANCH" "$REMOTE" "$TMP"
          cd "$TMP"
          git sparse-checkout set "$HEAD_SHA"
          git checkout -q "$BRANCH"
          if [ ! -d "$HEAD_SHA" ]; then
            echo "No $HEAD_SHA/ folder — nothing to prune."; exit 0
          fi
          git config user.name  "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git rm -r --quiet "$HEAD_SHA"
          git commit -m "chore(styleproof): prune map for closed PR #\${{ github.event.pull_request.number }} ($HEAD_SHA)"
          git push origin "$BRANCH"
`;

function writeFileSafe(file, contents, { force: f } = {}) {
  const exists = fs.existsSync(file);
  if (exists && !f) return { wrote: false, exists: true };
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, contents);
  return { wrote: true, exists };
}

function ensureGitignoreLine(line) {
  const file = '.gitignore';
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (existing.split(/\r?\n/).includes(line)) return false;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(file, `${existing}${prefix}${line}\n`);
  return true;
}

// Pre-push publish hook — the default fast path. Capture locally at push time and
// publish to the SHA-keyed styleproof-maps branch; CI restores by SHA and stays
// report-only. Maps are NEVER committed to the PR branch: a shared tracked map path
// shows up in every PR's changed files and forces cross-PR rebases on each merge.
//
// The hook file is a thin shim: the refspec/docs-only/capture rules live in the
// packaged styleproof-prepush command, so behavior updates with each styleproof
// release instead of drifting in a copied bash file per consumer.
const HOOK = `#!/bin/sh
# StyleProof pre-push (generated by styleproof-init; refresh with: styleproof-init --hook).
# Capture the pushed commit's map and publish it to the styleproof-maps branch, so CI
# restores it and reports without a browser. Maps never get committed to the PR branch.
# The rules (pushed-refspec selection, docs-only skip, restore-before-capture) live in
# the packaged styleproof-prepush command, which reads git's refspecs from stdin.
#
# A skipped capture is always safe — CI just recaptures on a cache miss:
#   STYLEPROOF_SKIP_CAPTURE=1 git push
[ "\${STYLEPROOF_SKIP_CAPTURE:-}" = "1" ] && exit 0
exec ${PM.exec(`styleproof-prepush --spec ${specPath}`)}
`;

function installPrePushHook({ force: f = false } = {}) {
  const hookDir = fs.existsSync('.husky') ? '.husky' : '.githooks';
  const hookPath = path.join(hookDir, 'pre-push');
  const hook = writeFileSafe(hookPath, HOOK, { force: f });
  if (hook.wrote) {
    fs.chmodSync(hookPath, 0o755);
    console.log(
      `${hook.exists ? 'refreshed' : 'created'} ${hookPath} (pre-push capture → publish via styleproof-prepush; maps never land on the PR branch)`,
    );
    if (hookDir === '.githooks') console.log('  activate with: git config core.hooksPath .githooks');
  } else {
    console.log(`${hookPath} already exists — left untouched (refresh it with: styleproof-init --hook)`);
  }
  return { ...hook, hookPath };
}

// --hook: (re)write ONLY the pre-push hook — the upgrade path for a hook installed
// by an older release (init never overwrites it during a full scaffold, so without
// this a stale copy would outlive every fix shipped to the shim or its flags).
if (hookOnly) {
  installPrePushHook({ force: true });
  process.exit(0);
}

const APPROVE_PATH = '.github/workflows/styleproof-approve.yml';
function readApproveTemplate() {
  const approveSource = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'example',
    'styleproof-approve.yml',
  );
  try {
    return fs.readFileSync(approveSource, 'utf8');
  } catch {
    // Packaged example missing (unexpected) — don't abort the rest of init.
    console.warn(`could not read the approval workflow template at ${approveSource} — skipped`);
    return undefined;
  }
}

// MACHINE-OWNED generated files: their content is fully derived from this release
// plus init's inputs (spec path, package manager), so `--upgrade` may rewrite them
// and `--check` can diff them against the current templates. The capture spec and
// playwright.styleproof.config.ts are USER-owned — never listed here, never touched.
// (Custom spec path? Pass the same --dir you scaffolded with, so the templates
// interpolate the matching path.)
function machineOwnedFiles() {
  const approve = readApproveTemplate();
  const hookDir = fs.existsSync('.husky') ? '.husky' : '.githooks';
  return [
    { file: path.join(hookDir, 'pre-push'), contents: HOOK, executable: true },
    { file: CI_PATH, contents: CI_WORKFLOW },
    ...(approve === undefined ? [] : [{ file: APPROVE_PATH, contents: approve }]),
  ];
}

// --check: report drift between the machine-owned files on disk and this release's
// templates, writing NOTHING. Exit 1 on any drift so a consumer CI step can say
// "a styleproof upgrade changed the generated files — run styleproof-init --upgrade".
if (checkOnly) {
  let stale = 0;
  for (const { file, contents } of machineOwnedFiles()) {
    if (!fs.existsSync(file)) {
      console.log(`missing  ${file}`);
      stale++;
    } else if (fs.readFileSync(file, 'utf8') !== contents) {
      console.log(`stale    ${file}`);
      stale++;
    } else {
      console.log(`current  ${file}`);
    }
  }
  if (stale) {
    console.log(
      `\n${stale} machine-owned file(s) differ from this styleproof release — run: styleproof-init --upgrade`,
    );
    process.exit(1);
  }
  console.log('\nall machine-owned files match this styleproof release');
  process.exit(0);
}

// --upgrade: refresh every machine-owned file to this release's template, leaving
// the user-owned spec and playwright config alone. Idempotent — an already-current
// file is reported, not rewritten.
if (upgrade) {
  for (const { file, contents, executable } of machineOwnedFiles()) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === contents) {
      console.log(`current   ${file}`);
      continue;
    }
    const wrote = writeFileSafe(file, contents, { force: true });
    if (executable) fs.chmodSync(file, 0o755);
    console.log(`${wrote.exists ? 'refreshed' : 'created'} ${file}`);
  }
  console.log('\nmachine-owned files now match this styleproof release (spec and playwright config untouched)');
  process.exit(0);
}

// Choose the scaffold: routes-aware when this is a Next.js app with discoverable
// routes, else the generic one-surface starter.
const routes = discoverNextRoutes(process.cwd());
const isNext = routes.length > 0;
const SPEC = isNext ? NEXT_SPEC : GENERIC_SPEC;

let wroteSomething = false;
// Every path init created or modified this run, so the summary can name exactly what
// it touched — and, by omission, what it did NOT (init never writes package.json or a
// lockfile; that's the package manager's `install`, not this scaffolder).
const touched = [];

const spec = writeFileSafe(specPath, SPEC, { force });
if (spec.wrote) {
  touched.push(specPath);
  console.log(`${spec.exists ? 'overwrote' : 'created'} ${specPath}`);
  if (isNext) {
    const dynamic = routes.filter((r) => r.dynamic).length;
    console.log(
      `  detected ${routes.length} Next.js route(s) — wired surfaces + the \`expected\` coverage guard to them` +
        (dynamic ? ` (${dynamic} dynamic route(s) excluded pending a concrete param)` : ''),
    );
  } else {
    console.log('  no Next.js routes detected — wrote a crawl-by-default spec that captures every');
    console.log('  surface your nav links to from / (nothing to hand-list; the inventory guard is on)');
  }
  wroteSomething = true;
} else {
  console.log(`${specPath} already exists — left untouched (use --force to overwrite)`);
}

const configPath = 'playwright.styleproof.config.ts';
const config = writeFileSafe(configPath, CONFIG, { force });
if (config.wrote) {
  touched.push(configPath);
  console.log(`${config.exists ? 'overwrote' : 'created'} ${configPath} (dedicated StyleProof capture config)`);
  wroteSomething = true;
} else {
  console.log(`${configPath} already exists — left untouched (use --force to overwrite)`);
}
if (fs.existsSync('playwright.config.ts') || fs.existsSync('playwright.config.js')) {
  console.log(
    'app playwright.config exists — left untouched; styleproof-map uses playwright.styleproof.config.ts by default',
  );
}

const ignored = ['.styleproof/', 'test-results/', 'playwright-report/'].filter((line) => ensureGitignoreLine(line));
if (ignored.length) {
  touched.push('.gitignore');
  console.log(`updated .gitignore (${ignored.join(', ')})`);
  wroteSomething = true;
}

// Cache-first CI report — never overwrite an existing workflow.
const ci = writeFileSafe(CI_PATH, CI_WORKFLOW);
if (ci.wrote) {
  touched.push(CI_PATH);
  console.log(`created ${CI_PATH} (cache-first StyleProof report)`);
  wroteSomething = true;
} else {
  console.log(`${CI_PATH} already exists — left untouched`);
}

// Approval gate — the issue_comment handler that flips the StyleProof status when a
// reviewer ticks "Approve all changes". The report workflow above runs with
// `require-approval: true`, so this is what makes the checkbox live; without it the
// gate can never go green. It's a static workflow (no package-manager wiring), so we
// copy the packaged example verbatim rather than regenerate it. GitHub only runs
// issue_comment workflows from the DEFAULT branch, so it activates when the init PR
// merges — writing it to the feature branch now is correct and harmless.
const approveWorkflow = readApproveTemplate();
if (approveWorkflow !== undefined) {
  const approve = writeFileSafe(APPROVE_PATH, approveWorkflow);
  if (approve.wrote) {
    touched.push(APPROVE_PATH);
    console.log(`created ${APPROVE_PATH} (approval gate — active once merged to your default branch)`);
    wroteSomething = true;
  } else {
    console.log(`${APPROVE_PATH} already exists — left untouched`);
  }
}

const hook = installPrePushHook();
if (hook.wrote) {
  touched.push(hook.hookPath);
  wroteSomething = true;
}

if (touched.length) {
  // State exactly what init wrote, and — because adopters have blamed init for the
  // `styleproof` entry their package manager's `install` added — say plainly that it
  // did NOT touch package.json or the lockfile. Truth over assumption.
  console.log(`\nstyleproof-init wrote only: ${touched.join(', ')}`);
  console.log('It did NOT modify package.json or your lockfile (that was your package manager’s install).');
}

console.log('\nHow the gate works — it runs on your first PR with no extra steps:');
console.log('  1. Commit and open a PR. CI captures the base and head surfaces in one pinned');
console.log('     environment and posts the StyleProof report — no local step required.');
console.log('  2. The pre-push hook restores an existing exact-SHA map or captures once and');
console.log('     publishes it to styleproof-maps; CI restores by SHA and generates');
console.log('     the report without a browser. Maps never get committed to the PR branch.');
console.log('     Skip a push that cannot affect render: STYLEPROOF_SKIP_CAPTURE=1 git push');
console.log('  3. Merge this PR. The approval workflow only runs from your default branch, so');
console.log('     the "Approve all changes" checkbox goes live once styleproof-approve.yml is there.');

if (!wroteSomething) console.log('\nnothing to write — project already scaffolded.');
process.exit(0);
