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
 * Declaration moves are stable only when every served value agrees and each selector
 * declares the property on both sides in every map on the side. Self-declaring
 * readers are shielded only for that agreed value and no other closure alias.
 * Pure: no browser, no I/O.
 *
 * Statuses:
 * - `reached`         a captured state matched each changed body (and every consumer of a
 *                     custom property it changed);
 * - `never-rendered`  some changed body never matched; `condition` names the at-rules gating it;
 * - `unmeasured`     a changed body (or its required consumer/referrer) matched only elements
 *                     StyleProof never compares (shadow DOM, an iframe, or an ignored or volatile
 *                     region); never proof of reach;
 * - `blind-channel`   a `@keyframes`/`@font-face`/`@property` that a matched rule references
 *                     (for `@property`, reads or declares outside a custom-property alias) — reached,
 *                     but its body is not something computed styles can hold.
 * Token closure follows `aliases`; a token no rule reads outside a custom property is never-rendered.
 * When any map on either side has no scoped ledger (captured without captureReach, or older),
 * or a ledger without `version: 2` (recorded before aliases), nothing is classified:
 * `ledger: 'missing'`. Unreadable stylesheets give `ledger: 'partial'`;
 * only readable rules are classified, so a partial ledger is never proof of reach.
 */
import type { ServedRule, StyleMap } from './capture/types.js';

export type RuleReachStatus = 'reached' | 'never-rendered' | 'unmeasured' | 'blind-channel';

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
  /**
   * `missing` when a map on either side has no ledger scoped to compared elements,
   * or one without `version: 2` (recorded before aliases); `rules` is then empty.
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
  selectorVars: Map<string, Set<string>>;
  mapCount: number;
  /** Every distinct key + body the side served, by `variantId`. */
  variants: Map<string, Variant>;
  /** Variant ids some map on the side matched. */
  used: Set<string>;
  /** Variant ids that matched only outside compared elements in some map. */
  outside: Set<string>;
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
function recordRule(side: Side, rule: ServedRule, label: string): void {
  const id = variantId(rule);
  const existing = side.variants.get(id);
  if (!existing) {
    const variant = { ...rule, sheetLabel: label, id };
    side.variants.set(id, variant);
    side.byKey.set(rule.key, [...(side.byKey.get(rule.key) ?? []), variant]);
  } else if (label && (!existing.sheetLabel || label < existing.sheetLabel)) {
    existing.sheetLabel = label;
  }
  if (rule.used) side.used.add(id);
  if (rule.outside) side.outside.add(id);
}

/** Intersect declarations across every map; missing selectors declare nothing. */
function recordSelectorVars(side: Side, rules: readonly ServedRule[], first: boolean): void {
  const declared = new Map<string, Set<string>>();
  for (const rule of rules) {
    for (const selector of selectorsOf(rule.key) ?? []) {
      const key = `${conditionOf(rule.key) ?? ''}\u0000${selector}`;
      const props = declared.get(key) ?? new Set<string>();
      for (const prop of Object.keys(rule.vars ?? {})) props.add(prop);
      declared.set(key, props);
    }
  }
  if (first) side.selectorVars = declared;
  else {
    for (const [key, props] of side.selectorVars) {
      side.selectorVars.set(key, new Set([...props].filter((prop) => declared.get(key)?.has(prop))));
    }
  }
}

function sideOf(maps: readonly StyleMap[]): Side {
  const side: Side = {
    selectorVars: new Map(),
    mapCount: maps.length,
    variants: new Map(),
    used: new Set(),
    outside: new Set(),
    // Rejected ledgers set complete = false below; classifyRuleReach then ignores all rule evidence.
    common: new Set(maps[0]?.reach?.rules.map(variantId)),
    byKey: new Map(),
    sorted: [],
    complete: maps.length > 0,
    unreadable: 0,
  };
  for (const [index, map] of maps.entries()) {
    if (!map.reach || map.reach.scope !== 'compared') {
      side.complete = false;
      continue;
    }
    side.unreadable += map.reach.unreadable ?? 0;
    // A ledger recorded before `aliases` cannot show which tokens feed which aliases.
    if (map.reach.version !== 2) {
      side.complete = false;
      continue;
    }
    recordSelectorVars(side, map.reach.rules, index === 0);
    const served = new Set(map.reach.rules.map(variantId));
    side.common = new Set([...side.common].filter((id) => served.has(id)));
    for (const rule of map.reach.rules) {
      recordRule(side, rule, map.reach.sheets[rule.sheet] ?? '');
    }
  }
  for (const bodies of side.byKey.values()) bodies.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  side.sorted = [...side.byKey.keys()].sort().flatMap((key) => side.byKey.get(key) ?? []);
  return side;
}

