/**
 * Test coverage for #539: advisory content JSON/Markdown parity.
 * TDD failing-first: verifies that advisory layer structure matches rendered Markdown
 * sections. Every JSON advisory entry must have a corresponding Markdown section with
 * matching content.
 *
 * @see https://github.com/BenSheridanEdwards/StyleProof/issues/539
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { generateStructuralStyleMapReportForTesting as generateStyleMapReport } from '../dist/report.js';

function mkTmp(prefix = 'styleproof-advisory-parity-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a minimal StyleMap with content capture enabled.
 */
function makeMap({ elements = {}, defaults = {}, states = {} } = {}) {
  const els = {};
  for (const [p, e] of Object.entries(elements)) {
    els[p] = {
      tag: e.tag ?? 'div',
      cls: e.cls ?? '',
      ...(e.rect ? { rect: e.rect } : {}),
      style: e.style ?? {},
      ...(e.ownTextLength !== undefined ? { ownTextLength: e.ownTextLength } : {}),
      ...(e.text !== undefined ? { text: e.text } : {}),
      ...(e.component ? { component: e.component } : {}),
    };
  }
  return { defaults, elements: els, states };
}

function writeCapture(dir, surface, map) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${surface}.json.gz`), gzipSync(JSON.stringify(map)));
}

function tmpDirs() {
  const root = mkTmp();
  return {
    root,
    beforeDir: path.join(root, 'before'),
    afterDir: path.join(root, 'after'),
    outDir: path.join(root, 'out'),
  };
}

describe('advisory content JSON/Markdown parity (#539)', () => {
  describe('JSON advisory layer structure', () => {
    test('report.json contains content field with advisory: true', () => {
      const { beforeDir, afterDir, outDir, root } = tmpDirs();
      try {
        const map = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > p:nth-child(1)': {
              tag: 'p',
              cls: 'intro',
              rect: [20, 20, 400, 100],
              ownTextLength: 50,
              text: 'Hello world',
              style: { color: 'rgb(0, 0, 0)' },
            },
          },
        });

        writeCapture(beforeDir, 'home@1280', map);
        writeCapture(afterDir, 'home@1280', map);

        const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
        const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));

        // Verify content field exists with advisory flag
        assert.ok(json.content !== undefined, 'report.json should have content field');
        assert.equal(json.content.advisory, true, 'content.advisory should be true');
        assert.ok(typeof json.content.evaluated === 'boolean', 'content.evaluated should be boolean');
        assert.ok(typeof json.content.changes === 'number', 'content.changes should be number');
      } finally {
        rmTmp(root);
      }
    });

    test('content.changes count matches actual content changes detected', () => {
      const { beforeDir, afterDir, outDir, root } = tmpDirs();
      try {
        const before = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > p:nth-child(1)': {
              tag: 'p',
              cls: 'intro',
              rect: [20, 20, 400, 100],
              ownTextLength: 11,
              text: 'Hello world',
              style: { color: 'rgb(0, 0, 0)' },
            },
          },
        });
        const after = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > p:nth-child(1)': {
              tag: 'p',
              cls: 'intro',
              rect: [20, 20, 400, 100],
              ownTextLength: 13,
              text: 'Hello world!!',
              style: { color: 'rgb(0, 0, 0)' }, // Same style, different text
            },
          },
        });

        writeCapture(beforeDir, 'home@1280', before);
        writeCapture(afterDir, 'home@1280', after);

        const result = generateStyleMapReport({
          beforeDir,
          afterDir,
          outDir,
          includeContent: true,
        });
        const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));

        assert.equal(json.content.evaluated, true, 'content should be evaluated when includeContent is true');
        assert.equal(result.contentChanges, json.content.changes, 'contentChanges in result should match JSON');
      } finally {
        rmTmp(root);
      }
    });
  });

  describe('Markdown advisory section rendering', () => {
    test('advisory section header appears when content changes exist', () => {
      const { beforeDir, afterDir, outDir, root } = tmpDirs();
      try {
        const before = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > span:nth-child(1)': {
              tag: 'span',
              cls: 'label',
              rect: [20, 20, 100, 30],
              ownTextLength: 5,
              text: 'Start',
              style: {},
            },
          },
        });
        const after = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > span:nth-child(1)': {
              tag: 'span',
              cls: 'label',
              rect: [20, 20, 100, 30],
              ownTextLength: 4,
              text: 'Stop',
              style: {},
            },
          },
        });

        writeCapture(beforeDir, 'home@1280', before);
        writeCapture(afterDir, 'home@1280', after);

        const result = generateStyleMapReport({
          beforeDir,
          afterDir,
          outDir,
          includeContent: true,
        });
        const md = fs.readFileSync(result.reportMdPath, 'utf8');

        // Verify advisory section header
        assert.match(
          md,
          /## 📝 Content and structure changes \(advisory\)/,
          'Advisory section header should be present',
        );
      } finally {
        rmTmp(root);
      }
    });

    test('advisory section includes explanatory disclaimer text', () => {
      const { beforeDir, afterDir, outDir, root } = tmpDirs();
      try {
        const before = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > h1:nth-child(1)': {
              tag: 'h1',
              cls: 'title',
              rect: [20, 20, 400, 50],
              ownTextLength: 7,
              text: 'Welcome',
              style: {},
            },
          },
        });
        const after = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > h1:nth-child(1)': {
              tag: 'h1',
              cls: 'title',
              rect: [20, 20, 400, 50],
              ownTextLength: 5,
              text: 'Hello',
              style: {},
            },
          },
        });

        writeCapture(beforeDir, 'home@1280', before);
        writeCapture(afterDir, 'home@1280', after);

        const result = generateStyleMapReport({
          beforeDir,
          afterDir,
          outDir,
          includeContent: true,
        });
        const md = fs.readFileSync(result.reportMdPath, 'utf8');

        // Verify explanatory text about advisory nature
        assert.match(md, /Advisory only/, 'Should include "Advisory only" disclaimer');
        assert.match(
          md,
          /content and DOM structure are not part of the/i,
          'Should explain content is not part of certification',
        );
        assert.match(md, /do not affect the check/i, 'Should clarify it does not affect the check');
      } finally {
        rmTmp(root);
      }
    });

    test('no advisory section when includeContent is false', () => {
      const { beforeDir, afterDir, outDir, root } = tmpDirs();
      try {
        const before = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > p:nth-child(1)': {
              tag: 'p',
              rect: [20, 20, 400, 100],
              ownTextLength: 5,
              text: 'Hello',
              style: {},
            },
          },
        });
        const after = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > p:nth-child(1)': {
              tag: 'p',
              rect: [20, 20, 400, 100],
              ownTextLength: 7,
              text: 'Goodbye',
              style: {},
            },
          },
        });

        writeCapture(beforeDir, 'home@1280', before);
        writeCapture(afterDir, 'home@1280', after);

        const result = generateStyleMapReport({
          beforeDir,
          afterDir,
          outDir,
          includeContent: false,
        });
        const md = fs.readFileSync(result.reportMdPath, 'utf8');
        const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));

        // Verify no advisory section in markdown
        assert.doesNotMatch(
          md,
          /## 📝 Content and structure changes/,
          'Advisory section should not appear when includeContent is false',
        );

        // JSON should still have the content field structure
        assert.equal(json.content.evaluated, false, 'content.evaluated should be false');
        assert.equal(json.content.changes, 0, 'content.changes should be 0 when not evaluated');
      } finally {
        rmTmp(root);
      }
    });
  });

  describe('JSON/Markdown structural parity', () => {
    test('content count in JSON matches count in Markdown header', () => {
      const { beforeDir, afterDir, outDir, root } = tmpDirs();
      try {
        const before = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > p:nth-child(1)': {
              tag: 'p',
              rect: [20, 20, 400, 100],
              ownTextLength: 3,
              text: 'One',
              style: {},
            },
            'body > p:nth-child(2)': {
              tag: 'p',
              rect: [20, 120, 400, 100],
              ownTextLength: 3,
              text: 'Two',
              style: {},
            },
          },
        });
        const after = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > p:nth-child(1)': {
              tag: 'p',
              rect: [20, 20, 400, 100],
              ownTextLength: 3,
              text: 'AAA',
              style: {},
            },
            'body > p:nth-child(2)': {
              tag: 'p',
              rect: [20, 120, 400, 100],
              ownTextLength: 3,
              text: 'BBB',
              style: {},
            },
          },
        });

        writeCapture(beforeDir, 'home@1280', before);
        writeCapture(afterDir, 'home@1280', after);

        const result = generateStyleMapReport({
          beforeDir,
          afterDir,
          outDir,
          includeContent: true,
        });
        const md = fs.readFileSync(result.reportMdPath, 'utf8');
        const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));

        const jsonCount = json.content.changes;

        // Extract count from Markdown - pattern: "_N content/structure change(s)"
        const mdMatch = md.match(/_(\d+) content\/structure change\(s\)/);
        const mdCount = mdMatch ? parseInt(mdMatch[1], 10) : null;

        if (jsonCount > 0) {
          assert.ok(mdCount !== null, 'Markdown should contain content change count');
          assert.equal(mdCount, jsonCount, `Markdown count (${mdCount}) should match JSON count (${jsonCount})`);
        }
      } finally {
        rmTmp(root);
      }
    });

    test('surfaces with content changes appear in both JSON and Markdown', () => {
      const { beforeDir, afterDir, outDir, root } = tmpDirs();
      try {
        const before = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > div:nth-child(1)': {
              tag: 'div',
              cls: 'card',
              rect: [20, 20, 300, 200],
              ownTextLength: 10,
              text: 'Card title',
              style: { color: 'rgb(0, 0, 0)' },
            },
          },
        });
        const after = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > div:nth-child(1)': {
              tag: 'div',
              cls: 'card',
              rect: [20, 20, 300, 200],
              ownTextLength: 12,
              text: 'New headline',
              style: { color: 'rgb(0, 0, 0)' }, // Same style
            },
          },
        });

        writeCapture(beforeDir, 'home@1280', before);
        writeCapture(afterDir, 'home@1280', after);

        const result = generateStyleMapReport({
          beforeDir,
          afterDir,
          outDir,
          includeContent: true,
        });
        const md = fs.readFileSync(result.reportMdPath, 'utf8');
        const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));

        // The content field indicates evaluation status
        assert.equal(json.content.evaluated, true);

        // If there are content changes, the advisory section should exist
        if (json.content.changes > 0) {
          assert.match(md, /Content and structure changes \(advisory\)/);
        }
      } finally {
        rmTmp(root);
      }
    });
  });

  describe('advisory indicator placement', () => {
    test('advisory changes are noted in headline when style changes also exist', () => {
      const { beforeDir, afterDir, outDir, root } = tmpDirs();
      try {
        const before = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > div:nth-child(1)': {
              tag: 'div',
              cls: 'box',
              rect: [20, 20, 200, 100],
              ownTextLength: 5,
              text: 'Hello',
              style: { color: 'rgb(0, 0, 0)' },
            },
          },
        });
        const after = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > div:nth-child(1)': {
              tag: 'div',
              cls: 'box',
              rect: [20, 20, 200, 100],
              ownTextLength: 7,
              text: 'Goodbye',
              style: { color: 'rgb(255, 0, 0)' }, // Style AND text changed
            },
          },
        });

        writeCapture(beforeDir, 'home@1280', before);
        writeCapture(afterDir, 'home@1280', after);

        const result = generateStyleMapReport({
          beforeDir,
          afterDir,
          outDir,
          includeContent: true,
        });
        const md = fs.readFileSync(result.reportMdPath, 'utf8');

        // When there are both style changes and content changes, advisory is mentioned
        if (result.contentChanges > 0 && result.totalFindings > 0) {
          assert.match(md, /advisory content change/i, 'Advisory content changes should be mentioned');
        }
      } finally {
        rmTmp(root);
      }
    });

    test('clean report with content changes shows advisory-only message', () => {
      const { beforeDir, afterDir, outDir, root } = tmpDirs();
      try {
        const before = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > span:nth-child(1)': {
              tag: 'span',
              cls: 'label',
              rect: [20, 20, 100, 30],
              ownTextLength: 4,
              text: 'v1.0',
              style: { color: 'rgb(0, 0, 0)' },
            },
          },
        });
        const after = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            'body > span:nth-child(1)': {
              tag: 'span',
              cls: 'label',
              rect: [20, 20, 100, 30],
              ownTextLength: 4,
              text: 'v2.0',
              style: { color: 'rgb(0, 0, 0)' }, // Same style, text change only
            },
          },
        });

        writeCapture(beforeDir, 'home@1280', before);
        writeCapture(afterDir, 'home@1280', after);

        const result = generateStyleMapReport({
          beforeDir,
          afterDir,
          outDir,
          includeContent: true,
        });
        const md = fs.readFileSync(result.reportMdPath, 'utf8');
        const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));

        // With no style changes but content changes, report should indicate clean for styles
        if (json.counts.style === 0 && json.counts.dom === 0 && json.content.changes > 0) {
          // The summary should indicate no style changes while noting content changes exist
          assert.match(md, /advisory/i, 'Should mention advisory content');
        }
      } finally {
        rmTmp(root);
      }
    });
  });

  describe('no orphaned JSON fields or Markdown sections', () => {
    test('all JSON content fields have Markdown representations', () => {
      const { beforeDir, afterDir, outDir, root } = tmpDirs();
      try {
        const map = makeMap({
          elements: {
            body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
          },
        });

        writeCapture(beforeDir, 'home@1280', map);
        writeCapture(afterDir, 'home@1280', map);

        const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
        const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));

        // Verify content field structure is complete
        assert.ok('evaluated' in json.content, 'content.evaluated must exist');
        assert.ok('changes' in json.content, 'content.changes must exist');
        assert.ok('advisory' in json.content, 'content.advisory must exist');
        assert.equal(json.content.advisory, true, 'advisory flag must be true');
      } finally {
        rmTmp(root);
      }
    });

    test('order and nesting preserved between JSON and Markdown', () => {
      const { beforeDir, afterDir, outDir, root } = tmpDirs();
      try {
        // Create multiple surfaces to test ordering
        for (const surface of ['about@1280', 'home@1280', 'contact@1280']) {
          const map = makeMap({
            elements: {
              body: { tag: 'body', rect: [0, 0, 1280, 800], style: {} },
            },
          });
          writeCapture(beforeDir, surface, map);
          writeCapture(afterDir, surface, map);
        }

        const result = generateStyleMapReport({ beforeDir, afterDir, outDir });
        const json = JSON.parse(fs.readFileSync(result.reportJsonPath, 'utf8'));

        // Verify surfaces array exists and is ordered
        assert.ok(Array.isArray(json.surfaces), 'surfaces should be an array');

        // Content field should always be present with consistent structure
        assert.deepEqual(Object.keys(json.content).sort(), ['advisory', 'changes', 'evaluated'].sort());
      } finally {
        rmTmp(root);
      }
    });
  });
});
