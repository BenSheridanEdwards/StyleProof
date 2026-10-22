import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkContextLayer, duplicateSections, isContextDoc } from '../scripts/check-context-layer.mjs';

const START_HERE = ['# Start here', '', ...Array.from({ length: 20 }, (_, i) => `Rule ${i + 1}.`)].join('\n');

/** A minimal valid context layer in a temp dir, with `overrides` written on top (null deletes). */
function contextLayer(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'styleproof-context-'));
  const files = {
    'AGENTS.md': '# AGENTS.md\n\nStart here: [`.agents/README.md`](.agents/README.md).\n',
    'CLAUDE.md': '# CLAUDE.md\n\nRead [`AGENTS.md`](AGENTS.md) first.\n\n@AGENTS.md\n',
    '.agents/README.md': START_HERE,
    '.agents/decisions/0001-first.md': '# 1. First\n',
    '.agents/decisions/0002-second.md': '# ADR 0002: Second\n',
    ...Object.fromEntries(
      [
        'ARCHITECTURE',
        'CONVENTIONS',
        'DEFINITION_OF_DONE',
        'GLOSSARY',
        'PR_QUALITY',
        'QUALITY_GATES',
        'TECH_STACK',
      ].map((name) => [`.agents/project/${name}.md`, `# ${name}\n`]),
    ),
    ...overrides,
  };
  for (const [file, text] of Object.entries(files)) {
    if (text === null) continue;
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const tracked = Object.keys(files).filter((file) => files[file] !== null);
  return { errors: checkContextLayer(root, tracked), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function errorsFor(overrides) {
  const { errors, cleanup } = contextLayer(overrides);
  cleanup();
  return errors;
}

test('a pointer chain with substantive start-here guide passes', () => {
  assert.deepEqual(errorsFor(), []);
});

test('AGENTS.md must point to .agents/README.md', () => {
  assert.match(
    errorsFor({ 'AGENTS.md': '# AGENTS.md\n\nRules live here.\n' }).join('\n'),
    /AGENTS\.md must point to \.agents\/README\.md/,
  );
});

test('CLAUDE.md must defer to AGENTS.md near the top', () => {
  const late = ['# CLAUDE.md', ...Array.from({ length: 10 }, () => ''), 'See AGENTS.md.'].join('\n');
  assert.match(errorsFor({ 'CLAUDE.md': late }).join('\n'), /CLAUDE\.md must defer to AGENTS\.md/);
});

test('a root pointer that regrows content (a gitnexus analyze block) fails', () => {
  const regrown = `# CLAUDE.md\n\nRead AGENTS.md first.\n\n${Array.from({ length: 12 }, (_, i) => `- generated ${i}`).join('\n')}\n`;
  assert.match(
    errorsFor({ 'CLAUDE.md': regrown }).join('\n'),
    /CLAUDE\.md has 14 non-empty lines \(max 12\).*--skip-agents-md/,
  );
});

test('a thin start-here guide and a missing project doc fail', () => {
  const errors = errorsFor({ '.agents/README.md': '# Start here\n', '.agents/project/GLOSSARY.md': null }).join('\n');
  assert.match(errors, /\.agents\/README\.md has under 20 non-empty lines/);
  assert.match(errors, /\.agents\/project\/GLOSSARY\.md is missing/);
});

test('a relative link to a missing file fails; URLs, anchors and code spans do not', () => {
  const guide = `${START_HERE}\n\n[gone](TOOLING.md) [web](https://example.com) [top](#start-here) \`[x](nope.md)\`\n\n\`\`\`md\n[fenced](nope.md)\n\`\`\`\n`;
  assert.deepEqual(errorsFor({ '.agents/README.md': guide }), ['.agents/README.md:24 links to missing TOOLING.md.']);
});

test('two ADRs with one number fail, naming both files', () => {
  const errors = errorsFor({ '.agents/decisions/0002-clash.md': '# ADR 0002: Clash\n' }).join('\n');
  assert.match(errors, /ADR 2 is used by \.agents\/decisions\/0002-clash\.md and \.agents\/decisions\/0002-second\.md/);
});

test('an ADR whose title number differs from its file name fails', () => {
  assert.match(
    errorsFor({ '.agents/decisions/0003-third.md': '# ADR 0004: Third\n' }).join('\n'),
    /0003-third\.md must start with `# ADR 0003:/,
  );
});

test('a section repeated under the same parent is reported once, at its outermost copy', () => {
  const text = '# Doc\n## Setup\n### Steps\n## Use\n## Setup\n### Steps\n';
  assert.deepEqual(
    duplicateSections(text).map(({ heading, lines }) => [heading, lines]),
    [['## Setup', [2, 5]]],
  );
  assert.deepEqual(duplicateSections('# A\n## Notes\n# B\n## Notes\n'), []);
  assert.deepEqual(duplicateSections('# A\n```\n# A\n```\n'), []);
});

test('context docs are root Markdown, .agents/ and skills, but not the changelog', () => {
  assert.deepEqual(
    [
      'AGENTS.md',
      'CHANGELOG.md',
      '.agents/project/GLOSSARY.md',
      '.claude/skills/x/SKILL.md',
      'docs/setup.md',
      'src/a.ts',
    ].filter(isContextDoc),
    ['AGENTS.md', '.agents/project/GLOSSARY.md', '.claude/skills/x/SKILL.md'],
  );
});
