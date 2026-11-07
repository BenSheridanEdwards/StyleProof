import type { CDPSession, Page } from '@playwright/test';
import { captureExpression } from './script-evaluation.js';
import { registerStyleProofSession } from './script-coverage-ownership.js';
type BoundaryNode = {
  nodeType?: number;
  nodeName?: string;
  backendNodeId?: number;
  shadowRootType?: string;
  children?: BoundaryNode[];
  shadowRoots?: BoundaryNode[];
  contentDocument?: BoundaryNode;
};
type Catalog = {
  client: CDPSession;
  version: number;
  scanned: number;
  roots: number[];
  registered: Set<number>;
  sheets: Map<string, string>;
};
const catalogs = new WeakMap<Page, Catalog>();
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
async function openCatalog(page: Page): Promise<Catalog> {
  const existing = catalogs.get(page);
  if (existing) return existing;
  const client = registerStyleProofSession(await page.context().newCDPSession(page));
  const state: Catalog = { client, version: 0, scanned: -1, roots: [], registered: new Set(), sheets: new Map() };
  const changed = () => {
    state.version++;
  };
  for (const event of [
    'DOM.documentUpdated',
    'DOM.shadowRootPushed',
    'DOM.shadowRootPopped',
    'DOM.childNodeInserted',
    'DOM.childNodeRemoved',
    'DOM.childNodeCountUpdated',
  ] as const)
    client.on(event, changed);
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
        'function(id){ const target=window.top; target.__spChannelRoots.set(id,this); target.__spChannelHosts.add(this.host); }',
      ),
      arguments: [{ value: id }],
    });
    if (result.exceptionDetails) throw new Error('unreadable author root');
    state.registered.add(id);
  } finally {
    await state.client.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}
/** A watched tree is reused only while no author-boundary mutation has occurred. */
export async function readVisualChannelBoundaries(
  page: Page,
): Promise<{ catalog: Catalog; version: number; roots: number[] }> {
  const state = await openCatalog(page);
  if (state.scanned !== state.version) {
    const version = state.version;
    const { root } = await state.client.send('DOM.getDocument', { depth: -1, pierce: true });
    state.roots = closedRoots(root as BoundaryNode);
    for (const id of state.roots) await registerRoot(state, id);
    if (version !== state.version) throw new Error('author boundaries changed during verification');
    state.scanned = version;
  }
  return { catalog: state, version: state.version, roots: state.roots };
}
export async function releaseVisualChannelSources(page: Page): Promise<void> {
  const state = catalogs.get(page);
  catalogs.delete(page);
  await state?.client.detach().catch(() => {});
  if (state) await page.evaluate(captureExpression('window.__spChannelRoots?.clear(); void 0;')).catch(() => {});
}
