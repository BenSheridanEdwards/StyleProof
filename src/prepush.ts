// Decision core of the pre-push capture hook. The generated hook file is a thin shim that
// execs `styleproof-prepush`; every rule lives here so it updates with the release.
// Pure and side-effect-free (git access is injected).

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

/** Parse the pre-push stdin protocol (`<local-ref> <local-oid> <remote-ref> <remote-oid>`); malformed lines are ignored. */
export function parsePrePushRefs(stdin: string): PrePushRef[] {
  return stdin.split(/\r?\n/).flatMap((line) => {
    const [localRef, localOid, remoteRef, remoteOid, extra] = line.trim().split(/\s+/);
    if (!localRef || !remoteRef || extra !== undefined || !OID.test(localOid ?? '') || !OID.test(remoteOid ?? ''))
      return [];
    return [{ localRef, localOid, remoteRef, remoteOid }];
  });
}

// Non-render docs: changing ONLY these cannot alter a computed style.
const DOC_FILE = /\.(md|mdx|markdown|txt)$/;

/** True iff `files` is non-empty and every entry is a non-render doc. An empty list means
 *  the range diff was empty/unreadable — never treated as docs-only. */
export function docsOnlyFiles(files: readonly string[]): boolean {
  if (files.length === 0) return false;
  return files.every(
    (file) => DOC_FILE.test(file) || file.startsWith('docs/') || file === 'LICENSE' || file.startsWith('LICENSE.'),
  );
}

export type PrePushCaptureChoice = {
  /** Commit to capture and publish, or undefined when nothing can be faithfully captured. */
  sha?: string;
  /** Human-readable skip notes for the hook to surface on stderr. */
  notes: string[];
};

/** Choose which pushed commit (if any) the hook should capture: only a ref whose tip is the
 *  CHECKED-OUT tree (any other branch is left for CI), skipping deletes and docs-only pushes.
 *  No refs on stdin (a manual run) falls back to HEAD. `changedFiles` returns undefined when
 *  the range is unreadable, which never skips. */
export function choosePrePushCaptureSha(options: {
  refs: readonly PrePushRef[];
  headSha: string | undefined;
  changedFiles: (from: string, to: string) => readonly string[] | undefined;
}): PrePushCaptureChoice {
  const { refs, headSha, changedFiles } = options;
  const notes: string[] = [];
  if (refs.length === 0) return { sha: headSha, notes };
  for (const ref of refs) {
    if (ref.localOid === PRE_PUSH_ZERO_OID || ref.localOid !== headSha) continue;
    const changed = ref.remoteOid === PRE_PUSH_ZERO_OID ? undefined : changedFiles(ref.remoteOid, ref.localOid);
    if (changed && docsOnlyFiles(changed)) {
      notes.push(`styleproof: docs-only push (${ref.localRef}) — skipping capture`);
      continue;
    }
    return { sha: ref.localOid, notes };
  }
  return { notes };
}
