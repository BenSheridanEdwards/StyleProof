import type { CDPSession, Page } from '@playwright/test';
import { captureExpression } from './script-evaluation.js';
import { registerStyleProofSession } from './script-coverage-ownership.js';
type BoundaryNode = {
  nodeId?: number;
  nodeType?: number;
  nodeName?: string;
  childNodeCount?: number;
  backendNodeId?: number;
  shadowRootType?: string;
  children?: BoundaryNode[];
  shadowRoots?: BoundaryNode[];
  contentDocument?: BoundaryNode;
};
type BoundaryRecord = { parent?: number; relevant: boolean; rooted: boolean; closedId?: number | null };
type Catalog = {
  client: CDPSession;
  version: number;
  epoch: number;
  scanned: number;
  roots: number[];
  registered: Set<number>;
  sheets: Map<string, string>;
  nodes: Map<number, BoundaryRecord>;
  pending: Set<Promise<void>>;
  unexpanded: Set<number>;
};
const catalogs = new WeakMap<Page, Catalog>();
function couldContainBoundary(node: BoundaryNode): boolean {
  if (node.nodeType !== 1) return false;
  if (node.shadowRoots?.some((root) => root.shadowRootType !== 'user-agent')) return true;
  if ((node.childNodeCount ?? 0) > (node.children?.length ?? 0)) return true;
  const name = node.nodeName?.toLowerCase() ?? '';
  // DOM's valid shadow host names; object/embed can introduce a document boundary.
  return (
    name.includes('-') ||
    /^(?:article|aside|blockquote|body|div|footer|h[1-6]|header|main|nav|p|section|span|object|embed)$/.test(name)
  );
}
function boundaryChildren(node: BoundaryNode): BoundaryNode[] {
  const children = (node.children ?? []).slice();
  for (const root of node.shadowRoots ?? []) if (root.shadowRootType !== 'user-agent') children.push(root);
  if (node.contentDocument && /^(?:OBJECT|EMBED)$/.test(node.nodeName ?? '')) children.push(node.contentDocument);
  return children;
}
function indexBoundaryNodes(root: BoundaryNode, parent?: number): Map<number, BoundaryRecord> {
  const nodes = new Map<number, BoundaryRecord>();
  const pending = [{ node: root, parent }];
  const order: number[] = [];
  while (pending.length) {
    const entry = pending.pop()!;
    const { node } = entry;
    if (node.nodeId !== undefined) {
      nodes.set(node.nodeId, {
        parent: entry.parent,
        relevant: couldContainBoundary(node),
        rooted:
          node.shadowRootType === 'open' ||
          node.shadowRootType === 'closed' ||
          (node.shadowRoots?.some((shadow) => shadow.shadowRootType !== 'user-agent') ?? false),
        ...(node.shadowRootType === 'closed' ? { closedId: node.backendNodeId ?? null } : {}),
      });
      order.push(node.nodeId);
    }
    for (const child of boundaryChildren(node)) pending.push({ node: child, parent: node.nodeId ?? entry.parent });
  }
  inheritBoundaryFlags(nodes, order);
  return nodes;
}
function inheritBoundaryFlags(nodes: Map<number, BoundaryRecord>, order: number[]): void {
  for (const id of order.reverse()) {
    const entry = nodes.get(id)!;
    const ancestor = entry.parent === undefined ? undefined : nodes.get(entry.parent);
    if (entry.relevant && ancestor) ancestor.relevant = true;
    if (entry.rooted && ancestor) ancestor.rooted = true;
  }
}
function markRooted(state: Catalog, id: number | undefined): void {
  let node = id === undefined ? undefined : state.nodes.get(id);
  while (node && !node.rooted) {
    node.rooted = true;
    node = node.parent === undefined ? undefined : state.nodes.get(node.parent);
  }
}
function insertedBoundary(state: Catalog, node: BoundaryNode, parent: number): void {
  const added = indexBoundaryNodes(node, parent);
  for (const [id, entry] of added) state.nodes.set(id, entry);
  if (node.nodeId !== undefined && added.get(node.nodeId)?.rooted) markRooted(state, parent);
  if (!(node.nodeId === undefined ? couldContainBoundary(node) : added.get(node.nodeId)?.relevant)) return;
  state.version++;
  let ancestor = state.nodes.get(parent);
  while (ancestor && !ancestor.relevant) {
    ancestor.relevant = true;
    ancestor = ancestor.parent === undefined ? undefined : state.nodes.get(ancestor.parent);
  }
}
function connectedNode(state: Catalog, id: number): boolean {
  let node = state.nodes.get(id);
  while (node?.parent !== undefined) node = state.nodes.get(node.parent);
  return node !== undefined;
}
function subscribeInsertedTree(state: Catalog, node: BoundaryNode): void {
  if (node.nodeType !== 1 || node.nodeId === undefined) return;
  const id = node.nodeId;
  state.unexpanded.add(id);
  const request = state.client
    .send('DOM.requestChildNodes', { nodeId: id, depth: -1, pierce: true })
    .then(() => {})
    .catch(() => {
      if (connectedNode(state, id)) state.version++;
    })
    .finally(() => {
      state.unexpanded.delete(id);
      state.pending.delete(request);
    });
  state.pending.add(request);
}
async function finishSubscriptions(state: Catalog): Promise<void> {
  for (let attempt = 0; state.pending.size && attempt < 3; attempt++) await Promise.all(state.pending);
  if (state.pending.size) throw new Error('unsettled author-boundary subscriptions');
}
function unexpandedAncestor(state: Catalog, id: number): boolean {
  let next: number | undefined = id;
  while (next !== undefined) {
    if (state.unexpanded.has(next)) return true;
    next = state.nodes.get(next)?.parent;
  }
  return false;
}
function unreadClosedDescendant(state: Catalog, removed: number): boolean {
  if (!state.nodes.get(removed)?.rooted) return false;
  for (const [id, entry] of state.nodes) {
    if (entry.closedId === undefined || (entry.closedId !== null && state.registered.has(entry.closedId))) continue;
    let current: number | undefined = id;
    while (current !== undefined) {
      if (current === removed) return true;
      current = state.nodes.get(current)?.parent;
    }
  }
  return false;
}
function closedRootId(root: BoundaryNode): number | undefined {
  if (root.shadowRootType === 'open') return;
  if (root.shadowRootType !== 'closed' || root.backendNodeId === undefined) throw new Error('unreadable author root');
  return root.backendNodeId;
}
function queueAuthorRoots(node: BoundaryNode, pending: BoundaryNode[], result: number[]): void {
  for (const shadow of node.shadowRoots ?? []) {
    if (shadow.shadowRootType === 'user-agent') continue;
    const id = closedRootId(shadow);
    if (id !== undefined) result.push(id);
    pending.push(shadow);
  }
}
function closedRoots(root: BoundaryNode): number[] {
  if (root.nodeType !== 9) throw new Error('missing document boundary');
  const result: number[] = [],
    pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    queueAuthorRoots(node, pending, result);
    for (const child of node.children ?? []) pending.push(child);
    if (node.contentDocument && /^(?:OBJECT|EMBED)$/.test(node.nodeName ?? '')) pending.push(node.contentDocument);
  }
  return result;
}
export async function openCatalog(page: Page): Promise<Catalog> {
  const existing = catalogs.get(page);
  if (existing) return existing;
  const client = registerStyleProofSession(await page.context().newCDPSession(page));
  const state: Catalog = {
    client,
    version: 0,
    epoch: 0,
    scanned: -1,
    roots: [],
    registered: new Set(),
    sheets: new Map(),
    nodes: new Map(),
    pending: new Set(),
    unexpanded: new Set(),
  };
  const changed = () => {
    state.version++;
  };
  const barrier = () => {
    state.epoch++;
    changed();
  };
  client.on('DOM.documentUpdated', barrier);
  client.on('DOM.shadowRootPopped', (event) => {
    if (event?.rootId === undefined || unreadClosedDescendant(state, event.rootId)) state.epoch++;
    changed();
  });
  client.on('DOM.shadowRootPushed', (event) => {
    if (event?.root?.shadowRootType === 'user-agent') return;
    changed();
    markRooted(state, event?.hostId);
    if (event?.root) insertedBoundary(state, event.root, event.hostId);
  });
  client.on('DOM.childNodeInserted', ({ node, parentNodeId }) => {
    insertedBoundary(state, node, parentNodeId);
    subscribeInsertedTree(state, node);
  });
  client.on('DOM.setChildNodes', ({ parentId, nodes }) => {
    for (const node of nodes) insertedBoundary(state, node, parentId);
  });
  client.on('DOM.childNodeCountUpdated', ({ nodeId }) => {
    // An unexpanded frontier could have hidden a transient root at Begin. A known
    // subscribed subtree's count notifications do not invalidate its evidence.
    if (unexpandedAncestor(state, nodeId)) barrier();
  });
  client.on('DOM.childNodeRemoved', ({ nodeId }) => {
    if (unexpandedAncestor(state, nodeId) || unreadClosedDescendant(state, nodeId)) state.epoch++;
    if (state.nodes.get(nodeId)?.relevant !== false) changed();
    state.nodes.delete(nodeId);
  });
  client.on('CSS.styleSheetAdded', ({ header }) => {
    if (header.sourceURL) state.sheets.set(header.styleSheetId, header.sourceURL);
  });
  client.on('CSS.styleSheetRemoved', ({ styleSheetId }) => state.sheets.delete(styleSheetId));
  try {
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    catalogs.set(page, state);
    return state;
  } catch (error) {
    await client.detach().catch(() => {});
    throw error;
  }
}
async function registerRoot(state: Catalog, id: number): Promise<void> {
  if (state.registered.has(id)) return;
  const { object } = await state.client.send('DOM.resolveNode', { backendNodeId: id });
  if (!object.objectId) throw new Error('unavailable author root');
  try {
    const result = await state.client.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: captureExpression(
        'function(id){ const target=window.top; target.__spChannelRoots.set(id,this); target.__spChannelHosts.add(this.host); if(!target.__spObserveChannelRoot) return false; target.__spObserveChannelRoot(this); return true; }',
      ),
      arguments: [{ value: id }],
    });
    if (result.exceptionDetails) throw new Error('unreadable author root');
    if (result.result?.value === true) state.registered.add(id);
  } finally {
    await state.client.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}
