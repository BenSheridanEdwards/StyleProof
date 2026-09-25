/**
 * CI selective remap (opt-in, fail-closed). Turns an affected-surfaces verdict into
 * a capture plan: re-capture the scoped set and reuse base maps for the rest, or
 * fall back to a full remap whenever anything is missing, invalid, or unbounded.
 *
 * Soft-pass HOLD: this never soft-greens. A full-remap fallback still captures;
 * compare stays fail-closed on real diffs. Default (opt-in off) is full remap.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { affectedSurfaces, classifyStyleChange, type AffectedSurfaces } from './affected-surfaces.js';
import { resolveStyleProofConfigPath } from './config.js';
import type { AffectedConfig } from './config/schema.js';

export type SelectiveRemapMode = 'full' | 'selective';

export type SelectiveRemapPlan = {
  mode: SelectiveRemapMode;
  /** Whether the consumer opted in (env and/or config). */
  optIn: boolean;
  /** Surface keys to re-capture. On `full`, equals `allSurfaces` (every declared key). */
  recapture: string[];
  /** Surface keys reused from base. Empty on `full`. */
  reuse: string[];
  /** Why `mode` is `full` (or empty when selective). Always set when falling closed. */
  reason: string;
};

export type DecideSelectiveRemapInput = {
  optIn: boolean;
  /** True when a usable base map directory is present for this CI run. */
  basePresent: boolean;
  /** Declared surface keys (typically `affected.surfaces` keys), sorted for stable logs. */
  allSurfaces: readonly string[];
  /**
   * Engine verdict, or `null` when the verdict could not be computed (missing/invalid
   * graph, surfaces map, changed files, etc.). `null` fails closed to full remap.
   */
  verdict: AffectedSurfaces | null;
  /** Optional explanation when `verdict` is `'all'` or `null`. */
  verdictReason?: string;
  /**
   * Surface keys present in the base map dir (filename stem before `@`). When provided
   * on a scoped verdict, any reuse key absent from base fails closed to full remap.
   */
  baseSurfaceKeys?: ReadonlySet<string> | null;
};

/** Env truthy values for STYLEPROOF_SELECTIVE_REMAP. */
const OPT_IN_TRUE = new Set(['1', 'true', 'yes', 'on']);
const OPT_IN_FALSE = new Set(['0', 'false', 'no', 'off']);

/**
 * Opt-in gate: env `STYLEPROOF_SELECTIVE_REMAP` beats config `affected.selectiveRemap`.
 * Default is OFF — CI captures every surface (today's behaviour).
 */
export function resolveSelectiveRemapOptIn(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  affectedConfig: { selectiveRemap?: boolean } | undefined,
): boolean {
  const raw = env.STYLEPROOF_SELECTIVE_REMAP;
  if (raw != null && String(raw).trim() !== '') {
    const v = String(raw).trim().toLowerCase();
    if (OPT_IN_TRUE.has(v)) return true;
    if (OPT_IN_FALSE.has(v)) return false;
    // Malformed env: fail closed to OFF (never invent selective under-capture).
    return false;
  }
  return affectedConfig?.selectiveRemap === true;
}

/** Pure decision: opt-in + base + verdict → capture plan. Wrong only in the safe direction. */
export function decideSelectiveRemap(input: DecideSelectiveRemapInput): SelectiveRemapPlan {
  const all = [...input.allSurfaces].sort();
  const full = (reason: string): SelectiveRemapPlan => ({
    mode: 'full',
    optIn: input.optIn,
    recapture: all,
    reuse: [],
    reason,
  });

  if (!input.optIn) return full('opt-in off');
  if (all.length === 0) return full('affected surfaces map empty or missing');
  if (!input.basePresent) return full('base missing or unusable');
  if (input.verdict == null) {
    return full(input.verdictReason?.trim() || 'affected verdict unavailable');
  }
  if (input.verdict === 'all') {
    return full(input.verdictReason?.trim() || 'unbounded affected verdict');
  }

  const affected = input.verdict;
  const recapture = [...affected].filter((k) => all.includes(k)).sort();
  const reuse = all.filter((k) => !affected.has(k));

  if (input.baseSurfaceKeys) {
    const missing = reuse.filter((k) => !input.baseSurfaceKeys!.has(k));
    if (missing.length > 0) {
      return full(`base missing maps for reuse surface(s): ${missing.join(', ')}`);
    }
  }

  return { mode: 'selective', optIn: true, recapture, reuse, reason: '' };
}

