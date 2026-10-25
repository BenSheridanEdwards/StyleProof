import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { alignRectsToFullPageGeometry, captureFullPageScreenshot } from '../dist/capture/full-page.js';

// Model the CSSOM boundary: writing a property serializes the entire style attribute.
// Attribute writes retain text without parsing declarations, as under strict CSP.
// The browser E2E covers Chromium's actual serialization and rule-reach classification.
function element(style, parentElement = null) {
  const properties = new Map();
  const el = {
    parentElement,
    scrollHeight: 1000,
    clientHeight: 300,
    scrollTop: 120,
    scrollLeft: 30,
    hasAttribute: () => style !== null,
    getAttribute: () => style,
    setAttribute: (_name, value) => {
      style = value;
    },
    removeAttribute: () => {
      style = null;
    },
    style: {
      set cssText(value) {
        assert.equal(value, '');
        properties.clear();
        style = '';
      },
      getPropertyValue: (name) => properties.get(name)?.value ?? '',
      getPropertyPriority: (name) => properties.get(name)?.priority ?? '',
      setProperty: (name, value, priority) => {
        if (value) properties.set(name, { value, priority });
        else properties.delete(name);
        style = [...properties]
          .map(([key, p]) => `${key}: ${p.value}${p.priority ? ' !' + p.priority : ''};`)
          .join(' ');
      },
      item: (index) => [...properties.keys()][index],
      get length() {
        return properties.size;
      },
    },
  };
  for (const declaration of (style ?? '').split(';').filter(Boolean)) {
    const [name, value] = declaration.split(':');
    properties.set(name, {
      value: value.replace(/!important$/, ''),
      priority: value.endsWith('!important') ? 'important' : '',
    });
  }
  return el;
}

for (const operation of ['rect alignment', 'screenshot', 'failed screenshot']) {
  test(`${operation} restores exact style attributes after expanding a scroller`, async () => {
    const html = element('margin:0');
    const body = element(null, html);
    const wrapper = element('', body);
    const scroller = element('overflow-y:auto;max-height:300px!important', wrapper);
    const nodes = [html, body, wrapper, scroller];
    const before = nodes.map((el) => el.getAttribute('style'));
    const originalMaxHeight = scroller.style.getPropertyValue('max-height');
    const context = vm.createContext({
      window: {},
      document: { documentElement: html, body, querySelectorAll: () => [wrapper, scroller] },
      getComputedStyle: (el) => ({ overflowY: el === scroller ? 'auto' : 'visible' }),
    });
    const page = {
      evaluate: async (fn, input) => vm.runInContext(`(${fn.toString()})`, context)(input),
      screenshot: async () => {
        assert.notDeepEqual(
          nodes.map((el) => el.getAttribute('style')),
          before,
          'layout was expanded',
        );
        if (operation === 'failed screenshot') throw new Error('screenshot failed');
      },
    };
    if (operation === 'rect alignment') await alignRectsToFullPageGeometry(page, {});
    else if (operation === 'failed screenshot') {
      await assert.rejects(captureFullPageScreenshot(page, 'unused.png'), /screenshot failed/);
    } else await captureFullPageScreenshot(page, 'unused.png');
    assert.deepEqual(
      nodes.map((el) => el.getAttribute('style')),
      before,
    );
    assert.equal(
      scroller.style.getPropertyValue('max-height'),
      originalMaxHeight,
      'CSSOM restored even when CSP blocks attribute parsing',
    );
    assert.equal(scroller.style.getPropertyValue('height'), '', 'expansion override removed');
    assert.equal(scroller.style.getPropertyPriority('max-height'), 'important');
    assert.equal(scroller.scrollTop, 120);
    assert.equal(scroller.scrollLeft, 30);
  });
}
