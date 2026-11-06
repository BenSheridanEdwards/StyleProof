import type { CDPSession, Page } from '@playwright/test';
import {
  canonicalEngineKeyframes,
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
        functionDeclaration: captureExpression('function(){ window.__spChannelHosts.add(this); }'),
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

/** Refresh read-only engine provenance while the motion freeze is temporarily lifted. */
async function refreshVisualChannelSources(client: CDPSession, unfreeze: boolean, sheets: Set<string>): Promise<void> {
  let verified = false;
  try {
    const { result } = await client.send('Runtime.evaluate', {
      expression: captureExpression(`window.__spBeginChannelProof(${unfreeze}); !!window.__spChannelHostsChecked`),
      returnByValue: true,
    });
    const checked = result.value === true;
    const { root } = await client.send('DOM.getDocument', { depth: checked ? 0 : -1, pierce: true });
    if (root.nodeType !== 9) throw new Error('missing document boundary');
    if (!checked) await markAuthorHosts(client, root as BoundaryNode);
    await recordMatchedSources(client);
    verified = true;
  } catch {
    // Missing provenance is an evidence limit, never permission to choose an outer rule.
  } finally {
    await client
      .send('Runtime.evaluate', {
        expression: captureExpression(
          `window.__spFinishChannelProof(${verified}, ${JSON.stringify([...sheets])}); void 0;`,
        ),
      })
      .catch(() => {});
  }
}

export async function prepareVisualChannelSources(page: Page, unfreeze = false): Promise<void> {
  let client: CDPSession | undefined;
  try {
    client = registerStyleProofSession(await page.context().newCDPSession(page));
    const sheets = new Set<string>();
    client.on('CSS.styleSheetAdded', ({ header }) => {
      if (header.sourceURL) sheets.add(header.sourceURL);
    });
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    await refreshVisualChannelSources(client, unfreeze, sheets);
  } catch {
    // The installer starts unverified; unsupported readers stay unknown.
  } finally {
    await client?.detach().catch(() => {});
  }
}
