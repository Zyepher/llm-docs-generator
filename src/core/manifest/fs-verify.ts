/**
 * Filesystem verification primitives: file metadata checks, symlink-refusing
 * path traversal, and path-type checks used by the manifest verifiers.
 */

import { lstat, stat } from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

import { describeGeneratedTextOutput } from '../generated-output-metadata.js';
import { errorMessage, isFileNotFoundError } from '../../utils/guards.js';
import { isParentRelativePath } from '../../utils/fs-path.js';
import { sha256File } from '../../utils/hash.js';
import { isInsideDirectory } from './predicates.js';
import type { VerifyGenerationManifestResult } from './types.js';

export async function runFileChecks(
  manifestPath: string,
  failures: string[],
  fileChecks: FileCheck[]
): Promise<VerifyGenerationManifestResult> {
  const checkedFiles = failures.length === 0 ? fileChecks.length : 0;

  if (failures.length === 0) {
    for (const check of fileChecks) {
      await verifyFile(check, failures);
    }
  }

  return {
    manifestPath,
    checkedFiles,
    failures,
  };
}

export async function describeFile(path: string): Promise<{ byteSize: number; hash: string }> {
  const [fileStats, hash] = await Promise.all([stat(path), sha256File(path)]);

  return {
    byteSize: fileStats.size,
    hash,
  };
}

export function toManifestRelativePath(manifestDir: string, outputPath: string): string {
  return relative(manifestDir, outputPath).split(sep).join('/');
}

export function resolveManifestSourcePath(sourcePath: string, manifestDir: string): string {
  if (isAbsolute(sourcePath)) {
    return sourcePath;
  }

  return resolve(manifestDir, sourcePath);
}

export function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameOptionalStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return sameStringArray(left, right);
}

export function isUrlLikePath(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('\\\\');
}

export function hasEmptyOrParentPathSegment(value: string): boolean {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .some((segment) => segment.length === 0 || segment === '..');
}

export interface FileCheck {
  label: string;
  path: string;
  expectedByteSize: number;
  expectedHash: string;
  expectedLineCount?: number;
  expectedEstimatedTokenCount?: number;
  rejectSymlink?: boolean;
  rejectSymlinkAncestors?: boolean;
  trustedRoot?: string;
}

export interface PathTypeCheck {
  label: string;
  path: string;
  expectedType: 'file' | 'directory';
  rejectSymlinkAncestors?: boolean;
}

export async function verifyFile(check: FileCheck, failures: string[]): Promise<void> {
  let actual: {
    byteSize: number;
    hash: string;
    lineCount?: number;
    estimatedTokenCount?: number;
  };

  try {
    if (check.rejectSymlink === true) {
      const pathIsAllowed =
        check.rejectSymlinkAncestors === true
          ? await verifyNoSymlinkAbsolutePath({
              label: check.label,
              path: check.path,
              trustedRoot: check.trustedRoot ?? dirname(check.path),
              expectedType: 'file',
              failures,
            })
          : await verifyNoSymlinkPathComponents(
              {
                label: check.label,
                path: check.path,
                trustedRoot: check.trustedRoot ?? dirname(check.path),
              },
              failures
            );

      if (!pathIsAllowed) {
        return;
      }
    }

    actual =
      check.expectedLineCount === undefined && check.expectedEstimatedTokenCount === undefined
        ? await describeFile(check.path)
        : await describeGeneratedTextOutput(check.path);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      failures.push(`${check.label}: missing file at ${check.path}`);
      return;
    }

    failures.push(`${check.label}: cannot read ${check.path}: ${errorMessage(error)}`);
    return;
  }

  if (actual.byteSize !== check.expectedByteSize) {
    failures.push(
      `${check.label}: byte size mismatch (expected ${check.expectedByteSize}, actual ${actual.byteSize})`
    );
  }

  if (actual.hash !== check.expectedHash) {
    failures.push(
      `${check.label}: hash mismatch (expected ${check.expectedHash}, actual ${actual.hash})`
    );
  }

  if (check.expectedLineCount !== undefined && actual.lineCount !== check.expectedLineCount) {
    failures.push(
      `${check.label}: line count mismatch (expected ${check.expectedLineCount}, actual ${String(
        actual.lineCount
      )})`
    );
  }

  if (
    check.expectedEstimatedTokenCount !== undefined &&
    actual.estimatedTokenCount !== check.expectedEstimatedTokenCount
  ) {
    failures.push(
      `${check.label}: estimated token count mismatch (expected ${check.expectedEstimatedTokenCount}, actual ${String(
        actual.estimatedTokenCount
      )})`
    );
  }
}

