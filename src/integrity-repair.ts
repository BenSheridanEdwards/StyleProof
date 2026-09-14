/**
 * Closed catalog of integrity failures that terminate as CERTIFICATION_FAILED.
 * Reviewer approval cannot clear these — each reason ships an adopter-legible
 * repair path (what broke, what to fix, how to verify) instead of a dead-end.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CONNECTOR_RECEIPT, INTEGRITY_RECEIPT, SOURCE_BINDING_RECEIPT, hasDuplicateJsonKeys } from './map-store.js';
import { readRegularFileNoFollow } from './safe-filesystem.js';

export { CONNECTOR_RECEIPT, INTEGRITY_RECEIPT, SOURCE_BINDING_RECEIPT };

export const INTEGRITY_FAILURE_REASONS = ['connector-partial', 'duplicate-id', 'integrity-mismatch'] as const;

export type IntegrityFailureReason = (typeof INTEGRITY_FAILURE_REASONS)[number];

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_SURFACE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,127}$/;
const MAX_SIDECAR_BYTES = 64 * 1024;
const MAX_MAP_BYTES = 16 * 1024 * 1024;

const LEDGER_FILES = new Set([
  'styleproof-coverage.json',
  'styleproof-confidence.json',
  'styleproof-manifest.json',
  CONNECTOR_RECEIPT,
  INTEGRITY_RECEIPT,
  SOURCE_BINDING_RECEIPT,
  'styleproof-audit.json',
  'report.json',
]);

export type IntegrityRepairPath = {
  reason: IntegrityFailureReason;
  title: string;
  whatBroke: string;
  whatToFix: string;
  howToVerify: string;
  /** Integrity is never a visual-approval gate. */
  approvable: false;
};

export type IntegrityFinding = {
  reason: IntegrityFailureReason;
  surfaces: string[];
};

export const INTEGRITY_REPAIR_PATHS: Record<IntegrityFailureReason, IntegrityRepairPath> = {
  'connector-partial': {
    reason: 'connector-partial',
    title: 'Map connector returned a partial bundle',
    whatBroke:
      'The map-store or evidence connector restored only some of the expected surfaces. Certification cannot compare a partial restore as if it were a complete pair.',
    whatToFix:
      'Re-run the connector restore for the missing surfaces, or recapture those surfaces and republish the bundle. Do not tick visual approval — the missing maps are not a style delta.',
    howToVerify:
      'Re-run styleproof-diff (or the Action). The connector receipt must read `complete`, every expected surface must have a map on both sides, and the integrity repair block must disappear.',
    approvable: false,
  },
  'duplicate-id': {
    reason: 'duplicate-id',
    title: 'Duplicate identity in a style map',
    whatBroke:
      'A style map contains a duplicate JSON key or a duplicate inventory identity. JSON.parse would keep only the last value, so correspondence and inventory would silently drop a real element.',
    whatToFix:
      'Give each element or navigable affordance a unique key (stable `id`, `data-testid`, or href). Recapture the surface so the map no longer carries a duplicate identity.',
    howToVerify:
      'Re-run styleproof-diff (or the Action). The report must no longer name `duplicate-id`, and styleproof-audit.json must show the integrity check clean.',
    approvable: false,
  },
  'integrity-mismatch': {
    reason: 'integrity-mismatch',
    title: 'Claimed evidence digest does not match the bytes',
    whatBroke:
      'A source SHA or content digest declared by the connector or integrity receipt does not match the bytes on disk. The comparison would be bound to the wrong capture.',
    whatToFix:
      'Restore or recapture from the exact claimed SHA, then republish the bundle. Do not reuse a map that failed digest verification.',
    howToVerify:
      'Re-run styleproof-diff (or the Action) against the republished bundle. Claimed and actual digests must match, and the integrity repair block must disappear.',
    approvable: false,
  },
};

export function isIntegrityFailureReason(value: unknown): value is IntegrityFailureReason {
  return typeof value === 'string' && (INTEGRITY_FAILURE_REASONS as readonly string[]).includes(value);
}

export function integrityRepairPath(reason: IntegrityFailureReason): IntegrityRepairPath {
  return INTEGRITY_REPAIR_PATHS[reason];
}

export function integrityReasonsOf(findings: readonly IntegrityFinding[]): IntegrityFailureReason[] {
  const seen = new Set<IntegrityFailureReason>();
  for (const finding of findings) {
    if (isIntegrityFailureReason(finding.reason)) seen.add(finding.reason);
  }
  return INTEGRITY_FAILURE_REASONS.filter((reason) => seen.has(reason));
}

function findingsFromReasonMap(found: Map<IntegrityFailureReason, Set<string>>): IntegrityFinding[] {
  return INTEGRITY_FAILURE_REASONS.filter((reason) => found.has(reason)).map((reason) => ({
    reason,
    surfaces: [...(found.get(reason) ?? [])].sort(),
  }));
}

