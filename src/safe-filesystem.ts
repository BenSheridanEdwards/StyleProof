import fs from 'node:fs';

export type UnsafeFilesystemEntryKind = 'symbolic-link' | 'non-regular' | 'changed-during-read';

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

/** Read one stable regular file without following a symlink or blocking on a FIFO. */
export function readRegularFileNoFollow(filePath: string): Buffer {
  const beforeOpen = fs.lstatSync(filePath);
  assertRegularPath(filePath, beforeOpen);

  let descriptor: number | undefined;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
    try {
      descriptor = fs.openSync(filePath, flags);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'ELOOP') throw new UnsafeFilesystemEntryError(filePath, 'symbolic-link', { cause: error });
      throw error;
    }

    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) throw new UnsafeFilesystemEntryError(filePath, 'non-regular');
    const pathBeforeRead = fs.lstatSync(filePath);
    assertRegularPath(filePath, pathBeforeRead);
    if (!sameFileIdentity(beforeOpen, opened) || !sameFileIdentity(pathBeforeRead, opened)) {
      throw new UnsafeFilesystemEntryError(filePath, 'changed-during-read');
    }

    const bytes = fs.readFileSync(descriptor);
    const afterRead = fs.fstatSync(descriptor);
    const pathAfterRead = fs.lstatSync(filePath);
    assertRegularPath(filePath, pathAfterRead);
    if (!sameFileIdentity(opened, afterRead) || !sameFileIdentity(pathAfterRead, afterRead)) {
      throw new UnsafeFilesystemEntryError(filePath, 'changed-during-read');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
