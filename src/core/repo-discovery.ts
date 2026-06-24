import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  DISCOVERY_REPORT_SCHEMA_VERSION,
  type DiscoveryCandidate,
  type DiscoverySourceType,
  type DiscoveryTraversalSettings,
  inspectLocalSource,
  isUrlLikeInput,
} from './discovery.js';

const execFileAsync = promisify(execFile);

export const REPO_BOUNDED_INSPECTION_MODE = 'repo-bounded-inspection';
export const DEFAULT_REPO_CACHE_ROOT = join(homedir(), '.explore', 'repos');

export interface DiscoverRepoOptions {
  repo: string;
  scope?: string;
  cacheDir?: string;
  outputDir?: string;
  maxDepth?: number;
  maxEntries?: number;
  maxFiles?: number;
}

export interface RepoGitState {
  remoteUrl: string | null;
  commit: string | null;
  dirty: boolean | null;
  status: string[];
}

export interface RepoUpdateState {
  attempted: boolean;
  successful: boolean | null;
  skippedReason?: string;
  error?: string;
}

export interface RepoDiscoveryReport {
  schemaVersion: typeof DISCOVERY_REPORT_SCHEMA_VERSION;
  mode: typeof REPO_BOUNDED_INSPECTION_MODE;
  generatedAt: string;
  repo: {
    input: string;
    normalizedInput: string;
    cacheDir: string;
    cacheKey: string;
    cachePath: string;
    cloned: boolean;
    existingCache: boolean;
    git: RepoGitState;
    update: RepoUpdateState;
  };
  scope: {
    input: string;
    path: string;
    resolvedPath: string;
    type: DiscoverySourceType;
  };
  output: {
    reportPath: string;
  };
  traversal: DiscoveryTraversalSettings;
  candidates: DiscoveryCandidate[];
  warnings: string[];
}

