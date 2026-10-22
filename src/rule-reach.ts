/**
 * Change Reach J1 (#995): which changed served CSS rules did a captured state render?
 *
 * Reads the served-rule ledgers captureReach records (`StyleMap.reach`) on both sides
 * and classifies every rule key whose served bodies differ between them. A side can
 * serve one key with different bodies on different surfaces (route-split stylesheets),
 * so each distinct body is compared on its own: every body only head serves must have
 * matched on head; when head serves no new body, every body only base serves must have
 * matched on base. Pure: no browser, no I/O.
 *
 * Statuses:
 * - `reached`         a captured state matched each changed body (and every consumer of a
 *                     custom property it changed);
 * - `never-rendered`  some changed body never matched; `condition` names the at-rules gating it;
 * - `blind-channel`   a `@keyframes`/`@font-face` that a matched rule references — reached,
 *                     but its body is not something computed styles can hold.
 * When any map on either side has no ledger (captured without captureReach, or older),
 * nothing is classified: `ledger: 'missing'`. An absent ledger proves nothing either way.
 */
import type { ServedRule, StyleMap } from './capture/types.js';

export type RuleReachStatus = 'reached' | 'never-rendered' | 'blind-channel';

export type RuleReach = {
  /** The ledger key: at-rule chain and prelude (`@media (prefers-color-scheme: dark) > .panel`). */
  key: string;
  change: 'added' | 'removed' | 'changed';
  status: RuleReachStatus;
  /** Plain-language reason for the status. */
  why: string;
  /** The at-rules a never-rendered rule sits inside, when any. */
  condition?: string;
  /** Where the rule was served from (URL path, `inline`, `constructed`). */
  sheet?: string;
};

export type RuleReachResult = {
  /** `missing` when a map on either side has no ledger; `rules` is then empty. */
  ledger: 'complete' | 'missing';
  rules: RuleReach[];
  /** Stylesheets either side could not read: changes inside them cannot be classified. */
  unreadableSheets: number;
};

type Variant = ServedRule & { sheetLabel: string; id: string };
type Side = {
  /** Every distinct key + body the side served, by `variantId`. */
  variants: Map<string, Variant>;
  /** Variant ids some map on the side matched. */
  used: Set<string>;
  /** Distinct served bodies per key. */
  byKey: Map<string, Variant[]>;
  complete: boolean;
  unreadable: number;
};

const variantId = (rule: ServedRule): string => `${rule.key}\u0000${rule.hash}`;

function sideOf(maps: readonly StyleMap[]): Side {
  const side: Side = {
    variants: new Map(),
    used: new Set(),
    byKey: new Map(),
    complete: maps.length > 0,
    unreadable: 0,
  };
  for (const map of maps) {
    if (!map.reach) return { ...side, complete: false };
    side.unreadable += map.reach.unreadable ?? 0;
    for (const rule of map.reach.rules) {
      const id = variantId(rule);
      if (!side.variants.has(id)) {
        const variant = { ...rule, sheetLabel: map.reach.sheets[rule.sheet] ?? '', id };
        side.variants.set(id, variant);
        side.byKey.set(rule.key, [...(side.byKey.get(rule.key) ?? []), variant]);
      }
      if (rule.used) side.used.add(id);
    }
  }
  return side;
}

/** True when some served body of `key` matched on this side. */
const keyUsed = (side: Side, key: string): boolean => (side.byKey.get(key) ?? []).some((v) => side.used.has(v.id));

/** Split a key on its top-level ` > ` joins, never inside brackets, parentheses or strings. */
function keyParts(key: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    if (ch === '\\') i++;
    else if (quote) quote = ch === quote ? '' : quote;
    else if (ch === '"' || ch === "'") quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (depth === 0 && key.startsWith(' > ', i)) {
      parts.push(key.slice(start, i));
      start = i + 3;
      i += 2;
    }
  }
  return [...parts, key.slice(start)];
}

/** The leading at-rule segments of a key (`@media (width > 600px) > @supports (…)`), if any. */
function conditionOf(key: string): string | undefined {
  const parts = keyParts(key).slice(0, -1);
  const end = parts.findIndex((p) => !p.startsWith('@'));
  const chain = end === -1 ? parts : parts.slice(0, end);
  return chain.length ? chain.join(' > ') : undefined;
}

