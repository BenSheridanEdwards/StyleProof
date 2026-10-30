import { GENERATED_ID_SOURCES } from '../dist/generated-id.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { capturePage, injectPathOf } from '../dist/capture/browser.js';

function repeatedTree(size) {
  let attributeReads = 0;

  const element = (tag, attributes = {}, children = []) => {
    const node = {
      tagName: tag.toUpperCase(),
      children,
      getAttribute(name) {
        attributeReads++;

        return attributes[name] ?? null;
      },
    };

    for (const child of children) child.parentElement = node;

    return node;
  };

  const rows = Array.from({ length: size }, (_, index) =>
    element('section', { 'data-testid': `row-${index}` }, [element('span'), element('button')]),
  );

  const body = element('body', {}, rows);
  body.appendChild = () => {};

  const html = element('html', {}, [body]);
  const descendants = (node) => node.children.flatMap((child) => [child, ...descendants(child)]);
  const style = { length: 0, display: 'block', getPropertyValue: () => 'none' };

  const context = createContext({
    window: { scrollX: 0, scrollY: 0 },
    document: {
      documentElement: html,
      body,
      styleSheets: [],
      querySelectorAll: () => descendants(body),
      createElement: () => ({
        style: {},
        contentDocument: {
          createElement: element,
          body: { appendChild() {} },
          defaultView: { getComputedStyle: () => style },
        },
        remove() {},
      }),
    },
    getComputedStyle: () => style,
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
  });

  runInContext(`(${injectPathOf.toString()})(${JSON.stringify(GENERATED_ID_SOURCES)})`, context);

  const capture = () => {
    attributeReads = 0;

    const map = runInContext(
      `(${capturePage.toString()})(${JSON.stringify({
        skipSel: '',
        motionOnly: true,
        captureText: false,
        pseudoReferences: { inherited: [], currentColor: [], generated: [] },
      })})`,
      context,
    );

    return { paths: Object.keys(map.elements), attributeReads };
  };

  return { capture, rows, body, html, element, context, descendants };
}

test('capturing repeated keyed rows resolves paths with linear attribute work', () => {
  const small = repeatedTree(40).capture();
  const large = repeatedTree(160).capture();
  assert.equal(small.paths.length, 122);
  assert.equal(large.paths.length, 482);
  assert.ok(
    large.attributeReads <= small.attributeReads * 5,
    `4x the rows required ${large.attributeReads / small.attributeReads}x the attribute reads`,
  );
});

test('each snapshot refreshes paths after insertion and duplicate identity changes', () => {
  const tree = repeatedTree(3);
  const before = tree.capture().paths;
  const inserted = tree.element('section', { 'data-testid': 'row-0' });
  inserted.parentElement = tree.body;
  tree.rows.unshift(inserted);
  const after = tree.capture().paths;
  assert.equal(after.length, before.length + 1);
  assert.ok(after.includes('body > section:nth-child(1)'));
  assert.ok(after.includes('body > section:nth-child(2)'));
  assert.ok(!after.includes(before[2]));
  tree.rows.shift();
  assert.deepEqual(tree.capture().paths, before);
});

test('cached paths equal uncached paths', () => {
  const tree = repeatedTree(0);
  const { element, body, html, context } = tree;

  const nodes = [
    element('section', { 'data-testid': 'unique' }, [
      element('div', { id: 'stable' }, [
        element('div', { id: ':r1:' }, [element('a', { href: '/example' }, [element('input', { name: 'query' })])]),
      ]),
    ]),
    element('section', { 'data-testid': 'duplicate' }),
    element('section', { 'data-testid': 'duplicate' }),
    element('div', { 'data-styleproof-key': 'explicit', 'data-test': 'test', 'data-style': 'token active' }),
  ];

  for (const node of nodes) node.parentElement = body;
  body.children.push(...nodes);
  const all = [html, body, ...tree.descendants(body)];
  const uncached = context.window.__spPathOf;
  const cached = context.window.__spCreatePathOf?.() ?? uncached;

  for (const node of all.toReversed()) assert.equal(cached(node), uncached(node));
  const expected = all.map(uncached);
  assert.ok(expected.includes('body > section:nth-child(2)'));
  assert.ok(expected.includes('body > section:nth-child(3)'));
  assert.ok(expected.some((path) => path.includes('div:nth-child(1)')));
  assert.deepEqual(tree.capture().paths, expected);
});