/** CI-log lines: selective ON/OFF, recapture/reuse counts, reason when full. */
export function formatSelectiveRemapPlan(plan: SelectiveRemapPlan): string {
  if (plan.mode === 'selective') {
    return [
      `selective remap: ON → re-capture ${plan.recapture.length}, reuse ${plan.reuse.length} from base`,
      ...plan.recapture.map((k) => `  ↻ ${k} (re-capture)`),
      ...plan.reuse.map((k) => `  ✓ ${k} (reuse base map)`),
    ].join('\n');
  }
  const why = plan.reason ? ` — ${plan.reason}` : '';
  return [
    `selective remap: OFF → re-capture all ${plan.recapture.length} surface(s)${why}`,
    ...plan.recapture.map((k) => `  ↻ ${k} (re-capture)`),
  ].join('\n');
}

/** Surface key from a capture artifact name (`home@1280.json.gz` → `home`). */
export function surfaceKeyFromArtifactName(name: string): string | null {
  const m = /^(.*)@\d+\.(?:json(?:\.gz)?|png|(?:hover|focus|active)\.png)$/.exec(name);
  return m ? m[1] : null;
}

/** True when `key` is in `only` or is a variant of a key in `only` (`dashboard-loading`). */
export function surfaceMatchesOnlySet(key: string, only: ReadonlySet<string>): boolean {
  if (only.has(key)) return true;
  for (const root of only) {
    if (root && key.startsWith(`${root}-`)) return true;
  }
  return false;
}

/**
 * Parse `STYLEPROOF_ONLY_SURFACES`. `undefined` → `null` (capture all, today's default).
 * Any other value (including `''`) → a Set (possibly empty = capture no surface tests;
 * coverage ledger + browser-build tests still run under the capture describe).
 */
