/** Capture-spec resolution: config `spec` (or `--spec`) → absolute path, failing closed when missing. */
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_STYLEPROOF_SPEC, loadStyleProofConfigWithLocation, resolveStyleProofConfigPath } from './load.js';
import { StyleProofConfigError } from './schema.js';

export type ResolvedProjectSpec = {
  /** Absolute filesystem path of the spec. */
  spec: string;
  /** Spec path as declared in config / `--spec` / the built-in default. */
  specDeclared: string;
  configDir: string;
  configFile?: string;
  searched: string[];
};

export type ResolveProjectSpecOptions = {
  startDir?: string;
  /** Explicit `--spec`; resolved from `startDir`, not the config directory. */
  spec?: string;
  /** When true, a missing config file is an error that lists every path searched. */
  requireConfig?: boolean;
  /** When false, a missing spec file is still returned. Default true. */
  requireSpec?: boolean;
};

const searchedLines = (searched: readonly string[], indent: string): string[] => [
  `${indent}no styleproof.config.ts / .mjs / .js / .json found; searched:`,
  ...searched.map((candidate) => `${indent}  ${candidate}`),
];

export function missingStyleProofSpecMessage(options: {
  spec: string;
  specDeclared?: string;
  configFile?: string;
  searched?: readonly string[];
}): string {
  const lines = [`no StyleProof spec at ${options.spec}`];
  if (options.configFile && options.specDeclared) {
    lines.push(`  declared as "${options.specDeclared}" in ${options.configFile}`);
  } else if (options.configFile) {
    lines.push(`  declared in ${options.configFile}`);
  } else if (options.searched?.length) {
    lines.push(...searchedLines(options.searched, '  '));
  }
  return lines.join('\n');
}

/** Prefer a cwd-relative spec when the resolved file sits under `cwd`; otherwise the absolute path. */
export function specPathForCwd(absoluteSpec: string, cwd: string): string {
  const rel = path.relative(path.resolve(cwd), path.resolve(absoluteSpec)).replaceAll('\\', '/');
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return path.resolve(absoluteSpec);
  return rel;
}

/**
 * Discover the governing config and resolve the capture spec to an absolute path
 * from the config directory (or from `startDir` when `--spec` is explicit).
 */
export function resolveProjectSpec(options: ResolveProjectSpecOptions = {}): ResolvedProjectSpec {
  const startDir = path.resolve(options.startDir ?? process.cwd());
  const loaded = loadStyleProofConfigWithLocation(startDir);
  if (options.requireConfig && !loaded.configFile) {
    throw new StyleProofConfigError(searchedLines(loaded.searched, '').join('\n'));
  }
  // The default applies only after a successful load: an unloadable `.ts` threw above.
  const specDeclared = options.spec ?? loaded.config.spec ?? DEFAULT_STYLEPROOF_SPEC;
  const spec = resolveStyleProofConfigPath(specDeclared, options.spec !== undefined ? startDir : loaded.configDir);
  if (options.requireSpec !== false && !fs.existsSync(spec)) {
    throw new StyleProofConfigError(
      missingStyleProofSpecMessage({
        spec,
        specDeclared,
        configFile: loaded.configFile ? path.join(loaded.configDir, loaded.configFile) : undefined,
        searched: loaded.searched,
      }),
    );
  }
  return { spec, specDeclared, configDir: loaded.configDir, configFile: loaded.configFile, searched: loaded.searched };
}