/** Split on a top-level separator, never inside brackets, parentheses or strings. */
function splitTop(key: string, separator: string): string[] {
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
    else if (depth === 0 && key.startsWith(separator, i)) {
      parts.push(key.slice(start, i));
      start = i + separator.length;
      i += separator.length - 1;
    }
  }
  return [...parts, key.slice(start)];
}

const keyParts = (key: string): string[] => splitTop(key, ' > ');

function selectorsOf(key: string): string[] | undefined {
  // Only the leading at-rule chain is metadata; selector child combinators stay intact.
  const condition = conditionOf(key);
  const prelude = (condition ? key.slice(condition.length + 3) : key).replace(/ #\d+$/, '');
  return prelude.startsWith('@') || prelude.includes('/*')
    ? undefined
    : splitTop(prelude, ',').map((selector) => selector.trim());
}

type Context = { agreed: (prop: string) => string | undefined; stable: (key: string, prop: string) => boolean };

function contextOf(base: Side, head: Side): Context {
  const hashes = new Map<string, Set<string>>();
  for (const rule of [...base.sorted, ...head.sorted]) {
    for (const [prop, hash] of Object.entries(rule.vars ?? {})) {
      const values = hashes.get(prop) ?? new Set<string>();
      values.add(hash);
      hashes.set(prop, values);
    }
  }
  const agreed = (prop: string): string | undefined => {
    const values = hashes.get(prop);
    return values?.size === 1 ? [...values][0] : undefined;
  };
  return {
    agreed,
    stable: (key, prop) =>
      agreed(prop) !== undefined &&
      (selectorsOf(key)?.every((selector) => {
        const id = `${conditionOf(key) ?? ''}\u0000${selector}`;
        return base.selectorVars.get(id)?.has(prop) && head.selectorVars.get(id)?.has(prop);
      }) ??
        false),
  };
}

/** The leading at-rule segments of a key (`@media (width > 600px) > @supports (…)`), if any. */
function conditionOf(key: string): string | undefined {
  const parts = keyParts(key).slice(0, -1);
  const end = parts.findIndex((p) => !p.startsWith('@'));
  const chain = end === -1 ? parts : parts.slice(0, end);
  return chain.length ? chain.join(' > ') : undefined;
}

type Dependency = { names: string[]; carries: (rule: Variant) => readonly string[] };

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
  if (/^@font-face$/i.test(prelude)) {
    const fold = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    return { names: (variant.refs ?? []).map(fold), carries: (rule) => (rule.refs ?? []).map(fold) };
  }
  if (/^@property\b/i.test(prelude)) {
    const name = /^@property\s+(--[\w-]+)$/.exec(prelude)?.[1];
    // An unparsable name has no referrer, so it stays never-rendered.
    return { names: name ? [name] : [], carries: (rule) => [...renderedReads(rule), ...Object.keys(rule.vars ?? {})] };
  }
  return undefined;
}

