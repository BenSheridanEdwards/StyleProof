/**
 * Decision core of the `styleproof-ci` command — the packaged form of the
 * restore → capture-on-miss → HAR-replay → publish orchestration that the
 * init-generated workflow used to carry as ~80 lines of copied bash (and every
 * consumer then hand-maintained, drifting, per repo).
 *
 * The driver (bin/styleproof-ci.mjs) owns the process work: checkouts, package
 * installs, spawning styleproof-map. Everything decidable without side effects
 * lives here so it is unit-testable:
 *   - restore exit-code triage (0 = hit, 4 = genuine miss, anything else is a
 *     PERSISTENT map-store/network fault to fail loudly on — a re-run is cheap
 *     and correct; silently paying a full cold recapture on every flaky network
 *     blip is not);
 *   - the package-manager command plans (runtime lockfile detection, argv form —
 *     no shell), including the cold path's exact-release install: the base may
 *     depend on an older StyleProof, so after the base's own install the head's
 *     exact release is installed and the metadata files that temporary install
 *     dirtied are restored, keeping the capture tree clean;
 *   - the step-output lines CI consumers branch on.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Triage of a `styleproof-map --restore` exit code (see that CLI's taxonomy). */
export type RestoreOutcome = 'hit' | 'miss' | 'fault';

export function classifyRestoreExit(code: number | null | undefined): RestoreOutcome {
  if (code === 0) return 'hit';
  if (code === 4) return 'miss';
  return 'fault';
}

/** One package manager's commands, as argv arrays (never joined through a shell). */
export type PackageManagerPlan = {
  name: 'npm' | 'yarn' | 'yarn-berry' | 'pnpm' | 'bun';
  /** Frozen-lockfile install of the checked-out commit's dependencies. */
  install: string[];
  /** Install the head's exact StyleProof release over the base's older one. */
  installExactStyleProof: (version: string) => string[];
  /** Tracked files that exact install may have dirtied; the driver restores each
   *  with `git checkout --` (npm's --no-save/--package-lock=false dirties none). */
  packageMetadataFiles: string[];
};

/** True when the checkout is a Yarn 2+ (Berry) repo: a `.yarnrc.yml`, or a
 *  `packageManager` field pinning yarn at major ≥ 2. An unreadable/unparsable
 *  package.json reads as "not Berry" — the yarn-1 fallback then fails with
 *  yarn's own message rather than this detector guessing. */
function isYarnBerry(root: string): boolean {
  if (fs.existsSync(path.join(root, '.yarnrc.yml'))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      packageManager?: unknown;
    };
    const pinned = typeof pkg.packageManager === 'string' ? /^yarn@(\d+)/.exec(pkg.packageManager) : null;
    return pinned !== null && Number(pinned[1]) >= 2;
  } catch {
    return false;
  }
}

/** Runtime twin of styleproof-init's lockfile detection: the workflow template no
 *  longer bakes package-manager commands in at scaffold time — the command reads
 *  the checked-out repo, so a later npm→pnpm migration needs no re-init. */
export function detectPackageManagerPlan(root: string): PackageManagerPlan {
  const has = (file: string) => fs.existsSync(path.join(root, file));
  if (has('bun.lock') || has('bun.lockb')) {
    return {
      name: 'bun',
      install: ['bun', 'install', '--frozen-lockfile'],
      installExactStyleProof: (version) => ['bun', 'add', '--dev', '--exact', `styleproof@${version}`],
      packageMetadataFiles: ['package.json', ...['bun.lock', 'bun.lockb'].filter(has)],
    };
  }
  if (has('pnpm-lock.yaml')) {
    return {
      name: 'pnpm',
      install: ['pnpm', 'install', '--frozen-lockfile'],
      installExactStyleProof: (version) => ['pnpm', 'add', '--save-dev', '--save-exact', `styleproof@${version}`],
      packageMetadataFiles: ['package.json', 'pnpm-lock.yaml'],
    };
  }
  if (has('yarn.lock')) {
    // Yarn Berry (2+): pinning yarn 1 either refuses outright (the repo's
    // `packageManager` field) or cannot parse the Berry lockfile — every
    // base-miss run would fail. Berry repos declare themselves via .yarnrc.yml
    // or `packageManager: "yarn@<2+>"`; drive those through corepack, which
    // reads that same field and provisions the pinned release.
    if (isYarnBerry(root)) {
      return {
        name: 'yarn-berry',
        install: ['corepack', 'yarn', 'install', '--immutable'],
        installExactStyleProof: (version) => ['corepack', 'yarn', 'add', '--dev', '--exact', `styleproof@${version}`],
        packageMetadataFiles: [
          'package.json',
          'yarn.lock',
          ...['.pnp.cjs', '.pnp.loader.mjs', '.pnp.data.json'].filter(has),
        ],
      };
    }
    return {
      name: 'yarn',
      install: ['npx', '-y', 'yarn@1.22.22', 'install', '--frozen-lockfile', '--non-interactive'],
      installExactStyleProof: (version) => [
        'npx',
        '-y',
        'yarn@1.22.22',
        'add',
        '--dev',
        '--exact',
        `styleproof@${version}`,
      ],
      packageMetadataFiles: ['package.json', 'yarn.lock'],
    };
  }
  return {
    name: 'npm',
    install: ['npm', 'ci'],
    installExactStyleProof: (version) => [
      'npm',
      'install',
      '--no-save',
      '--package-lock=false',
      `styleproof@${version}`,
    ],
    packageMetadataFiles: [],
  };
}

/** The `$GITHUB_OUTPUT` lines the old workflow step emitted, verbatim, so existing
 *  consumer steps keyed on `steps.maps.outputs.*` keep working after the collapse. */
export function ciOutputLines(baseHit: boolean, headHit: boolean, baseCaptureFailed = false): string[] {
  return [
    `base-hit=${baseHit}`,
    `head-hit=${headHit}`,
    `capture-needed=${!(baseHit && headHit)}`,
    `base-capture-failed=${baseCaptureFailed}`,
  ];
}
