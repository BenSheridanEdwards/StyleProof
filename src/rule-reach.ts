/**
 * Change Reach J1 (#995): which changed served CSS rules did a captured state render?
 *
 * Reads the served-rule ledgers captureReach records (`StyleMap.reach`) on both sides
 * and classifies every rule key whose served bodies differ between them. A side can
 * serve one key with different bodies on different surfaces (route-split stylesheets),
 * so each distinct body is compared on its own: every body only head serves must have
 * matched on head; every body only base serves is judged on base. A one-for-one swap
 * is judged only on head if the old body matched on base, or both bodies were served
 * in every map of their respective side with equal map counts. Other route pairings
 * are ambiguous.
 * Pure: no browser, no I/O.
 *
 * Statuses:
 * - `reached`         a captured state matched each changed body (and every consumer of a
 *                     custom property it changed);
 * - `never-rendered`  some changed body never matched; `condition` names the at-rules gating it;
 * - `blind-channel`   a `@keyframes`/`@font-face`/`@property` that a matched rule references
 *                     (for `@property`, reads or declares outside a custom-property alias) — reached,
 *                     but its body is not something computed styles can hold; for `@font-face`,
 *                     `pixels` names the captures to compare with `--pixels`.
 * Token closure follows `aliases`; a token no rule reads outside a custom property is never-rendered.
 * When any map on either side has no ledger (captured without captureReach, or older),
 * or a ledger without `version: 2` (recorded before aliases), nothing is classified:
 * `ledger: 'missing'`. Unreadable stylesheets give `ledger: 'partial'`;
 * only readable rules are classified, so a partial ledger is never proof of reach.
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
  /** Captures where a blind-channel `@font-face` rendered; compare with `styleproof-diff --pixels`. */
  pixels?: string[];
};

export type RuleReachResult = {
  /**
   * `missing` when a map on either side has no ledger, or one without `version: 2`
   * (recorded before aliases); `rules` is then empty.
   * `partial` when either side has unreadable stylesheets: `rules` covers only readable
   * sheets, so a changed rule or consumer inside an unreadable one is absent.
   * Treat a partial result as unknown, never as proof of reach.
   */
  ledger: 'complete' | 'partial' | 'missing';
  rules: RuleReach[];
  /** Stylesheets either side could not read: changes inside them cannot be classified. */
  unreadableSheets: number;
};

type Variant = ServedRule & { sheetLabel: string; id: string };
type Side = {
  mapCount: number;
  keys: readonly string[];
  /** Every distinct key + body the side served, by `variantId`. */
  variants: Map<string, Variant>;
  /** Variant ids some map on the side matched. */
  used: Set<string>;
  /** Variant ids mapped to the capture indexes where they matched. */
  usedIn: Map<string, number[]>;
  /** Variant ids served in every map on the side, independent of map order. */
  common: Set<string>;
  /** Distinct served bodies per key. */
  byKey: Map<string, Variant[]>;
  /** Every variant ordered by key, then body hash. */
  sorted: Variant[];
  complete: boolean;
  unreadable: number;
};

const variantId = (rule: ServedRule): string => `${rule.key}\u0000${rule.hash}`;

/** Merge evidence for one body, keeping its lowest non-empty sheet label. */
function recordRule(side: Side, rule: ServedRule, label: string, index: number): void {
  const id = variantId(rule);
  const existing = side.variants.get(id);
  if (!existing) {
    const variant = { ...rule, sheetLabel: label, id };
    side.variants.set(id, variant);
    side.byKey.set(rule.key, [...(side.byKey.get(rule.key) ?? []), variant]);
  } else if (label && (!existing.sheetLabel || label < existing.sheetLabel)) {
    existing.sheetLabel = label;
  }
  if (rule.used) {
    side.used.add(id);
    side.usedIn.set(id, [...(side.usedIn.get(id) ?? []), index]);
  }
}

