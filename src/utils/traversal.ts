import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, parse, relative, sep } from 'node:path';

import { compareStringsByCodeUnit } from './sort.js';

/**
 * Directory names that bounded local traversals never descend into: version
 * control internals, dependency trees, and build outputs. Shared by discovery,
 * source-docs generation, source-truth, and source-verification so every
 * command that claims bounded local inspection skips the same vendored trees.
 * The lists had already drifted while copy-pasted per module ('.docusaurus'
 * was skipped only by source-verification); this is the reconciled union.
 */
export const SKIPPED_DIRECTORY_NAMES = [
  '.cache',
  '.docusaurus',
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
] as const;

const SKIPPED_DIRECTORY_NAME_SET: ReadonlySet<string> = new Set(SKIPPED_DIRECTORY_NAMES);

export function isSkippedTraversalDirectory(name: string): boolean {
  return SKIPPED_DIRECTORY_NAME_SET.has(name);
}

/**
 * Shared bound parsing for traversal options (maxDepth, maxEntries, maxFiles,
 * maxFileBytes). Every command that accepts these flags rejects the same inputs
 * with the same message, so the CLI cannot drift per command.
 */
export function resolveTraversalBound(
  value: number | undefined,
  defaultValue: number,
  name: string,
  allowZero: boolean
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    const lowerBound = allowZero ? 'non-negative' : 'positive';
    throw new Error(`${name} must be a ${lowerBound} safe integer`);
  }

  return value;
}

/**
 * Reject an input path whose parent directories contain a symbolic link.
 * Traversal itself never follows symlinks, so a symlinked ancestor would let a
 * caller read a tree outside the path they explicitly named.
 */
export async function assertNoParentSymlinkComponents(options: {
  label: string;
  path: string;
}): Promise<void> {
  const parsedPath = parse(options.path);
  const parts = options.path.slice(parsedPath.root.length).split(sep).filter(Boolean);
  let currentPath = parsedPath.root;

  for (let index = 0; index < parts.length - 1; index++) {
    currentPath = join(currentPath, parts[index] as string);

    const componentStats = await lstat(currentPath);

    if (componentStats.isSymbolicLink()) {
      throw new Error(
        `${options.label} path must not contain a symbolic link component: ${currentPath}`
      );
    }
  }
}

export interface BoundedWalkCounters {
  visitedEntries: number;
  visitedFiles: number;
}

export interface BoundedWalkOptions {
  root: string;
  maxDepth: number;
  maxEntries: number;
  maxFiles: number;
  skipDirectoryNames: boolean;
  counters?: BoundedWalkCounters;
}

export type TraversalEvent =
  | { kind: 'file'; absolutePath: string; relativePath: string; entry: Dirent; depth: number }
  | { kind: 'symlink'; absolutePath: string; relativePath: string; depth: number }
  | { kind: 'skipped-directory'; absolutePath: string; relativePath: string; depth: number }
  | { kind: 'depth-pruned'; absolutePath: string; relativePath: string; depth: number }
  | { kind: 'entries-exhausted' }
  | { kind: 'files-exhausted' }
  | { kind: 'unreadable-directory'; absolutePath: string; relativePath: string; error: unknown };

interface BoundedWalkState {
  counters: BoundedWalkCounters;
  emittedEntriesExhausted: boolean;
  emittedFilesExhausted: boolean;
  stopped: boolean;
}

/**
 * Bounded, symlink-safe directory walk shared by discovery, source-docs,
 * source-truth, and source-verification. The generator owns the mechanics
 * (listing, deterministic ordering, global budgets, depth pruning, symlink
 * refusal); each caller owns the policy, deciding per event whether to warn,
 * throw, record, or stop.
 *
 * Depth convention: `depth` is the number of path segments in `relativePath`,
 * so entries directly inside `root` are at depth 1. A directory entry is
 * descended into while its depth is <= `maxDepth`, and yields `depth-pruned`
 * once its depth exceeds it. With maxDepth 8 the deepest directory listed sits
 * 8 levels below the root and its children are pruned, which is what the
 * per-module walkers this replaces did with their own `depth >= maxDepth`
 * check against a parent-relative counter.
 *
 * Budgets are global across the whole walk, and `counters` (when supplied) is
 * mutated live so callers can report the same visited totals they always have.
 * `entries-exhausted` and `files-exhausted` each fire at most once. Once the
 * entry budget is consumed the current directory listing is still delivered but
 * no already-listed subdirectory is descended into, and the walk ends when that
 * directory is done. The file budget does not stop the walk: file events keep
 * coming and the caller decides what to do with them.
 *
 * `relativePath` uses platform separators; callers apply their own report
 * normalization.
 */
