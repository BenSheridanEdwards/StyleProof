import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  prepareVisualChannelSources,
  prepareInitialVisualChannelInputs,
} from '../dist/capture/visual-channel-proof.js';
import { releaseVisualChannelSources } from '../dist/capture/visual-channel-boundaries.js';
import * as values from '../dist/capture/visual-channel-values.js';
import { canonicalEngineKeyframes, resolveEngineBody } from '../dist/capture/visual-channel-values.js';
import { installVisualChannels } from '../dist/capture/visual-channels.js';

// Fixture blocks isolate helper state; the test bodies and matrices are unchanged.
{
  for (const change of [
    'text',
    'inert element',
    'host',
    'new closed root',
    'popped root',
    'unexpanded inert',
    'unexpanded count',
    'mime conflict',
    'raster formats',
  ])
    test(`proof revalidates boundary membership after ${change}`, async () => {
      let scans = 0,
        changed = false,
        rootAppeared = false;
      const listeners = new Map(),
        finishes = [];
      const window = {
        __spChannelRoots: new Map(),
        __spChannelHosts: new WeakSet(),
        __spBeginChannelProof() {},
        __spObserveChannelRoot() {},
        __spFinishChannelProof(verified) {
          finishes.push(verified);
        },
      };
      window.top = window;
      const root = { host: {} };
      const client = {
        on(name, fn) {
          listeners.set(name, fn);
        },
        async send(method, args) {
          if (method === 'DOM.getDocument') {
            scans++;
            return {
              root: {
                nodeId: 1,
                nodeType: 9,
                children: [{ nodeId: 2, nodeType: 1, nodeName: 'BODY', children: [] }],
                shadowRoots:
                  changed && (change === 'new closed root' || rootAppeared)
                    ? [{ nodeType: 11, shadowRootType: 'closed', backendNodeId: 42 }]
                    : [],
              },
            };
          }
          if (method === 'DOM.requestChildNodes' && change === 'unexpanded count') {
            listeners.get('DOM.childNodeCountUpdated')({ nodeId: 3 });
            return {};
          }
          if (method === 'DOM.requestChildNodes' && change === 'unexpanded inert') {
            rootAppeared = true;
            listeners.get('DOM.setChildNodes')({
              parentId: 3,
              nodes: [
                {
                  nodeId: 4,
                  nodeType: 1,
                  nodeName: 'X-LATE',
                  shadowRoots: [{ nodeType: 11, shadowRootType: 'closed', backendNodeId: 42 }],
                },
              ],
            });
            return {};
          }
          // A frame has one entry per URL; different frames can disagree.
          if (method === 'Page.getResourceTree')
            return {
              frameTree: {
                childFrames: ['mime conflict', 'raster formats'].includes(change)
                  ? [
                      {
                        frame: { url: 'https://frame.test/' },
                        resources: [
                          {
                            url: 'https://site.test/image',
                            mimeType: change === 'mime conflict' ? 'image/png' : 'image/webp',
                          },
                        ],
                      },
                    ]
                  : [],
                resources:
                  change === 'mime conflict'
                    ? [{ url: 'https://site.test/image', mimeType: 'image/svg+xml' }]
                    : change === 'raster formats'
                      ? [{ url: 'https://site.test/image', mimeType: 'image/avif' }]
                      : [],
              },
            };
          if (method === 'DOM.resolveNode') return { object: { objectId: 'root' } };
          if (method === 'Runtime.callFunctionOn') {
            const observed = vm.runInNewContext('(' + args.functionDeclaration + '\n).call(root,42)', { window, root });
            return { result: { value: observed } };
          }
          if (method === 'Runtime.evaluate') {
            if (!changed) {
              changed = true;
              if (change === 'new closed root') listeners.get('DOM.shadowRootPushed')();
              else if (change === 'popped root') listeners.get('DOM.shadowRootPopped')();
              else
                listeners.get('DOM.childNodeInserted')({
                  parentNodeId: 2,
                  node: {
                    nodeId: 3,
                    nodeType: change === 'text' ? 3 : 1,
                    nodeName: change === 'host' ? 'DIV' : 'I',
                    childNodeCount: 0,
                  },
                });
            }
            return { result: { value: [] } };
          }
          return {};
        },
        async detach() {},
      };
      const page = {
        evaluate: async (s) => vm.runInNewContext(s, { window }),
        context: () => ({ newCDPSession: async () => client }),
      };
      try {
        await prepareVisualChannelSources(page);
        if (change === 'mime conflict') assert.equal(window.__spChannelImageTypes.get('https://site.test/image'), true);
        if (change === 'raster formats')
          assert.equal(window.__spChannelImageTypes.get('https://site.test/image'), false);
        assert.equal(finishes.at(-1), !['popped root', 'unexpanded count'].includes(change));
        assert.equal(
          scans,
          ['text', 'inert element', 'popped root', 'unexpanded count', 'mime conflict', 'raster formats'].includes(
            change,
          )
            ? 1
            : 2,
        );
      } finally {
        await releaseVisualChannelSources(page);
      }
    });
}