function collectParsedEntry(found: Map<IntegrityFailureReason, Set<string>>, entry: unknown): void {
  if (typeof entry === 'string' && isIntegrityFailureReason(entry)) {
    if (!found.has(entry)) found.set(entry, new Set());
    return;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
  const reason = (entry as { reason?: unknown }).reason;
  if (!isIntegrityFailureReason(reason)) return;
  const surfaces = found.get(reason) ?? new Set<string>();
  const listed = (entry as { surfaces?: unknown }).surfaces;
  if (Array.isArray(listed)) {
    for (const surface of listed) {
      const safe = safeSurfaceKey(surface);
      if (safe) surfaces.add(safe);
    }
  }
  found.set(reason, surfaces);
}

/** Parse machine receipts: `{ reason }[]`, `string[]`, or a single reason string. */
export function parseIntegrityFailures(value: unknown): IntegrityFinding[] {
  if (typeof value === 'string' && isIntegrityFailureReason(value)) {
    return [{ reason: value, surfaces: [] }];
  }
  if (!Array.isArray(value)) return [];
  const found = new Map<IntegrityFailureReason, Set<string>>();
  for (const entry of value) collectParsedEntry(found, entry);
  return findingsFromReasonMap(found);
}

export function formatIntegrityRepairMarkdown(findings: readonly IntegrityFinding[]): string[] {
  const reasons = integrityReasonsOf(findings);
  if (reasons.length === 0) return [];
  const lines = [
    '⛔ **Integrity repair required** — `CERTIFICATION_FAILED`. Reviewer approval cannot clear this. Repair the evidence, then re-run.',
    '',
  ];
  for (const reason of reasons) {
    const repair = INTEGRITY_REPAIR_PATHS[reason];
    const finding = findings.find((entry) => entry.reason === reason);
    const named = finding?.surfaces.length
      ? ` Affected surface(s): ${finding.surfaces.map((key) => `\`${key}\``).join(', ')}.`
      : '';
    lines.push(`- **\`${reason}\` — ${repair.title}.**`);
    lines.push(`  - **What broke:** ${repair.whatBroke}${named}`);
    lines.push(`  - **What to fix:** ${repair.whatToFix}`);
    lines.push(`  - **How to verify:** ${repair.howToVerify}`);
  }
  lines.push('');
  return lines;
}

/** One-line PR-comment / commit-status footer. Approval stays hidden. */
export function formatIntegrityRepairComment(findings: readonly IntegrityFinding[]): string {
  const reasons = integrityReasonsOf(findings);
  if (reasons.length === 0) {
    return '_Coverage, determinism, or report/diff consistency evidence is incomplete — this is not a base recapture failure. Repair the named evidence in the report; reviewer approval cannot clear this failure._';
  }
  const named = reasons.map((reason) => `\`${reason}\``).join(', ');
  return `_Integrity failure (${named}) — see the integrity repair path in the report (what broke, what to fix, how to verify). Reviewer approval cannot clear this. Repair the evidence and re-run._`;
}

export function formatIntegrityStatusDescription(findings: readonly IntegrityFinding[]): string {
  const reasons = integrityReasonsOf(findings);
  if (reasons.length === 0) {
    return 'Evidence incomplete on named surface+SHA — not a base recapture failure';
  }
  return `Integrity failure (${reasons.join(', ')}) — repair evidence; approval cannot clear`;
}

export function integrityAuditChecks(
  findings: readonly IntegrityFinding[],
): Array<{ check: string; result: 'failed'; detail: string }> {
  return integrityReasonsOf(findings).map((reason) => {
    const repair = INTEGRITY_REPAIR_PATHS[reason];
    return {
      check: `integrity:${reason}`,
      result: 'failed' as const,
      detail: `${repair.title}. Fix: ${repair.whatToFix} Verify: ${repair.howToVerify}`,
    };
  });
}

export function inspectIntegrityFailures(dirs: readonly string[]): IntegrityFinding[] {
  const found = new Map<IntegrityFailureReason, Set<string>>();
  const add = (reason: IntegrityFailureReason, surfaces: readonly string[] = []): void => {
    const set = found.get(reason) ?? new Set<string>();
    for (const surface of surfaces) {
      const safe = safeSurfaceKey(surface);
      if (safe) set.add(safe);
    }
    found.set(reason, set);
  };
  for (const dir of dirs) {
    if (typeof dir !== 'string' || dir.length === 0 || !fs.existsSync(dir)) continue;
    inspectConnectorReceipt(dir, add);
    inspectIntegrityReceipt(dir, add);
    inspectSourceBindingReceipt(dir, add);
    inspectMapIdentities(dir, add);
  }
  return findingsFromReasonMap(found);
}

function safeSurfaceKey(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_SURFACE_KEY.test(value) ? value : undefined;
}

