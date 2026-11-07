import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installVisualChannelValues, prepareVisualChannelSources } from '../dist/capture/visual-channel-proof.js';
import { releaseVisualChannelSources } from '../dist/capture/visual-channel-boundaries.js';
import * as values from '../dist/capture/visual-channel-values.js';

test('serialized channel values run without their module scope', async () => {
  const context = vm.createContext({ window: {}, URL, URLSearchParams });
  await installVisualChannelValues({ evaluate: async (source) => vm.runInContext(source, context) });
  const v = context.window.__spChannelValues;
  assert.deepEqual(Object.keys(v).sort(), Object.keys(values).sort());
  assert.equal(v.mayBeSvg('data:image/png;base64,AA'), false);
  assert.equal(v.mayBeSvg('/a.svg', 'image/svg+xml'), true);
  assert.equal(v.mayBeSvg('/unknown'), true);
  assert.equal(v.mayBeSvg('/photo.png'), true);
  for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif'])
    assert.equal(v.mayBeSvg('/no-extension', mime), false);
  assert.equal(JSON.stringify(v.contentImageSources('url("https://site.test/a.png")')), '["https://site.test/a.png"]');
  assert.equal(JSON.stringify(v.contentImageSources('"url(text.svg)"')), '[]');
  assert.equal(v.contentImageSources('image-set("x.svg" 1x)'), undefined);
  assert.equal(v.motionInProgress('finished', { activeDuration: 1 }), false);
  assert.equal(v.holdKeyframes(false, false, false), false);
  assert.equal(v.fixedMediaSize({ unit: 'px', value: 1 }, { unit: 'px', value: 2 }), true);
  assert.equal(v.smilClockSeconds('1min'), 60);
  const svg = {
    getAttribute: () => null,
    getStartTime: () => 0,
    getSimpleDuration: () => 1,
    ownerSVGElement: { getCurrentTime: () => 2 },
  };
  assert.equal(v.smilActiveDuration(1, 0, svg), 1);
  assert.equal(v.smilInProgress(svg), false);
  const frames = [
    { offset: 0, easing: 'linear', composite: 'auto', opacity: '0' },
    { offset: 1, easing: 'ease', composite: 'auto', opacity: '1' },
  ];
  assert.ok(v.canonicalEngineKeyframes(frames).includes('cubic-bezier'));
  assert.equal(v.orderIndependentFrames(frames).length, 2);
  assert.equal(v.orderFrameGroup(frames).length, 2);
  assert.equal(v.frameDependencies(frames).edges[0].has(1), true);
  assert.equal(
    v.normalizeImageSource('https://site.test/a.png?token=secret', 'https://site.test', 'https://site.test/', true),
    '/a.png',
  );
  assert.equal(
    v.resolveEngineBody({
      verified: true,
      ambiguous: false,
      hasLive: true,
      body: 'known',
      expected: 'x',
      matched: 'x',
    }),
    'known',
  );
});

for (const change of ['text', 'inert element', 'host', 'new closed root', 'popped root', 'unexpanded inert'])
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
        if (method === 'Page.getResourceTree') return { frameTree: { resources: [] } };
        if (method === 'DOM.resolveNode') return { object: { objectId: 'root' } };
        if (method === 'Runtime.callFunctionOn') {
          vm.runInNewContext('(' + args.functionDeclaration + '\n).call(root,42)', { window, root });
          return {};
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
      assert.equal(finishes.at(-1), !['new closed root', 'popped root', 'unexpanded inert'].includes(change));
      assert.equal(scans, ['text', 'inert element', 'popped root'].includes(change) ? 1 : 2);
    } finally {
      await releaseVisualChannelSources(page);
    }
  });