{
  const frame = (props, easing = 'ease', offset = 1, composite = 'auto') => ({
    offset,
    computedOffset: offset,
    easing,
    composite,
    ...props,
  });

  for (const name of [
    'S1 closed slotted doc change',
    'S2 closed slotted body change',
    'S3 closed host doc change',
    'S4 closed host body change',
    'S5 closed host no doc rule',
    'S6 mixed doc change',
    'S7 mixed body change',
    'S8 closed outer',
  ]) {
    test(`${name} cannot publish an outer body`, () => {
      const body = canonicalEngineKeyframes([frame({ opacity: '0.5' })]);
      assert.equal(
        resolveEngineBody({
          body,
          hasLive: true,
          expected: 'document',
          matched: 'shadow',
          ambiguous: true,
          verified: true,
        }),
        undefined,
      );
    });
  }

  test('a verified document winner remains known outside shadow scope chains', () => {
    const body = canonicalEngineKeyframes([frame({ opacity: '.1' })]);
    assert.equal(
      resolveEngineBody({
        body,
        hasLive: true,
        expected: 'document',
        matched: 'document',
        verified: true,
        ambiguous: false,
      }),
      body,
    );
  });

  for (const scope of ['S9 adopted doc change', 'S10 adopted body change', 'three-level mixed chain'])
    test(scope, () => {
      assert.equal(
        resolveEngineBody({
          body: 'engine',
          hasLive: true,
          expected: 'document',
          matched: 'shadow',
          verified: true,
          ambiguous: true,
        }),
        undefined,
      );
    });
}

{
  test('late root invalidates the watched catalogue; registered roots are reused', async () => {
    const { releaseVisualChannelSources } = await import('../dist/capture/visual-channel-boundaries.js');
    let scans = 0,
      resolves = 0;
    const listeners = new Map(),
      begins = [],
      finishes = [];
    const window = {
      __spChannelRoots: new Map(),
      __spChannelHosts: new WeakSet(),
      __spObserveChannelRoot(root) {
        assert.deepEqual(root.getAnimations(), []);
      },
      __spBeginChannelProof(...args) {
        begins.push(args);
      },
      __spFinishChannelProof(...args) {
        finishes.push(args);
      },
    };
    window.top = window;
    const root = { host: {}, getAnimations: () => [] };
    const client = {
      on(name, fn) {
        listeners.set(name, fn);
      },
      async send(method, args) {
        if (method === 'DOM.getDocument')
          return {
            root: { nodeType: 9, shadowRoots: ++scans === 1 ? [] : [{ shadowRootType: 'closed', backendNodeId: 42 }] },
          };
        if (method === 'DOM.resolveNode') {
          resolves++;
          return { object: { objectId: 'root' } };
        }
        if (method === 'Runtime.callFunctionOn') {
          const observed = vm.runInNewContext('(' + args.functionDeclaration + '\n).call(root, 42)', { window, root });
          return { result: { value: observed } };
        }
        if (method === 'Runtime.evaluate') return { result: { value: [] } };
        return {};
      },
      async detach() {},
    };
    const page = {
      evaluate: async (expression) => vm.runInNewContext(expression, { window }),
      context: () => ({ newCDPSession: async () => client }),
    };
    await prepareVisualChannelSources(page);
    listeners.get('DOM.shadowRootPushed')();
    await prepareVisualChannelSources(page);
    await prepareVisualChannelSources(page);
    assert.equal(scans, 2);
    assert.equal(resolves, 1);
    assert.ok(finishes.every((args) => args[0]));
    assert.deepEqual(Array.from(begins[1][1]), [42]);
    assert.equal(window.__spChannelRoots.get(42), root);
    await releaseVisualChannelSources(page);
  });
}

{
  test('closed-root entry motion is retained after it finishes before proof', async () => {
    const held = [],
      events = [];
    const animation = {
      playState: 'paused',
      effect: {
        getComputedTiming: () => ({ delay: 0, activeDuration: 1000, endTime: 1000, localTime: 100, progress: 0.1 }),
      },
    };
    const reads = [];
    const root = {
      host: {},
      getAnimations: () => {
        reads.push(animation.playState);
        return animation.playState === 'finished' ? [] : [animation];
      },
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
          const observed = vm.runInNewContext('(' + args.functionDeclaration + '\n).call(root,42)', { window, root });
          return { result: { value: observed } };
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
      assert.deepEqual(reads, ['paused', 'paused']);
      // Registration already held the capture, so Begin short-circuits the later hold check.
      assert.deepEqual(held, []);
    } finally {
      await releaseVisualChannelSources(page);
    }
  });
}