export interface DiscoverRepoResult {
  report: RepoDiscoveryReport;
  reportPath: string;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export async function discoverRepo(options: DiscoverRepoOptions): Promise<DiscoverRepoResult> {
  const normalizedInput = await normalizeRepoInput(options.repo);
  const cacheDir = resolve(expandHomePath(options.cacheDir ?? DEFAULT_REPO_CACHE_ROOT));
  const cacheKey = cacheKeyForRepo(normalizedInput);
  const cachePath = join(cacheDir, cacheKey);
  const warnings: string[] = [];
  let cloned = false;
  let existingCache = false;
  let update: RepoUpdateState = { attempted: false, successful: null };

  await mkdir(cacheDir, { recursive: true });

  if (await pathExists(cachePath)) {
    existingCache = true;
    await ensureGitCheckout(cachePath);
    const preUpdateGit = await readGitState(cachePath, warnings);

    if (!remoteMatchesRequestedRepo(preUpdateGit.remoteUrl, normalizedInput)) {
      warnings.push(
        'Cached repo remote does not match requested repo; update skipped and current checkout inspected.'
      );
      update = { attempted: false, successful: null, skippedReason: 'remote-mismatch' };
    } else if (preUpdateGit.dirty === true) {
      warnings.push(
        'Cached repo has local changes or ignored files; update skipped and current checkout inspected.'
      );
      update = { attempted: false, successful: null, skippedReason: 'dirty-cache' };
    } else if (preUpdateGit.dirty === null) {
      warnings.push(
        'Cached repo clean state could not be confirmed; update skipped and current checkout inspected.'
      );
      update = { attempted: false, successful: null, skippedReason: 'unknown-cache-state' };
    } else {
      update = await updateExistingCache(cachePath, warnings);
    }
  } else {
    await cloneRepo(normalizedInput, cachePath);
    cloned = true;
  }

  const git = await readGitState(cachePath, warnings);
  const scopeInput = options.scope ?? '.';
  const scopePath = resolveScopePath(cachePath, scopeInput);

  if (!isInsideOrSame(cachePath, scopePath)) {
    throw new Error(`scope path must stay inside the cached repository: ${scopeInput}`);
  }

  const realCachePath = await realpath(cachePath);
  const realScopePath = await realpathOrNull(scopePath);

  if (realScopePath === null) {
    throw new Error(`scope path not found or cannot be read: ${scopePath}`);
  }

  if (!isInsideOrSame(realCachePath, realScopePath)) {
    throw new Error(`scope path must stay inside the cached repository: ${scopeInput}`);
  }

  const inspectionOptions: Parameters<typeof inspectLocalSource>[0] = { source: scopePath };

  if (options.maxDepth !== undefined) {
    inspectionOptions.maxDepth = options.maxDepth;
  }

  if (options.maxEntries !== undefined) {
    inspectionOptions.maxEntries = options.maxEntries;
  }

  if (options.maxFiles !== undefined) {
    inspectionOptions.maxFiles = options.maxFiles;
  }

  const inspection = await inspectLocalSource(inspectionOptions);
  const outputDir =
    options.outputDir === undefined
      ? defaultOutputDirForRepoCache(cachePath)
      : resolve(expandHomePath(options.outputDir));
  const reportPath = join(outputDir, 'discovery-report.json');
  const report: RepoDiscoveryReport = {
    schemaVersion: DISCOVERY_REPORT_SCHEMA_VERSION,
    mode: REPO_BOUNDED_INSPECTION_MODE,
    generatedAt: new Date().toISOString(),
    repo: {
      input: options.repo,
      normalizedInput,
      cacheDir,
      cacheKey,
      cachePath,
      cloned,
      existingCache,
      git,
      update,
    },
    scope: {
      input: scopeInput,
      path: scopePathToReportPath(cachePath, scopePath),
      resolvedPath: inspection.source.resolvedPath,
      type: inspection.source.type,
    },
    output: {
      reportPath,
    },
    traversal: inspection.traversal,
    candidates: inspection.candidates,
    warnings: [...warnings, ...inspection.warnings],
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

  return { report, reportPath };
}

async function normalizeRepoInput(repo: string): Promise<string> {
  const trimmed = repo.trim();

  if (trimmed === '') {
    throw new Error('Repo input is required.');
  }

  if (isUrlLikeInput(trimmed)) {
    return trimmed;
  }

  const resolvedPath = resolve(expandHomePath(trimmed));

  if (!(await pathExists(resolvedPath))) {
    throw new Error(`repository path not found or cannot be read: ${resolvedPath}`);
  }

  const topLevel = await git(['-C', resolvedPath, 'rev-parse', '--show-toplevel']).catch(
    (error: unknown) => {
      throw new Error(`repository path is not a git repository: ${resolvedPath}`, {
        cause: error,
      });
    }
  );

  return topLevel.stdout.trim();
}

async function ensureGitCheckout(path: string): Promise<void> {
  const stats = await lstat(path);

  if (!stats.isDirectory()) {
    throw new Error(`cache path exists but is not a directory: ${path}`);
  }

  await git(['-C', path, 'rev-parse', '--is-inside-work-tree']).catch((error: unknown) => {
    throw new Error(`cache path exists but is not a git repository: ${path}`, { cause: error });
  });
}

async function cloneRepo(repo: string, cachePath: string): Promise<void> {
  try {
    await git(['clone', '--', repo, cachePath]);
  } catch (error) {
    throw new Error(`failed to clone repository into cache: ${formatGitError(error)}`);
  }
}

async function updateExistingCache(path: string, warnings: string[]): Promise<RepoUpdateState> {
  try {
    await git(['-C', path, 'fetch', '--tags', '--prune', 'origin']);
    return { attempted: true, successful: true };
  } catch (error) {
    const message = formatGitError(error);
    warnings.push(`Cached repo fetch failed; current checkout inspected. ${message}`);
    return { attempted: true, successful: false, error: message };
  }
}

async function readGitState(path: string, warnings: string[]): Promise<RepoGitState> {
  const remoteUrl = await gitTextOrNull(path, ['remote', 'get-url', 'origin'], warnings);
  const commit = await gitTextOrNull(path, ['rev-parse', 'HEAD'], warnings);
  const statusResult = await git([
    '-C',
    path,
    'status',
    '--short',
    '--ignored',
    '--untracked-files=all',
  ]).catch((error: unknown) => {
    warnings.push(`Could not read cached repo status. ${formatGitError(error)}`);
    return undefined;
  });
  const status =
    statusResult === undefined
      ? []
      : statusResult.stdout
          .split('\n')
          .map((line) => line.trimEnd())
          .filter((line) => line !== '');
  const dirty = statusResult === undefined ? null : status.length > 0;

  return {
    remoteUrl,
    commit,
    dirty,
    status,
  };
}

async function gitTextOrNull(
  path: string,
  args: string[],
  warnings: string[]
): Promise<string | null> {
  try {
    const result = await git(['-C', path, ...args]);
    const text = result.stdout.trim();

    return text === '' ? null : text;
  } catch (error) {
    warnings.push(`Could not read cached repo git metadata. ${formatGitError(error)}`);
    return null;
  }
}

async function git(args: string[]): Promise<GitCommandResult> {
  const result = await execFileAsync('git', args, {
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function resolveScopePath(cachePath: string, scopeInput: string): string {
  if (scopeInput.trim() === '') {
    throw new Error('Scope path is required when --scope is provided.');
  }

  if (isAbsolute(scopeInput)) {
    throw new Error(`scope path must be repo-relative: ${scopeInput}`);
  }

  return resolve(cachePath, scopeInput);
}

function scopePathToReportPath(cachePath: string, scopePath: string): string {
  const relativePath = relative(cachePath, scopePath);

  if (relativePath === '') {
    return '.';
  }

  return normalizePathForReport(relativePath);
}

function defaultOutputDirForRepoCache(cachePath: string): string {
  return join(dirname(cachePath), `${basename(cachePath)}-discovery`);
}

function cacheKeyForRepo(normalizedInput: string): string {
  const base = cacheBaseNameForRepo(normalizedInput);
  const digest = createHash('sha256').update(normalizedInput).digest('hex').slice(0, 12);

  return `${base}--${digest}`;
}

function cacheBaseNameForRepo(normalizedInput: string): string {
  const githubSshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(normalizedInput);

  if (githubSshMatch?.[1] !== undefined && githubSshMatch[2] !== undefined) {
    return sanitizeCachePart(`${githubSshMatch[1]}__${githubSshMatch[2]}`);
  }

  try {
    const url = new URL(normalizedInput);
    const pathParts = url.pathname
      .replace(/\.git$/i, '')
      .split('/')
      .filter((part) => part !== '');

    if (pathParts.length >= 2) {
      return sanitizeCachePart(`${pathParts.at(-2)}__${pathParts.at(-1)}`);
    }
  } catch {
    // Local paths and scp-like git inputs are handled below.
  }

  return sanitizeCachePart(basename(normalizedInput.replace(/\.git$/i, '')) || 'repo');
}

function sanitizeCachePart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');

  return (sanitized || 'repo').slice(0, 80);
}

function remoteMatchesRequestedRepo(remoteUrl: string | null, normalizedInput: string): boolean {
  return remoteUrl === normalizedInput;
}

function expandHomePath(path: string): string {
  if (path === '~') {
    return homedir();
  }

  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

function isInsideOrSame(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath);

  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function normalizePathForReport(path: string): string {
  return path.split(/[\\/]+/).join('/');
}

function formatGitError(error: unknown): string {
  if (error instanceof Error) {
    const maybeExecError = error as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
    const stderr = maybeExecError.stderr?.toString().trim();
    const stdout = maybeExecError.stdout?.toString().trim();

    return stderr || stdout || error.message;
  }

  return String(error);
}