/** For a `@keyframes`/`@font-face` leaf: the names a referencing rule must carry in `refs`. */
function referencedNames(variant: Variant): string[] | undefined {
  const prelude = keyParts(variant.key).at(-1) ?? '';
  const keyframes = /^@(?:-[a-z]+-)?keyframes\s+(.+)$/i.exec(prelude);
  if (keyframes) return [keyframes[1].trim().replace(/^(["'])(.*)\1$/, '$2')];
  if (/^@font-face$/i.test(prelude)) return variant.refs ?? []; // the family it declares
  return undefined;
}

/** Why one changed body is not `reached` on the side that judges it, or undefined when it is. */
function shortfall(v: Variant, side: Side, before: readonly Variant[]): Omit<RuleReach, 'key' | 'change'> | undefined {
  const sheet = v.sheetLabel ? { sheet: v.sheetLabel } : {};
  const names = referencedNames(v);
  if (names) {
    const referrer = [...side.byKey.entries()].find(
      ([key, bodies]) =>
        key !== v.key && keyUsed(side, key) && bodies.some((r) => r.refs?.some((n) => names.includes(n))),
    );
    return referrer
      ? { status: 'blind-channel', why: `referenced by ${referrer[0]}, which rendered`, ...sheet }
      : { status: 'never-rendered', why: 'no rendered rule references it', ...sheet };
  }
  if (!side.used.has(v.id)) {
    const condition = conditionOf(v.key);
    const why = condition ? `never matched while ${condition} applied` : 'its selector never matched';
    return { status: 'never-rendered', why, ...(condition ? { condition } : {}), ...sheet };
  }
  const changed = Object.entries(v.vars ?? {}).filter(([prop, value]) => !before.some((b) => b.vars?.[prop] === value));
  for (const [prop] of changed) {
    const idle = [...side.byKey.entries()].find(
      ([key, bodies]) => key !== v.key && bodies.some((r) => r.uses?.includes(prop)) && !keyUsed(side, key),
    );
    if (idle)
      return { status: 'never-rendered', why: `${prop} changed, and its consumer ${idle[0]} never matched`, ...sheet };
  }
  return undefined;
}

/** One status per changed key: the first changed body that never rendered, else blind, else reached. */
function classifyKey(key: string, base: Side, head: Side): RuleReach | undefined {
  const was = base.byKey.get(key) ?? [];
  const now = head.byKey.get(key) ?? [];
  const added = now.filter((v) => !base.variants.has(v.id));
  const removed = was.filter((v) => !head.variants.has(v.id));
  if (!added.length && !removed.length) return undefined;
  const change: RuleReach['change'] = !was.length ? 'added' : !now.length ? 'removed' : 'changed';
  // A new body is seen where head renders it. Only when head serves nothing new (a body
  // removed, say from one route's stylesheet) is the old body judged where base rendered it.
  const results = added.length
    ? added.map((v) => shortfall(v, head, was))
    : removed.map((v) => shortfall(v, base, now));
  const verdict =
    results.find((r) => r?.status === 'never-rendered') ?? results.find((r) => r?.status === 'blind-channel');
  if (verdict) return { key, change, ...verdict };
  const sheet = (added[0] ?? removed[0]).sheetLabel;
  return { key, change, status: 'reached', why: 'matched in a captured state', ...(sheet ? { sheet } : {}) };
}

/**
 * Classify every served rule key whose bodies differ between the base maps and the
 * head maps (all surfaces and widths of one compare).
 */
export function classifyRuleReach(baseMaps: readonly StyleMap[], headMaps: readonly StyleMap[]): RuleReachResult {
  const base = sideOf(baseMaps);
  const head = sideOf(headMaps);
  const unreadableSheets = base.unreadable + head.unreadable;
  if (!base.complete || !head.complete) return { ledger: 'missing', rules: [], unreadableSheets };
  const keys = [...new Set([...base.byKey.keys(), ...head.byKey.keys()])].sort();
  return { ledger: 'complete', rules: keys.flatMap((key) => classifyKey(key, base, head) ?? []), unreadableSheets };
}
