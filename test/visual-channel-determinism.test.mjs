import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installVisualChannelValues } from '../dist/capture/visual-channel-proof.js';
import * as values from '../dist/capture/visual-channel-values.js';
import { assertDeterministicVisualChannels } from '../dist/visual-channels.js';
import { diffStyleMaps } from '../dist/diff.js';

// Fixture blocks isolate helper state; the test bodies and matrices are unchanged.
{
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
    assert.equal(
      JSON.stringify(v.contentImageSources('url("https://site.test/a.png")')),
      '["https://site.test/a.png"]',
    );
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
    assert.equal(
      v.smilActiveDuration(1, 0, { ...svg, getAttribute: (name) => (name === 'repeatDur' ? '2s' : null) }),
      2,
    );
    assert.equal(v.smilInProgress(svg), false);
    const frames = [
      { offset: 0, easing: 'linear', composite: 'auto', opacity: '0' },
      { offset: 1, easing: 'ease', composite: 'auto', opacity: '1' },
    ];
    assert.ok(v.canonicalEngineKeyframes(frames).includes('cubic-bezier'));
    assert.equal(v.orderIndependentFrames(frames).length, 2);
    assert.equal(v.orderFrameGroup(frames).length, 2);
    assert.equal(
      v.orderFrameGroup([
        { offset: 0, color: 'red' },
        { offset: 0, opacity: '1' },
        { offset: 0, transform: 'none' },
      ]).length,
      3,
    );
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
}

{
  const map = (style, visualChannels) => ({
    defaults: {},
    elements: { body: { tag: 'body', cls: '', style } },
    states: {},
    ...(visualChannels ? { visualChannels } : {}),
  });

  const evidence = (body) => ({
    version: 1,
    keyframes: { pulse: { name: 'pulse', hash: body, body, status: 'known' } },
  });

  test('self-check includes skipped unknown and missing visual-channel evidence', () => {
    const first = map({ 'animation keyframes (pulse)': 'pulse' }, evidence('a'));
    const missing = map({ 'animation keyframes (pulse)': 'pulse' });
    assert.deepEqual(diffStyleMaps(first, missing), []);
    assert.throws(() => assertDeterministicVisualChannels(first, missing, 'home'), /self-check failed/);
    const unknown = structuredClone(first);
    unknown.visualChannels.keyframes.pulse = { name: 'pulse', status: 'unknown' };
    assert.deepEqual(diffStyleMaps(first, unknown), []);
    assert.throws(() => assertDeterministicVisualChannels(first, unknown, 'home'), /self-check failed/);
  });

  test('channel self-check ignores ordinary empty layers while preserving target identity', () => {
    const first = map({ 'animation keyframes (pulse)': 'pulse' }, evidence('a'));
    const again = structuredClone(first);
    again.elements.extra = { tag: 'div', cls: '', style: { color: 'blue' }, pseudo: { '::before': { content: 'x' } } };
    again.states.extra = { checked: { extra: { color: 'blue' } } };
    assert.doesNotThrow(() => assertDeterministicVisualChannels(first, again, 'ordinary layers'));
  });

  test('channel self-check still rejects a missing unknown reference', () => {
    const first = map(
      { 'animation keyframes (pulse)': 'pulse' },
      { version: 1, keyframes: { pulse: { name: 'pulse', status: 'unknown' } } },
    );
    const again = structuredClone(first);
    delete again.elements.body.style['animation keyframes (pulse)'];
    assert.throws(() => assertDeterministicVisualChannels(first, again, 'missing'), /self-check failed/);
  });

  test('channel self-check rejects a reference moved to a different target', () => {
    const first = map({ 'animation keyframes (pulse)': 'pulse' }, evidence('a'));
    const again = structuredClone(first);
    again.elements.extra = again.elements.body;
    delete again.elements.body;
    assert.throws(() => assertDeterministicVisualChannels(first, again, 'moved target'), /self-check failed/);
  });

  test('channel self-check rejects a reference moved to a different forced state', () => {
    const first = map({}, evidence('a'));
    first.states.body = { hover: { body: { 'animation keyframes (pulse)': 'pulse' } } };
    const again = structuredClone(first);
    again.states.body.focus = again.states.body.hover;
    delete again.states.body.hover;
    assert.throws(() => assertDeterministicVisualChannels(first, again, 'moved state'), /self-check failed/);
  });

  test('channel-named target paths do not turn ordinary properties into channel evidence', () => {
    const first = map({ 'animation keyframes (pulse)': 'pulse' }, evidence('a'));
    first.elements['img currentSrc'] = { tag: 'div', cls: '', style: { color: 'red' } };
    const again = structuredClone(first);
    again.elements['img currentSrc'].style.color = 'blue';
    assert.doesNotThrow(() => assertDeterministicVisualChannels(first, again, 'channel-named path'));
  });
}
