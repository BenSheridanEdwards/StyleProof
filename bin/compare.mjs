// Shared preamble for the two commands that compare a base and a head capture
// (styleproof-diff and styleproof-report): the cached-map source, the ledger
// flags, trusted source SHAs, and the read-while-the-dirs-exist bracket.
import fs from 'node:fs';
import path from 'node:path';
import { cachedMapsUnavailableMessage, missingManualCaptureMessage, projectConfigOrExit } from '../dist/cli-errors.js';
import {
  loadStyleProofConfigWithLocation,
  resolveProjectSpec,
  resolveStyleProofConfigPath,
  specPathForCwd,
} from '../dist/config.js';
import { COVERAGE_LEDGER } from '../dist/coverage.js';
import {
  criticalStatesGateArmed,
  readCriticalStatesFile,
  resolveConfiguredCriticalStatesPath,
} from '../dist/critical-obligations.js';
import {
  legacyPairsGateArmed,
  readLegacyPairsAckFile,
  resolveConfiguredLegacyPairsPath,
} from '../dist/legacy-pairs.js';
import {
  DEFAULT_MAP_STORE_BRANCH,
  DEFAULT_REMOTE,
  assertCompatibleMapDirs,
  captureEvidenceBindingReceipt,
  cleanupCachedCaptureDirs,
  expectedSourceShaFlagsError,
  manifestlessError,
  manifestlessSide,
  resolveCachedCaptureDirs,
} from '../dist/map-store.js';
import { errorMessage, fail } from './cli.mjs';

/** Flags every compare command accepts. */
export function compareFlags() {
  return {
    spec: {
      value: 'path',
      help: 'StyleProof spec used to select compatible cached maps (default: e2e/styleproof.spec.ts)',
    },
    'cache-branch': { value: 'b', help: `map store branch for cached-map mode (default: ${DEFAULT_MAP_STORE_BRANCH})` },
    remote: { value: 'name', help: `git remote for the map store (default: ${DEFAULT_REMOTE})` },
    'require-state-identity': {
      help: 'require explicit matching productState {id, revision} on every paired capture; undeclared pairs are non-certifying',
    },
    'legacy-pairs': {
      value: 'file',
      help: 'declare known-legacy product-state pairs ({"<surface>":"<why>"}); undeclared unproven pairs fail closed, declared pairs stay advisory. Flag and $STYLEPROOF_PRODUCT_STATE override config; an empty env unarms it',
    },
    'critical-states': {
      value: 'file',
      help: 'declare obligations that must produce certifying evidence ({"<surface>":{"owner":"...","reason":"..."}}); unproven, unresolved, or coverage-excluded obligations fail closed. Flag and $STYLEPROOF_CRITICAL_STATES override config; an empty env unarms it',
    },
    'expected-before-sha': {
      value: 'sha',
      help: 'trusted full base commit SHA; pair with --expected-after-sha',
      allowEmpty: true,
    },
    'expected-after-sha': {
      value: 'sha',
      help: 'trusted full head commit SHA; pair with --expected-before-sha',
      allowEmpty: true,
    },
    migration: {
      help: 'migration showcase mode: structure changes (added/removed elements) become reviewable instead of advisory',
    },
  };
}

/** Flag > env > config file > built-in, so compare computes the same compatibility key as capture did. */
function captureSource(name, opts) {
  const config = projectConfigOrExit(name);
  const resolved = resolveProjectSpec({ startDir: process.cwd(), requireSpec: false });
  const specForCwd = specPathForCwd(resolved.spec, process.cwd());
  return {
    spec: opts.spec ?? (path.isAbsolute(specForCwd) ? resolved.specDeclared : specForCwd),
    branch:
      opts['cache-branch'] ?? process.env.STYLEPROOF_CACHE_BRANCH ?? config.cacheBranch ?? DEFAULT_MAP_STORE_BRANCH,
    remote: opts.remote ?? process.env.STYLEPROOF_REMOTE ?? config.remote ?? DEFAULT_REMOTE,
  };
}