function readSidecarJson(dir: string, name: string): unknown | undefined {
  const filePath = path.join(dir, name);
  if (!fs.existsSync(filePath)) return undefined;
  let bytes: Buffer;
  try {
    bytes = readRegularFileNoFollow(filePath, MAX_SIDECAR_BYTES);
  } catch {
    return null;
  }
  const source = bytes.toString('utf8');
  if (hasDuplicateJsonKeys(source)) return null;
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function inspectConnectorReceipt(
  dir: string,
  add: (reason: IntegrityFailureReason, surfaces?: readonly string[]) => void,
): void {
  const receipt = readSidecarJson(dir, CONNECTOR_RECEIPT);
  if (receipt === undefined) return;
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    add('integrity-mismatch');
    return;
  }
  const body = receipt as { version?: unknown; status?: unknown; missing?: unknown };
  if (body.version !== 1 || (body.status !== 'complete' && body.status !== 'partial')) {
    add('integrity-mismatch');
    return;
  }
  if (body.status === 'partial') {
    const missing = Array.isArray(body.missing) ? body.missing : [];
    add(
      'connector-partial',
      missing.filter((key): key is string => typeof key === 'string'),
    );
  }
}

function inspectIntegrityReceipt(
  dir: string,
  add: (reason: IntegrityFailureReason, surfaces?: readonly string[]) => void,
): void {
  const receipt = readSidecarJson(dir, INTEGRITY_RECEIPT);
  if (receipt === undefined) return;
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    add('integrity-mismatch');
    return;
  }
  const body = receipt as { version?: unknown; claimedDigest?: unknown; actualDigest?: unknown };
  if (
    body.version !== 1 ||
    !SHA256_HEX.test(String(body.claimedDigest)) ||
    !SHA256_HEX.test(String(body.actualDigest))
  ) {
    add('integrity-mismatch');
    return;
  }
  if (body.claimedDigest !== body.actualDigest) add('integrity-mismatch');
}

function inspectSourceBindingReceipt(
  dir: string,
  add: (reason: IntegrityFailureReason, surfaces?: readonly string[]) => void,
): void {
  const receipt = readSidecarJson(dir, SOURCE_BINDING_RECEIPT);
  if (receipt === undefined) return;
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    add('integrity-mismatch');
    return;
  }
  const body = receipt as { expectedSha?: unknown; observedSha?: unknown };
  const expected = typeof body.expectedSha === 'string' ? body.expectedSha.toLowerCase() : '';
  const observed = typeof body.observedSha === 'string' ? body.observedSha.toLowerCase() : '';
  if (!/^[0-9a-f]{40}$/.test(expected) || !/^[0-9a-f]{40}$/.test(observed)) {
    add('integrity-mismatch');
    return;
  }
  if (expected !== observed) add('integrity-mismatch');
}

function listStyleMapFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => {
      if (LEDGER_FILES.has(name)) return false;
      if (name.endsWith('.json.gz')) return true;
      return name.endsWith('.json') && /@\d+\.json$/.test(name);
    });
  } catch {
    return [];
  }
}

function readMapSource(filePath: string, gzipped: boolean): { bytes: Buffer; source: string } | undefined {
  let bytes: Buffer;
  try {
    bytes = readRegularFileNoFollow(filePath, MAX_MAP_BYTES);
  } catch {
    return undefined;
  }
  try {
    return { bytes, source: (gzipped ? gunzipSync(bytes) : bytes).toString('utf8') };
  } catch {
    return undefined;
  }
}

function inventoryHasDuplicateKeys(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const inventory = (parsed as { inventory?: unknown }).inventory;
  if (!Array.isArray(inventory)) return false;
  const keys = new Set<string>();
  for (const item of inventory) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const key = (item as { key?: unknown }).key;
    if (typeof key !== 'string') continue;
    if (keys.has(key)) return true;
    keys.add(key);
  }
  return false;
}

function siblingDigestMismatches(filePath: string, bytes: Buffer): boolean {
  const digestSidecar = `${filePath}.sha256`;
  if (!fs.existsSync(digestSidecar)) return false;
  let claimed: string;
  try {
    claimed = readRegularFileNoFollow(digestSidecar, 128).toString('utf8').trim().toLowerCase();
  } catch {
    return true;
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  return !SHA256_HEX.test(claimed) || claimed !== actual;
}

function inspectMapIdentities(
  dir: string,
  add: (reason: IntegrityFailureReason, surfaces?: readonly string[]) => void,
): void {
  for (const name of listStyleMapFiles(dir)) {
    const filePath = path.join(dir, name);
    const loaded = readMapSource(filePath, name.endsWith('.json.gz'));
    if (!loaded) continue;
    const surface = name.replace(/\.json(\.gz)?$/, '');
    if (hasDuplicateJsonKeys(loaded.source)) add('duplicate-id', [surface]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(loaded.source);
    } catch {
      continue;
    }
    if (inventoryHasDuplicateKeys(parsed)) add('duplicate-id', [surface]);
    if (siblingDigestMismatches(filePath, loaded.bytes)) add('integrity-mismatch', [surface]);
  }
}
