import fs from 'node:fs';
import path from 'node:path';
import { loadStyleMap, type StyleMap } from './capture.js';

/**
 * Structured diff between two style maps. Custom properties (--*) are
 * ignored: they are inputs, not outcomes — every visual effect of a variable
 * lands in a real longhand which is compared in full.
 */

export type PropChange = { prop: string; before: string; after: string };

export type Finding =
  | { kind: 'dom'; path: string; cls: string; change: 'added' | 'removed' | 'retagged'; detail?: string }
  | { kind: 'style'; path: string; cls: string; pseudo: string | null; props: PropChange[] }
  | { kind: 'state'; path: string; cls: string; state: string; sub: string; props: PropChange[] };

export type SurfaceDiff = {
  surface: string;
  /** Set when the surface was captured in only one of the two sets. */
  missing?: 'before' | 'after';
  findings: Finding[];
};

export type DiffCounts = { dom: number; style: number; state: number };

function diffProps(
  propsA: Record<string, string>,
  propsB: Record<string, string>,
  fallbackA: Record<string, string>,
  fallbackB: Record<string, string>,
  unsetA: string,
  unsetB: string,
): PropChange[] {
  const changed: PropChange[] = [];
  for (const prop of new Set([...Object.keys(propsA), ...Object.keys(propsB)])) {
    if (prop.startsWith('--')) continue;
    const before = propsA[prop] ?? fallbackA[prop] ?? unsetA;
    const after = propsB[prop] ?? fallbackB[prop] ?? unsetB;
    if (before !== after) changed.push({ prop, before, after });
  }
  return changed;
}

/** Diff two style maps of the same surface. */
export function diffStyleMaps(a: StyleMap, b: StyleMap): Finding[] {
  const findings: Finding[] = [];

  for (const p of [...new Set([...Object.keys(a.elements), ...Object.keys(b.elements)])].sort()) {
    const ea = a.elements[p];
    const eb = b.elements[p];
    if (!ea || !eb) {
      findings.push({ kind: 'dom', path: p, cls: (ea ?? eb)!.cls, change: !ea ? 'added' : 'removed' });
      continue;
    }
    if (ea.tag !== eb.tag) {
      findings.push({ kind: 'dom', path: p, cls: ea.cls, change: 'retagged', detail: `<${ea.tag}> → <${eb.tag}>` });
      continue;
    }
    const defsA = a.defaults[ea.tag] ?? {};
    const defsB = b.defaults[eb.tag] ?? {};
    for (const pseudo of [null, ...new Set([...Object.keys(ea.pseudo ?? {}), ...Object.keys(eb.pseudo ?? {})])]) {
      const propsA = pseudo ? (ea.pseudo?.[pseudo] ?? {}) : ea.style;
      const propsB = pseudo ? (eb.pseudo?.[pseudo] ?? {}) : eb.style;
      // A pseudo-element is pruned against its own UA defaults (capture stores
      // them under a composite `tag::pseudo` key); fall back to the element's
      // tag defaults for maps written before that fix.
      const pdefsA = pseudo ? (a.defaults[ea.tag + pseudo] ?? defsA) : defsA;
      const pdefsB = pseudo ? (b.defaults[eb.tag + pseudo] ?? defsB) : defsB;
      const props = diffProps(propsA, propsB, pdefsA, pdefsB, '(unset)', '(unset)');
      if (props.length) findings.push({ kind: 'style', path: p, cls: ea.cls, pseudo, props });
    }
  }

  // If the forced-state layer was skipped on exactly one side (CDP skew during
  // that capture), the :hover/:focus/:active layer was not compared — flag it
  // loudly rather than letting {} vs {} read as "identical".
  if (!!a.statesSkipped !== !!b.statesSkipped) {
    findings.push({
      kind: 'state',
      path: '(surface)',
      cls: '',
      state: 'forced-state capture',
      sub: '(surface)',
      props: [
        {
          prop: 'forced :hover/:focus/:active layer',
          before: a.statesSkipped ? 'skipped (CDP skew)' : 'captured',
          after: b.statesSkipped ? 'skipped (CDP skew)' : 'captured',
        },
      ],
    });
  }

  for (const p of new Set([...Object.keys(a.states ?? {}), ...Object.keys(b.states ?? {})])) {
    const sa = a.states?.[p] ?? {};
    const sb = b.states?.[p] ?? {};
    const cls = (a.elements[p] ?? b.elements[p])?.cls ?? '';
    for (const state of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      const da = sa[state] ?? {};
      const db = sb[state] ?? {};
      for (const sub of new Set([...Object.keys(da), ...Object.keys(db)])) {
        const props = diffProps(
          da[sub] ?? {},
          db[sub] ?? {},
          {},
          {},
          '(state does not change it)',
          '(state no longer changes it)',
        );
        if (props.length) findings.push({ kind: 'state', path: p, cls, state, sub, props });
      }
    }
  }

  return findings;
}

function indexDir(dir: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter((f) => /\.json(\.gz)?$/.test(f))
      .map((f) => [f.replace(/\.json(\.gz)?$/, ''), path.join(dir, f)]),
  );
}

/** Diff every same-named capture between two directories. */
export function diffStyleMapDirs(dirA: string, dirB: string): { surfaces: SurfaceDiff[]; counts: DiffCounts } {
  const indexA = indexDir(dirA);
  const indexB = indexDir(dirB);
  const names = [...new Set([...Object.keys(indexA), ...Object.keys(indexB)])].sort();
  if (names.length === 0) throw new Error(`no .json(.gz) captures found in ${dirA} or ${dirB}`);

  const surfaces: SurfaceDiff[] = [];
  const counts: DiffCounts = { dom: 0, style: 0, state: 0 };
  for (const surface of names) {
    if (!indexA[surface] || !indexB[surface]) {
      // A surface present on only one side has no baseline to diff against — it's
      // a NEW surface, not a style change. It does NOT count toward the change
      // tallies (those drive the review gate); the consumer flags it separately
      // off the `missing` marker and shows it for reference without blocking.
      surfaces.push({ surface, missing: indexA[surface] ? 'after' : 'before', findings: [] });
      continue;
    }
    const findings = diffStyleMaps(loadStyleMap(indexA[surface]), loadStyleMap(indexB[surface]));
    for (const f of findings) {
      if (f.kind === 'dom') counts.dom++;
      else if (f.kind === 'style') counts.style += f.props.length;
      else counts.state += f.props.length;
    }
    if (findings.length) surfaces.push({ surface, findings });
  }
  return { surfaces, counts };
}

/** Human label: structural path plus a truncated class hint. */
export function findingLabel(path: string, cls: string): string {
  if (!cls) return path;
  const classes = cls.split(' ').filter(Boolean);
  return `${path}  (.${classes.slice(0, 3).join('.')}${classes.length > 3 ? '…' : ''})`;
}
