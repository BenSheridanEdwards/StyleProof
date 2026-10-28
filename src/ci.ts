// Decision core of `styleproof-ci`: restore exit triage, the package-manager command
// plans (argv form, never a shell), and the step-output lines consumers branch on.
// The driver (bin/styleproof-ci.mjs) owns the process work.
import fs from 'node:fs';
import path from 'node:path';
import { asRecord, readJsonFile } from './map-store/json.js';

function platformExcludes(constraint: unknown, current: string | undefined): boolean {
  if (!constraint || !current) return false;
  const values = typeof constraint === 'string' ? [constraint] : constraint;
  if (!Array.isArray(values) || !values.every((value) => typeof value === 'string')) return false;
  if (values.length === 1 && values[0] === 'any') return false;
  return (
    values.includes(`!${current}`) || (values.some((value) => !value.startsWith('!')) && !values.includes(current))
  );
}

function currentLibc(): string | undefined {
  const report = asRecord(process.report.getReport());
  if (asRecord(report?.header)?.glibcVersionRuntime) return 'glibc';
  if (!Array.isArray(report?.sharedObjects)) return undefined;
  return report.sharedObjects.some((file) => /\/(?:ld-musl-|libc\.musl-)/.test(file)) ? 'musl' : undefined;
}

type NpmLockfileRecord = NonNullable<ReturnType<typeof asRecord>>;

function absentOptional(expected: NpmLockfileRecord, key: string, cwd: string): boolean {
  return expected.optional === true && key.startsWith('node_modules/') && !fs.existsSync(path.join(cwd, key));
}

function platformExcluded(expected: NpmLockfileRecord): boolean {
  if (platformExcludes(expected.os, process.platform) || platformExcludes(expected.cpu, process.arch)) return true;
  // Only a known libc can prove exclusion; an inconclusive report must run the install.
  return !!expected.libc && process.platform === 'linux' && platformExcludes(expected.libc, currentLibc());
}

function lockfileKey(packages: NpmLockfileRecord, from: string, name: string): string | undefined {
  for (let base = from; ;) {
    const key = `${base ? `${base}/` : ''}node_modules/${name}`;

    if (Object.hasOwn(packages, key)) return key;

    if (!base) return undefined;
    const parent = base.lastIndexOf('/node_modules/');
    base = parent < 0 ? '' : base.slice(0, parent);
  }
}

function dependentsByKey(packages: NpmLockfileRecord): Map<string, string[]> {
  const dependents = new Map<string, string[]>();

  for (const [from, value] of Object.entries(packages)) {
    const entry = asRecord(value);

    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      for (const name of Object.keys(asRecord(entry?.[field]) ?? {})) {
        const key = lockfileKey(packages, from, name);

        if (key === undefined) continue;
        const sources = dependents.get(key) ?? [];
        sources.push(from);
        dependents.set(key, sources);
      }
    }
  }

  return dependents;
}

/** Match installed identities, allowing absent optionals excluded by platform or all dependents; ignore root metadata. */
export function npmLockfilesMatch(
  lockfile: string | undefined,
  hiddenLockfile: string | undefined,
  consumerCwd = process.cwd(),
): boolean {
  try {
    const packages = asRecord(asRecord(JSON.parse(lockfile ?? ''))?.packages);
    const installed = asRecord(asRecord(JSON.parse(hiddenLockfile ?? ''))?.packages);
    if (!packages || !installed) return false;
    const keys = Object.keys(packages).filter((key) => key !== '');
    if (Object.keys(installed).some((key) => key !== '' && !Object.hasOwn(packages, key))) return false;
    const dependents = dependentsByKey(packages);
    const memo = new Map<string, boolean>();

    const excluded = (key: string): boolean => {
      const cached = memo.get(key);

      if (cached !== undefined) return cached;
      memo.set(key, false); // A cycle never proves exclusion.
      const expected = asRecord(packages[key]);
      const from = dependents.get(key) ?? [];

      const result =
        expected !== null &&
        !Object.hasOwn(installed, key) &&
        absentOptional(expected, key, consumerCwd) &&
        (platformExcluded(expected) || (from.length > 0 && from.every(excluded)));

      memo.set(key, result);

      return result;
    };
    return keys.every((key) => {
      const expected = asRecord(packages[key]);
      if (expected === null) return false;

      if (!Object.hasOwn(installed, key)) return excluded(key);
      const actual = asRecord(installed[key]);
      return (
        actual !== null &&
        ['version', 'resolved', 'integrity', 'link'].every(
          (field) =>
            (expected[field] === undefined || typeof expected[field] === (field === 'link' ? 'boolean' : 'string')) &&
            expected[field] === actual[field],
        )
      );
    });
  } catch {
    return false;
  }
}

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

/** Preserve head tarballs and Git specs; other declarations use the running CLI's exact version.
 * Returns the portion after `styleproof@` for the existing exact-install plans. */
export function styleProofRuntimeSpec(
  headPackageJson: {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    optionalDependencies?: Record<string, unknown>;
  },
  headDir: string,
  ownVersion: string,
): string {
  const spec =
    headPackageJson.optionalDependencies?.styleproof ??
    headPackageJson.dependencies?.styleproof ??
    headPackageJson.devDependencies?.styleproof;
  if (typeof spec !== 'string') return ownVersion;
  const local = /^(file:|link:)(.*)$/.exec(spec);
  if (local) {
    return local[1] === 'file:' && /\.(?:tgz|tar\.gz)$/.test(local[2])
      ? `file:${path.resolve(headDir, local[2])}`
      : ownVersion;
  }
  if (/^(?:git(?:\+[^:]+)?:|https?:|ssh:|github:|gitlab:|bitbucket:|git@)/.test(spec)) return spec;
  if (/\.(?:tgz|tar\.gz)$/.test(spec)) {
    return `file:${path.resolve(headDir, spec)}`;
  }
  if (path.isAbsolute(spec) || spec.startsWith('./') || spec.startsWith('../')) return ownVersion;
  if (/^[^@\s/]+\/[^\s]+$/.test(spec)) return spec;
  return ownVersion;
}

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
