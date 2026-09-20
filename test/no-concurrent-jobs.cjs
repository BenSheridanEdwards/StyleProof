// fallow-ignore-file unused-file — loaded via NODE_OPTIONS=--require, never imported
// Preloaded via NODE_OPTIONS=--require for every Node process in the test tree:
// the runner, its --test workers, and every spawnSync'd CLI child. On this
// repo's Node 26.7.0/macOS runs a spawned CLI child can deadlock at teardown —
// the main thread joins the worker pool while a V8 job worker stays parked in a
// concurrent-compile dispatcher, so a finished child never exits (#711/#718).
// Disabling the concurrent job tiers removes the workers the deadlock needs.
const { setFlagsFromString } = require('node:v8');

// Long-lived flags present on every supported Node (18/20/22/26).
const flags = [
  '--no-concurrent-sparkplug',
  '--no-baseline-batch-compilation',
  '--no-concurrent-recompilation',
  '--no-concurrent-osr',
  '--no-concurrent-marking',
  '--no-concurrent-sweeping',
  '--no-concurrent-array-buffer-sweeping',
  '--no-concurrent-cache-deserialization',
];
// Maglev landed in Node 21 (V8 11.8). On older versions setFlagsFromString
// prints "unrecognized flag" to stderr before throwing — polluting every
// spawned child's output — so these are gated, not probed.
if (Number(process.versions.node.split('.')[0]) >= 21) {
  flags.push(
    '--no-maglev-deopt-data-on-background',
    '--no-maglev-build-code-on-background',
    '--no-maglev-destroy-on-background',
  );
}
for (const flag of flags) {
  try {
    setFlagsFromString(flag);
  } catch {
    // Unknown on this V8 build — keep the rest.
  }
}
// Marker the contract test reads back out of a spawned child to prove the
// preload ran there.
process.env.STYLEPROOF_NO_CONCURRENT_JOBS = '1';
