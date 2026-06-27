import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const actionYml = fs.readFileSync(path.join(here, '..', 'action.yml'), 'utf8');

test('composite action builds its checkout before running local bins', () => {
  const installStep = actionYml.match(/- name: Install StyleProof action runtime[\s\S]*?(?=\n\s{4}#|\n\s{4}- id:)/);

  assert.ok(installStep, 'action.yml should include an action runtime install step');
  assert.match(installStep[0], /npm ci --ignore-scripts/);
  assert.match(installStep[0], /npm run build/);
  assert.doesNotMatch(installStep[0], /npm ci .*--omit=dev/);
});
