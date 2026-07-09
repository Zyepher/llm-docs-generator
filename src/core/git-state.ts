/**
 * Deterministic VCS-provenance capture for `generate --source`. Given the
 * resolved source path, records the enclosing git repository's identity
 * (origin remote, HEAD commit, tags pointing at HEAD, dirty state, and the
 * source path relative to the repo root). A non-git source yields undefined
 * and is never an error: the engine records facts, it does not require them.
 */

import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { promisify } from 'node:util';

import { compareStringsByCodeUnit } from '../utils/sort.js';
import type { GenerateSourceGitContext } from './source-docs.js';

const execFileAsync = promisify(execFile);

// Upper bound for any single git invocation. With GIT_TERMINAL_PROMPT=0 git
// fails fast on auth prompts, so this is a secondary safety net.
const GIT_COMMAND_TIMEOUT_MS = 300_000;

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export async function captureGitState(
  resolvedSourcePath: string
): Promise<GenerateSourceGitContext | undefined> {
  const gitCwd = await gitCwdForSource(resolvedSourcePath);

  if (gitCwd === undefined) {
    return undefined;
  }

  const repoRoot = await gitTextOrUndefined(gitCwd.dir, ['rev-parse', '--show-toplevel']);

  if (repoRoot === undefined) {
    // Not inside a git work tree, or git is unavailable. Record no VCS identity.
    return undefined;
  }

  const commit = await gitTextOrUndefined(gitCwd.dir, ['rev-parse', 'HEAD']);

  if (commit === undefined) {
    // A repository with no commit yet has no HEAD provenance to record.
    return undefined;
  }

  const showPrefix = (await gitTextOrUndefined(gitCwd.dir, ['rev-parse', '--show-prefix'])) ?? '';
  const remoteRaw = await gitTextOrUndefined(gitCwd.dir, ['remote', 'get-url', 'origin']);
  const remoteUrl = remoteRaw === undefined ? null : scrubUrlCredentials(remoteRaw);
  const tags = (await gitLines(gitCwd.dir, ['tag', '--points-at', 'HEAD'])).sort(
    compareStringsByCodeUnit
  );
  const status = await gitLines(repoRoot, ['status', '--porcelain']);

  return {
    remoteUrl,
    commit,
    tags,
    dirty: status.length > 0,
    sourceRootFromRepo: sourceRootFromRepo(showPrefix, gitCwd.isDirectory, resolvedSourcePath),
  };
}

function sourceRootFromRepo(
  showPrefix: string,
  isDirectory: boolean,
  resolvedSourcePath: string
): string {
  // git rev-parse --show-prefix yields the run directory relative to the repo
  // root with POSIX separators and a trailing slash (empty at the root). For a
  // file source git runs in the file's parent, so append the file name.
  const prefix = showPrefix.replace(/\/+$/, '');
  const relativePath = isDirectory
    ? prefix
    : prefix === ''
      ? basename(resolvedSourcePath)
      : `${prefix}/${basename(resolvedSourcePath)}`;

  return relativePath === '' ? '.' : relativePath;
}

async function gitCwdForSource(
  resolvedSourcePath: string
): Promise<{ dir: string; isDirectory: boolean } | undefined> {
  let stats: Awaited<ReturnType<typeof lstat>>;

  try {
    stats = await lstat(resolvedSourcePath);
  } catch {
    return undefined;
  }

  if (stats.isDirectory()) {
    return { dir: resolvedSourcePath, isDirectory: true };
  }

  if (stats.isFile()) {
    return { dir: dirname(resolvedSourcePath), isDirectory: false };
  }

  return undefined;
}

async function gitTextOrUndefined(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await git(cwd, args);
    const text = result.stdout.trim();

    return text === '' ? undefined : text;
  } catch {
    return undefined;
  }
}

async function gitLines(cwd: string, args: string[]): Promise<string[]> {
  try {
    const result = await git(cwd, args);

    return result.stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line !== '');
  } catch {
    return [];
  }
}

async function git(cwd: string, args: string[]): Promise<GitCommandResult> {
  const result = await execFileAsync('git', ['-c', 'protocol.ext.allow=never', '-C', cwd, ...args], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    env: {
      ...process.env,
      // Keep git non-interactive and scriptable: never block on a terminal
      // credential prompt (fail fast instead) and never spawn an askpass helper.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      GCM_INTERACTIVE: 'never',
    },
  });

  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/**
 * Remove embedded userinfo (user:token@) from an origin URL so a credential
 * that a developer baked into their remote is never persisted to the manifest.
 * scp-like inputs (git@host:path) carry no secret and are returned unchanged.
 */
function scrubUrlCredentials(value: string): string {
  try {
    const url = new URL(value);

    if (url.username !== '' || url.password !== '') {
      url.username = '';
      url.password = '';

      return url.toString();
    }
  } catch {
    // Not a standard URL (for example scp-like git@host:path); nothing to scrub.
  }

  return value;
}
