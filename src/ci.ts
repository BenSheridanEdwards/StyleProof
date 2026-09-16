// Decision core of `styleproof-ci`: restore exit triage, the package-manager command
// plans (argv form, never a shell), and the step-output lines consumers branch on.
// The driver (bin/styleproof-ci.mjs) owns the process work.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile } from './map-store/json.js';

/** Triage of a `styleproof-map --restore` exit code: 0 hit, 4 genuine miss, else a loud fault. */
export type RestoreOutcome = 'hit' | 'miss' | 'fault';

export function classifyRestoreExit(code: number | null | undefined): RestoreOutcome {
  return code === 0 ? 'hit' : code === 4 ? 'miss' : 'fault';
}

/** One package manager's commands, as argv arrays (never joined through a shell). */
export type PackageManagerPlan = {
  name: 'npm' | 'yarn' | 'yarn-berry' | 'pnpm' | 'bun';
  /** Frozen-lockfile install of the checked-out commit's dependencies. */
  install: string[];
  /** Install the head's exact StyleProof release over the base's older one. npm uses
   *  `runtimeRoot` as an isolated prefix so it cannot re-resolve application ranges. */
  installExactStyleProof: (version: string, runtimeRoot: string) => string[];
  /** Isolated package to link over the base checkout's StyleProof (npm only; others null). */
  isolatedStyleProofPackage: (runtimeRoot: string) => string | null;
  /** Tracked files the exact install may have dirtied; the driver restores each with `git checkout --`. */
  packageMetadataFiles: string[];
};

/** Yarn 2+ (Berry): a `.yarnrc.yml`, or `packageManager` pinning yarn at major ≥ 2. */
function isYarnBerry(root: string): boolean {
  if (fs.existsSync(path.join(root, '.yarnrc.yml'))) return true;
  const pinned = readJsonFile<{ packageManager?: unknown }>(path.join(root, 'package.json'))?.packageManager;
  const major = typeof pinned === 'string' ? /^yarn@(\d+)/.exec(pinned) : null;
  return major !== null && Number(major[1]) >= 2;
}

type Has = (file: string) => boolean;
type InPlacePlan = {
  name: Exclude<PackageManagerPlan['name'], 'npm'>;
  detect: (has: Has, root: string) => boolean;
  install: string;
  addExact: string;
  metadata: (has: Has) => string[];
};

const YARN1 = 'npx -y yarn@1.22.22';
const PNP_FILES = ['.pnp.cjs', '.pnp.loader.mjs', '.pnp.data.json'];

/** Lockfile detection in priority order (bun > pnpm > yarn); npm is the fallback. Berry
 *  refuses yarn 1 and yarn 1 cannot parse its lockfile, so corepack provisions the pinned release. */
const IN_PLACE_PLANS: InPlacePlan[] = [
  {
    name: 'bun',
    detect: (has) => has('bun.lock') || has('bun.lockb'),
    install: 'bun install --frozen-lockfile',
    addExact: 'bun add --dev --exact',
    metadata: (has) => ['package.json', ...['bun.lock', 'bun.lockb'].filter(has)],
  },
  {
    name: 'pnpm',
    detect: (has) => has('pnpm-lock.yaml'),
    install: 'pnpm install --frozen-lockfile',
    addExact: 'pnpm add --save-dev --save-exact',
    metadata: () => ['package.json', 'pnpm-lock.yaml'],
  },
  {
    name: 'yarn-berry',
    detect: (has, root) => has('yarn.lock') && isYarnBerry(root),
    install: 'corepack yarn install --immutable',
    addExact: 'corepack yarn add --dev --exact',
    metadata: (has) => ['package.json', 'yarn.lock', ...PNP_FILES.filter(has)],
  },
  {
    name: 'yarn',
    detect: (has) => has('yarn.lock'),
    install: `${YARN1} install --frozen-lockfile --non-interactive`,
    addExact: `${YARN1} add --dev --exact`,
    metadata: () => ['package.json', 'yarn.lock'],
  },
];

/** Runtime lockfile detection: the checked-out repo decides, so a later npm→pnpm migration needs no re-init. */
export function detectPackageManagerPlan(root: string): PackageManagerPlan {
  const has: Has = (file) => fs.existsSync(path.join(root, file));
  const plan = IN_PLACE_PLANS.find((candidate) => candidate.detect(has, root));
  if (plan) {
    return {
      name: plan.name,
      install: plan.install.split(' '),
      installExactStyleProof: (version) => [...plan.addExact.split(' '), `styleproof@${version}`],
      isolatedStyleProofPackage: () => null,
      packageMetadataFiles: plan.metadata(has),
    };
  }
  return {
    name: 'npm',
    install: ['npm', 'ci'],
    installExactStyleProof: (version, runtimeRoot) => [
      ...'npm install --prefix'.split(' '),
      runtimeRoot,
      '--no-save',
      '--package-lock=false',
      `styleproof@${version}`,
    ],
    isolatedStyleProofPackage: (runtimeRoot) => path.join(runtimeRoot, 'node_modules', 'styleproof'),
    packageMetadataFiles: [],
  };
}

/** The `$GITHUB_OUTPUT` lines consumer steps key on. `base-restored-from-ancestor=<sha>` is
 *  appended only on ancestor reuse; the original four lines never change shape. */
export function ciOutputLines(
  baseHit: boolean,
  headHit: boolean,
  baseCaptureFailed = false,
  baseRestoredFromAncestorSha = '',
): string[] {
  return [
    `base-hit=${baseHit}`,
    `head-hit=${headHit}`,
    `capture-needed=${!(baseHit && headHit)}`,
    `base-capture-failed=${baseCaptureFailed}`,
    ...(baseRestoredFromAncestorSha ? [`base-restored-from-ancestor=${baseRestoredFromAncestorSha}`] : []),
  ];
}