export async function verifyNoSymlinkPathComponents(
  check: { label: string; path: string; trustedRoot: string },
  failures: string[]
): Promise<boolean> {
  const trustedRoot = resolve(check.trustedRoot);
  const targetPath = resolve(check.path);
  const relativePath = relative(trustedRoot, targetPath);

  if (isParentRelativePath(relativePath) || isAbsolute(relativePath)) {
    failures.push(`${check.label}: path escapes trusted root: ${targetPath}`);
    return false;
  }

  const pathParts = relativePath === '' ? [] : relativePath.split(sep).filter(Boolean);
  let currentPath = trustedRoot;

  if (pathParts.length === 0) {
    return verifyNoSymlinkPathComponent({
      label: check.label,
      path: currentPath,
      targetPath,
      isLeaf: true,
      failures,
    });
  }

  for (const [index, pathPart] of pathParts.entries()) {
    currentPath = resolve(currentPath, pathPart);

    const pathIsAllowed = await verifyNoSymlinkPathComponent({
      label: check.label,
      path: currentPath,
      targetPath,
      isLeaf: index === pathParts.length - 1,
      failures,
    });

    if (!pathIsAllowed) {
      return false;
    }
  }

  return true;
}

export async function verifyNoSymlinkAbsolutePath(options: {
  label: string;
  path: string;
  trustedRoot: string;
  expectedType: 'file' | 'directory';
  failures: string[];
}): Promise<boolean> {
  const trustedRoot = resolve(options.trustedRoot);
  const targetPath = resolve(options.path);

  if (!isInsideDirectory(trustedRoot, targetPath)) {
    options.failures.push(`${options.label}: path escapes trusted root: ${targetPath}`);
    return false;
  }

  const parsedPath = parse(targetPath);
  const pathParts = targetPath.slice(parsedPath.root.length).split(sep).filter(Boolean);
  let currentPath = parsedPath.root;

  if (pathParts.length === 0) {
    return verifyNoSymlinkPathComponent({
      label: options.label,
      path: currentPath,
      targetPath,
      isLeaf: true,
      leafType: options.expectedType,
      failures: options.failures,
    });
  }

  for (const [index, pathPart] of pathParts.entries()) {
    currentPath = resolve(currentPath, pathPart);

    const pathIsAllowed = await verifyNoSymlinkPathComponent({
      label: options.label,
      path: currentPath,
      targetPath,
      isLeaf: index === pathParts.length - 1,
      leafType: options.expectedType,
      failures: options.failures,
    });

    if (!pathIsAllowed) {
      return false;
    }
  }

  return true;
}

export async function verifyNoSymlinkPathComponent(options: {
  label: string;
  path: string;
  targetPath: string;
  isLeaf: boolean;
  leafType?: 'file' | 'directory';
  failures: string[];
}): Promise<boolean> {
  const { label, path, targetPath, isLeaf, leafType = 'file', failures } = options;
  let stats: Awaited<ReturnType<typeof lstat>>;

  try {
    stats = await lstat(path);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      failures.push(
        isLeaf
          ? `${label}: missing ${leafType} at ${targetPath}`
          : `${label}: missing path component at ${path}`
      );
      return false;
    }

    failures.push(`${label}: cannot inspect ${path}: ${errorMessage(error)}`);
    return false;
  }

  if (stats.isSymbolicLink()) {
    failures.push(`${label}: symbolic links are not allowed in path at ${path}`);
    return false;
  }

  if (isLeaf && leafType === 'file' && !stats.isFile()) {
    failures.push(`${label}: expected file at ${path}`);
    return false;
  }

  if (isLeaf && leafType === 'directory' && !stats.isDirectory()) {
    failures.push(`${label}: expected directory at ${path}`);
    return false;
  }

  if (!isLeaf && !stats.isDirectory()) {
    failures.push(`${label}: expected directory at ${path}`);
    return false;
  }

  return true;
}

export async function verifyPathType(check: PathTypeCheck, failures: string[]): Promise<void> {
  if (check.rejectSymlinkAncestors === true) {
    await verifyNoSymlinkAbsolutePath({
      label: check.label,
      path: check.path,
      trustedRoot: check.expectedType === 'directory' ? check.path : dirname(check.path),
      expectedType: check.expectedType,
      failures,
    });
    return;
  }

  let stats: Awaited<ReturnType<typeof lstat>>;

  try {
    stats = await lstat(check.path);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      failures.push(`${check.label}: missing ${check.expectedType} at ${check.path}`);
      return;
    }

    failures.push(`${check.label}: cannot inspect ${check.path}: ${errorMessage(error)}`);
    return;
  }

  if (
    (check.expectedType === 'file' && !stats.isFile()) ||
    (check.expectedType === 'directory' && !stats.isDirectory())
  ) {
    failures.push(`${check.label}: expected ${check.expectedType} at ${check.path}`);
  }
}
