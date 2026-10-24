import fs from 'node:fs';
import path from 'node:path';

export type UnsafeFilesystemEntryKind = 'symbolic-link' | 'non-regular' | 'changed-during-read' | 'oversized';

export class UnsafeFilesystemEntryError extends Error {
  readonly kind: UnsafeFilesystemEntryKind;
  readonly filePath: string;

  constructor(filePath: string, kind: UnsafeFilesystemEntryKind, options?: ErrorOptions) {
    super(`refusing ${kind} filesystem entry: ${filePath}`, options);
    this.name = 'UnsafeFilesystemEntryError';
    this.kind = kind;
    this.filePath = filePath;
  }
}

/** True when `candidate` resolves to `root` itself or somewhere beneath it. */
export function isWithinDirectory(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  // A filesystem root (`/`, `C:\`) already ends with the separator.
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  return resolved === resolvedRoot || resolved.startsWith(prefix);
}

function sameFileIdentity(first: fs.Stats, second: fs.Stats): boolean {
  if (first.dev !== 0 || first.ino !== 0 || second.dev !== 0 || second.ino !== 0) {
    return first.dev === second.dev && first.ino === second.ino;
  }
  return first.mode === second.mode && first.birthtimeMs === second.birthtimeMs;
}

/** `p` resolved through its nearest existing parent's real (on-disk) path, missing tail re-joined. */
function realPathThroughExisting(p: string): { existing: string; real: string } {
  const resolved = path.resolve(p);
  let existing = resolved;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const realExisting = fs.realpathSync.native(existing);
  return { existing: realExisting, real: path.join(realExisting, path.relative(existing, resolved)) };
}

/** True when `candidate` is `root` or lies beneath it on disk. Compares folder identity up the
 *  candidate's real parents, so a symlinked or differently cased spelling (case-insensitive
 *  filesystems) is still caught (#1065). A missing tail cannot change the answer: a path below it
 *  is inside `root` exactly when its nearest existing parent is. */
export function isWithinDirectoryOnDisk(root: string, candidate: string): boolean {
  if (!fs.existsSync(root)) {
    return isWithinDirectory(realPathThroughExisting(root).real, realPathThroughExisting(candidate).real);
  }
  const rootStat = fs.statSync(root);
  let current = realPathThroughExisting(candidate).existing;
  for (;;) {
    if (sameFileIdentity(fs.statSync(current), rootStat)) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function assertRegularPath(filePath: string, stat: fs.Stats): void {
  if (stat.isSymbolicLink()) throw new UnsafeFilesystemEntryError(filePath, 'symbolic-link');
  if (!stat.isFile()) throw new UnsafeFilesystemEntryError(filePath, 'non-regular');
}

/** Read up to `size + 1` bytes: sized from `fstat`, not the cap, with one spare byte to see growth. */
function readBoundedDescriptor(descriptor: number, size: number): Buffer {
  const buffer = Buffer.allocUnsafe(size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset);
}

function openRegularFileNoFollow(filePath: string): number {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
  try {
    return fs.openSync(filePath, flags);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ELOOP') throw new UnsafeFilesystemEntryError(filePath, 'symbolic-link', { cause: error });
    throw error;
  }
}

function assertWithinMaximum(filePath: string, size: number, maximumBytes?: number): void {
  if (maximumBytes !== undefined && size > maximumBytes) {
    throw new UnsafeFilesystemEntryError(filePath, 'oversized');
  }
}

function assertStableIdentity(filePath: string, first: fs.Stats, second: fs.Stats): void {
  if (!sameFileIdentity(first, second)) throw new UnsafeFilesystemEntryError(filePath, 'changed-during-read');
}

function assertUnchangedSnapshot(filePath: string, opened: fs.Stats, later: fs.Stats): void {
  if (later.size !== opened.size || later.mtimeMs !== opened.mtimeMs || later.ctimeMs !== opened.ctimeMs) {
    throw new UnsafeFilesystemEntryError(filePath, 'changed-during-read');
  }
}

function readDescriptor(filePath: string, descriptor: number, size: number, maximumBytes?: number): Buffer {
  const bytes = maximumBytes === undefined ? fs.readFileSync(descriptor) : readBoundedDescriptor(descriptor, size);
  assertWithinMaximum(filePath, bytes.length, maximumBytes);
  // Identity checks cannot see an in-place append or truncate, so the bytes must match the sized snapshot.
  if (bytes.length !== size) throw new UnsafeFilesystemEntryError(filePath, 'changed-during-read');
  return bytes;
}

/** Read one stable regular file without following a symlink or blocking on a FIFO. */
export function readRegularFileNoFollow(filePath: string, maximumBytes?: number): Buffer {
  const beforeOpen = fs.lstatSync(filePath);
  assertRegularPath(filePath, beforeOpen);
  const descriptor = openRegularFileNoFollow(filePath);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) throw new UnsafeFilesystemEntryError(filePath, 'non-regular');
    assertWithinMaximum(filePath, opened.size, maximumBytes);

    const pathBeforeRead = fs.lstatSync(filePath);
    assertRegularPath(filePath, pathBeforeRead);
    assertStableIdentity(filePath, beforeOpen, opened);
    assertStableIdentity(filePath, pathBeforeRead, opened);

    const bytes = readDescriptor(filePath, descriptor, opened.size, maximumBytes);
    const afterRead = fs.fstatSync(descriptor);
    const pathAfterRead = fs.lstatSync(filePath);
    assertRegularPath(filePath, pathAfterRead);
    assertStableIdentity(filePath, opened, afterRead);
    assertStableIdentity(filePath, pathAfterRead, afterRead);
    assertWithinMaximum(filePath, afterRead.size, maximumBytes);
    assertWithinMaximum(filePath, pathAfterRead.size, maximumBytes);
    assertUnchangedSnapshot(filePath, opened, afterRead);
    assertUnchangedSnapshot(filePath, opened, pathAfterRead);
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}
