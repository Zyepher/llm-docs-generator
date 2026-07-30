/**
 * Filesystem verification primitives: file metadata checks, symlink-refusing
 * path traversal, path-type checks, and the pack-directory scan used by the
 * manifest verifiers.
 */

import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { describeGeneratedTextOutput } from '../generated-output-metadata.js';
import { errorMessage, isFileNotFoundError } from '../../utils/guards.js';
import { isParentRelativePath } from '../../utils/fs-path.js';
import { sha256File } from '../../utils/hash.js';
import { compareStringsByCodeUnit } from '../../utils/sort.js';
import { isInsideDirectory } from './predicates.js';

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// Filenames the generator itself emits. An unlisted file matching one of these
// can masquerade as verified content, so the pack scan reports it as a
// verification failure instead of an informational unmanaged entry. The root
// manifest.json is exempt (it is the manifest under verification); a nested
// manifest.json is not.
const GENERATED_OUTPUT_NAMING_FILENAMES: ReadonlySet<string> = new Set([
  'semantic-chunks.jsonl',
  'manifest.json',
  'discovery-report.json',
  'failure.json',
]);

// Cap on reported paths so a pack directory with thousands of stray files
// cannot flood the verify report; the overflow collapses into a "+N more"
// marker after deterministic sorting.
const PACK_SCAN_REPORT_LIMIT = 20;

function matchesGeneratedOutputNaming(filename: string): boolean {
  return filename.endsWith('-llms.txt') || GENERATED_OUTPUT_NAMING_FILENAMES.has(filename);
}

function boundReportedEntries(entries: string[]): string[] {
  if (entries.length <= PACK_SCAN_REPORT_LIMIT) {
    return entries;
  }

  return [
    ...entries.slice(0, PACK_SCAN_REPORT_LIMIT),
    `+${entries.length - PACK_SCAN_REPORT_LIMIT} more`,
  ];
}

/**
 * Enumerate the manifest's directory recursively and classify every entry the
 * manifest does not cover. Unlisted files matching the tool's own output
 * naming are verification failures (they can masquerade as verified content);
 * every other unlisted entry is reported informationally as unmanaged, never a
 * failure. Symlinks are reported as unmanaged and are never followed or
 * hashed, so a link cannot pull content from outside the pack into the scan.
 */
export async function scanManifestDirectoryForUnlistedFiles(options: {
  manifestPath: string;
  listedPaths: Iterable<string>;
}): Promise<{ failures: string[]; unmanagedFiles: string[] }> {
  const manifestPath = resolve(options.manifestPath);
  const packDir = dirname(manifestPath);
  const listedPaths = new Set<string>([manifestPath]);

  for (const listedPath of options.listedPaths) {
    listedPaths.add(resolve(listedPath));
  }

  const failures: string[] = [];
  const masqueradingPaths: string[] = [];
  const unmanagedEntries: string[] = [];
  const pendingDirectories: string[] = [packDir];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();

    if (directory === undefined) {
      break;
    }

    let entries: Dirent[];

    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      failures.push(`pack scan: cannot read directory ${directory}: ${errorMessage(error)}`);
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
        continue;
      }

      if (listedPaths.has(resolve(entryPath))) {
        continue;
      }

      const relativePath = toManifestRelativePath(packDir, entryPath);

      if (entry.isSymbolicLink()) {
        unmanagedEntries.push(`${relativePath} (symbolic link; not followed)`);
        continue;
      }

      if (!entry.isFile()) {
        unmanagedEntries.push(`${relativePath} (not a regular file)`);
        continue;
      }

      if (matchesGeneratedOutputNaming(entry.name)) {
        masqueradingPaths.push(relativePath);
      } else {
        unmanagedEntries.push(relativePath);
      }
    }
  }

  masqueradingPaths.sort(compareStringsByCodeUnit);
  unmanagedEntries.sort(compareStringsByCodeUnit);

  const reportedMasqueradingPaths = masqueradingPaths.slice(0, PACK_SCAN_REPORT_LIMIT);

  for (const path of reportedMasqueradingPaths) {
    failures.push(
      `unlisted file matches generated-output naming; not covered by this manifest: ${path}`
    );
  }

  if (masqueradingPaths.length > PACK_SCAN_REPORT_LIMIT) {
    failures.push(
      `unlisted files matching generated-output naming; not covered by this manifest: +${
        masqueradingPaths.length - PACK_SCAN_REPORT_LIMIT
      } more`
    );
  }

  return { failures, unmanagedFiles: boundReportedEntries(unmanagedEntries) };
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
async function verifyNoSymlinkPathComponents(
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
async function verifyNoSymlinkAbsolutePath(options: {
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

  // Canonicalize the trusted root and verify only the components below it.
  // Symlinks in the root's ancestry (for example macOS's /tmp -> private/tmp)
  // are the caller's environment, not pack contents; walking from the
  // filesystem root would spuriously fail every pack addressed through such
  // an alias, and refresh would then quarantine a healthy manifest.
  let canonicalRoot: string;

  try {
    canonicalRoot = await realpath(trustedRoot);
  } catch (error) {
    options.failures.push(
      isFileNotFoundError(error)
        ? `${options.label}: missing path component at ${trustedRoot}`
        : `${options.label}: cannot inspect ${trustedRoot}: ${errorMessage(error)}`
    );
    return false;
  }

  const relativePath = relative(trustedRoot, targetPath);
  const pathParts = relativePath === '' ? [] : relativePath.split(sep).filter(Boolean);
  let currentPath = canonicalRoot;

  if (pathParts.length === 0) {
    return verifyNoSymlinkPathComponent({
      label: options.label,
      path: trustedRoot,
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
async function verifyNoSymlinkPathComponent(options: {
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
