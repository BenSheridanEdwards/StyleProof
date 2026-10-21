/**
 * Change Reach J1 (#995): which changed served CSS rules did a captured state render?
 *
 * Reads the served-rule ledgers captureReach records (`StyleMap.reach`) on both sides
 * and classifies every rule that differs between them. An added or changed rule is
 * judged on head, a removed one on base, because that is the side where it can render.
 * Pure: no browser, no I/O.
 *
 * Statuses:
 * - `reached`         a captured state matched it (and every consumer of a token it changed);
 * - `never-rendered`  no captured state matched it; `condition` names the at-rules gating it;
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

type Entry = ServedRule & { sheetLabel: string };
type Catalog = { rules: Map<string, Entry>; used: Set<string>; complete: boolean; unreadable: number };

/** One side's rules (first occurrence per key) and the keys any of its maps matched. */
function catalog(maps: readonly StyleMap[]): Catalog {
  const rules = new Map<string, Entry>();
  const used = new Set<string>();
  let unreadable = 0;
  for (const map of maps) {
    if (!map.reach) return { rules, used, complete: false, unreadable };
    unreadable += map.reach.unreadable ?? 0;
    for (const rule of map.reach.rules) {
      if (!rules.has(rule.key)) rules.set(rule.key, { ...rule, sheetLabel: map.reach.sheets[rule.sheet] ?? '' });
      if (rule.used) used.add(rule.key);
    }
  }
  return { rules, used, complete: maps.length > 0, unreadable };
}

/** The leading at-rule segments of a key (`@media (…) > @supports (…)`), or undefined at top level. */
function conditionOf(key: string): string | undefined {
  const parts = key.split(' > ');
  const chain = parts
    .slice(0, -1)
    .filter((p, i) => p.startsWith('@') && parts.slice(0, i).every((q) => q.startsWith('@')));
  return chain.length ? chain.join(' > ') : undefined;
}

/** `@keyframes pulse` → `pulse`; `@font-face` → its quoted or bare family name. */
function referencedName(rule: Entry): string | undefined {
  const keyframes = rule.key.match(/^@(?:-webkit-)?keyframes\s+(.+)$/i);
  if (keyframes) return keyframes[1].replace(/^["']|["']$/g, '').trim();
  return undefined;
}

function classify(rule: Entry, side: Catalog, before: Entry | undefined): Omit<RuleReach, 'key' | 'change'> {
  const sheet = rule.sheetLabel ? { sheet: rule.sheetLabel } : {};
  if (/^@font-face\b/i.test(rule.key) || referencedName(rule) !== undefined) {
    const name = referencedName(rule);
    const referrers = [...side.rules.values()].filter(
      (r) => side.used.has(r.key) && (name === undefined ? r.refs?.length : r.refs?.includes(name)),
    );
    // A @font-face key carries no family, so any matched rule naming a font keeps it in view.
    return referrers.length
      ? { status: 'blind-channel', why: `referenced by ${referrers[0].key}, which rendered`, ...sheet }
      : { status: 'never-rendered', why: 'no rendered rule references it', ...sheet };
  }
  if (!side.used.has(rule.key)) {
    const condition = conditionOf(rule.key);
    return {
      status: 'never-rendered',
      why: condition ? `never matched while ${condition} applied` : 'its selector never matched',
      ...(condition ? { condition } : {}),
      ...sheet,
    };
  }
  const changedVars = Object.entries(rule.vars ?? {}).filter(([prop, value]) => before?.vars?.[prop] !== value);
  for (const [prop] of changedVars) {
    const idle = [...side.rules.values()].find(
      (r) => r.key !== rule.key && r.uses?.includes(prop) && !side.used.has(r.key),
    );
    if (idle)
      return { status: 'never-rendered', why: `${prop} changed, and its consumer ${idle.key} never matched`, ...sheet };
  }
  return { status: 'reached', why: 'matched in a captured state', ...sheet };
}

/**
 * Classify every served rule that differs between the base maps and the head maps
 * (all surfaces and widths of one compare).
 */
export function classifyRuleReach(base: readonly StyleMap[], head: readonly StyleMap[]): RuleReachResult {
  const b = catalog(base);
  const h = catalog(head);
  const unreadableSheets = b.unreadable + h.unreadable;
  if (!b.complete || !h.complete) return { ledger: 'missing', rules: [], unreadableSheets };
  const out: RuleReach[] = [];
  for (const [key, rule] of h.rules) {
    const was = b.rules.get(key);
    if (!was) out.push({ key, change: 'added', ...classify(rule, h, undefined) });
    else if (was.hash !== rule.hash) out.push({ key, change: 'changed', ...classify(rule, h, was) });
  }
  for (const [key, rule] of b.rules)
    if (!h.rules.has(key)) out.push({ key, change: 'removed', ...classify(rule, b, undefined) });
  return {
    ledger: 'complete',
    rules: out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)),
    unreadableSheets,
  };
}
