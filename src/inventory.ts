// Inventory guard — assert the navigable UI doesn't silently shrink.
//
// StyleProof's certification diff answers "did surface X change between base and
// head?" — a same-key regression check. It is structurally blind to a whole class
// of high-stakes change: a redesign delivered as a NEW surface beside the old one
// (the diff is old-vs-old, clean), or a nav item / route that DISAPPEARS (a feature
// stops being reachable). Those aren't restyles — they're the reachable set of the
// UI shrinking, which is an information-architecture change the pixel diff catches
// only incidentally, if at all.
//
// This module harvests the *navigable inventory* of each captured surface — the
// user-reachable affordances (route links, tabs, menu items, button-only SPA nav) —
// keyed by a stable id, then diffs the UNION across a run. A key present on base but
// absent on head is a REMOVAL: a feature the UI no longer offers. Removals gate
// (like the `exclude` coverage ledger) unless explicitly acknowledged with a reason,
// so "we dropped Model Config" is a decision on the record, never a silent green.
//
// The harvest (`detectNavigableInventory`) runs in-page, mirroring
// `detectOverlayCandidates`; the diff/union/guard are pure and unit-testable.

/** One user-reachable navigation affordance, keyed stably across base/head. */
export type NavigableItem = {
  /**
   * Stable identity across captures. `route:<pathname><search>` for internal
   * links; `<role>:<slug(name)>` for tabs / menu items / button-only nav — so a
   * tab labelled "MODEL CONFIG" keys as `tab:model-config` regardless of styling,
   * and lines up with an app's own view id.
   */
  key: string;
  kind: 'link' | 'tab' | 'menuitem' | 'nav-button';
  /** Visible accessible name at capture time (for the report). */
  label: string;
  /** Resolved same-origin path, for `kind: 'link'`. */
  href?: string;
};

export type InventoryDelta = {
  /** Present on head, absent on base — a newly-offered affordance (informational). */
  added: NavigableItem[];
  /** Present on base, absent on head — a feature the UI stopped offering (gates). */
  removed: NavigableItem[];
};

/** `key -> reason` — removals that are intentional, reviewed, and on the record. */
export type AllowedRemovals = Record<string, string>;

/** One raw navigable affordance as read from the DOM, before classification. */
export type RawAffordance = {
  tag: string;
  role: string;
  name: string;
  /** pathname+search for a same-origin `<a href>`; null otherwise. Resolved in-page. */
  internalPath: string | null;
};

// ── in-page harvest ───────────────────────────────────────────────────────────
// Split in two: the DOM-touching half stays thin (and serializable to the page,
// like detectOverlayCandidates); the classification is pure and unit-testable.

/** In-page: collect visible navigable affordances. No classification. */
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
    const raw = (el.getAttribute('href') || '').trim();
    if (!raw || raw.startsWith('#')) return null;
    try {
      const u = new URL(raw, location.href);
      return u.origin === location.origin ? `${u.pathname}${u.search}` : null;
    } catch {
      return null;
    }
  };
  // Semantic nav first (a[href], role=tab/menuitem, <nav>/tablist buttons); then a
  // conservative class heuristic for button-only navs that skip ARIA — a container
  // whose class strongly implies navigation (nav / navtab / subnav / tabs / subtab).
  // Erring broad is correct here: a stray non-nav button is harmless noise, but a
  // MISSED nav item defeats the guard. Prefer semantic markup (role=tablist) for
  // fully reliable harvesting; see docs/inventory-guard.md.
  const SEL =
    'a[href], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], nav button, [role="navigation"] button, [role="tablist"] button, [class*="navtab" i] button, [class*="nav-tab" i] button, [class*="subnav" i] button, [class*="subtab" i] button, [class*="tabs" i] button';
  return Array.from(document.querySelectorAll(SEL))
    .filter(visible)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      role: (el.getAttribute('role') || '').toLowerCase(),
      name: nameOf(el),
      internalPath: el.tagName === 'A' ? internalPath(el) : null,
    }));
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

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
      add(`tab:${slug(c.name)}`, 'tab', c.name);
    } else if (c.name && c.role.startsWith('menuitem')) {
      add(`menuitem:${slug(c.name)}`, 'menuitem', c.name);
    } else if (c.name && c.tag === 'button') {
      add(`nav-button:${slug(c.name)}`, 'nav-button', c.name);
    }
  }
  return Array.from(items.values()).sort((a, b) => a.key.localeCompare(b.key));
}

/** Harvest a page's inventory: thin in-page collect + pure classify. */
export async function harvestInventory(page: { evaluate: <T>(fn: () => T) => Promise<T> }): Promise<NavigableItem[]> {
  return classifyInventory(await page.evaluate(collectNavAffordances));
}

// ── pure diff / union / guard ───────────────────────────────────────────────────

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

/**
 * The gate. Removals that aren't acknowledged in `allowed` (key -> reason) are
 * unexplained — the caller fails on a non-empty result. An `allowed` key that
 * isn't actually removed is a stale acknowledgement, returned separately so the
 * ledger can't quietly rot (mirrors the `exclude` coverage guard).
 */
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

/**
 * Run-level entry point: union both sides' per-surface `map.inventory`, diff, and
 * audit removals. This is what a gate calls — pass every base map and every head
 * map (the reachable set is the union across all surfaces). `unexplained` non-empty
 * ⇒ the gate should fail; `staleAllowances` non-empty ⇒ prune the ledger.
 */
export function auditRunInventory(
  baseMaps: Array<{ inventory?: NavigableItem[] } | undefined>,
  headMaps: Array<{ inventory?: NavigableItem[] } | undefined>,
  allowed: AllowedRemovals = {},
): { delta: InventoryDelta; unexplained: NavigableItem[]; staleAllowances: string[] } {
  const delta = diffInventory(unionInventory(baseMaps), unionInventory(headMaps));
  return { delta, ...auditRemovals(delta, allowed) };
}
