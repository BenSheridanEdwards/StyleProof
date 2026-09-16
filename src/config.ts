/**
 * The consumer-owned `styleproof.config.ts` (or legacy `.json`), loaded once and
 * shared by every CLI and the Action. Precedence everywhere: explicit flag >
 * environment variable > this file > built-in default.
 *
 * Split: `config/schema.ts` (shape + validation), `config/load.ts` (discovery +
 * loading), `config/load-ts.ts` (`.ts` evaluation), `config/spec.ts` (spec resolution).
 */
export type {
  AffectedConfig,
  CrawlConfig,
  MapStoreConfig,
  AncestorBaselineConfig,
  ReportStoreConfig,
  CoverageConfig,
  ProductStateConfig,
  StyleProofConfig,
} from './config/schema.js';
import type { StyleProofConfig } from './config/schema.js';
export {
  DEFAULT_STYLEPROOF_SPEC,
  discoverStyleProofConfig,
  resolveStyleProofConfigPath,
  resolveStyleProofConfigFilePaths,
  loadStyleProofConfigWithLocation,
  loadStyleProofConfigWithLocationAsync,
  loadStyleProofConfig,
  loadStyleProofConfigAsync,
} from './config/load.js';
export type { StyleProofConfigLocation, StyleProofConfigDiscovery, StyleProofConfigLoad } from './config/load.js';
export { unloadableStyleProofConfigMessage } from './config/load-ts.js';
export { missingStyleProofSpecMessage, specPathForCwd, resolveProjectSpec } from './config/spec.js';
export type { ResolvedProjectSpec, ResolveProjectSpecOptions } from './config/spec.js';

/** Type-safe identity helper for `styleproof.config.ts` (IDE autocomplete + compile-time checks). */
export function defineConfig(config: StyleProofConfig): StyleProofConfig {
  return config;
}
