/** Deterministic bounds for opt-in script evidence; the clock is only a backstop. */
export class ScriptEvidenceError extends Error {}
export const MAX_GENERATED_LENGTH = 4 * 1024 * 1024;
export const MAX_MAPPING_LENGTH = 2 * 1024 * 1024;
export const MAX_MAP_BYTES = 8 * 1024 * 1024;
export const MAX_APP_SEGMENTS = 100_000;
export const MAX_COVERAGE_RANGES = 200_000;
export const MAX_SCRIPT_EVIDENCE_BYTES = 1024 * 1024;
export const MAX_CAPTURE_EVIDENCE_BYTES = 4 * 1024 * 1024;

export const MAX_SCRIPTS = 1000;