/** The capture dirs (restored or explicit), trusted SHAs, and armed ledgers a compare needs. Exits 2 on usage problems. */
export function resolveCompareInputs(name, { opts, args, purpose, usage }) {
  let config;
  let configDir;
  try {
    ({ config, configDir } = loadStyleProofConfigWithLocation());
  } catch (error) {
    fail(name, errorMessage(error));
  }
  const configPath = (value) => (value ? resolveStyleProofConfigPath(value, configDir) : undefined);
  const requireStateIdentity = opts['require-state-identity'] || config.productState?.requireIdentity === true;
  const legacyPairsPath = resolveConfiguredLegacyPairsPath(
    opts['legacy-pairs'],
    configPath(config.productState?.legacyPairs),
  );
  const criticalStatesPath = resolveConfiguredCriticalStatesPath(
    opts['critical-states'],
    configPath(config.productState?.critical),
  );
  const expectedBeforeSha = opts['expected-before-sha'];
  const expectedAfterSha = opts['expected-after-sha'];
  const shaError = expectedSourceShaFlagsError({
    beforeProvided: expectedBeforeSha !== undefined,
    beforeSha: expectedBeforeSha,
    afterProvided: expectedAfterSha !== undefined,
    afterSha: expectedAfterSha,
  });
  if (shaError) fail(name, shaError);

  let ledgers;
  try {
    ledgers = {
      legacyPairDeclarations: readLegacyPairsAckFile(legacyPairsPath),
      legacyPairsArmed: legacyPairsGateArmed(legacyPairsPath),
      criticalObligations: readCriticalStatesFile(criticalStatesPath),
      criticalStatesArmed: criticalStatesGateArmed(criticalStatesPath),
    };
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(2);
  }

  const dirs = args.length <= 1 ? cachedDirs(name, opts, args, purpose, usage) : explicitDirs(name, args);
  return { ...dirs, requireStateIdentity, expectedBeforeSha, expectedAfterSha, ...ledgers };
}

function cachedDirs(name, opts, args, purpose, usage) {
  try {
    const cacheCapture = resolveCachedCaptureDirs({
      command: name,
      args,
      ...captureSource(name, opts),
      baseUrl: process.env.BASE_URL,
      usage,
    });
    return { beforeDir: cacheCapture.beforeDir, afterDir: cacheCapture.afterDir, cacheCapture };
  } catch (error) {
    console.error(cachedMapsUnavailableMessage(name, purpose, error));
    return process.exit(2);
  }
}

function explicitDirs(name, args) {
  if (args.length !== 2) {
    console.error(`usage: ${name} <beforeDir> <afterDir> [options]  (--help for all options)`);
    process.exit(2);
  }
  const missing = args.find((dir) => !fs.existsSync(dir));
  if (missing) {
    console.error(missingManualCaptureMessage(name, missing));
    process.exit(2);
  }
  return { beforeDir: args[0], afterDir: args[1], cacheCapture: null };
}

/** The head coverage ledger's exclusions — a declared critical obligation that is also opted out is contradictory. */
export function coverageExclusions(afterDir) {
  const ledgerPath = path.join(afterDir, COVERAGE_LEDGER);
  if (!fs.existsSync(ledgerPath)) return {};
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))?.exclude ?? {};
}

/** Bind both manifests to the trusted SHAs, run `read`, and prove the evidence did not change
 *  underneath it. Restored dirs are removed afterwards, so read everything inside `read`. Exits 2 on failure. */
export function withCaptureDirs(name, inputs, read) {
  const { beforeDir, afterDir } = inputs;
  // `read` and the catch below may exit the process (a ledger `fail()`), which skips `finally`;
  // an exit hook still removes the restored dirs. Removal is idempotent, so both paths are safe.
  const cleanup = () => cleanupCachedCaptureDirs(inputs.cacheCapture);
  process.once('exit', cleanup);
  try {
    const manifestless = manifestlessSide(beforeDir, afterDir);
    if (manifestless) throw new Error(manifestlessError(manifestless));
    const initialEvidenceBinding = captureEvidenceBindingReceipt(beforeDir, afterDir);
    const sourceBinding = assertCompatibleMapDirs(beforeDir, afterDir, {
      beforeSha: inputs.expectedBeforeSha,
      afterSha: inputs.expectedAfterSha,
    });
    const result = read(sourceBinding);
    const evidenceBinding = captureEvidenceBindingReceipt(beforeDir, afterDir);
    if (JSON.stringify(evidenceBinding) !== JSON.stringify(initialEvidenceBinding)) {
      throw new Error(`capture evidence changed while ${name} was reading it`);
    }
    return { ...result, sourceBinding, evidenceBinding };
  } catch (error) {
    console.error(errorMessage(error));
    process.exit(2);
  } finally {
    process.removeListener('exit', cleanup);
    cleanup();
  }
}