/** A watched tree is reused only while no author-boundary mutation has occurred. */
export async function readVisualChannelBoundaries(
  page: Page,
): Promise<{ catalog: Catalog; version: number; epoch: number; roots: number[] }> {
  const state = await openCatalog(page);
  await finishSubscriptions(state);
  for (let attempt = 0; state.scanned !== state.version && attempt < 3; attempt++) {
    const version = state.version;
    const { root } = await state.client.send('DOM.getDocument', { depth: -1, pierce: true });
    state.roots = closedRoots(root as BoundaryNode);
    state.nodes = indexBoundaryNodes(root as BoundaryNode);
    for (const id of state.roots) await registerRoot(state, id);
    await finishSubscriptions(state);
    if (version === state.version) state.scanned = version;
  }
  if (state.scanned !== state.version) throw new Error('author boundaries keep changing during verification');
  return { catalog: state, version: state.version, epoch: state.epoch, roots: state.roots };
}
/** Ordinary subtree churn is harmless when the roots actually read are still complete. */
export async function verifyVisualChannelBoundaries(
  page: Page,
  before: Awaited<ReturnType<typeof readVisualChannelBoundaries>>,
): Promise<boolean> {
  await finishSubscriptions(before.catalog);
  if (before.catalog.epoch !== before.epoch) return false;
  if (before.catalog.version === before.version) return true;
  const after = await readVisualChannelBoundaries(page);
  // New closed roots are synchronously observed during registration. Removed
  // observed roots are safe too: any motion they exposed is held capture-wide.
  const previous = new Set(before.roots);
  return (
    after.epoch === before.epoch && after.roots.every((id) => previous.has(id) || after.catalog.registered.has(id))
  );
}
export async function releaseVisualChannelSources(page: Page): Promise<void> {
  const state = catalogs.get(page);
  catalogs.delete(page);
  await state?.client.detach().catch(() => {});
  if (state)
    await page
      .evaluate(captureExpression('window.__spChannelRoots?.clear(); window.__spChannelImageTypes?.clear(); void 0;'))
      .catch(() => {});
}
