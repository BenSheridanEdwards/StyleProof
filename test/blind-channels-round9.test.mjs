import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installVisualChannels } from '../dist/capture/visual-channels.js';
import { prepareInitialVisualChannelInputs } from '../dist/capture/visual-channel-proof.js';
import { releaseVisualChannelSources } from '../dist/capture/visual-channel-boundaries.js';
import * as values from '../dist/capture/visual-channel-values.js';

test('closed-root entry motion is retained after it finishes before proof', async () => {
  const held = [],
    events = [];
  const animation = {
    playState: 'paused',
    effect: {
      getComputedTiming: () => ({ delay: 0, activeDuration: 1000, endTime: 1000, localTime: 100, progress: 0.1 }),
    },
  };
  const root = {
    host: {},
    getAnimations: () => (animation.playState === 'finished' ? [] : [animation]),
    querySelectorAll: () => [],
  };
  const window = {
    __spChannelValues: {
      ...values,
      holdKeyframes: (...args) => {
        held.push(args);
        return values.holdKeyframes(...args);
      },
    },
  };
  window.top = window;
  const document = { getAnimations: () => [], querySelectorAll: () => [], adoptedStyleSheets: [] };
  const context = vm.createContext({ window, document });
  vm.runInContext(`(${installVisualChannels.toString()})({enabled:true,retainInputs:true})`, context);
  const client = {
    on() {},
    async send(method, args) {
      events.push(method);
      if (method === 'DOM.getDocument')
        return { root: { nodeType: 9, shadowRoots: [{ shadowRootType: 'closed', backendNodeId: 42 }] } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'root' } };
      if (method === 'Runtime.callFunctionOn') {
        vm.runInNewContext('(' + args.functionDeclaration + '\n).call(root,42)', { window, root });
        return {};
      }
      return {};
    },
    async detach() {},
  };
  const page = {
    context: () => ({ newCDPSession: async () => client }),
    evaluate: async (s) => vm.runInContext(s, context),
  };
  try {
    await prepareInitialVisualChannelInputs(page);
    assert.equal(window.__spChannelRoots.get(42), root);
    assert.ok(events.includes('Runtime.callFunctionOn'));
    animation.playState = 'finished';
    window.__spBeginChannelProof(false, [42]);
    assert.deepEqual(held, [[true, true, false]]);
  } finally {
    await releaseVisualChannelSources(page);
  }
});
