// The PreToolUse guard in .claude/hooks/block-gate-bypass.sh (ADR 0007): pipe a
// realistic hook payload for each command through the script under sh and bash,
// and pin the Claude Code and Codex registrations that spawn it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK = path.join(ROOT, '.claude/hooks/block-gate-bypass.sh');
const HOOK_ARG = '${CLAUDE_PROJECT_DIR}/.claude/hooks/block-gate-bypass.sh';

function runHook(shell, command, description = 'Run a git command') {
  const payload = {
    session_id: 'test-session',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command, description },
  };
  const result = spawnSync(shell, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

const BLOCKED = [
  'git commit --no-verify -m "x"',
  'git push --no-verify',
  'git commit --no-veri -m x',
  "git push --no-ver''ify",
  'git push --no-\\verify',
  'git commit -n -m x',
  'git commit -nm x',
  'git commit -anm x',
  'git commit --amend -n',
  'git commit -m "x" -n',
  'git commit "-n" -m x',
  'git commit -m "$(git commit -n -m y)"',
  'git -C src commit -n -m x',
  'git commit\n-n -m x',
  'cd src && git commit -n -m x',
  // A fake -m inside another quoted string must not hide what follows it.
  "git push 'x -m ' --no-verify ' y'",
  'HUSKY=0 git commit -m x',
  'HUSKY="0" git push',
  'HU""SKY=0 git push',
  'HUSKY=$(echo 0) git push',
  'HUSKY=`echo 0` git push',
  'export HUSKY=0; git push',
  'env HUSKY=0 git push',
  'git -c core.hooksPath=/dev/null commit -m x',
  'git -c core.hookspath=/dev/null push',
  'git --config-env core.hooksPath=EMPTY push',
  'git config core.hooksPath /dev/null',
  'git config core.hooks\\Path /dev/null',
  'git config --global core.hooksPath /tmp/none',
  'git config --unset core.hooksPath',
  'git config --get core.hooksPath && git config core.hooksPath /dev/null',
  "GIT_CONFIG_PARAMETERS=\"'core.hooksPath'='/dev/null'\" git push",
  'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/x git push',
  "git config alias.ci 'commit -n'",
  "git -c alias.ci='commit -n' ci -m x",
  'git config include.path /tmp/other.gitconfig',
  'git config includeIf.gitdir:~/.path /tmp/other.gitconfig',
  "bash -c 'git push --no-verify'",
  'sh -c "git commit -n -m x"',
];

const ALLOWED = [
  'git status',
  'git commit -m "feat: add thing"',
  'git commit -m "docs: explain -n"',
  "git commit -m 'docs: explain -nm'",
  'git commit -m "docs: mention --no-verify and HUSKY=0"',
  'git commit --message="docs: -n flag"',
  'git commit -mn',
  'git commit -uno -m x',
  'git commit --no-edit --amend',
  'git commit -F msg.txt',
  'git push',
  'git push -n',
  'git push origin HEAD',
  'git config --get core.hooksPath',
  'git config core.hooksPath',
  'git config core.hooksPath .husky',
  'git config core.hooksPath .husky/_',
  'git config --get alias.ci',
  'git config --list',
  'git log --oneline -n 5',
  'HUSKY=1 git push',
];

for (const shell of ['sh', 'bash']) {
  test(`gate-bypass hook blocks every bypass shape under ${shell}`, () => {
    for (const command of BLOCKED) {
      const { status, stderr } = runHook(shell, command);
      assert.equal(status, 2, `expected a block for ${JSON.stringify(command)}`);
      assert.match(stderr, /Fix what the gate reports instead/);
      assert.match(stderr, /\.agents\/project\/DEFINITION_OF_DONE\.md/);
    }
  });

  test(`gate-bypass hook allows ordinary git commands under ${shell}`, () => {
    for (const command of ALLOWED) {
      assert.deepEqual(runHook(shell, command), { status: 0, stderr: '' }, JSON.stringify(command));
    }
  });
}

test('gate-bypass hook matches only the command, never the free-text description', () => {
  assert.deepEqual(runHook('sh', 'git push', 'Push without HUSKY=0 or --no-verify'), { status: 0, stderr: '' });
});

test('gate-bypass hook blocks when the payload is not JSON', () => {
  const result = spawnSync('sh', [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(result.status, 2);
});

test('.claude/settings.json spawns the hook for git, env, sh and bash commands only', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.json'), 'utf8'));
  const hooks = settings.hooks.PreToolUse.filter((entry) => entry.matcher === 'Bash').flatMap((entry) => entry.hooks);
  assert.deepEqual(hooks.map((hook) => hook.if).sort(), ['Bash(bash *)', 'Bash(env *)', 'Bash(git *)', 'Bash(sh *)']);
  for (const hook of hooks) assert.deepEqual(hook, { type: 'command', if: hook.if, command: 'sh', args: [HOOK_ARG] });
});

test('.codex/hooks.json runs the same script from the repository root', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, '.codex/hooks.json'), 'utf8'));
  const [entry, ...rest] = hooks.hooks.PreToolUse;
  assert.equal(rest.length, 0);
  assert.equal(entry.matcher, '^Bash$');
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git push --no-verify' },
  });
  for (const cwd of [ROOT, path.join(ROOT, 'scripts')]) {
    const result = spawnSync('sh', ['-c', entry.hooks[0].command], { cwd, input: payload, encoding: 'utf8' });
    assert.equal(result.status, 2, `run from ${cwd}: ${result.stderr}`);
  }
});