/** Custom properties this body changes: a new value, or one it no longer declares. */
function changedVars(v: Variant, before: readonly Variant[], ctx: Context): string[] {
  // Without a unique counterpart, every other-side body must agree to prove no change.
  const own = Object.entries(v.vars ?? {})
    .filter(([prop, value]) => !before.length || !before.every((b) => b.vars?.[prop] === value))
    .map(([prop]) => prop);
  const dropped = before.flatMap((b) => Object.keys(b.vars ?? {})).filter((prop) => !Object.hasOwn(v.vars ?? {}, prop));
  return [...new Set([...own, ...dropped])].filter((prop) => !ctx.stable(v.key, prop)).sort();
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

/** Every token consumer must render: never-rendered over unmeasured, independent of key order. */
function tokenShortfall(
  v: Variant,
  side: Side,
  before: readonly Variant[],
  ctx: Context,
): Pick<RuleReach, 'status' | 'why'> | undefined {
  let unmeasured: Pick<RuleReach, 'status' | 'why'> | undefined;
  for (const prop of changedVars(v, before, ctx)) {
    const closure = tokenClosure(side, prop);
    const idle = side.sorted.filter(
      (r) =>
        r.uses?.some((used) => closure.has(used)) &&
        !side.used.has(r.id) &&
        !(
          ctx.agreed(prop) !== undefined &&
          r.vars?.[prop] === ctx.agreed(prop) &&
          (r.uses ?? []).every((used) => !closure.has(used) || used === prop)
        ),
    );
    const consumer = idle.find((r) => !side.outside.has(r.id)) ?? idle[0];
    if (consumer) {
      const via = consumer.uses?.includes(prop) ? prop : consumer.uses?.filter((used) => closure.has(used)).sort()[0];
      const through = via === prop ? '' : ` through ${via}`;
      if (!side.outside.has(consumer.id))
        return {
          status: 'never-rendered',
          why: `${prop} changed${through}, and its consumer ${consumer.key} never matched`,
        };
      unmeasured ??= {
        status: 'unmeasured',
        why: `${prop} changed${through}, and its consumer ${consumer.key} matched only elements StyleProof does not compare`,
      };
    }
    const terminal = side.sorted.some((rule) => renderedReads(rule).some((used) => closure.has(used)));
    if (!terminal) {
      return {
        status: 'never-rendered',
        why: `${prop} changed, and no served rule reads it outside a custom property`,
      };
    }
  }
  return unmeasured;
}

/** An unmatched body stays unmeasured unless it or a required consumer never matched. */
function unmatchedShortfall(
  v: Variant,
  side: Side,
  before: readonly Variant[],
  ctx: Context,
): Omit<RuleReach, 'key' | 'change'> {
  if (side.outside.has(v.id)) {
    const token = tokenShortfall(v, side, before, ctx);
    if (token?.status === 'never-rendered') return token;
    return {
      status: 'unmeasured',
      why: 'matched only elements StyleProof does not compare (shadow DOM, an iframe, or an ignored or volatile region)',
    };
  }
  const condition = conditionOf(v.key);
  const why = condition ? `never matched while ${condition} applied` : 'its selector never matched';
  return { status: 'never-rendered', why, ...(condition ? { condition } : {}) };
}

/** Why one changed body is not `reached` on the side that judges it, or undefined when it is. */
function shortfall(
  v: Variant,
  side: Side,
  before: readonly Variant[],
  ctx: Context,
): Omit<RuleReach, 'key' | 'change'> | undefined {
  const sheet = v.sheetLabel ? { sheet: v.sheetLabel } : {};
  const dependency = dependencyOf(v);
  if (dependency) {
    const referrer = side.sorted.find(
      (r) => r.key !== v.key && side.used.has(r.id) && dependency.carries(r).some((n) => dependency.names.includes(n)),
    );
    if (referrer)
      return {
        status: 'blind-channel',
        why: `referenced by ${referrer.key}, which matched a captured element`,
        ...sheet,
      };
    const outside = side.sorted.find(
      (r) =>
        r.key !== v.key && side.outside.has(r.id) && dependency.carries(r).some((n) => dependency.names.includes(n)),
    );
    return outside
      ? {
          status: 'unmeasured',
          why: `referenced only by ${outside.key}, which matched only elements StyleProof does not compare`,
          ...sheet,
        }
      : { status: 'never-rendered', why: 'no matched rule references it', ...sheet };
  }
  if (!side.used.has(v.id)) return { ...unmatchedShortfall(v, side, before, ctx), ...sheet };
  const token = tokenShortfall(v, side, before, ctx);
  return token ? { ...token, ...sheet } : undefined;
}

/** One status per changed key: never-rendered, then unmeasured, then blind, then reached. */
function classifyKey(key: string, base: Side, head: Side, ctx: Context): RuleReach | undefined {
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
    ...added.map((v) => shortfall(v, head, was, ctx)),
    ...(inPlace ? [] : removed.map((v) => shortfall(v, base, now, ctx))),
  ];
  const verdict =
    results.find((r) => r?.status === 'never-rendered') ??
    results.find((r) => r?.status === 'unmeasured') ??
    results.find((r) => r?.status === 'blind-channel');
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
  const ctx = contextOf(base, head);
  const keys = [...new Set([...base.byKey.keys(), ...head.byKey.keys()])].sort();
  return {
    ledger: unreadableSheets ? 'partial' : 'complete',
    rules: keys.flatMap((key) => classifyKey(key, base, head, ctx) ?? []),
    unreadableSheets,
  };
}
