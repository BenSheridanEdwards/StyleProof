/** Manifest/git adapter for J2. Capture provenance, never report cwd, anchors source keys. */
import path from 'node:path';
import { readMapManifest } from './map-store/manifest.js';
import { runGit, sha256 } from './node-util.js';
import type { StyleMap } from './capture.js';
import { changedScriptRanges } from './script-join-ranges.js';
import { readScriptGitDiff, readScriptGitBlobs, type ScriptGitFile, type ScriptBlob } from './script-join-git-read.js';
import {
  compareScriptRanges,
  compareSourceKeys,
  scriptJoinGap,
  type ScriptChange,
  type ScriptJoinGap,
} from './script-join.js';

export { changedScriptRanges } from './script-join-ranges.js';

export type ScriptChanges = { changes: ScriptChange[]; gaps: ScriptJoinGap[] };

type Side = 'base' | 'head';

type CaptureRoot = { prefix?: string; keys: Set<string>; gap?: ScriptJoinGap };

type ReadOptions = { cwd?: string; baseMaps?: readonly StyleMap[]; headMaps?: readonly StyleMap[] };

function sourceKey(prefix: string, gitPath: string): string {
  return path.posix.relative(prefix || '.', gitPath);
}

function validPrefix(prefix: unknown): prefix is string {
  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Untrusted capture metadata is parsed here before path APIs; the rest of this guard validates its canonical path contract.
    typeof prefix === 'string' &&
    (prefix === '' ||
      (path.posix.normalize(prefix) === prefix &&
        !/^(?:\/|\.\.(?:\/|$)|[a-z]:)/i.test(prefix) &&
        !prefix.includes('\\')))
  );
}

function captureRoot(maps: readonly StyleMap[], side: Side, paths: string[]): CaptureRoot {
  const evidence = maps.flatMap((map) => (map.scriptReach ? [map.scriptReach] : []));

  const keys = new Set(
    evidence.flatMap((reach) =>
      reach.scripts.flatMap((script) =>
        script.status === 'mapped'
          ? (script.files ?? []).flatMap((file) => (file.sourceKey ? [file.sourceKey] : []))
          : [],
      ),
    ),
  );

  if (!evidence.length) return { keys };
  const prefixes = new Set(evidence.map((reach) => reach.projectRootPrefix));
  const prefix = evidence[0].projectRootPrefix;

  if (prefixes.size !== 1 || !validPrefix(prefix))
    return {
      keys,
      gap: scriptJoinGap(
        `${side} capture project-root prefix missing, invalid or conflicting; recapture scriptReach`,
        side,
      ),
    };

  if (keys.size && paths.length && !paths.some((file) => keys.has(sourceKey(prefix, file))))
    return {
      keys,
      gap: scriptJoinGap(
        `captured source keys on ${side} match no changed path; project-root join cannot be verified`,
        side,
      ),
    };

  return { prefix, keys };
}

type ScriptComparison = { shas: { base: string; head: string }; gaps: ScriptJoinGap[] };

function comparisonShas(beforeDir: string, afterDir: string): ScriptComparison {
  const shas = { base: '', head: '' },
    gaps: ScriptJoinGap[] = [];

  for (const [side, dir] of [
    ['base', beforeDir],
    ['head', afterDir],
  ] as const) {
    try {
      const manifest = readMapManifest(dir);

      if (!manifest || manifest.dirty || !/^[0-9a-f]{7,40}$/i.test(manifest.sha)) throw new Error('SHA unavailable');
      shas[side] = manifest.sha;
    } catch {
      gaps.push(scriptJoinGap(`${side} map SHA unavailable or dirty; changed source ranges cannot be listed`, side));
    }
  }

  return { shas, gaps };
}

function isCandidate(file: ScriptGitFile, roots: Record<Side, CaptureRoot>): boolean {
  return (
    /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i.test(file.path) ||
    (['base', 'head'] as const).some(
      (side) => roots[side].prefix !== undefined && roots[side].keys.has(sourceKey(roots[side].prefix!, file.path)),
    )
  );
}

function hasBlob(file: ScriptGitFile, side: Side): boolean {
  return !/^0+$/.test(file[side]) && file[`${side}Mode`] !== '160000';
}

