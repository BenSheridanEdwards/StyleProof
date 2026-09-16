// Inventory guard — assert the navigable UI doesn't silently shrink. The certification
// diff is same-key (old-vs-old) and blind to a nav item or route that DISAPPEARS. This
// harvests each surface's user-reachable affordances, keyed stably, and diffs the UNION
// across a run: a key on base but not head is a removal that gates unless acknowledged.

import { INVENTORY_LEDGER, readLedger } from './ack-ledger.js';

/** One user-reachable navigation affordance, keyed stably across base/head. */
export type NavigableItem = {
  /** `route:<pathname><search>` for internal links; `<role>:<slug(name)>` (or `<role>:#<id>`) otherwise. */
  key: string;
  kind: 'link' | 'tab' | 'menuitem' | 'nav-button';
  /** Visible accessible name at capture time (for the report). */
  label: string;
  /** Resolved same-origin path, for `kind: 'link'`. */
  href?: string;
};

export type InventoryDelta = {
  /** Present on head, absent on base (informational). */
  added: NavigableItem[];
  /** Present on base, absent on head — a feature the UI stopped offering (gates). */
  removed: NavigableItem[];
};

/** `key -> reason` — removals that are intentional, reviewed, and on the record. */
export type AllowedRemovals = Record<string, string>;

/** Read the acknowledged-removals ledger (`$STYLEPROOF_INVENTORY` or `styleproof.inventory.json`). */
export function readAckFile(): AllowedRemovals {
  return readLedger(INVENTORY_LEDGER);
}

/** One raw navigable affordance as read from the DOM, before classification. */
export type RawAffordance = {
  tag: string;
  role: string;
  name: string;
  /** pathname+search for a same-origin `<a href>`; null otherwise. */
  internalPath: string | null;
  /** `data-testid` — developer-authored, trusted as a stable identity. */
  testId: string | null;
  /** `id` — a stable identity only when it doesn't look framework-generated. */
  domId: string | null;
  /** `aria-controls` (a tab's panel) — a stable identity when not framework-generated. */
  controls: string | null;
};

/** In-page (serialized by page.evaluate; self-contained): collect visible navigable affordances. */
export function collectNavAffordances(): RawAffordance[] {
  const visible = (el: Element): boolean => {
    if ((el as HTMLElement).hidden || el.getAttribute('aria-hidden') === 'true') return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const nameOf = (el: Element): string =>
    (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const internalPath = (el: Element): string | null => {
    // SVG anchors carry the target in `xlink:href` (legacy) or `href`.
    const raw = (el.getAttribute('href') || el.getAttribute('xlink:href') || '').trim();
    if (!raw || raw.startsWith('#')) return null;
    try {
      const u = new URL(raw, location.href);
      return u.origin === location.origin ? `${u.pathname}${u.search}` : null;
    } catch {
      return null;
    }
  };
  // Semantic nav first, then a conservative class heuristic for button-only navs that skip
  // ARIA. Erring broad is correct: a stray button is noise, a MISSED nav item defeats the guard.
  // `a[*|href]` (any namespace) so an SVG anchor with only `xlink:href` is selected.
  const SEL =
    'a[*|href], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], nav button, [role="navigation"] button, [role="tablist"] button, [class*="navtab" i] button, [class*="nav-tab" i] button, [class*="subnav" i] button, [class*="subtab" i] button, [class*="tabs" i] button';
  return Array.from(document.querySelectorAll(SEL))
    .filter(visible)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      role: (el.getAttribute('role') || '').toLowerCase(),
      name: nameOf(el),
      internalPath: el.tagName.toLowerCase() === 'a' ? internalPath(el) : null,
      testId: el.getAttribute('data-testid'),
      domId: el.getAttribute('id'),
      controls: el.getAttribute('aria-controls'),
    }));
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Whether an `id` / `aria-controls` is a STABLE identity, vs a framework-generated one that wobbles across builds. */
export function isStableId(id: string | null | undefined): id is string {
  if (!id) return false;
  const v = id.trim();
  if (!v || v.length > 80) return false;
  if (v.includes(':')) return false; // React useId / Radix scoped ids
  if (/^(headlessui|radix|mui|chakra|reach|react-aria|floating-ui|downshift)-/i.test(v)) return false;
  if (/^[0-9a-f]{8,}$/i.test(v)) return false; // hash-like
  return true;
}

