import type { CDPSession, Page } from '@playwright/test';
import {
  canonicalEngineKeyframes,
  motionInProgress,
  holdKeyframes,
  normalizeImageSource,
  orderIndependentFrames,
  orderFrameGroup,
  frameDependencies,
  resolveEngineBody,
} from './visual-channel-values.js';
import { captureExpression } from './script-evaluation.js';
import { registerStyleProofSession } from './script-coverage-ownership.js';

type BoundaryNode = {
  backendNodeId?: number;
  nodeType?: number;
  children?: BoundaryNode[];
  shadowRoots?: BoundaryNode[];
  shadowRootType?: string;
};
/** Author hosts in the captured document, including hosts hidden inside closed roots; not iframe documents. */
function authorHosts(root: BoundaryNode): number[] {
  const hosts: number[] = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.shadowRootType === 'user-agent') continue;
    const roots = node.shadowRoots?.filter((shadow) => shadow.shadowRootType !== 'user-agent') ?? [];
    if (roots.length) {
      if (node.backendNodeId === undefined) throw new Error('missing shadow host identity');
      hosts.push(node.backendNodeId);
    }
    for (const child of node.children ?? []) pending.push(child);
    for (const shadow of roots) pending.push(shadow);
  }
  return hosts;
}

export async function installVisualChannelValues(page: Page): Promise<void> {
  await page.evaluate(
    captureExpression(`window.__spChannelValues = {
    motionInProgress: (${motionInProgress.toString()}),
    holdKeyframes: (${holdKeyframes.toString()}),
    frameDependencies: (${frameDependencies.toString()}),
    orderFrameGroup: (group) => (${orderFrameGroup.toString()})(group, window.__spChannelValues.frameDependencies),
    orderIndependentFrames: (frames) => (${orderIndependentFrames.toString()})(frames, window.__spChannelValues.orderFrameGroup),
    canonicalEngineKeyframes: (frames) => (${canonicalEngineKeyframes.toString()})(frames, window.__spChannelValues.orderIndependentFrames),
    normalizeImageSource: (${normalizeImageSource.toString()}),
    resolveEngineBody: (${resolveEngineBody.toString()})
  }; void 0;`),
  );
}

async function matchedSource(
  client: CDPSession,
  id: number,
  name: string,
  pseudo: string,
): Promise<string | undefined> {
  const { result } = await client.send('Runtime.evaluate', {
    expression: captureExpression(`window.__spChannelNodes.get(${id})`),
    returnByValue: false,
  });
  if (!result.objectId) return undefined;
  try {
    let { nodeId } = await client.send('DOM.requestNode', { objectId: result.objectId });
    if (pseudo) {
      const { node } = await client.send('DOM.describeNode', { nodeId, depth: 0, pierce: true });
      const target = node.pseudoElements?.find((element) => element.pseudoType === pseudo.slice(2));
      if (!target) return undefined;
      const { nodeIds } = await client.send('DOM.pushNodesByBackendIdsToFrontend', {
        backendNodeIds: [target.backendNodeId],
      });
      nodeId = nodeIds[0];
    }
    const { cssKeyframesRules } = await client.send('CSS.getMatchedStylesForNode', { nodeId });
    const rules = cssKeyframesRules?.filter((rule) => rule.animationName.text === name);
    if (rules?.length !== 1) return undefined;
    const frames: string[] = [];
    for (const frame of rules[0].keyframes) {
      if (typeof frame.style.cssText !== 'string') return undefined;
      frames.push(`${frame.keyText.text}{${frame.style.cssText}}`);
    }
    return '@keyframes __sp_source {' + frames.join('') + '}';
  } finally {
    await client.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
  }
}

async function markAuthorHosts(client: CDPSession, root: BoundaryNode): Promise<void> {
  for (const backendNodeId of authorHosts(root)) {
    const { object } = await client.send('DOM.resolveNode', { backendNodeId });
    if (!object.objectId) throw new Error('unavailable shadow host');
    try {
      const result = await client.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: captureExpression(
          'function(){ window.__spChannelHosts.add(this); if (!this.shadowRoot) window.__spChannelOpaqueRoots = true; }',
        ),
      });
      if (result.exceptionDetails) throw new Error('unavailable shadow boundary');
    } finally {
      await client.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    }
  }
}

async function recordMatchedSources(client: CDPSession): Promise<void> {
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression: captureExpression('window.__spChannelRequests()'),
    returnByValue: true,
  });
  if (exceptionDetails || !Array.isArray(result.value)) throw new Error('unavailable animation sources');
  const requests = result.value as { id: number; name: string; pseudo: string }[];
  for (const request of requests) {
    let text: string | undefined;
    try {
      text = await matchedSource(client, request.id, request.name, request.pseudo);
    } catch {
      text = undefined;
    }
    await client.send('Runtime.evaluate', {
      expression: captureExpression(
        `window.__spRecordChannelSource(${JSON.stringify(request.name)}, ${JSON.stringify(text) ?? 'undefined'}); void 0;`,
      ),
    });
  }
}

/** Refresh provenance after the synchronous snapshot; session availability never controls the motion read. */
async function refreshVisualChannelSources(client: CDPSession, checked: boolean): Promise<void> {
  const { root } = await client.send('DOM.getDocument', { depth: checked ? 0 : -1, pierce: true });
  if (root.nodeType !== 9) throw new Error('missing document boundary');
  if (!checked) await markAuthorHosts(client, root as BoundaryNode);
  await recordMatchedSources(client);
}

export async function prepareVisualChannelSources(page: Page, unfreeze = false): Promise<void> {
  // Always lift/read through Playwright before any CDP setup that may fail.
  const checked = await page.evaluate<boolean>(
    captureExpression(`window.__spBeginChannelProof(${unfreeze}); !!window.__spChannelHostsChecked`),
  );
  let client: CDPSession | undefined;
  const sheets = new Set<string>();
  let verified = false;
  try {
    client = registerStyleProofSession(await page.context().newCDPSession(page));
    client.on('CSS.styleSheetAdded', ({ header }) => {
      if (header.sourceURL) sheets.add(header.sourceURL);
    });
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    await refreshVisualChannelSources(client, checked);
    verified = true;
  } catch {
    // No CDP means unknown channel evidence, never a frozen ordinary motion read.
  } finally {
    try {
      await page.evaluate(
        captureExpression(`window.__spFinishChannelProof(${verified}, ${JSON.stringify([...sheets])}); void 0;`),
      );
    } finally {
      await client?.detach().catch(() => {});
    }
  }
}
