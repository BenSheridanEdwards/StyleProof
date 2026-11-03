import type { ScriptReachEntry, CompactSourceSpan, SourceSpan } from './script-reach.js';

/** One tuple per single-line range, keeping isolated anchors but dropping redundant ones. */
export function compactScriptEvidence(script: ScriptReachEntry): ScriptReachEntry {
  const compact = {
    ...script,
    files: script.files?.map((file) => ({
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
                (previous[2] > span[2] || previous[1] === previous[2])
              )
                return false;
              previous = span;
              return true;
            }),
          ];
        }),
      ),
    })),
  };
  return Buffer.byteLength(JSON.stringify(compact)) > 1024 * 1024
    ? { url: script.url, status: 'unknown', reason: 'script evidence exceeds 1 MiB' }
    : compact;
}
