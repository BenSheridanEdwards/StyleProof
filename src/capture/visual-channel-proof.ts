import type { CDPSession, Page } from '@playwright/test';
import {
  canonicalEngineKeyframes,
  motionInProgress,
  smilInProgress,
  smilActiveDuration,
  smilClockSeconds,
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
  nodeType?: number;
  children?: BoundaryNode[];
  shadowRoots?: BoundaryNode[];
  shadowRootType?: string;
};
/** Bulk author-boundary evidence; iframe documents and browser-owned roots are outside this capture. */
function opaqueAuthorRoots(root: BoundaryNode): boolean {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.shadowRootType === 'user-agent') continue;
    for (const shadow of node.shadowRoots ?? []) {
      if (shadow.shadowRootType === 'user-agent') continue;
      if (shadow.shadowRootType !== 'open') return true;
      pending.push(shadow);
    }
    for (const child of node.children ?? []) pending.push(child);
  }
  return false;
}

export async function installVisualChannelValues(page: Page): Promise<void> {
  await page.evaluate(
    captureExpression(`window.__spChannelValues = {
    motionInProgress: (${motionInProgress.toString()}),
    smilClockSeconds: (${smilClockSeconds.toString()}),
    smilActiveDuration: (duration, start, element) => (${smilActiveDuration.toString()})(duration, start, element, window.__spChannelValues.smilClockSeconds),
    smilInProgress: (element) => (${smilInProgress.toString()})(element, window.__spChannelValues.smilActiveDuration),
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
async function refreshVisualChannelSources(client: CDPSession): Promise<boolean> {
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  if (root.nodeType !== 9) throw new Error('missing document boundary');
  const opaque = opaqueAuthorRoots(root as BoundaryNode);
  await recordMatchedSources(client);
  return opaque;
}

export async function prepareVisualChannelSources(page: Page, unfreeze = false): Promise<void> {
  // Always lift/read through Playwright before any CDP setup that may fail.
  await page.evaluate(captureExpression(`window.__spBeginChannelProof(${unfreeze}); void 0;`));
  let client: CDPSession | undefined;
  const sheets = new Set<string>();
  let verified = false;
  let opaque = false;
  try {
    client = registerStyleProofSession(await page.context().newCDPSession(page));
    client.on('CSS.styleSheetAdded', ({ header }) => {
      if (header.sourceURL) sheets.add(header.sourceURL);
    });
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    opaque = await refreshVisualChannelSources(client);
    verified = true;
  } catch {
    // No CDP means unknown channel evidence, never a frozen ordinary motion read.
  } finally {
    try {
      await page.evaluate(
        captureExpression(
          `window.__spFinishChannelProof(${verified}, ${JSON.stringify([...sheets])}, ${opaque}); void 0;`,
        ),
      );
    } finally {
      await client?.detach().catch(() => {});
    }
  }
}
