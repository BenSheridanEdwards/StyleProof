// Read everything a compare needs while the (possibly restored) capture dirs still exist.
import fs from 'node:fs';
import path from 'node:path';
import { auditLiveTextDirs, diffStyleMapDirs } from '../../dist/diff.js';
import { readBaselineProvenance } from '../../dist/map-store.js';
import {
  captureKeysIn,
  mergeSurfaceKeyLookup,
  readInventories,
  readResidue,
  surfaceElementPaths,
} from '../../dist/capture.js';
import { auditRunInventory, hasCapturedInventory, readAckFile } from '../../dist/inventory.js';
import { auditRunResidue, readResidueAckFile } from '../../dist/data-residue.js';
import { COVERAGE_LEDGER, auditCoverage, auditDeterminism } from '../../dist/coverage.js';
import { readConfidenceLedger, summarizeConfidence, withCaptureDeterminism } from '../../dist/confidence-ledger.js';
import { errorMessage, fail } from '../cli.mjs';

/** `key -> reason` ledgers fail loud (exit 2) so a broken file can't silently un-acknowledge a real gap. */
function readLedgerOrExit(name, read) {
  try {
    return read();
  } catch (error) {
    return fail(name, errorMessage(error));
  }
}

function readCoverageLedger(name, dir) {
  const file = path.join(dir, COVERAGE_LEDGER);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Reading a corrupt ledger as "no registry" would silently disarm the coverage, determinism, and residue gates.
    return fail(
      name,
      `corrupt coverage ledger: ${file} — recapture the bundle; refusing to compare with disarmed gates.`,
    );
  }
}

const surfaceKeysIn = (dir) => [...new Set(captureKeysIn(dir).map((key) => key.replace(/@\d+$/, '')))];

function readInventoryAudit(name, dirA, dirB) {
  const baseInv = readInventories(dirA);
  const headInv = readInventories(dirB);
  if (!hasCapturedInventory(baseInv, headInv)) return null;
  const allowed = readLedgerOrExit(name, readAckFile);
  return { allowed, ...auditRunInventory(baseInv, headInv, allowed) };
}

function readResidueAudit(name, dirB, headLedger) {
  const armed = headLedger?.dataResidue === 'gate';
  const headResidue = readResidue(dirB);
  if (!armed && !headResidue.some((m) => m.dataResidue?.length)) return null;
  const acknowledged = readLedgerOrExit(name, readResidueAckFile);
  return { acknowledged, hasLedger: headLedger != null, ...auditRunResidue(headResidue, acknowledged, armed) };
}

/** The diff plus every ledger and audit the gates read, from the base (`dirA`) and head (`dirB`) captures. */
export function readCompareEvidence(name, { beforeDir: dirA, afterDir: dirB }, { migration, pixels }) {
  const headLedger = readCoverageLedger(name, dirB);
  return {
    result: diffStyleMapDirs(dirA, dirB, { includeStructure: migration, pixels }),
    inventoryAudit: readInventoryAudit(name, dirA, dirB),
    residueAudit: readResidueAudit(name, dirB, headLedger),
    coverageExclusions: headLedger?.exclude ?? {},
    coverageVerdict: auditCoverage(surfaceKeysIn(dirB), headLedger),
    determinismVerdict: auditDeterminism(
      withCaptureDeterminism(dirA, readCoverageLedger(name, dirA)),
      withCaptureDeterminism(dirB, headLedger),
    ),
    confidenceSummary: summarizeConfidence(readConfidenceLedger(dirB)),
    liveTextAudit: auditLiveTextDirs(dirA, dirB),
    surfacePaths: surfaceElementPaths(dirA, dirB),
    surfaceKeyOf: mergeSurfaceKeyLookup(dirA, dirB),
    baselineProvenance: readBaselineProvenance(dirA),
    baseMapCount: captureKeysIn(dirA).length,
  };
}
