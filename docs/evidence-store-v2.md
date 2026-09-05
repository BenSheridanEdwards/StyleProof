# StyleProof Evidence Store v2

**Status:** Experimental architecture, local semantic kernel and v1 import bridge implemented behind package APIs and `styleproof store import`

## Problem

The v1 map store uses a Git branch as identity, object storage, mutable index, transport, concurrency protocol, and retention mechanism at once. A capture lives at `<commit-sha>/<compatibility-key>`, publication clones and rewrites branch state, and retention force-replaces the branch with an orphan commit. The current implementation is careful, but the abstraction has reached its limit:

- capture identity is coupled to repository history rather than evidence content;
- identical objects across captures have no explicit deduplication contract;
- concurrent publishers contend on the whole branch;
- compaction contends with publishers, although conditional ref updates now prevent it from discarding a racing publication;
- restore requires Git negotiation and sparse checkout;
- retention reconstructs dates from commit history and a sidecar;
- GitHub is the data model instead of one possible transport;
- maps, screenshots, provenance, confidence, reports, and future Component Map evidence have no shared object lifecycle.

## Decision

V2 separates immutable evidence from mutable discovery.

### 1. Immutable objects

Every persisted byte sequence is addressed as:

```text
sha256:<64 lowercase hex digits>
```

Local layout:

```text
objects/sha256/<first-two-digits>/<full-digest>
```

The digest and byte length are verified on every read and deduplicating write. Existing corrupt bytes fail loudly.

### 2. Immutable capture manifests

A capture is canonical JSON stored as another immutable object. Its object digest is the capture identity.

```json
{
  "kind": "styleproof.capture",
  "version": 2,
  "source": {
    "sha": "...",
    "compatibilityKey": "..."
  },
  "trust": {
    "coverageBasis": "complete",
    "determinismStatus": "proven"
  },
  "files": [
    {
      "path": "home@1280.json",
      "object": {
        "algorithm": "sha256",
        "digest": "...",
        "size": 1234
      }
    }
  ]
}
```

File order is canonical. Paths are repository-independent POSIX relative paths. Absolute paths, traversal, backslashes, NULs, drive paths, and duplicate destinations are rejected.

Timestamps are deliberately absent from content identity. Operational publication time belongs in mutable metadata or adapter logs, not in evidence equivalence.

### 3. Mutable refs

Human and workflow lookup keys point to capture objects:

```text
refs/commits/<commit-sha>/<compatibility-key>.json
refs/prs/<pull-request>/<head-sha>.json
refs/releases/<release>.json
```

Only refs may move. Every update is compare-and-swap against an expected previous capture or explicit absence. Concurrent publication cannot silently overwrite another result.

The local adapter uses a versioned owner lock plus atomic file replacement. Legacy PID-line locks remain recoverable during upgrades. A lock is recoverable only when its recorded publisher PID is no longer alive; age alone never authorizes lock theft. Recovery hard-links and rechecks exact owner bytes plus file identity before removal, with a zero-inode fallback for Windows, while malformed or live-owner locks fail closed. Remote adapters must use their native conditional-write primitive, generation match, ETag, or Git ref lease.

### 4. Atomic verified materialization

Restore performs four steps:

1. read and hash-verify the capture manifest;
2. schema-check every path and object reference;
3. read and hash-verify every referenced object;
4. write a temporary directory and atomically rename it into place.

A corrupt or missing late object cannot expose a partial capture directory.

### 5. Retention and garbage collection

Garbage collection is reachability-based, not branch-history rewriting:

1. snapshot all retained refs and pinned report/release roots;
2. mark capture manifests reachable from those refs;
3. mark objects reachable from each capture;
4. sweep only unmarked objects older than a configured grace period;
5. produce a machine-readable deletion receipt.

Publication may temporarily leak an unreachable immutable object if interrupted. It must never delete or corrupt a live capture.

## Layering

```text
CLI and CI policy
  -> capture/report/component evidence model
    -> object + manifest + ref contract
      -> local filesystem adapter
      -> Git/GitHub migration adapter
      -> object-storage adapter
      -> future hosted StyleProof evidence service
```

Git remains useful for migration and perhaps a small ref ledger. It is no longer the evidence data model.

## CLI direction

```bash
styleproof store import .styleproof/maps/current
styleproof store verify commits/<sha>/<compatibility-key>
styleproof store restore commits/<sha>/<compatibility-key> <out-dir>
styleproof store refs
styleproof store gc --dry-run
styleproof store migrate --from git-branch
```

The current `styleproof prune-maps` remains a legacy compatibility command until v2 restore equivalence is proven.

## Migration

No flag day.

1. Ship the v2 local object, manifest, ref, and verification kernel.
2. Import a current v1 bundle and prove byte-for-byte materialization.
3. Dual-write v1 and v2 during CI publication.
4. Compare v1 and v2 restore results in dogfood.
5. Switch reads to v2 with v1 fallback and explicit provenance.
6. Migrate retained refs and pinned evidence.
7. Enable reachability GC with a grace period.
8. Retire branch-tree writes and force-squash pruning only after remote exact-SHA CI evidence.

## Security and privacy

- HAR and network payloads are excluded from persistent evidence by default.
- Credentials and setup secrets are never objects.
- Object reads always verify digest and size.
- Manifest paths are treated as hostile input.
- V1 import routes every manifest, coverage, confidence, provenance, and map read through one no-follow regular-file primitive; FIFOs, sockets, devices, and symlinks are refused before bytes are read.
- Only canonical flat StyleProof failure receipts are imported from the managed failures directory; unknown files and nested directories remain excluded.
- Remote refs require authenticated conditional writes.
- Encryption belongs in adapters, while hashes remain over a clearly versioned plaintext or ciphertext policy.
- Signing and attestations should bind capture digest, producer workflow identity, source SHA, and certification receipt without changing capture bytes.

## Implemented tracer

The current branch implements and tests:

- immutable SHA-256 object put/read and deduplication;
- corruption refusal;
- canonical capture creation independent of input file order;
- unsafe and duplicate path refusal;
- verified atomic materialization;
- compare-and-swap local refs;
- versioned lock ownership, dead-publisher recovery, and fail-closed live/malformed locks;
- packed-package API exposure;
- strict v1 bundle import with fail-closed trust mapping, non-regular-file refusal before metadata reads, canonical failure-receipt filtering, HAR exclusion, and unrelated-file exclusion by default;
- `styleproof store import <bundle> [--json]` with an idempotent commit/compatibility ref;
- `styleproof store verify <ref>` full-object verification;
- `styleproof store restore <ref> <out-dir>` verified atomic restoration.

Not yet implemented:

- remote adapter;
- dual-write;
- reachability GC;
- encryption/signing;
- hosted service.