// `<role>:#<stable-id>` when the affordance exposes one (testid, then id, then aria-controls),
// else `<role>:<slug(name)>`. The `#` keeps id-keys from colliding with slug-keys.
function affordanceKey(role: string, c: RawAffordance): string {
  const id =
    c.testId?.trim() || (isStableId(c.domId) && c.domId.trim()) || (isStableId(c.controls) && c.controls.trim());
  return id ? `${role}:#${id}` : `${role}:${slug(c.name)}`;
}

/** Pure: turn raw affordances into keyed, deduped, sorted navigable items. */
export function classifyInventory(raw: RawAffordance[]): NavigableItem[] {
  const items = new Map<string, NavigableItem>();
  const add = (key: string, kind: NavigableItem['kind'], label: string, href?: string): void => {
    if (key && !items.has(key)) items.set(key, href ? { key, kind, label, href } : { key, kind, label });
  };
  for (const c of raw) {
    if (c.tag === 'a' && c.internalPath) {
      add(`route:${c.internalPath}`, 'link', c.name || c.internalPath, c.internalPath);
    } else if (c.name && c.role === 'tab') {
      add(affordanceKey('tab', c), 'tab', c.name);
    } else if (c.name && c.role.startsWith('menuitem')) {
      add(affordanceKey('menuitem', c), 'menuitem', c.name);
    } else if (c.name && c.tag === 'button') {
      add(affordanceKey('nav-button', c), 'nav-button', c.name);
    }
  }
  return Array.from(items.values()).sort((a, b) => a.key.localeCompare(b.key));
}

/** Harvest a page's inventory: thin in-page collect + pure classify. */
export async function harvestInventory(page: { evaluate: <T>(fn: () => T) => Promise<T> }): Promise<NavigableItem[]> {
  return classifyInventory(await page.evaluate(collectNavAffordances));
}

/** Did ANY captured map on either side carry an inventory? Every consumer must ask this FIRST. */
export function hasCapturedInventory(...sides: Array<Array<{ inventory?: NavigableItem[] } | undefined>>): boolean {
  return sides.some((maps) => maps.some((map) => (map?.inventory?.length ?? 0) > 0));
}

/** Union the per-surface inventories of a whole run into one reachable set. */
export function unionInventory(perSurface: Array<{ inventory?: NavigableItem[] } | undefined>): NavigableItem[] {
  const byKey = new Map<string, NavigableItem>();
  for (const map of perSurface) {
    for (const item of map?.inventory ?? []) if (!byKey.has(item.key)) byKey.set(item.key, item);
  }
  return Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
}

/** Base vs head reachable sets → what the UI newly offers / stopped offering. */
export function diffInventory(base: NavigableItem[], head: NavigableItem[]): InventoryDelta {
  const headKeys = new Set(head.map((i) => i.key));
  const baseKeys = new Set(base.map((i) => i.key));
  return {
    added: head.filter((i) => !baseKeys.has(i.key)),
    removed: base.filter((i) => !headKeys.has(i.key)),
  };
}

/** The gate: unacknowledged removals fail; acknowledged keys that are not removed are stale. */
export function auditRemovals(
  delta: InventoryDelta,
  allowed: AllowedRemovals = {},
): { unexplained: NavigableItem[]; staleAllowances: string[] } {
  const removedKeys = new Set(delta.removed.map((i) => i.key));
  return {
    unexplained: delta.removed.filter((i) => !(i.key in allowed)),
    staleAllowances: Object.keys(allowed).filter((k) => !removedKeys.has(k)),
  };
}

/** Run-level entry: union both sides, diff, audit removals. `unexplained` non-empty ⇒ the gate should fail. */
export function auditRunInventory(
  baseMaps: Array<{ inventory?: NavigableItem[] } | undefined>,
  headMaps: Array<{ inventory?: NavigableItem[] } | undefined>,
  allowed: AllowedRemovals = {},
): { delta: InventoryDelta; unexplained: NavigableItem[]; staleAllowances: string[] } {
  const delta = diffInventory(unionInventory(baseMaps), unionInventory(headMaps));
  return { delta, ...auditRemovals(delta, allowed) };
}
