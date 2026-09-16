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
    'cache-branch': { value: 'b', help: 'map store branch for cached-map mode', default: DEFAULT_MAP_STORE_BRANCH },
    remote: { value: 'name', help: 'git remote for the map store', default: DEFAULT_REMOTE },
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

/** Config is the lowest-precedence layer (flag > env > file > built-in), so a repo whose
 *  config moves the spec or store branch computes the same compatibility key as capture did. */
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

/**
 * Resolve everything a compare needs before reading maps: the two capture dirs
 * (restored from the map store, or the explicit pair), trusted SHAs, and the
 * armed ledgers. Exits 2 on any usage problem.
 */
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

  let beforeDir;
  let afterDir;
  let cacheCapture = null;
  if (args.length <= 1) {
    try {
      const source = captureSource(name, opts);
      cacheCapture = resolveCachedCaptureDirs({
        command: name,
        args,
        spec: source.spec,
        branch: source.branch,
        remote: source.remote,
        baseUrl: process.env.BASE_URL,
        usage,
      });
      ({ beforeDir, afterDir } = cacheCapture);
    } catch (error) {
      console.error(cachedMapsUnavailableMessage(name, purpose, error));
      process.exit(2);
    }
  } else {
    if (args.length !== 2) {
      console.error(`usage: ${name} <beforeDir> <afterDir> [options]  (--help for all options)`);
      process.exit(2);
    }
    [beforeDir, afterDir] = args;
    for (const dir of args) {
      if (fs.existsSync(dir)) continue;
      console.error(missingManualCaptureMessage(name, dir));
      process.exit(2);
    }
  }
  return { beforeDir, afterDir, cacheCapture, requireStateIdentity, expectedBeforeSha, expectedAfterSha, ...ledgers };
}

/** The head coverage ledger's exclusions — a declared critical obligation that is also opted out is contradictory. */
export function coverageExclusions(afterDir) {
  const ledgerPath = path.join(afterDir, COVERAGE_LEDGER);
  if (!fs.existsSync(ledgerPath)) return {};
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))?.exclude ?? {};
}

/**
 * Read both captures inside one bracket: refuse a manifest-less side, bind both
 * manifests to the trusted SHAs, run `read`, and prove the evidence did not change
 * underneath it. Cached (restored) dirs are removed afterwards, so everything that
 * needs the files must happen inside `read`. Exits 2 on failure.
 */
export function withCaptureDirs(name, inputs, read) {
  const { beforeDir, afterDir } = inputs;
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
    cleanupCachedCaptureDirs(inputs.cacheCapture);
  }
}
