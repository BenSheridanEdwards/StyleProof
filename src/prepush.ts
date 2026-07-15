/**
 * Decision core of the pre-push capture hook.
 *
 * The generated `.husky`/`.githooks` pre-push file is a thin shim that execs the
 * packaged `styleproof-prepush` command; every behavioral rule lives HERE so hook
 * behavior updates with the styleproof release instead of with a bash file copied
 * into each consumer repo (and then hand-maintained, drifting, per consumer).
 *
 * The rules mirror the original shell hook exactly:
 *   - git feeds pre-push one line per ref on stdin:
 *     `<local-ref> <local-oid> <remote-ref> <remote-oid>`. Capture the ref whose
 *     tip is the CHECKED-OUT tree — the only commit whose render we can faithfully
 *     capture and bind to its SHA. Pushing some other branch (local-oid != HEAD)
 *     is left for CI to recapture, never captured from the wrong tree under that
 *     SHA.
 *   - A docs-only push (every changed file is a non-render doc) skips capture —
 *     always safe, CI just recaptures on a cache miss. A new ref (zero remote-oid)
 *     or an unreadable range never skips.
 *   - No refs on stdin (a manual run, or an older git): fall back to HEAD.
 *
 * Pure and side-effect-free (git access is injected) so it is fully unit-testable.
 */

/** One stdin line of the pre-push hook protocol. */
export type PrePushRef = {
  localRef: string;
  localOid: string;
  remoteRef: string;
  remoteOid: string;
};

/** The all-zero object id git uses for "no commit" (ref create/delete). */
export const PRE_PUSH_ZERO_OID = '0'.repeat(40);

// 40-hex sha1 or 64-hex sha256 — what git actually emits for the oid fields.
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Parse the pre-push stdin protocol; malformed lines are ignored. */
export function parsePrePushRefs(stdin: string): PrePushRef[] {
  const refs: PrePushRef[] = [];
  for (const line of stdin.split(/\r?\n/)) {
    const [localRef, localOid, remoteRef, remoteOid, extra] = line.trim().split(/\s+/);
    if (!localRef || !remoteRef || extra !== undefined) continue;
    if (!localOid || !OID.test(localOid) || !remoteOid || !OID.test(remoteOid)) continue;
    refs.push({ localRef, localOid, remoteRef, remoteOid });
  }
  return refs;
}

// Non-render docs: changing ONLY these cannot alter a computed style. Keep in sync
// with nothing — this is the single copy (the shell hook that duplicated it is gone).
const DOC_FILE = /\.(md|mdx|markdown|txt)$/;

/** True iff `files` is non-empty and every entry is a non-render doc. An empty list
 *  means the range diff was empty/unreadable — never treated as docs-only. */
export function docsOnlyFiles(files: readonly string[]): boolean {
  if (files.length === 0) return false;
  return files.every(
    (file) => DOC_FILE.test(file) || file.startsWith('docs/') || file === 'LICENSE' || file.startsWith('LICENSE.'),
  );
}

export type PrePushCaptureChoice = {
  /** Commit to capture and publish, or undefined when nothing can be faithfully
   *  captured (all deletes / docs-only / only non-checked-out refs). */
  sha?: string;
  /** Human-readable skip notes for the hook to surface on stderr. */
  notes: string[];
};

/**
 * Choose which pushed commit (if any) the hook should capture.
 *
 * @param refs         parsed stdin refspecs; empty means "no refs fed" (manual run).
 * @param headSha      `git rev-parse HEAD`, or undefined outside a repo.
 * @param changedFiles list files changed from..to, or undefined when the range is
 *                     unreadable (e.g. the remote oid isn't fetched locally).
 */
export function choosePrePushCaptureSha(options: {
  refs: readonly PrePushRef[];
  headSha: string | undefined;
  changedFiles: (from: string, to: string) => readonly string[] | undefined;
}): PrePushCaptureChoice {
  const { refs, headSha, changedFiles } = options;
  const notes: string[] = [];
  if (refs.length === 0) return { sha: headSha, notes };
  for (const ref of refs) {
    if (ref.localOid === PRE_PUSH_ZERO_OID) continue; // a delete: nothing to render
    if (ref.localOid !== headSha) continue; // not the checked-out tree: CI recaptures
    if (ref.remoteOid !== PRE_PUSH_ZERO_OID) {
      const changed = changedFiles(ref.remoteOid, ref.localOid);
      if (changed && docsOnlyFiles(changed)) {
        notes.push(`styleproof: docs-only push (${ref.localRef}) — skipping capture`);
        continue;
      }
    }
    return { sha: ref.localOid, notes };
  }
  return { notes };
}
