'use strict';
// Loaded via `node --require` ahead of the test runner. Bounds blocking
// child-process spawns so a deadlocked CLI child fails its test with a name
// and a signal instead of hanging the suite forever (#711 — a Node 26.x
// job-worker teardown race can leave a spawned child idle but unexited).
// A caller-supplied `timeout` option always wins over this default.
const cp = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 120_000;
const ENV_VAR = 'STYLEPROOF_TEST_SPAWN_TIMEOUT_MS';
const LOADED_FLAG = 'STYLEPROOF_SPAWN_TIMEOUT_LOADED';

function timeoutMs() {
  const v = Number(process.env[ENV_VAR]);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

const origSpawnSync = cp.spawnSync;
cp.spawnSync = function spawnSync(command, args, options) {
  return origSpawnSync.call(this, command, args, { timeout: timeoutMs(), ...options });
};

const origExecFileSync = cp.execFileSync;
cp.execFileSync = function execFileSync(file, args, options) {
  return origExecFileSync.call(this, file, args, { timeout: timeoutMs(), ...options });
};

process.env[LOADED_FLAG] = '1';
