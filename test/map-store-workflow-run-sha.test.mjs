// #1136: under workflow_run, GITHUB_SHA is the default-branch tip, so a checkout of it
// must not be relabelled as workflow_run.head_sha.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentGitSha } from '../dist/map-store/manifest.js';

test('#1136 a workflow_run checkout of the default-branch tip keeps its own SHA', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-1136-'));

  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
    const defaultTip = git('rev-parse', 'HEAD');
    const prHead = 'b'.repeat(40);
    const eventPath = path.join(dir, 'event.json');
    fs.writeFileSync(eventPath, JSON.stringify({ workflow_run: { head_sha: prHead } }));
    const env = { GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: eventPath, GITHUB_SHA: defaultTip };

    let sha;

    try {
      sha = currentGitSha(dir, env);
    } catch {
      return; // requiring an explicit --sha is acceptable
    }

    assert.equal(sha, defaultTip, 'default-branch maps must not be labelled with the PR head');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: 'pull_request merge checkout uses the PR head', eventName: 'pull_request', expected: 'event' },
  { name: 'workflow_run head checkout keeps its SHA', eventName: 'workflow_run', expected: 'checkout' },
  { name: 'STYLEPROOF_SHA overrides a workflow_run checkout', eventName: 'workflow_run', expected: 'explicit' },
]) {
  test(scenario.name, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-1136-'));

    try {
      const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
      git('init', '-q');
      git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'head');
      const head = git('rev-parse', 'HEAD');
      const eventHead = scenario.eventName === 'pull_request' ? 'b'.repeat(40) : head;
      const eventPath = path.join(dir, 'event.json');
      fs.writeFileSync(
        eventPath,
        JSON.stringify({
          pull_request: { head: { sha: eventHead } },
          workflow_run: { head_sha: eventHead },
        }),
      );
      const explicit = 'c'.repeat(40);

      const env = {
        GITHUB_EVENT_NAME: scenario.eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_SHA: scenario.eventName === 'pull_request' ? head : 'a'.repeat(40),
      };

      if (scenario.expected === 'explicit') env.STYLEPROOF_SHA = explicit;

      const expected = scenario.expected === 'explicit' ? explicit : eventHead;

      assert.equal(currentGitSha(dir, env), expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
