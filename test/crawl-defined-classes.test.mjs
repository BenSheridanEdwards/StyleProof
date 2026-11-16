import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { collectDefinedClasses } from '../dist/crawl/browser.js';

for (const [selectorText, expected] of [
  [String.raw`.md\:flex .hover\:bg-blue-500:hover .w-1\/2 .p-2\.5`, ['md:flex', 'hover:bg-blue-500', 'w-1/2', 'p-2.5']],
  [String.raw`.-mt-4 .\32xl\:grid`, ['-mt-4', '2xl:grid']],
  [String.raw`.-mt-4 .\32 xl\:grid`, ['-mt-4', '2xl:grid']],
  ['a[href$=".pdf"]:is(.card)', ['card']],
  [String.raw`[data-note="escaped\".fake"] .card`, ['card']],
  [String.raw`#escaped\.id /* .comment */ .card`, ['card']],
]) {
  test(`defined vocabulary: ${selectorText}`, () => {
    const result = vm.runInNewContext(`(${collectDefinedClasses.toString()})()`, {
      document: { styleSheets: [{ cssRules: [{ selectorText }] }] },
    });
    assert.deepEqual(Array.from(result.classes), expected);
    assert.deepEqual(Array.from(result.unreadable), []);
  });
}
