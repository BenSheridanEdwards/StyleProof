/** CDP sees closed author shadow roots that DOM shadowRoot cannot expose. */
import type { CDPSession, Page } from '@playwright/test';
import { FRAMEWORK_IGNORE } from './shared.js';
import { registerStyleProofSession } from './script-coverage-ownership.js';

type Node = {
  nodeType?: number;
  nodeName?: string;
  attributes?: string[];
  shadowRootType?: string;
  children?: Node[];
  shadowRoots?: Node[];
  contentDocument?: Node;
};
function frameworkNode(node: Node): boolean {
  const attributes = new Map<string, string>();
  for (let i = 0; i < (node.attributes?.length ?? 0); i += 2)
    attributes.set(node.attributes![i], node.attributes![i + 1]);
  return FRAMEWORK_IGNORE.some((selector) => {
    const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    return attribute
      ? attributes.has(attribute[1]) && (attribute[2] === undefined || attributes.get(attribute[1]) === attribute[2])
      : node.nodeName?.toLowerCase() === selector;
  });
}
function authorRoots(root: Node): number {
  let count = 0;
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (frameworkNode(node) || node.shadowRootType === 'user-agent') continue;
    if (node.shadowRootType) count++;
    pending.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
    if (node.contentDocument) pending.push(node.contentDocument);
  }
  return count;
}
/** Failure or unsupported CDP leaves absence unproven; never invent a zero. */
export async function captureAuthorShadowRoots(page: Page): Promise<number | undefined> {
  let client: CDPSession | undefined;
  try {
    client = registerStyleProofSession(await page.context().newCDPSession(page));
    const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    if (root?.nodeType !== 9) return undefined;
    return authorRoots(root as Node);
  } catch {
    return undefined;
  } finally {
    await client?.detach().catch(() => {});
  }
}
