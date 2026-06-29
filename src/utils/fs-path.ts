import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { isFileNotFoundError } from './guards.js';

/**
 * Shared filesystem path-containment helpers.
 *
 * These underpin the security-critical "output directory must be outside the
 * input" checks across source-docs, source-truth-docs, source-verification, and
 * refresh. They were copy-pasted into each module, so a drift here was a real
 * path-escape hazard; keeping one copy means every call-site shares the exact
 * same containment logic.
 */

/** True when a relative path points at or above its base (`..` or `../...`). */
export function isParentRelativePath(path: string): boolean {
  return path === '..' || path.startsWith(`..${sep}`);
}

/**
 * True when candidatePath is the same as, or nested inside, parentPath. Callers
 * resolve/realpath both sides first so the comparison is canonical.
 */
export function isSameOrDescendant(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(parentPath, candidatePath);

  return relativePath === '' || (!isParentRelativePath(relativePath) && !isAbsolute(relativePath));
}

/** realpath(path), or undefined when the path does not exist. */
export async function realpathIfExists(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

/**
 * Canonicalize outputDir even when it does not exist yet: walk up to the nearest
 * existing ancestor, realpath that, then re-append the missing segments. This
 * resolves symlinks in the existing prefix without requiring the full output
 * path to exist, which is what the containment checks need before a generate run
 * creates the directory.
 */
export async function resolveEffectiveOutputPath(outputDir: string): Promise<string> {
  const resolvedOutputDir = resolve(outputDir);
  const missingSegments: string[] = [];
  let currentPath = resolvedOutputDir;

  while (true) {
    try {
      const canonicalExistingPath = await realpath(currentPath);

      return missingSegments.length === 0
        ? canonicalExistingPath
        : join(canonicalExistingPath, ...missingSegments.reverse());
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
    }

    const parentPath = dirname(currentPath);

    if (parentPath === currentPath) {
      return resolvedOutputDir;
    }

    missingSegments.push(basename(currentPath));
    currentPath = parentPath;
  }
}