export function parseOnlySurfacesEnv(envValue: string | undefined): Set<string> | null {
  if (envValue === undefined) return null;
  return new Set(
    String(envValue)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Copy base capture artifacts for `reuseKeys` into `toDir`. Only owned capture
 * artifacts whose surface key matches a reuse key (or its variants) are copied.
 */
export function copyReuseSurfaceArtifacts(options: { fromDir: string; toDir: string; reuseKeys: readonly string[] }): {
  copied: number;
} {
  const reuse = new Set(options.reuseKeys);
  if (reuse.size === 0 || !fs.existsSync(options.fromDir)) return { copied: 0 };
  fs.mkdirSync(options.toDir, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(options.fromDir)) {
    // Only @width capture artifacts (maps/screenshots) — avoid importing map-store
    // here so CI selective-remap cannot enter a capture/map-store ESM cycle on load.
    const key = surfaceKeyFromArtifactName(name);
    if (!key || !surfaceMatchesOnlySet(key, reuse)) continue;
    fs.copyFileSync(path.join(options.fromDir, name), path.join(options.toDir, name));
    copied += 1;
  }
  return { copied };
}

/** Surface keys that have at least one map/`@width` artifact in `dir`. */
export function surfaceKeysInMapDir(dir: string): Set<string> {
  const keys = new Set<string>();
  if (!fs.existsSync(dir)) return keys;
  for (const name of fs.readdirSync(dir)) {
    const key = surfaceKeyFromArtifactName(name);
    if (key) keys.add(key);
  }
  return keys;
}

/** Env vars styleproof-map honors for a selective head capture. Empty when mode is full. */
export function selectiveCaptureEnv(plan: SelectiveRemapPlan, baseMapsDir: string): Record<string, string> {
  if (plan.mode !== 'selective') return {};
  return {
    STYLEPROOF_ONLY_SURFACES: plan.recapture.join(','),
    STYLEPROOF_REUSE_FROM: baseMapsDir,
  };
}

export type AffectedVerdictAttempt = {
  surfaces: Record<string, string>;
  verdict: AffectedSurfaces | null;
  reason: string;
};

/**
 * Load `affected.*` inputs and run the engine. Any missing/invalid input yields
 * `verdict: null` with a loud reason — callers fail closed to full remap.
 */
export function tryComputeAffectedVerdict(options: {
  root: string;
  baseSha: string;
  headSha: string;
  affected: AffectedConfig | undefined;
  configDir: string;
}): AffectedVerdictAttempt {
  const affected = options.affected ?? {};
  const surfaces = { ...(affected.surfaces ?? {}) };
  if (Object.keys(surfaces).length === 0) {
    return { surfaces, verdict: null, reason: 'affected.surfaces missing or empty' };
  }
  if (!affected.graph) {
    return { surfaces, verdict: null, reason: 'affected.graph missing' };
  }
  const graphPath = resolveStyleProofConfigPath(affected.graph, options.configDir);
  let cruise: {
    modules?: Array<{ source: string; dependencies?: Array<{ resolved: string; dynamic?: boolean }> }>;
  };
  try {
    cruise = JSON.parse(fs.readFileSync(path.resolve(options.root, graphPath), 'utf8')) as typeof cruise;
  } catch (error) {
    return {
      surfaces,
      verdict: null,
      reason: `affected.graph unreadable (${graphPath}): ${(error as Error).message}`,
    };
  }
  if (!Array.isArray(cruise?.modules)) {
    return { surfaces, verdict: null, reason: `affected.graph has no modules[] (${graphPath})` };
  }
  const graph = cruise.modules.flatMap((m) =>
    (m.dependencies ?? []).map((d) => ({ from: m.source, to: d.resolved, dynamic: d.dynamic })),
  );
  const files = cruise.modules.map((m) => m.source);

  const diff = spawnSync('git', ['diff', '--name-only', options.baseSha, options.headSha], {
    cwd: options.root,
    encoding: 'utf8',
  });
  if (diff.status !== 0) {
    return {
      surfaces,
      verdict: null,
      reason: `git diff --name-only ${options.baseSha.slice(0, 12)} ${options.headSha.slice(0, 12)} failed`,
    };
  }
  let changedFiles = diff.stdout.split(/\r?\n/).filter(Boolean);
  try {
    const toplevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: options.root,
      encoding: 'utf8',
    });
    if (toplevel.status === 0) {
      const real = (p: string) => {
        try {
          return fs.realpathSync(p);
        } catch {
          return path.resolve(p);
        }
      };
      const prefix = path.relative(real(toplevel.stdout.trim()), real(options.root)).split(path.sep).join('/');
      if (prefix && !prefix.startsWith('..')) {
        changedFiles = changedFiles.map((f) => (f.startsWith(`${prefix}/`) ? f.slice(prefix.length + 1) : f));
      }
    }
  } catch {
    // keep repo-root-relative paths
  }

  const readFile = (p: string) => fs.readFileSync(path.resolve(options.root, p), 'utf8');
  try {
    const verdict = affectedSurfaces({ changedFiles, surfaces, graph, files, readFile });
    const culprit =
      verdict === 'all' ? changedFiles.find((f) => classifyStyleChange(f, readFile) === 'all') : undefined;
    const reason = culprit ? `${culprit} could not be proven local (global/config/unreadable)` : '';
    return { surfaces, verdict, reason };
  } catch (error) {
    return { surfaces, verdict: null, reason: `affectedSurfaces failed: ${(error as Error).message}` };
  }
}