function changesForFile(
  file: ScriptGitFile,
  roots: Record<Side, CaptureRoot>,
  blobs: Map<string, ScriptBlob>,
): ScriptChanges {
  const texts = { base: '', head: '' },
    hashes = { base: '', head: '' };

  const available = new Set<Side>();
  const gaps: ScriptJoinGap[] = [];

  for (const side of ['base', 'head'] as const) {
    if (roots[side].prefix === undefined || !hasBlob(file, side)) continue;
    const blob = blobs.get(file[side]);

    if (!blob?.content) {
      gaps.push(scriptJoinGap(`${file.path}: ${blob?.reason ?? 'git blob unavailable'}`, side));
      continue;
    }

    const text = blob.content.toString('utf8');

    if (!Buffer.from(text).equals(blob.content)) {
      gaps.push(scriptJoinGap(`${file.path}: git blob is not valid UTF-8; source ranges unmeasured`, side));
      continue;
    }

    texts[side] = text;
    hashes[side] = sha256(blob.content);
    available.add(side);
  }

  const changes = changedScriptRanges(file.patch, texts, file.path)
    .filter((change) => available.has(change.side))
    .map((change) => ({
      ...change,
      sourceKey: sourceKey(roots[change.side].prefix!, file.path),
      contentHash: hashes[change.side],
    }));

  return { changes, gaps };
}

function joinFiles(
  repository: string,
  files: ScriptGitFile[],
  maps: { base: readonly StyleMap[]; head: readonly StyleMap[] },
): ScriptChanges {
  const paths = files.map((file) => file.path);
  const roots = { base: captureRoot(maps.base, 'base', paths), head: captureRoot(maps.head, 'head', paths) };
  const gaps = (['base', 'head'] as const).flatMap((side) => (roots[side].gap ? [roots[side].gap!] : []));

  const candidates = files.filter(
    (file) =>
      isCandidate(file, roots) && ![file.baseMode, file.headMode].includes('160000') && /^@@ /m.test(file.patch),
  );

  const ids = [
    ...new Set(
      candidates.flatMap((file) =>
        (['base', 'head'] as const).flatMap((side) =>
          roots[side].prefix !== undefined && hasBlob(file, side) ? [file[side]] : [],
        ),
      ),
    ),
  ].sort();

  const blobs = readScriptGitBlobs(repository, ids);

  const changes: ScriptChange[] = [],
    unjudged = new Set(paths);

  for (const file of candidates) {
    const result = changesForFile(file, roots, blobs);
    changes.push(...result.changes);
    gaps.push(...result.gaps);

    if (result.changes.length && !result.gaps.length) unjudged.delete(file.path);
  }

  if (unjudged.size) {
    const paths = [...unjudged].sort(compareSourceKeys);
    gaps.push({ ...scriptJoinGap(`changed files J2 does not judge: ${paths.join(', ')}`), paths });
  }

  return { changes: changes.sort(compareScriptRanges), gaps };
}

/** No git or manifest reads when J2 was never recorded. The existing J1 opt-in behavior is unchanged. */
export function readScriptChanges(beforeDir: string, afterDir: string, options: ReadOptions = {}): ScriptChanges {
  const maps = { base: options.baseMaps ?? [], head: options.headMaps ?? [] };

  if (![...maps.base, ...maps.head].some((map) => map.scriptReach)) return { changes: [], gaps: [] };
  const { shas, gaps } = comparisonShas(beforeDir, afterDir);

  if (gaps.length) return { changes: [], gaps };
  const cwd = options.cwd ?? process.cwd();
  const root = runGit(cwd, ['rev-parse', '--show-toplevel'], { timeout: 10_000 });

  if (root.status !== 0)
    return {
      changes: [],
      gaps: [scriptJoinGap('git source diff unavailable; retain both captured revisions in the checkout')],
    };

  try {
    const repository = root.stdout.trim();

    return joinFiles(repository, readScriptGitDiff(repository, shas.base, shas.head), maps);
  } catch {
    return {
      changes: [],
      gaps: [scriptJoinGap('git source diff unavailable; retain both captured revisions in the checkout')],
    };
  }
}