function sideOf(maps: readonly StyleMap[], keys: readonly string[] = []): Side {
  const side: Side = {
    mapCount: maps.length,
    keys,
    variants: new Map(),
    used: new Set(),
    usedIn: new Map(),
    // Rejected ledgers set complete = false below; classifyRuleReach then ignores all rule evidence.
    common: new Set(maps[0]?.reach?.rules.map(variantId)),
    byKey: new Map(),
    sorted: [],
    complete: maps.length > 0,
    unreadable: 0,
  };
  for (const [index, map] of maps.entries()) {
    if (!map.reach) {
      side.complete = false;
      continue;
    }
    side.unreadable += map.reach.unreadable ?? 0;
    // A ledger recorded before `aliases` cannot show which tokens feed which aliases.
    if (map.reach.version !== 2) {
      side.complete = false;
      continue;
    }
    const served = new Set(map.reach.rules.map(variantId));
    side.common = new Set([...side.common].filter((id) => served.has(id)));
    for (const rule of map.reach.rules) {
      recordRule(side, rule, map.reach.sheets[rule.sheet] ?? '', index);
    }
  }
  for (const bodies of side.byKey.values()) bodies.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  side.sorted = [...side.byKey.keys()].sort().flatMap((key) => side.byKey.get(key) ?? []);
  return side;
}

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

type Dependency = { names: string[]; carries: (rule: Variant) => readonly string[]; font?: boolean };

/** Custom properties a rule reads outside its own alias declarations. A read both ways counts as alias-only. */
function renderedReads(rule: Variant): string[] {
  const aliased = new Set(Object.values(rule.aliases ?? {}).flat());
  return (rule.uses ?? []).filter((used) => !aliased.has(used));
}