export async function* walkBoundedDirectoryTree(
  options: BoundedWalkOptions
): AsyncGenerator<TraversalEvent, void, undefined> {
  const state: BoundedWalkState = {
    counters: options.counters ?? { visitedEntries: 0, visitedFiles: 0 },
    emittedEntriesExhausted: false,
    emittedFilesExhausted: false,
    stopped: false,
  };

  yield* walkBoundedDirectory(options.root, 0, options, state);
}

async function* walkBoundedDirectory(
  directoryPath: string,
  depth: number,
  options: BoundedWalkOptions,
  state: BoundedWalkState
): AsyncGenerator<TraversalEvent, void, undefined> {
  const remainingEntries = options.maxEntries - state.counters.visitedEntries;

  if (remainingEntries <= 0) {
    if (!state.emittedEntriesExhausted) {
      state.emittedEntriesExhausted = true;
      yield { kind: 'entries-exhausted' };
    }

    state.stopped = true;
    return;
  }

  let listing: Dirent[];

  try {
    listing = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    yield {
      kind: 'unreadable-directory',
      absolutePath: directoryPath,
      relativePath: relative(options.root, directoryPath),
      error,
    };
    return;
  }

  // Sort BEFORE applying the entry budget so a truncated directory retains the
  // lexicographically-first N entries deterministically, rather than whichever
  // N the filesystem happened to return first.
  listing.sort((a, b) => compareStringsByCodeUnit(a.name, b.name));

  const entryBudgetExhausted = listing.length > remainingEntries;
  const entries = entryBudgetExhausted ? listing.slice(0, remainingEntries) : listing;

  state.counters.visitedEntries += entries.length;

  if (entryBudgetExhausted && !state.emittedEntriesExhausted) {
    state.emittedEntriesExhausted = true;
    yield { kind: 'entries-exhausted' };
  }

  for (const entry of entries) {
    const absolutePath = join(directoryPath, entry.name);
    const relativePath = relative(options.root, absolutePath);
    const entryDepth = depth + 1;

    if (entry.isSymbolicLink()) {
      yield { kind: 'symlink', absolutePath, relativePath, depth: entryDepth };
      continue;
    }

    if (entry.isDirectory()) {
      if (options.skipDirectoryNames && isSkippedTraversalDirectory(entry.name)) {
        yield { kind: 'skipped-directory', absolutePath, relativePath, depth: entryDepth };
        continue;
      }

      if (entryBudgetExhausted) {
        continue;
      }

      if (entryDepth > options.maxDepth) {
        yield { kind: 'depth-pruned', absolutePath, relativePath, depth: entryDepth };
        continue;
      }

      yield* walkBoundedDirectory(absolutePath, entryDepth, options, state);

      if (state.stopped) {
        return;
      }

      continue;
    }

    if (entry.isFile()) {
      if (state.counters.visitedFiles >= options.maxFiles) {
        if (!state.emittedFilesExhausted) {
          state.emittedFilesExhausted = true;
          yield { kind: 'files-exhausted' };
        }
      } else {
        state.counters.visitedFiles++;
      }

      yield { kind: 'file', absolutePath, relativePath, entry, depth: entryDepth };
    }
  }

  if (entryBudgetExhausted) {
    state.stopped = true;
  }
}

/**
 * Unbounded recursive file search used by the format parsers, which inspect a
 * documentation directory the human named explicitly rather than a bounded
 * local inspection. No depth cap, no skip list, and symlinks are silently
 * dropped (a symlink dirent is neither a directory nor a file here, so it is
 * never followed). Read errors propagate to the caller.
 */
export async function findFilesRecursively(
  dirPath: string,
  matchesFile: (fileName: string) => boolean
): Promise<string[]> {
  const results: string[] = [];
  const entries = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) =>
    compareStringsByCodeUnit(a.name, b.name)
  );

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      results.push(...(await findFilesRecursively(fullPath, matchesFile)));
    } else if (entry.isFile() && matchesFile(entry.name)) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Detection counterpart to findFilesRecursively: stops at the first match
 * instead of collecting every path. Same unbounded, symlink-dropping semantics.
 */
export async function directoryContainsMatchingFile(
  dirPath: string,
  matchesFile: (fileName: string) => boolean
): Promise<boolean> {
  const entries = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) =>
    compareStringsByCodeUnit(a.name, b.name)
  );

  for (const entry of entries) {
    if (entry.isFile() && matchesFile(entry.name)) {
      return true;
    }

    if (
      entry.isDirectory() &&
      (await directoryContainsMatchingFile(join(dirPath, entry.name), matchesFile))
    ) {
      return true;
    }
  }

  return false;
}
