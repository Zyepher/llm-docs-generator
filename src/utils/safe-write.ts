import { randomUUID } from 'node:crypto';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { isFileNotFoundError } from './guards.js';

export async function writeTextFileSafely(path: string, content: string): Promise<void> {
  await assertSafeReplaceTarget(path);

  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let tempFileCreated = false;

  try {
    const file = await open(tempPath, 'wx');
    tempFileCreated = true;

    try {
      await file.writeFile(content, 'utf-8');
      await file.sync();
    } finally {
      await file.close();
    }

    await assertSafeReplaceTarget(path);
    await rename(tempPath, path);
    tempFileCreated = false;
  } finally {
    if (tempFileCreated) {
      await rm(tempPath, { force: true });
    }
  }
}

async function assertSafeReplaceTarget(path: string): Promise<void> {
  try {
    const stats = await lstat(path);

    if (!stats.isFile()) {
      throw new Error(`Refusing to write ${path}: destination exists and is not a regular file.`);
    }
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return;
    }

    throw error;
  }
}
