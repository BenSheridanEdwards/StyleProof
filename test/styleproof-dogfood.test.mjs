import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.join(here, '..', '.github/workflows/styleproof-dogfood.yml');
const actionDogfoodPath = path.join(here, '..', '.github/workflows/action-dogfood.yml');
const ciPath = path.join(here, '..', '.github/workflows/ci.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const actionDogfood = fs.readFileSync(actionDogfoodPath, 'utf8');
const ci = fs.readFileSync(ciPath, 'utf8');

test('live dogfood captures declared config.ts surfaces and runs the Action advisory', () => {
  assert.match(workflow, /name: StyleProof dogfood/);
  assert.match(workflow, /styleproof\.config\.ts/);
  assert.match(workflow, /example\/styleproof\.spec\.ts/);
  assert.match(workflow, /example\/store-dogfood\.playwright\.config\.ts/);
  assert.match(workflow, /--sha "\$HEAD_SHA" --upload/);
  assert.match(workflow, /--sha "\$BASE_SHA" --upload/);
  assert.match(workflow, /STYLEPROOF_DEMO_ROOT="\$BASE_WT\/example\/demo"/);
  assert.match(workflow, /--config example\/store-dogfood\.playwright\.config\.ts/);
  assert.doesNotMatch(workflow, /--config "\$BASE_WT\//, 'worktree Playwright config cannot resolve @playwright/test');
  assert.doesNotMatch(workflow, /ln -sfn/, 'worktree must stay clean so --upload is not refused');
  const pwConfig = fs.readFileSync(path.join(here, '..', 'example/store-dogfood.playwright.config.ts'), 'utf8');
  assert.match(pwConfig, /STYLEPROOF_DEMO_ROOT/);
  assert.match(workflow, /uses: \.\//);
  assert.match(workflow, /fail-on-diff:\s*'false'/);
  assert.match(workflow, /mode:\s*'advisory'/);
  assert.match(workflow, /report-branch:\s*styleproof-reports/);
  assert.match(workflow, /status-context:\s*'StyleProof dogfood'/);
  assert.match(workflow, /comment-marker:\s*'<!-- styleproof-dogfood-report -->'/);
  assert.doesNotMatch(workflow, /require-approval:\s*'true'/);
});

test('live dogfood stays same-repo, writes maps/reports, and publishes a distinct comment', () => {
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /<!-- styleproof-dogfood-report -->/);
  assert.match(workflow, /styleproof-reports/);
  assert.match(workflow, /STYLEPROOF_CACHE_BRANCH|styleproof-maps|--upload/);
  assert.match(workflow, /Assert PR report was published/);
  assert.doesNotMatch(workflow, /<!-- styleproof-report -->/);
});

test('live dogfood does not replace the synthetic action-dogfood contract suite', () => {
  assert.match(actionDogfood, /node scripts\/action-dogfood-fixtures\.mjs/);
  assert.match(actionDogfood, /report-branch: styleproof-action-dogfood/);
  assert.match(actionDogfood, /Synthetic action dogfood receipt/);
  assert.doesNotMatch(workflow, /action-dogfood-fixtures\.mjs/);
  assert.doesNotMatch(workflow, /report-branch: styleproof-action-dogfood/);
});

test('hosted required CI does not gate the advisory dogfood path', () => {
  const required = ci.match(/ {2}required:[\s\S]*$/)?.[0] ?? '';
  assert.match(required, /needs: \[build, e2e, e2e-evidence, cli-smoke\]/);
  assert.doesNotMatch(required, /dogfood/);
  assert.match(workflow, /NOT part of the hosted `required` check/);
});
