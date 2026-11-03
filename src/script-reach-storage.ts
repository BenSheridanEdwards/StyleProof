import { MAX_CAPTURE_EVIDENCE_BYTES, MAX_SCRIPT_EVIDENCE_BYTES } from './script-reach-limits.js';
import type { ScriptReach, ScriptReachEntry, CompactSourceSpan, SourceSpan } from './script-reach.js';

/** One tuple per single-line range, keeping isolated anchors but dropping redundant ones. */
export function compactScriptEvidence(script: ScriptReachEntry): ScriptReachEntry {
  const compact = {
    ...script,
    ...(script.files
      ? {
          files: script.files.map((file) => ({
            ...file,
            encoding: 'line-column-tuples' as const,
            ...Object.fromEntries(
              ['executed', 'mixed', 'unexecuted'].map((kind) => {
                const spans = file[kind as 'executed'].map((span: SourceSpan | CompactSourceSpan): CompactSourceSpan =>
                  Array.isArray(span) ? span : [span.start.line, span.start.column, span.end.column],
                );
                spans.sort((a, b) => a[0] - b[0] || a[1] - b[1] || b[2] - a[2]);
                let previous: CompactSourceSpan | undefined;
                return [
                  kind,
                  spans.filter((span) => {
                    if (
                      span[1] === span[2] &&
                      previous?.[0] === span[0] &&
                      previous[1] <= span[1] &&
                      previous[2] > span[2]
                    )
                      return false;
                    previous = span;
                    return true;
                  }),
                ];
              }),
            ),
          })),
        }
      : {}),
  };
  return Buffer.byteLength(JSON.stringify(compact)) > MAX_SCRIPT_EVIDENCE_BYTES
    ? { url: script.url, status: 'unknown', reason: 'script evidence exceeds 1 MiB' }
    : compact;
}

/** Collisions invalidate every involved script, even when hashes happen to agree. */
export function storedScriptEvidence(scripts: ScriptReachEntry[]): ScriptReach {
  const entries = scripts.map((script) => ({ ...script }));
  const owners = new Map<string, ScriptReachEntry>();
  const collisions = new Set<ScriptReachEntry>();
  for (const script of entries)
    for (const file of script.files ?? []) {
      const key = file.sourceKey ?? file.source;
      const owner = owners.get(key);
      if (owner) {
        collisions.add(owner);
        collisions.add(script);
      } else owners.set(key, script);
    }
  for (const script of collisions) {
    script.status = 'unknown';
    script.reason = 'source key collision';
    delete script.files;
  }
  const evidence: ScriptReach = {
    version: 1,
    window: 'navigation',
    status: 'measured',
    scripts: entries.map(compactScriptEvidence),
  };
  return Buffer.byteLength(JSON.stringify(evidence)) > MAX_CAPTURE_EVIDENCE_BYTES
    ? {
        version: 1,
        window: 'navigation',
        status: 'unknown',
        reason: 'total script evidence exceeds 4 MiB',
        scripts: [],
      }
    : evidence;
}