/** The names and ledger fields that can reference a dependency leaf. */
function dependencyOf(variant: Variant): Dependency | undefined {
  // The ledger appends a repeat counter to duplicate keys.
  const prelude = (keyParts(variant.key).at(-1) ?? '').replace(/ #\d+$/, '');
  const keyframes = /^@(?:-[a-z]+-)?keyframes\s+(.+)$/i.exec(prelude);
  if (keyframes) {
    return { names: [keyframes[1].trim().replace(/^(["'])(.*)\1$/, '$2')], carries: (rule) => rule.refs ?? [] };
  }
  if (/^@font-face$/i.test(prelude))
    return { names: variant.refs ?? [], carries: (rule) => rule.refs ?? [], font: true };
  if (/^@property\b/i.test(prelude)) {
    const name = /^@property\s+(--[\w-]+)$/.exec(prelude)?.[1];
    // An unparsable name has no referrer, so it stays never-rendered.
    return { names: name ? [name] : [], carries: (rule) => [...renderedReads(rule), ...Object.keys(rule.vars ?? {})] };
  }
  return undefined;
}

/** Custom properties this body changes: a new value, or one it no longer declares. */
function changedVars(v: Variant, before: readonly Variant[]): string[] {
  // Without a unique counterpart, every other-side body must agree to prove no change.
  const own = Object.entries(v.vars ?? {})
    .filter(([prop, value]) => !before.length || !before.every((b) => b.vars?.[prop] === value))
    .map(([prop]) => prop);
  const dropped = before.flatMap((b) => Object.keys(b.vars ?? {})).filter((prop) => !Object.hasOwn(v.vars ?? {}, prop));
  return [...new Set([...own, ...dropped])].sort();
}

function tokenClosure(side: Side, seed: string): Set<string> {
  const closure = new Set([seed]);
  let size: number;
  do {
    size = closure.size;
    for (const rule of side.sorted) {
      for (const [alias, reads] of Object.entries(rule.aliases ?? {})) {
        if (reads.some((prop) => closure.has(prop))) closure.add(alias);
      }
    }
  } while (closure.size !== size);
  return closure;
}

/** A changed token must reach every body that consumes it, including through aliases. */
function tokenShortfall(v: Variant, side: Side, before: readonly Variant[]): string | undefined {
  for (const prop of changedVars(v, before)) {
    const closure = tokenClosure(side, prop);
    const idle = side.sorted.find((r) => r.uses?.some((used) => closure.has(used)) && !side.used.has(r.id));
    if (idle) {
      const via = idle.uses?.includes(prop) ? prop : idle.uses?.filter((used) => closure.has(used)).sort()[0];
      const through = via === prop ? '' : ` through ${via}`;
      return `${prop} changed${through}, and its consumer ${idle.key} never matched`;
    }
    const terminal = side.sorted.some((rule) => renderedReads(rule).some((used) => closure.has(used)));
    if (!terminal) return `${prop} changed, and no served rule reads it outside a custom property`;
  }
  return undefined;
}

/** Why one changed body is not `reached` on the side that judges it, or undefined when it is. */
function shortfall(v: Variant, side: Side, before: readonly Variant[]): Omit<RuleReach, 'key' | 'change'> | undefined {
  const sheet = v.sheetLabel ? { sheet: v.sheetLabel } : {};
  const dependency = dependencyOf(v);
  if (dependency) {
    const referrers = side.sorted.filter(
      (r) => r.key !== v.key && side.used.has(r.id) && dependency.carries(r).some((n) => dependency.names.includes(n)),
    );
    const referrer = referrers[0];
    const pixels = dependency.font
      ? [
          ...new Set(referrers.flatMap((r) => (side.usedIn.get(r.id) ?? []).map((i) => side.keys[i])).filter(Boolean)),
        ].sort()
      : [];
    return referrer
      ? {
          status: 'blind-channel',
          why: `referenced by ${referrer.key}, which rendered`,
          ...sheet,
          ...(pixels.length ? { pixels } : {}),
        }
      : { status: 'never-rendered', why: 'no rendered rule references it', ...sheet };
  }
  if (!side.used.has(v.id)) {
    const condition = conditionOf(v.key);
    const why = condition ? `never matched while ${condition} applied` : 'its selector never matched';
    return { status: 'never-rendered', why, ...(condition ? { condition } : {}), ...sheet };
  }
  const why = tokenShortfall(v, side, before);
  return why ? { status: 'never-rendered', why, ...sheet } : undefined;
}

/** One status per changed key: the first changed body that never rendered, else blind, else reached. */
function classifyKey(key: string, base: Side, head: Side): RuleReach | undefined {
  const was = base.byKey.get(key) ?? [];
  const now = head.byKey.get(key) ?? [];
  const added = now.filter((v) => !base.variants.has(v.id));
  const removed = was.filter((v) => !head.variants.has(v.id));
  if (!added.length && !removed.length) return undefined;
  const change: RuleReach['change'] = !was.length ? 'added' : !now.length ? 'removed' : 'changed';
  // Keep ambiguous route-specific removals: order or sheet labels cannot pair them.
  const inPlace =
    added.length === 1 &&
    removed.length === 1 &&
    (base.used.has(removed[0].id) ||
      (base.mapCount === head.mapCount && base.common.has(removed[0].id) && head.common.has(added[0].id)));
  const results = [
    ...added.map((v) => shortfall(v, head, was)),
    ...(inPlace ? [] : removed.map((v) => shortfall(v, base, now))),
  ];
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
export function classifyRuleReach(
  baseMaps: readonly StyleMap[],
  headMaps: readonly StyleMap[],
  captureKeys?: { base: readonly string[]; head: readonly string[] },
): RuleReachResult {
  const base = sideOf(baseMaps, captureKeys?.base);
  const head = sideOf(headMaps, captureKeys?.head);
  const unreadableSheets = base.unreadable + head.unreadable;
  if (!base.complete || !head.complete) return { ledger: 'missing', rules: [], unreadableSheets };
  const keys = [...new Set([...base.byKey.keys(), ...head.byKey.keys()])].sort();
  return {
    ledger: unreadableSheets ? 'partial' : 'complete',
    rules: keys.flatMap((key) => classifyKey(key, base, head) ?? []),
    unreadableSheets,
  };
}
