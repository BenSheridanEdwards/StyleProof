import type { CDPSession, Page } from '@playwright/test';
import {
  canonicalEngineKeyframes,
  motionInProgress,
  smilInProgress,
  smilActiveDuration,
  smilClockSeconds,
  fixedMediaSize,
  mayBeSvg,
  contentImageSources,
  holdKeyframes,
  normalizeImageSource,
  orderIndependentFrames,
  orderFrameGroup,
  frameDependencies,
  resolveEngineBody,
} from './visual-channel-values.js';
import { captureExpression } from './script-evaluation.js';
import { readVisualChannelBoundaries, verifyVisualChannelBoundaries } from './visual-channel-boundaries.js';

export async function installVisualChannelValues(page: Page): Promise<void> {
  await page.evaluate(
    captureExpression(`window.__spChannelValues = {
    motionInProgress: (${motionInProgress.toString()}),
    fixedMediaSize: (${fixedMediaSize.toString()}),
    mayBeSvg: (${mayBeSvg.toString()}),
    contentImageSources: (${contentImageSources.toString()}),
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

async function installImageTypes(page: Page, client: CDPSession): Promise<void> {
  const types: [string, string][] = [];
  try {
    const { frameTree } = await client.send('Page.getResourceTree');
    const pending = [frameTree];
    while (pending.length) {
      const tree = pending.pop()!;
      if (tree.frame?.url && tree.frame.mimeType) types.push([tree.frame.url, tree.frame.mimeType]);
      for (const resource of tree.resources) types.push([resource.url, resource.mimeType]);
      for (const child of tree.childFrames ?? []) pending.push(child);
    }
  } catch {
    // Missing MIME evidence holds only the affected opaque images, not every model.
  }
  await page.evaluate(captureExpression(`window.__spChannelImageTypes = new Map(${JSON.stringify(types)}); void 0;`));
}

/** Retain entry-time liveness only after closed roots are available, before freezing. */
export async function prepareInitialVisualChannelInputs(page: Page): Promise<void> {
  try {
    const read = await readVisualChannelBoundaries(page);
    await installImageTypes(page, read.catalog.client);
    await page.evaluate(
      captureExpression(`window.__spReadInitialChannelInputs(${JSON.stringify(read.roots)}); void 0;`),
    );
    if (!(await verifyVisualChannelBoundaries(page, read)))
      throw new Error('author boundaries changed during initial read');
  } catch {
    await page.evaluate(captureExpression('window.__spReadInitialChannelInputs(); void 0;'));
  }
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

export async function prepareVisualChannelSources(page: Page, unfreeze = false): Promise<void> {
  let begun = false;
  let verified = false;
  let read: Awaited<ReturnType<typeof readVisualChannelBoundaries>> | undefined;
  try {
    read = await readVisualChannelBoundaries(page);
    await installImageTypes(page, read.catalog.client);
    await page.evaluate(
      captureExpression(`window.__spBeginChannelProof(${unfreeze}, ${JSON.stringify(read.roots)}); void 0;`),
    );
    begun = true;
    await recordMatchedSources(read.catalog.client);
    verified = await verifyVisualChannelBoundaries(page, read);
  } catch {
    // Missing or changing boundary/source evidence remains unknown.
  } finally {
    // No CDP must still lift the freeze before the ordinary motion read.
    if (!begun) await page.evaluate(captureExpression(`window.__spBeginChannelProof(${unfreeze}); void 0;`));
    await page.evaluate(
      captureExpression(
        `window.__spFinishChannelProof(${verified}, ${JSON.stringify([...(read?.catalog.sheets.values() ?? [])])}); void 0;`,
      ),
    );
  }
}
