import { takeCoverage } from 'node:v8';

// Signal exits do not run Node's normal coverage writer. Flush before server teardown.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    takeCoverage();
    if (process.listenerCount(signal) === 1) process.exit(0);
  });
}
