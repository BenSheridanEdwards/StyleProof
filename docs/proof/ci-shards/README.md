# Browser shard evidence

`output.png` is an unmodified browser rendering of `output.txt`, produced by the
changed verifier against real local Playwright JSON reports. It is self-attested
local evidence, not a hosted timing result or application coverage certificate.
The transcript records the verifier's source SHA-256, successful inventory check,
and actual rejection messages when a shard or the oracle is omitted.

Reproduce from a clean checkout under Node 22:

```sh
npm ci
npx playwright install chromium firefox
mkdir -p .styleproof/ci/shards/e2e-shard-1 .styleproof/ci/shards/e2e-shard-2
npx playwright test --config=playwright.ci.config.ts --list --reporter=json > .styleproof/ci/inventory.json
PLAYWRIGHT_JSON_OUTPUT_NAME=.styleproof/ci/shards/e2e-shard-1/shard.json \
STYLEPROOF_DETERMINISM_RECEIPT=.styleproof/ci/shards/e2e-shard-1/determinism-oracle.json \
npx playwright test --config=playwright.ci.config.ts --shard=1/2 --reporter=line,json
PLAYWRIGHT_JSON_OUTPUT_NAME=.styleproof/ci/shards/e2e-shard-2/shard.json \
STYLEPROOF_DETERMINISM_RECEIPT=.styleproof/ci/shards/e2e-shard-2/determinism-oracle.json \
npx playwright test --config=playwright.ci.config.ts --shard=2/2 --reporter=line,json
node scripts/verify-e2e-shards.mjs .styleproof/ci/inventory.json .styleproof/ci/shards
node --test test/e2e-shards.test.mjs test/ci-determinism-receipt.test.mjs
```

The two local browser runs produced 118 pass + 1 intentional Chromium skip and 103 pass. The Firefox-only regression proves the skipped unsupported Chromium state separately. CI runs the shards on separate
runners; local execution was sequential to avoid fixture-port collisions. Hosted
timing and exact-head checks belong in the PR's Verification Summary.
