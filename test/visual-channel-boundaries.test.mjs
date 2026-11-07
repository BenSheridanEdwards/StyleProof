import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  readVisualChannelBoundaries,
  verifyVisualChannelBoundaries,
  releaseVisualChannelSources,
} from '../dist/capture/visual-channel-boundaries.js';
import { installVisualChannels } from '../dist/capture/visual-channels.js';
import { prepareInitialVisualChannelInputs } from '../dist/capture/visual-channel-proof.js';

for (const kind of [
  'open read',
  'closed read',
  'closed unread',
  'unreadable closed',
  'unsubscribed',
  'inert unsubscribed',
])
  test(`boundary removal handles ${kind} evidence`, async () => {
    const listeners = new Map();
    const shadow = {
      nodeId: 4,
      nodeType: 11,
      shadowRootType: kind.startsWith('open') ? 'open' : 'closed',
      backendNodeId: kind === 'unreadable closed' ? undefined : 40,
    };
    const host = { nodeId: 3, nodeType: 1, nodeName: 'X-ROW', shadowRoots: [shadow] };
    let removed = false,
      finish;
    const client = {
      on: (name, fn) => listeners.set(name, fn),
      async send(method) {
        if (method === 'DOM.getDocument')
          return {
            root: {
              nodeId: 1,
              nodeType: 9,
              children: [
                {
                  nodeId: 2,
                  nodeType: 1,
                  nodeName: 'BODY',
                  children: !removed && kind.endsWith(' read') ? [host] : [],
                },
              ],
            },
          };
        if (method === 'DOM.resolveNode') return { object: { objectId: 'root' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
        if (method === 'DOM.requestChildNodes' && kind.endsWith('unsubscribed'))
          return new Promise((resolve) => {
            finish = resolve;
          });
        return {};
      },
      async detach() {},
    };
    const page = { context: () => ({ newCDPSession: async () => client }), evaluate: async () => {} };
    try {
      const before = await readVisualChannelBoundaries(page);
      if (!kind.endsWith(' read')) {
        listeners.get('DOM.childNodeInserted')({
          parentNodeId: 2,
          node: kind.endsWith('unsubscribed')
            ? { nodeId: 3, nodeType: 1, nodeName: kind === 'unsubscribed' ? 'DIV' : 'I', childNodeCount: 0 }
            : host,
        });
        if (!kind.endsWith('unsubscribed')) await new Promise((resolve) => setImmediate(resolve));
      }
      removed = true;
      listeners.get('DOM.childNodeRemoved')({ parentNodeId: 2, nodeId: 3 });
      finish?.({});
      assert.equal(
        await verifyVisualChannelBoundaries(page, before),
        kind.endsWith(' read') || kind === 'inert unsubscribed',
      );
    } finally {
      await releaseVisualChannelSources(page);
    }
  });

test('initial liveness verification flushes queued events on the catalogue session', async () => {
  const listeners = new Map(),
    calls = [];
  let queued = false,
    changed = false;
  const window = {
    __spReadInitialChannelInputs: (roots) => {
      calls.push(roots);
      queued = true;
    },
  };
  const client = {
    on: (name, fn) => listeners.set(name, fn),
    async send(method) {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1, nodeType: 9, children: [] } };
      if (method === 'Page.getResourceTree') return { frameTree: { resources: [] } };
      if (method === 'Runtime.evaluate' && queued && !changed) {
        changed = true;
        listeners.get('DOM.documentUpdated')();
      }
      return {};
    },
    async detach() {},
  };
  const page = {
    context: () => ({ newCDPSession: async () => client }),
    evaluate: async (s) => vm.runInNewContext(s, { window }),
  };
  try {
    await prepareInitialVisualChannelInputs(page);
    assert.equal(changed, true);
    assert.equal(calls.length, 2);
    assert.equal(calls.at(-1), undefined);
  } finally {
    await releaseVisualChannelSources(page);
  }
});

test('a completed failed proof stays unknown after a later successful proof', () => {
  const window = { __spChannelValues: {} };
  vm.runInNewContext('(' + installVisualChannels.toString() + ')(true)', { window });
  window.__spFinishChannelProof(false);
  window.__spFinishChannelProof(true);
  assert.equal(window.__spChannelScopesVerified, false);
});
