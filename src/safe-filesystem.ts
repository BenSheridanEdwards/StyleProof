import fs from 'node:fs';

export type UnsafeFilesystemEntryKind =
  'symbolic-link' | 'non-regular' | 'hard-linked' | 'changed-during-read' | 'oversized';

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

export function sameFileIdentity(first: fs.Stats, second: fs.Stats): boolean {
  if (first.dev !== 0 || first.ino !== 0 || second.dev !== 0 || second.ino !== 0) {
    return first.dev === second.dev && first.ino === second.ino;
  }
  return first.mode === second.mode && first.birthtimeMs === second.birthtimeMs;
}

function assertRegularPath(filePath: string, stat: fs.Stats): void {
  if (stat.isSymbolicLink()) throw new UnsafeFilesystemEntryError(filePath, 'symbolic-link');
  if (!stat.isFile()) throw new UnsafeFilesystemEntryError(filePath, 'non-regular');
}

function readBoundedDescriptor(descriptor: number, maximumBytes: number): Buffer {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
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
  if (
    !sameFileIdentity(first, second) ||
    first.size !== second.size ||
    first.mtimeMs !== second.mtimeMs ||
    first.ctimeMs !== second.ctimeMs
  ) {
    throw new UnsafeFilesystemEntryError(filePath, 'changed-during-read');
  }
}

function assertLinkCount(filePath: string, stat: fs.Stats, requireSingleLink: boolean): void {
  if (requireSingleLink && stat.nlink !== 1) throw new UnsafeFilesystemEntryError(filePath, 'hard-linked');
}

function readDescriptor(filePath: string, descriptor: number, maximumBytes?: number): Buffer {
  const bytes =
    maximumBytes === undefined ? fs.readFileSync(descriptor) : readBoundedDescriptor(descriptor, maximumBytes);
  assertWithinMaximum(filePath, bytes.length, maximumBytes);
  return bytes;
}

/** Read one stable regular file without following a symlink or blocking on a FIFO. */
export function readRegularFileNoFollow(
  filePath: string,
  maximumBytes?: number,
  options: { requireSingleLink?: boolean } = {},
): Buffer {
  const beforeOpen = fs.lstatSync(filePath);
  assertRegularPath(filePath, beforeOpen);
  assertLinkCount(filePath, beforeOpen, options.requireSingleLink === true);
  const descriptor = openRegularFileNoFollow(filePath);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) throw new UnsafeFilesystemEntryError(filePath, 'non-regular');
    assertLinkCount(filePath, opened, options.requireSingleLink === true);
    assertWithinMaximum(filePath, opened.size, maximumBytes);

    const pathBeforeRead = fs.lstatSync(filePath);
    assertRegularPath(filePath, pathBeforeRead);
    assertLinkCount(filePath, pathBeforeRead, options.requireSingleLink === true);
    assertStableIdentity(filePath, beforeOpen, opened);
    assertStableIdentity(filePath, pathBeforeRead, opened);

    const bytes = readDescriptor(filePath, descriptor, maximumBytes);
    const afterRead = fs.fstatSync(descriptor);
    const pathAfterRead = fs.lstatSync(filePath);
    assertRegularPath(filePath, pathAfterRead);
    assertLinkCount(filePath, pathAfterRead, options.requireSingleLink === true);
    assertStableIdentity(filePath, opened, afterRead);
    assertStableIdentity(filePath, pathAfterRead, afterRead);
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}
