import { MAX_CAPTURE_EVIDENCE_BYTES, MAX_SCRIPT_EVIDENCE_BYTES } from './script-reach-limits.js';
import type {
  ScriptReach,
  ScriptReachEntry,
  ScriptSourceReach,
  CompactSourceSpan,
  SourceSpan,
} from './script-reach.js';

/** Adapt the pure mapper's objects to stored tuples; no stored object format is supported. */
function compactSpans(spans: (SourceSpan | CompactSourceSpan)[]): CompactSourceSpan[] {
  return spans
    .map((span): CompactSourceSpan =>
      Array.isArray(span) ? [...span] : [span.start.line, span.start.column, span.end.column],
    )
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || b[2] - a[2]);
}

/** One tuple per original anchor; never merge distinct points. */
export function compactScriptEvidence(script: ScriptReachEntry<SourceSpan | CompactSourceSpan>): ScriptReachEntry {
  const { files, ...entry } = script;
  const compact: ScriptReachEntry = {
    ...entry,
    ...(files
      ? {
          files: files.map((file): ScriptSourceReach => ({
            ...file,
            encoding: 'line-column-tuples',
            executed: compactSpans(file.executed),
            mixed: compactSpans(file.mixed),
            unexecuted: compactSpans(file.unexecuted),
          })),
        }
      : {}),
  };
  return Buffer.byteLength(JSON.stringify(compact)) > MAX_SCRIPT_EVIDENCE_BYTES
    ? { url: script.url, status: 'unknown', reason: 'script evidence exceeds 1 MiB' }
    : compact;
}

/** Collisions invalidate every involved script, even when hashes happen to agree. */
export function storedScriptEvidence(scripts: ScriptReachEntry<SourceSpan | CompactSourceSpan>[]): ScriptReach {
  const entries = scripts.map((script) => ({ ...script }));
  const owners = new Map<string, ScriptReachEntry<SourceSpan | CompactSourceSpan>>();
  const collisions = new Set<ScriptReachEntry<SourceSpan | CompactSourceSpan>>();
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
    notes: [
      'An executed anchor means its block was entered; code after any expression that threw in that block is not proved. V8 expression evaluation is unknown for default parameter values, destructuring defaults, logical assignment RHS (||=, &&=, ??=), and later links of a short-circuited optional chain. J2 2.2 must not treat these expressions as reached.',
    ],
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
