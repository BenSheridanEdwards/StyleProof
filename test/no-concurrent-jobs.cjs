// fallow-ignore-file unused-file — loaded via NODE_OPTIONS=--require, never imported
// Preloaded via NODE_OPTIONS=--require for every Node process in the test tree:
// the runner, its --test workers, and every spawnSync'd CLI child. On this
// repo's Node 26.7.0/macOS runs a spawned CLI child can deadlock at teardown —
// the main thread joins the worker pool while a V8 job worker stays parked in a
// concurrent-compile dispatcher, so a finished child never exits (#711/#718).
// Disabling the concurrent job tiers removes the workers the deadlock needs.
// Each flag is applied independently so a Node/V8 version that does not know
// one flag still gets the rest.
const { setFlagsFromString } = require('node:v8');
for (const flag of [
  '--no-concurrent-sparkplug',
  '--no-baseline-batch-compilation',
  '--no-concurrent-recompilation',
  '--no-concurrent-osr',
  '--no-concurrent-marking',
  '--no-concurrent-sweeping',
  '--no-concurrent-array-buffer-sweeping',
  '--no-concurrent-cache-deserialization',
  '--no-maglev-deopt-data-on-background',
  '--no-maglev-build-code-on-background',
  '--no-maglev-destroy-on-background',
]) {
  try {
    setFlagsFromString(flag);
  } catch {
    // Unknown on this Node/V8 version — keep the rest.
  }
}
// Marker the contract test reads back out of a spawned child to prove the
// preload ran there.
process.env.STYLEPROOF_NO_CONCURRENT_JOBS = '1';
