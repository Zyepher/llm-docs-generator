/**
 * CLI regression tests for documented compatibility commands.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverLocalSources } from '../../src/core/discovery.js';
import { discoverRepo } from '../../src/core/repo-discovery.js';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = join(repoRoot, 'src/cli.ts');
const tsxBin = join(
  repoRoot,
  'node_modules/.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
);

const tempDirs: string[] = [];
interface ManifestFileEntry {
  path: string;
  kind: string;
  byteSize: number;
  hash: string;
}

interface GenerationManifest {
  schemaVersion: string;
  generatedAt: string;
  generator: {
    name: string;
    version: string;
    cliName: string;
  };
  mode: string;
  sdk: {
    name: string;
    resolvedVersion: string;
    displayName: string;
  };
  source: {
    configuredUrl: string;
    configuredLocalPath: string | null;
    resolvedSpecPath: string;
    format: string;
    byteSize: number;
    contentHash: string;
  };
  parser: {
    name: string;
    version: string;
    format: string;
  };
  formatter: {
    name: string;
    version: string;
    format: string;
  };
  generatedOutputs: ManifestFileEntry[];
  warnings: string[];
}

interface DiscoveryCandidate {
  path: string;
  resolvedPath: string;
  kind: string;
  format: string;
  hints: string[];
  formatHints: string[];
  byteSize: number;
  sha256: string;
}

interface DiscoveryReport {
  schemaVersion: string;
  mode: string;
  generatedAt: string;
  source: {
    input: string;
    resolvedPath: string;
    type: string;
  };
  output: {
    reportPath: string;
  };
  traversal: {
    followSymlinks: false;
    maxDepth: number;
    maxEntries: number;
    maxFiles: number;
    skippedDirectoryNames: string[];
    visitedEntries: number;
    visitedFiles: number;
    candidateCount: number;
    truncated: boolean;
  };
  candidates: DiscoveryCandidate[];
  warnings: string[];
}

interface RepoDiscoveryReport {
  schemaVersion: string;
  mode: string;
  generatedAt: string;
  repo: {
    input: string;
    normalizedInput: string;
    cacheDir: string;
    cacheKey: string;
    cachePath: string;
    cloned: boolean;
    existingCache: boolean;
    git: {
      remoteUrl: string | null;
      commit: string | null;
      dirty: boolean | null;
      status: string[];
    };
    update: {
      attempted: boolean;
      successful: boolean | null;
      skippedReason?: string;
      error?: string;
    };
  };
  scope: {
    input: string;
    path: string;
    resolvedPath: string;
    type: string;
  };
  output: {
    reportPath: string;
  };
  traversal: DiscoveryReport['traversal'];
  candidates: DiscoveryCandidate[];
  warnings: string[];
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const testSpecYaml = [
  'info:',
  '  id: swift',
  '  title: Supabase Swift SDK',
  '  description: Test fixture',
  'functions:',
  '  - id: select',
  '    title: Select data',
  '    description: Read rows',
  '    examples:',
  '      - id: select-basic',
  '        name: Basic select',
  '        code: supabase.from("todos").select()',
  '',
].join('\n');

async function createTestConfig(versionOrder: Array<'v1' | 'v2'> = ['v2', 'v1']): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-cli-'));
  tempDirs.push(dir);

  const specPath = join(dir, 'supabase_swift_v2.yml');
  await writeFile(specPath, testSpecYaml, 'utf-8');

  const versions = Object.fromEntries(
    versionOrder.map((version) => [
      version,
      {
        displayName: `Supabase Swift SDK ${version}`,
        spec: {
          url: `http://127.0.0.1:9/supabase_swift_${version}.yml`,
          localPath: specPath,
          format: 'openref-0.1',
        },
        output: {
          baseDir: 'swift',
          filenamePrefix: `supabase-swift-${version}`,
        },
      },
    ])
  );

  await writeFile(
    join(dir, 'sdks.json'),
    JSON.stringify(
      {
        sdks: {
          swift: {
            name: 'Swift',
            language: 'swift',
            versions,
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  await writeFile(
    join(dir, 'categories.json'),
    JSON.stringify(
      {
        categories: {
          database: {
            title: 'Database',
            description: 'Database operations',
            systemPrompt: 'Database operations for {sdk_name}.',
            operations: ['select'],
            order: 1,
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  return dir;
}

async function runCli(args: string[], cwd = repoRoot): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(tsxBin, [cliPath, ...args], {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
  });

  return { stdout, stderr };
}

async function runCliWithExit(args: string[], cwd = repoRoot): Promise<CliResult> {
  try {
    const { stdout, stderr } = await runCli(args, cwd);
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const execError = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string | null;
    };

    return {
      stdout: execError.stdout?.toString() ?? '',
      stderr: execError.stderr?.toString() ?? '',
      exitCode: typeof execError.code === 'number' ? execError.code : null,
    };
  }
}

async function sha256File(path: string): Promise<string> {
  const content = await readFile(path);
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

async function sha256FileHex(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}

async function byteSize(path: string): Promise<number> {
  const fileStats = await stat(path);
  return fileStats.size;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });

  return stdout.toString().trim();
}

async function createLocalGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-repo-source-'));
  tempDirs.push(dir);

  await git(['init'], dir);
  await mkdir(join(dir, 'docs'), { recursive: true });
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'README.md'), '# Root\n', 'utf-8');
  await writeFile(join(dir, 'docs/guide.md'), '# Guide\n', 'utf-8');
  await writeFile(join(dir, 'docs/openapi.json'), '{"openapi":"3.1.0"}\n', 'utf-8');
  await writeFile(join(dir, 'src/ignored.ts'), 'export const value = 1;\n', 'utf-8');
  await git(['add', '.'], dir);
  await git(
    [
      '-c',
      'user.email=tests@example.com',
      '-c',
      'user.name=Tests',
      'commit',
      '-m',
      'Initial fixture',
    ],
    dir
  );

  return dir;
}

async function findManifestFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const entryPath = join(root, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await findManifestFiles(entryPath)));
    } else if (entry.name === 'manifest.json') {
      found.push(entryPath);
    }
  }

  return found.sort(compareStringsByCodeUnit);
}

async function generateSwiftFixture(): Promise<{
  configDir: string;
  outputDir: string;
  manifestPath: string;
}> {
  const configDir = await createTestConfig();
  const outputDir = join(configDir, 'output');

  await runCli([
    'generate',
    '--sdk',
    'swift',
    '--sdk-version',
    'v2',
    '--config-dir',
    configDir,
    '--output-dir',
    outputDir,
  ]);

  return {
    configDir,
    outputDir: join(outputDir, 'swift/v2'),
    manifestPath: join(outputDir, 'swift/v2/manifest.json'),
  };
}

function compareStringsByCodeUnit(a: string, b: string): number {
  const length = Math.min(a.length, b.length);

  for (let index = 0; index < length; index++) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);

    if (difference !== 0) {
      return difference;
    }
  }

  return a.length - b.length;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('CLI compatibility behavior', () => {
  it('ships built-in SDK config without default local spec paths', async () => {
    const config = JSON.parse(await readFile(join(repoRoot, 'config/sdks.json'), 'utf-8')) as {
      sdks: Record<
        string,
        {
          versions: Record<string, { spec: { localPath: string | null } }>;
        }
      >;
    };

    const offenders = Object.entries(config.sdks)
      .flatMap(([sdkName, sdk]) =>
        Object.entries(sdk.versions).flatMap(([version, versionConfig]) => ({
          sdkName,
          version,
          localPath: versionConfig.spec.localPath,
        }))
      )
      .filter(({ localPath }) => localPath !== null);

    const offenderMessages = offenders.map(
      ({ sdkName, version, localPath }) => `${sdkName}@${version}: ${String(localPath)}`
    );

    expect(Object.keys(config.sdks).length).toBeGreaterThan(0);
    expect(offenderMessages).toEqual([]);
  });

  it('keeps the root --version option available', async () => {
    const { stdout } = await runCli(['--version']);

    expect(stdout.trim()).toBe('1.0.0');
  });

  it('treats validate --version as the SDK version option', async () => {
    const configDir = await createTestConfig();

    const { stdout } = await runCli([
      'validate',
      '--sdk',
      'swift',
      '--version',
      'v2',
      '--config-dir',
      configDir,
    ]);

    expect(stdout).toContain('Validating swift v2');
    expect(stdout).toContain('Validation successful!');
    expect(stdout).toContain('Version: v2');
    expect(stdout).toContain('Operations: 1');
    expect(stdout).toContain('Examples: 1');
    expect(stdout.trim()).not.toBe('1.0.0');
    expect(await findManifestFiles(configDir)).toEqual([]);
  });

  it('lists SDKs from a supplied config directory', async () => {
    const configDir = await createTestConfig();

    const { stdout } = await runCli(['list-sdks', '--config-dir', configDir]);

    expect(stdout).toContain('Configured SDKs:');
    expect(stdout).toContain('swift');
    expect(stdout).toContain('Name: Swift');
    expect(stdout).toContain('Versions: v2, v1');
    expect(stdout).toContain('Total SDKs: 1');
    expect(await findManifestFiles(configDir)).toEqual([]);
  });

  it('writes a bounded local discovery report with stable candidate ordering and hints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-discover-'));
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'reports');
    await mkdir(join(sourceDir, 'docs'), { recursive: true });
    await mkdir(join(sourceDir, 'guide.docc'), { recursive: true });
    await mkdir(join(sourceDir, 'spec'), { recursive: true });
    await mkdir(join(sourceDir, 'node_modules/pkg'), { recursive: true });
    await mkdir(join(sourceDir, 'dist'), { recursive: true });
    await writeFile(join(sourceDir, 'docs/reference.md'), '# Reference\n', 'utf-8');
    await writeFile(join(sourceDir, 'docs/components.mdx'), '# Components\n', 'utf-8');
    await writeFile(join(sourceDir, 'guide.docc/Tutorial.md'), '# Tutorial\n', 'utf-8');
    await writeFile(join(sourceDir, 'index.html'), '<h1>Home</h1>\n', 'utf-8');
    await writeFile(join(sourceDir, 'readme.rst'), 'Readme\n======\n', 'utf-8');
    await writeFile(join(sourceDir, 'spec/openapi.json'), '{"openapi":"3.1.0"}\n', 'utf-8');
    await writeFile(join(sourceDir, 'spec/openref.yml'), 'functions: []\n', 'utf-8');
    await writeFile(join(sourceDir, 'node_modules/pkg/ignored.md'), '# Ignored\n', 'utf-8');
    await writeFile(join(sourceDir, 'dist/ignored.md'), '# Ignored\n', 'utf-8');

    const { stdout } = await runCli(['discover', '--source', sourceDir, '--output-dir', outputDir]);
    const reportPath = join(outputDir, 'discovery-report.json');
    const reportText = await readFile(reportPath, 'utf-8');
    const report = JSON.parse(reportText) as DiscoveryReport;

    expect(stdout).toContain('Local source discovery');
    expect(stdout).toContain('Candidate files: 7');
    expect(stdout).toContain(`Report: ${reportPath}`);
    expect(reportText.endsWith('\n')).toBe(true);
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
    expect(report).toMatchObject({
      schemaVersion: '0.1.0',
      mode: 'local-bounded-inspection',
      source: {
        input: sourceDir,
        resolvedPath: sourceDir,
        type: 'directory',
      },
      output: {
        reportPath,
      },
      traversal: {
        followSymlinks: false,
        maxDepth: 8,
        maxEntries: 20000,
        maxFiles: 5000,
        candidateCount: 7,
        truncated: false,
      },
    });
    expect(report.traversal.skippedDirectoryNames).toContain('node_modules');
    expect(report.candidates.map((candidate) => candidate.path)).toEqual([
      'docs/components.mdx',
      'docs/reference.md',
      'guide.docc/Tutorial.md',
      'index.html',
      'readme.rst',
      'spec/openapi.json',
      'spec/openref.yml',
    ]);
    expect(report.candidates.map((candidate) => candidate.kind)).toEqual([
      'mdx',
      'markdown',
      'docc',
      'html',
      'rst',
      'openapi-json',
      'openref-yaml',
    ]);
    expect(report.candidates[2]?.formatHints).toEqual(['docc-marker', 'markdown']);
    expect(report.candidates[5]?.formatHints).toEqual(['json', 'openapi-json']);
    expect(report.candidates[6]?.formatHints).toEqual(['openref-yaml', 'yaml']);

    const referencePath = join(sourceDir, 'docs/reference.md');
    const referenceCandidate = report.candidates.find(
      (candidate) => candidate.path === 'docs/reference.md'
    );
    expect(referenceCandidate?.byteSize).toBe(await byteSize(referencePath));
    expect(referenceCandidate?.sha256).toBe(await sha256FileHex(referencePath));
    expect(report.candidates.some((candidate) => candidate.path.includes('ignored'))).toBe(false);
    expect(report.warnings).toContain('Skipped directory by default: dist');
    expect(report.warnings).toContain('Skipped directory by default: node_modules');
  });

  it('supports an explicit local file source without defaulting output inside the source path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-discover-file-'));
    tempDirs.push(dir);

    const sourcePath = join(dir, 'openapi.yaml');
    await writeFile(sourcePath, 'openapi: 3.1.0\n', 'utf-8');

    const { stdout } = await runCli(['discover', '--source', sourcePath]);
    const reportPath = join(dir, 'openapi.yaml-discovery/discovery-report.json');
    const report = JSON.parse(await readFile(reportPath, 'utf-8')) as DiscoveryReport;

    expect(stdout).toContain('Candidate files: 1');
    expect(stdout).toContain(`Report: ${reportPath}`);
    expect(report.source).toMatchObject({
      input: sourcePath,
      resolvedPath: sourcePath,
      type: 'file',
    });
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]).toMatchObject({
      path: 'openapi.yaml',
      resolvedPath: sourcePath,
      kind: 'openapi-yaml',
      formatHints: ['openapi-yaml', 'yaml'],
      byteSize: await byteSize(sourcePath),
      sha256: await sha256FileHex(sourcePath),
    });
    expect(report.output.reportPath).toBe(reportPath);
    expect(dirname(report.output.reportPath)).not.toBe(dirname(sourcePath));
  });

  it('rejects missing local discovery sources with a non-zero exit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-discover-missing-'));
    tempDirs.push(dir);
    const missingPath = join(dir, 'missing-docs');

    const result = await runCliWithExit(['discover', '--source', missingPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Discovery failed: source path not found');
    expect(result.stderr).toContain(missingPath);
  });

  it('rejects a symbolic link as the local discovery source root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-discover-symlink-'));
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    const linkedSource = join(dir, 'linked-source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'guide.md'), '# Guide\n', 'utf-8');
    await symlink(sourceDir, linkedSource, 'dir');

    const result = await runCliWithExit(['discover', '--source', linkedSource]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Discovery failed: Source path must not be a symbolic link');
    expect(result.stderr).toContain(linkedSource);
  });

  it.each([
    'https://example.com/docs',
    'http://example.com/docs',
    'git@github.com:owner/repo.git',
    ' https://example.com/docs ',
  ])('rejects URL-like discovery source %s with a non-zero exit', async (source) => {
    const result = await runCliWithExit(['discover', '--source', source]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Discovery failed: discover --source accepts local file or directory paths only'
    );
  });

  it('does not make unsupported source authority claims in discovery output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-discover-claims-'));
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'reports');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'guide.md'), '# Guide\n', 'utf-8');

    const { stdout, stderr } = await runCli([
      'discover',
      '--source',
      sourceDir,
      '--output-dir',
      outputDir,
    ]);
    const reportText = await readFile(join(outputDir, 'discovery-report.json'), 'utf-8');
    const combinedOutput = `${stdout}\n${stderr}\n${reportText}`;

    expect(combinedOutput).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(combinedOutput).not.toMatch(/\bofficial\b/i);
    expect(combinedOutput).not.toMatch(/\bscore\b/i);
    expect(combinedOutput).not.toMatch(/\bselected\b/i);
  });

  it('clones a local git repo into an explicit cache and writes a repo discovery report', async () => {
    const repoDir = await createLocalGitRepo();
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-repo-discover-'));
    tempDirs.push(dir);

    const cacheDir = join(dir, 'cache');
    const outputDir = join(dir, 'reports');
    const { stdout } = await runCli([
      'discover',
      '--repo',
      repoDir,
      '--cache-dir',
      cacheDir,
      '--output-dir',
      outputDir,
    ]);
    const reportPath = join(outputDir, 'discovery-report.json');
    const reportText = await readFile(reportPath, 'utf-8');
    const report = JSON.parse(reportText) as RepoDiscoveryReport;

    expect(stdout).toContain('Repo discovery');
    expect(stdout).toContain(`Report: ${reportPath}`);
    expect(reportText.endsWith('\n')).toBe(true);
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
    expect(report).toMatchObject({
      schemaVersion: '0.1.0',
      mode: 'repo-bounded-inspection',
      repo: {
        input: repoDir,
        cacheDir,
        cloned: true,
        existingCache: false,
        git: {
          dirty: false,
          status: [],
        },
      },
      scope: {
        input: '.',
        path: '.',
        type: 'directory',
      },
      output: {
        reportPath,
      },
      traversal: {
        followSymlinks: false,
        maxDepth: 8,
        maxEntries: 20000,
        maxFiles: 5000,
        candidateCount: 3,
        truncated: false,
      },
    });
    expect(report.repo.normalizedInput.endsWith(basename(repoDir))).toBe(true);
    expect(report.repo.git.remoteUrl?.endsWith(basename(repoDir))).toBe(true);
    expect(report.repo.cachePath.startsWith(`${cacheDir}/`)).toBe(true);
    expect(await pathExists(join(report.repo.cachePath, '.git'))).toBe(true);
    expect(report.repo.cachePath.startsWith(repoRoot)).toBe(false);
    expect(report.repo.git.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(report.warnings).toContain('Skipped directory by default: .git');
    expect(report.candidates.map((candidate) => candidate.path)).toEqual([
      'README.md',
      'docs/guide.md',
      'docs/openapi.json',
    ]);
    expect(report.candidates[0]?.resolvedPath.startsWith(report.repo.cachePath)).toBe(true);
  });

  it('inspects only the requested repo scope path', async () => {
    const repoDir = await createLocalGitRepo();
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-repo-scope-'));
    tempDirs.push(dir);

    const outputDir = join(dir, 'reports');
    await runCli([
      'discover',
      '--repo',
      repoDir,
      '--scope',
      'docs',
      '--cache-dir',
      join(dir, 'cache'),
      '--output-dir',
      outputDir,
    ]);
    const report = JSON.parse(
      await readFile(join(outputDir, 'discovery-report.json'), 'utf-8')
    ) as RepoDiscoveryReport;

    expect(report.scope).toMatchObject({
      input: 'docs',
      path: 'docs',
      type: 'directory',
    });
    expect(report.scope.resolvedPath).toBe(join(report.repo.cachePath, 'docs'));
    expect(report.candidates.map((candidate) => candidate.path)).toEqual([
      'guide.md',
      'openapi.json',
    ]);
  });

  it('fetches clean existing caches without changing checkout or inspected candidates', async () => {
    const repoDir = await createLocalGitRepo();
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-repo-fetch-only-cache-'));
    tempDirs.push(dir);

    const cacheDir = join(dir, 'cache');
    const first = await discoverRepo({
      repo: repoDir,
      cacheDir,
      outputDir: join(dir, 'reports-first'),
    });
    const firstCommit = first.report.repo.git.commit;
    const firstCandidatePaths = first.report.candidates.map((candidate) => candidate.path);
    const branchName = await gitOutput(['branch', '--show-current'], repoDir);

    await writeFile(join(repoDir, 'docs/new.md'), '# New upstream docs\n', 'utf-8');
    await git(['add', 'docs/new.md'], repoDir);
    await git(
      [
        '-c',
        'user.email=tests@example.com',
        '-c',
        'user.name=Tests',
        'commit',
        '-m',
        'Add upstream docs',
      ],
      repoDir
    );
    const upstreamCommit = await gitOutput(['rev-parse', 'HEAD'], repoDir);

    const second = await discoverRepo({
      repo: repoDir,
      cacheDir,
      outputDir: join(dir, 'reports-second'),
    });
    const fetchedRemoteCommit = await gitOutput(
      ['rev-parse', `refs/remotes/origin/${branchName}`],
      second.report.repo.cachePath
    );

    expect(second.report.repo).toMatchObject({
      cloned: false,
      existingCache: true,
      git: {
        commit: firstCommit,
        dirty: false,
        status: [],
      },
      update: {
        attempted: true,
        successful: true,
      },
    });
    expect(second.report.candidates.map((candidate) => candidate.path)).toEqual(
      firstCandidatePaths
    );
    expect(second.report.candidates.map((candidate) => candidate.path)).not.toContain(
      'docs/new.md'
    );
    expect(fetchedRemoteCommit).toBe(upstreamCommit);
    expect(second.report.repo.git.commit).not.toBe(upstreamCommit);
  });

  it('fails clearly when the requested repo scope path is missing', async () => {
    const repoDir = await createLocalGitRepo();
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-repo-missing-scope-'));
    tempDirs.push(dir);

    const result = await runCliWithExit([
      'discover',
      '--repo',
      repoDir,
      '--scope',
      'missing-docs',
      '--cache-dir',
      join(dir, 'cache'),
      '--output-dir',
      join(dir, 'reports'),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Discovery failed: scope path not found or cannot be read');
    expect(result.stderr).toContain('missing-docs');
  });

  it('fails clearly when the requested repo scope escapes the cached repository', async () => {
    const repoDir = await createLocalGitRepo();
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-repo-escaping-scope-'));
    tempDirs.push(dir);

    const result = await runCliWithExit([
      'discover',
      '--repo',
      repoDir,
      '--scope',
      '../outside',
      '--cache-dir',
      join(dir, 'cache'),
      '--output-dir',
      join(dir, 'reports'),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Discovery failed: scope path must stay inside');
    expect(result.stderr).toContain('../outside');
  });

  it('fails clearly when repo scope escapes through an intermediate symlink component', async () => {
    const repoDir = await createLocalGitRepo();
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-repo-symlink-scope-escape-'));
    tempDirs.push(dir);

    const outsideDir = join(dir, 'outside');
    await mkdir(join(outsideDir, 'docs'), { recursive: true });
    await writeFile(join(outsideDir, 'docs/outside.md'), '# Outside\n', 'utf-8');
    await symlink(outsideDir, join(repoDir, 'link'), 'dir');
    await git(['add', 'link'], repoDir);
    await git(
      [
        '-c',
        'user.email=tests@example.com',
        '-c',
        'user.name=Tests',
        'commit',
        '-m',
        'Add symlink fixture',
      ],
      repoDir
    );

    const result = await runCliWithExit([
      'discover',
      '--repo',
      repoDir,
      '--scope',
      'link/docs',
      '--cache-dir',
      join(dir, 'cache'),
      '--output-dir',
      join(dir, 'reports'),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Discovery failed: scope path must stay inside');
    expect(result.stderr).toContain('link/docs');
  });

  it('fails clearly when repo scope is absolute instead of repo-relative', async () => {
    const repoDir = await createLocalGitRepo();
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-repo-absolute-scope-'));
    tempDirs.push(dir);

    const result = await runCliWithExit([
      'discover',
      '--repo',
      repoDir,
      '--scope',
      join(repoDir, 'docs'),
      '--cache-dir',
      join(dir, 'cache'),
      '--output-dir',
      join(dir, 'reports'),
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Discovery failed: scope path must be repo-relative');
    expect(result.stderr).toContain(join(repoDir, 'docs'));
  });

  it('warns and reuses a dirty cached repo without destructive cleanup', async () => {
    const repoDir = await createLocalGitRepo();
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-repo-dirty-cache-'));
    tempDirs.push(dir);

    const cacheDir = join(dir, 'cache');
    const firstOutputDir = join(dir, 'reports-first');
    await runCli([
      'discover',
      '--repo',
      repoDir,
      '--cache-dir',
      cacheDir,
      '--output-dir',
      firstOutputDir,
    ]);
    const firstReport = JSON.parse(
      await readFile(join(firstOutputDir, 'discovery-report.json'), 'utf-8')
    ) as RepoDiscoveryReport;
    const dirtyFile = join(firstReport.repo.cachePath, 'docs/dirty.md');
    await writeFile(dirtyFile, '# Dirty cache note\n', 'utf-8');

    const secondOutputDir = join(dir, 'reports-second');
    const { stderr } = await runCli([
      'discover',
      '--repo',
      repoDir,
      '--cache-dir',
      cacheDir,
      '--output-dir',
      secondOutputDir,
    ]);
    const secondReport = JSON.parse(
      await readFile(join(secondOutputDir, 'discovery-report.json'), 'utf-8')
    ) as RepoDiscoveryReport;

    expect(stderr).toContain('Warning: Cached repo has local changes or ignored files');
    expect(secondReport.repo).toMatchObject({
      cloned: false,
      existingCache: true,
      git: {
        dirty: true,
      },
      update: {
        attempted: false,
        successful: null,
        skippedReason: 'dirty-cache',
      },
    });
    expect(secondReport.repo.git.status).toContain('?? docs/dirty.md');
    expect(secondReport.warnings).toContain(
      'Cached repo has local changes or ignored files; update skipped and current checkout inspected.'
    );
    expect(secondReport.candidates.map((candidate) => candidate.path)).toContain('docs/dirty.md');
    expect(await readFile(dirtyFile, 'utf-8')).toBe('# Dirty cache note\n');
  });

  it('warns and skips update when the cache contains ignored files', async () => {
    const repoDir = await createLocalGitRepo();
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-repo-ignored-cache-'));
    tempDirs.push(dir);

    await writeFile(join(repoDir, '.gitignore'), 'generated/\n', 'utf-8');
    await git(['add', '.gitignore'], repoDir);
    await git(
      [
        '-c',
        'user.email=tests@example.com',
        '-c',
        'user.name=Tests',
        'commit',
        '-m',
        'Ignore generated files',
      ],
      repoDir
    );

    const cacheDir = join(dir, 'cache');
    const firstOutputDir = join(dir, 'reports-first');
    await runCli([
      'discover',
      '--repo',
      repoDir,
      '--cache-dir',
      cacheDir,
      '--output-dir',
      firstOutputDir,
    ]);
    const firstReport = JSON.parse(
      await readFile(join(firstOutputDir, 'discovery-report.json'), 'utf-8')
    ) as RepoDiscoveryReport;
    const ignoredFile = join(firstReport.repo.cachePath, 'generated/cache.md');
    await mkdir(dirname(ignoredFile), { recursive: true });
    await writeFile(ignoredFile, '# Local ignored cache file\n', 'utf-8');

    await mkdir(join(repoDir, 'generated'), { recursive: true });
    await writeFile(join(repoDir, 'generated/cache.md'), '# Upstream tracked file\n', 'utf-8');
    await git(['add', '-f', 'generated/cache.md'], repoDir);
    await git(
      [
        '-c',
        'user.email=tests@example.com',
        '-c',
        'user.name=Tests',
        'commit',
        '-m',
        'Track generated cache file',
      ],
      repoDir
    );

    const secondOutputDir = join(dir, 'reports-second');
    const { stderr } = await runCli([
      'discover',
      '--repo',
      repoDir,
      '--cache-dir',
      cacheDir,
      '--output-dir',
      secondOutputDir,
    ]);
    const secondReport = JSON.parse(
      await readFile(join(secondOutputDir, 'discovery-report.json'), 'utf-8')
    ) as RepoDiscoveryReport;

    expect(stderr).toContain('Warning: Cached repo has local changes or ignored files');
    expect(secondReport.repo).toMatchObject({
      cloned: false,
      existingCache: true,
      git: {
        dirty: true,
      },
      update: {
        attempted: false,
        successful: null,
        skippedReason: 'dirty-cache',
      },
    });
    expect(secondReport.repo.git.status).toContain('!! generated/cache.md');
    expect(secondReport.warnings).toContain(
      'Cached repo has local changes or ignored files; update skipped and current checkout inspected.'
    );
    expect(await readFile(ignoredFile, 'utf-8')).toBe('# Local ignored cache file\n');
  });

  it('warns and skips update when cached repo clean state is unknown', async () => {
    const repoDir = await createLocalGitRepo();
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-repo-unknown-cache-state-'));
    tempDirs.push(dir);

    const cacheDir = join(dir, 'cache');
    const firstOutputDir = join(dir, 'reports-first');
    const first = await discoverRepo({
      repo: repoDir,
      cacheDir,
      outputDir: firstOutputDir,
    });
    const firstCommit = first.report.repo.git.commit;

    await writeFile(join(repoDir, 'docs/new.md'), '# New upstream docs\n', 'utf-8');
    await git(['add', 'docs/new.md'], repoDir);
    await git(
      [
        '-c',
        'user.email=tests@example.com',
        '-c',
        'user.name=Tests',
        'commit',
        '-m',
        'Add upstream docs',
      ],
      repoDir
    );

    const badIndexPath = join(dir, 'bad-index-dir');
    await mkdir(badIndexPath, { recursive: true });
    const previousGitIndexFile = process.env.GIT_INDEX_FILE;

    try {
      process.env.GIT_INDEX_FILE = badIndexPath;
      const second = await discoverRepo({
        repo: repoDir,
        cacheDir,
        outputDir: join(dir, 'reports-second'),
      });

      expect(second.report.repo.git).toMatchObject({
        commit: firstCommit,
        dirty: null,
        status: [],
      });
      expect(second.report.repo.update).toMatchObject({
        attempted: false,
        successful: null,
        skippedReason: 'unknown-cache-state',
      });
      expect(
        second.report.warnings.some((warning) =>
          warning.includes('Could not read cached repo status')
        )
      ).toBe(true);
      expect(second.report.warnings).toContain(
        'Cached repo clean state could not be confirmed; update skipped and current checkout inspected.'
      );
      expect(second.report.candidates.map((candidate) => candidate.path)).not.toContain(
        'docs/new.md'
      );
    } finally {
      if (previousGitIndexFile === undefined) {
        delete process.env.GIT_INDEX_FILE;
      } else {
        process.env.GIT_INDEX_FILE = previousGitIndexFile;
      }
    }
  });

  it('warns and skips update when an existing cache remote does not match the requested repo', async () => {
    const repoDir = await createLocalGitRepo();
    const otherRepoDir = await createLocalGitRepo();
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-repo-remote-mismatch-'));
    tempDirs.push(dir);

    const cacheDir = join(dir, 'cache');
    const firstOutputDir = join(dir, 'reports-first');
    await runCli([
      'discover',
      '--repo',
      repoDir,
      '--cache-dir',
      cacheDir,
      '--output-dir',
      firstOutputDir,
    ]);
    const firstReport = JSON.parse(
      await readFile(join(firstOutputDir, 'discovery-report.json'), 'utf-8')
    ) as RepoDiscoveryReport;
    await git(['remote', 'set-url', 'origin', otherRepoDir], firstReport.repo.cachePath);

    const secondOutputDir = join(dir, 'reports-second');
    const { stderr } = await runCli([
      'discover',
      '--repo',
      repoDir,
      '--cache-dir',
      cacheDir,
      '--output-dir',
      secondOutputDir,
    ]);
    const secondReport = JSON.parse(
      await readFile(join(secondOutputDir, 'discovery-report.json'), 'utf-8')
    ) as RepoDiscoveryReport;

    expect(stderr).toContain('Warning: Cached repo remote does not match requested repo');
    expect(secondReport.repo.git.remoteUrl).toBe(otherRepoDir);
    expect(secondReport.repo.update).toMatchObject({
      attempted: false,
      successful: null,
      skippedReason: 'remote-mismatch',
    });
    expect(secondReport.warnings).toContain(
      'Cached repo remote does not match requested repo; update skipped and current checkout inspected.'
    );
  });

  it('does not make unsupported source authority claims in repo discovery output', async () => {
    const repoDir = await createLocalGitRepo();
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-repo-claims-'));
    tempDirs.push(dir);

    const outputDir = join(dir, 'reports');
    const { stdout, stderr } = await runCli([
      'discover',
      '--repo',
      repoDir,
      '--scope',
      'docs',
      '--cache-dir',
      join(dir, 'cache'),
      '--output-dir',
      outputDir,
    ]);
    const reportText = await readFile(join(outputDir, 'discovery-report.json'), 'utf-8');
    const combinedOutput = `${stdout}\n${stderr}\n${reportText}`;

    expect(combinedOutput).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(combinedOutput).not.toMatch(/\bofficial\b/i);
    expect(combinedOutput).not.toMatch(/\bscore\b/i);
    expect(combinedOutput).not.toMatch(/\bselected\b/i);
  });

  it('reports truncated local discovery when maxFiles bounds traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-discover-bounds-'));
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'reports');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'a.md'), '# A\n', 'utf-8');
    await writeFile(join(sourceDir, 'b.md'), '# B\n', 'utf-8');
    await writeFile(join(sourceDir, 'c.md'), '# C\n', 'utf-8');

    const { report, reportPath } = await discoverLocalSources({
      source: sourceDir,
      outputDir,
      maxFiles: 2,
    });
    const reportFromDisk = JSON.parse(await readFile(reportPath, 'utf-8')) as DiscoveryReport;

    expect(report.traversal).toMatchObject({
      maxFiles: 2,
      visitedFiles: 2,
      candidateCount: 2,
      truncated: true,
    });
    expect(report.warnings).toContain('Traversal maxFiles reached: 2');
    expect(report.candidates.map((candidate) => candidate.path)).toEqual(['a.md', 'b.md']);
    expect(reportFromDisk.traversal.truncated).toBe(true);
    expect(reportFromDisk.warnings).toContain('Traversal maxFiles reached: 2');
  });

  it('reports truncated local discovery when maxDepth bounds nested directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-discover-depth-bounds-'));
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'reports');
    await mkdir(join(sourceDir, 'z-nested'), { recursive: true });
    await writeFile(join(sourceDir, 'a.md'), '# A\n', 'utf-8');
    await writeFile(join(sourceDir, 'z-nested/deep.md'), '# Deep\n', 'utf-8');

    const { report, reportPath } = await discoverLocalSources({
      source: sourceDir,
      outputDir,
      maxDepth: 0,
    });
    const reportFromDisk = JSON.parse(await readFile(reportPath, 'utf-8')) as DiscoveryReport;

    expect(report.traversal).toMatchObject({
      maxDepth: 0,
      candidateCount: 1,
      truncated: true,
    });
    expect(report.candidates.map((candidate) => candidate.path)).toEqual(['a.md']);
    expect(report.warnings).toContain('Traversal stopped at max depth 0: z-nested');
    expect(reportFromDisk.traversal.truncated).toBe(true);
    expect(reportFromDisk.warnings).toContain('Traversal stopped at max depth 0: z-nested');
  });

  it('reports truncated local discovery when maxEntries bounds directory fanout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-discover-entry-bounds-'));
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'reports');
    await mkdir(join(sourceDir, 'a'), { recursive: true });
    await mkdir(join(sourceDir, 'b'), { recursive: true });
    await mkdir(join(sourceDir, 'c'), { recursive: true });

    const { report, reportPath } = await discoverLocalSources({
      source: sourceDir,
      outputDir,
      maxEntries: 2,
    });
    const reportFromDisk = JSON.parse(await readFile(reportPath, 'utf-8')) as DiscoveryReport;

    expect(report.traversal).toMatchObject({
      maxEntries: 2,
      visitedEntries: 2,
      candidateCount: 0,
      truncated: true,
    });
    expect(report.warnings).toContain('Traversal maxEntries reached: 2');
    expect(reportFromDisk.traversal.truncated).toBe(true);
    expect(reportFromDisk.warnings).toContain('Traversal maxEntries reached: 2');
  });

  it('generates OpenRef documentation from a local configured spec', async () => {
    const configDir = await createTestConfig();
    const outputDir = join(configDir, 'output');

    const { stdout } = await runCli([
      'generate',
      '--sdk',
      'swift',
      '--sdk-version',
      'v2',
      '--config-dir',
      configDir,
      '--output-dir',
      outputDir,
    ]);

    expect(stdout).toContain('Processing 1 SDK/version pair');
    expect(stdout).toContain('Generation complete!');
    expect(stdout).toContain('Successful: 1');

    const parsedSpec = JSON.parse(
      await readFile(join(outputDir, 'swift/v2/parsed/swift-v2-spec.json'), 'utf-8')
    ) as { operations: Array<{ id: string; examples: unknown[] }> };
    expect(parsedSpec.operations).toHaveLength(1);
    expect(parsedSpec.operations[0]?.id).toBe('select');
    expect(parsedSpec.operations[0]?.examples).toHaveLength(1);

    const fullDoc = await readFile(
      join(outputDir, 'swift/v2/llm-docs/supabase-swift-v2-full-llms.txt'),
      'utf-8'
    );
    expect(fullDoc).toContain('# Supabase Swift SDK v2 Reference');
    expect(fullDoc).toContain(
      `<!-- Generated from: ${join(configDir, 'supabase_swift_v2.yml')} -->`
    );
    expect(fullDoc).not.toContain('<!-- Generated from:  -->');
    expect(fullDoc).toContain('Select data');
    expect(fullDoc).toContain('supabase.from("todos").select()');

    const moduleDoc = await readFile(
      join(outputDir, 'swift/v2/llm-docs/supabase-swift-v2-database-llms.txt'),
      'utf-8'
    );
    expect(moduleDoc).toContain('Supabase Swift SDK v2 Database Documentation');
    expect(moduleDoc).toContain('Database operations');

    const manifestPath = join(outputDir, 'swift/v2/manifest.json');
    const manifestText = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestText) as GenerationManifest;
    const specPath = join(configDir, 'supabase_swift_v2.yml');
    const generatedAt = new Date(manifest.generatedAt);
    const outputPaths = manifest.generatedOutputs.map((output) => output.path);
    const outputsByPath = new Map(manifest.generatedOutputs.map((output) => [output.path, output]));

    expect(manifestText.endsWith('\n')).toBe(true);
    expect(generatedAt.toISOString()).toBe(manifest.generatedAt);
    expect(manifest).toMatchObject({
      schemaVersion: '0.1.0',
      generator: {
        name: 'llm-docs-generator',
        version: '1.0.0',
        cliName: 'supabase-llm-docs',
      },
      mode: 'configured-sdk',
      sdk: {
        name: 'swift',
        resolvedVersion: 'v2',
        displayName: 'Supabase Swift SDK v2',
      },
      source: {
        configuredUrl: 'http://127.0.0.1:9/supabase_swift_v2.yml',
        configuredLocalPath: specPath,
        resolvedSpecPath: specPath,
        format: 'openref-0.1',
      },
      parser: {
        name: 'OpenRefParser',
        version: '1.0.0',
        format: 'openref-0.1',
      },
      formatter: {
        name: 'LLMFormatter',
        version: '1.0.0',
        format: 'legacy-llm-docs',
      },
      warnings: [],
    });
    expect(manifest.source.byteSize).toBe(await byteSize(specPath));
    expect(manifest.source.contentHash).toBe(await sha256File(specPath));
    expect(outputPaths).toEqual([
      'llm-docs/supabase-swift-v2-database-llms.txt',
      'llm-docs/supabase-swift-v2-full-llms.txt',
      'parsed/swift-v2-spec.json',
    ]);
    expect(outputsByPath.get('parsed/swift-v2-spec.json')?.kind).toBe('parsed-spec-json');
    expect(outputsByPath.get('llm-docs/supabase-swift-v2-full-llms.txt')?.kind).toBe('llm-docs');
    expect(outputPaths).not.toContain('manifest.json');

    for (const output of manifest.generatedOutputs) {
      expect(isAbsolute(output.path)).toBe(false);
      expect(output.path.startsWith('..')).toBe(false);
      expect(output.path.includes('\\')).toBe(false);

      const actualPath = join(dirname(manifestPath), output.path);
      expect(output.byteSize).toBe(await byteSize(actualPath));
      expect(output.hash).toBe(await sha256File(actualPath));
    }
  });

  it('removes a stale manifest for failed generation tasks while continuing later tasks', async () => {
    const configDir = await createTestConfig();
    const outputDir = join(configDir, 'output');
    const v2ManifestPath = join(outputDir, 'swift/v2/manifest.json');
    const v1ManifestPath = join(outputDir, 'swift/v1/manifest.json');

    await runCli(
      [
        'generate',
        '--sdk',
        'swift',
        '--sdk-version',
        'v2',
        '--config-dir',
        configDir,
        '--output-dir',
        outputDir,
      ],
      configDir
    );
    expect(await pathExists(v2ManifestPath)).toBe(true);

    const sdksPath = join(configDir, 'sdks.json');
    const config = JSON.parse(await readFile(sdksPath, 'utf-8')) as {
      sdks: {
        swift: {
          versions: {
            v2: {
              spec: {
                localPath: string | null;
              };
            };
          };
        };
      };
    };
    config.sdks.swift.versions.v2.spec.localPath = join(configDir, 'missing-spec.yml');
    await writeFile(sdksPath, JSON.stringify(config, null, 2), 'utf-8');

    const result = await runCliWithExit(
      [
        'generate',
        '--sdk',
        'swift',
        '--sdk-version',
        'all',
        '--config-dir',
        configDir,
        '--output-dir',
        outputDir,
      ],
      configDir
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Processing 2 SDK/version pair');
    expect(result.stdout).toContain('Generation complete!');
    expect(result.stdout).toContain('Successful: 1');
    expect(result.stdout).toContain('Failed: 1');
    expect(await pathExists(v2ManifestPath)).toBe(false);
    expect(await pathExists(v1ManifestPath)).toBe(true);
    expect(await findManifestFiles(outputDir)).toEqual([v1ManifestPath]);
  });

  it('resolves latest consistently to the highest numeric version for output and cleanup', async () => {
    const configDir = await createTestConfig(['v1', 'v2']);
    const outputDir = join(configDir, 'output');
    const v1ManifestPath = join(outputDir, 'swift/v1/manifest.json');
    const v2ManifestPath = join(outputDir, 'swift/v2/manifest.json');

    const firstResult = await runCli([
      'generate',
      '--sdk',
      'swift',
      '--config-dir',
      configDir,
      '--output-dir',
      outputDir,
    ]);

    expect(firstResult.stdout).toContain('Successful: 1');
    expect(await pathExists(v1ManifestPath)).toBe(false);
    expect(await pathExists(v2ManifestPath)).toBe(true);

    const manifest = JSON.parse(await readFile(v2ManifestPath, 'utf-8')) as GenerationManifest;
    expect(manifest.sdk.resolvedVersion).toBe('v2');
    expect(manifest.source.configuredUrl).toBe('http://127.0.0.1:9/supabase_swift_v2.yml');

    const sdksPath = join(configDir, 'sdks.json');
    const config = JSON.parse(await readFile(sdksPath, 'utf-8')) as {
      sdks: {
        swift: {
          versions: {
            v2: {
              spec: {
                localPath: string | null;
              };
            };
          };
        };
      };
    };
    config.sdks.swift.versions.v2.spec.localPath = join(configDir, 'missing-spec.yml');
    await writeFile(sdksPath, JSON.stringify(config, null, 2), 'utf-8');

    const secondResult = await runCliWithExit(
      ['generate', '--sdk', 'swift', '--config-dir', configDir, '--output-dir', outputDir],
      configDir
    );

    expect(secondResult.exitCode).toBe(1);
    expect(secondResult.stdout).toContain('Failed: 1');
    expect(await pathExists(v1ManifestPath)).toBe(false);
    expect(await pathExists(v2ManifestPath)).toBe(false);
    expect(await findManifestFiles(outputDir)).toEqual([]);
  });

  it('uses the resolved cache spec path in full-doc source comments when localPath is null', async () => {
    const configDir = await createTestConfig();
    const cacheSpecPath = join(configDir, 'config/supabase_swift_v2.yml');
    await mkdir(dirname(cacheSpecPath), { recursive: true });
    await writeFile(cacheSpecPath, testSpecYaml, 'utf-8');

    const sdksPath = join(configDir, 'sdks.json');
    const config = JSON.parse(await readFile(sdksPath, 'utf-8')) as {
      sdks: {
        swift: {
          versions: {
            v2: { spec: { localPath: string | null } };
          };
        };
      };
    };
    config.sdks.swift.versions.v2.spec.localPath = null;
    await writeFile(sdksPath, JSON.stringify(config, null, 2), 'utf-8');

    const outputDir = join(configDir, 'output');

    const { stdout } = await runCli(
      [
        'generate',
        '--sdk',
        'swift',
        '--sdk-version',
        'v2',
        '--config-dir',
        configDir,
        '--output-dir',
        outputDir,
      ],
      configDir
    );

    expect(stdout).toContain('Generation complete!');
    expect(stdout).toContain('Successful: 1');

    const fullDoc = await readFile(
      join(outputDir, 'swift/v2/llm-docs/supabase-swift-v2-full-llms.txt'),
      'utf-8'
    );
    expect(fullDoc).toContain('<!-- Generated from: config/supabase_swift_v2.yml -->');
    expect(fullDoc).not.toContain('<!-- Generated from:  -->');
  });

  it('verifies a generated configured SDK manifest by output directory', async () => {
    const { outputDir } = await generateSwiftFixture();

    const result = await runCli(['verify', '--output-dir', outputDir]);

    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain('Checked files: 4');
    expect(result.stdout).toContain('Failures: 0');
    expect(result.stdout).toContain('Verification passed');
  });

  it('requires exactly one verify manifest location option', async () => {
    const missingResult = await runCliWithExit(['verify']);
    const duplicateResult = await runCliWithExit([
      'verify',
      '--manifest',
      'manifest.json',
      '--output-dir',
      'output',
    ]);

    expect(missingResult.exitCode).toBe(1);
    expect(missingResult.stderr).toContain('provide exactly one of --manifest or --output-dir');
    expect(duplicateResult.exitCode).toBe(1);
    expect(duplicateResult.stderr).toContain('provide exactly one of --manifest or --output-dir');
  });

  it('reports a modified generated output hash mismatch', async () => {
    const { manifestPath } = await generateSwiftFixture();
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as GenerationManifest;
    const outputPath = join(dirname(manifestPath), manifest.generatedOutputs[0]?.path ?? '');
    await writeFile(outputPath, 'changed output with the same manifest\n', 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain('Failures:');
    expect(result.stderr).toContain('hash mismatch');
  });

  it('reports a missing generated output', async () => {
    const { manifestPath } = await generateSwiftFixture();
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as GenerationManifest;
    const outputPath = join(dirname(manifestPath), manifest.generatedOutputs[0]?.path ?? '');
    await rm(outputPath, { force: true });

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('missing file');
    expect(result.stderr).toContain(manifest.generatedOutputs[0]?.path);
  });

  it('verifies a relative source path from the manifest directory across cwd changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-cli-'));
    tempDirs.push(dir);
    const outputDir = join(dir, 'output');
    const sourcePath = join(outputDir, 'config/source.yml');
    const generatedPath = join(outputDir, 'llm-docs/output.txt');
    const manifestPath = join(outputDir, 'manifest.json');

    await mkdir(dirname(sourcePath), { recursive: true });
    await mkdir(dirname(generatedPath), { recursive: true });
    await writeFile(sourcePath, testSpecYaml, 'utf-8');
    await writeFile(generatedPath, 'generated docs\n', 'utf-8');
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: '0.1.0',
          mode: 'configured-sdk',
          source: {
            resolvedSpecPath: 'config/source.yml',
            byteSize: await byteSize(sourcePath),
            contentHash: await sha256File(sourcePath),
          },
          generatedOutputs: [
            {
              path: 'llm-docs/output.txt',
              kind: 'llm-docs',
              byteSize: await byteSize(generatedPath),
              hash: await sha256File(generatedPath),
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    const passResult = await runCli(['verify', '--manifest', manifestPath], repoRoot);

    expect(passResult.stdout).toContain('Checked files: 2');
    expect(passResult.stdout).toContain('Failures: 0');

    await writeFile(sourcePath, `${testSpecYaml}# drift\n`, 'utf-8');

    const driftResult = await runCliWithExit(['verify', '--manifest', manifestPath], repoRoot);

    expect(driftResult.exitCode).toBe(1);
    expect(driftResult.stdout).toContain('Checked files: 2');
    expect(driftResult.stderr).toContain('source:');
    expect(driftResult.stderr).toContain('hash mismatch');
  });

  it('does not fall back to cwd for missing relative source paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-cli-'));
    tempDirs.push(dir);
    const outputDir = join(dir, 'output');
    const sourcePath = join(outputDir, 'config/source.yml');
    const cwdSourcePath = join(dir, 'cwd/config/source.yml');
    const generatedPath = join(outputDir, 'llm-docs/output.txt');
    const manifestPath = join(outputDir, 'manifest.json');

    await mkdir(dirname(sourcePath), { recursive: true });
    await mkdir(dirname(cwdSourcePath), { recursive: true });
    await mkdir(dirname(generatedPath), { recursive: true });
    await writeFile(sourcePath, testSpecYaml, 'utf-8');
    await writeFile(cwdSourcePath, testSpecYaml, 'utf-8');
    await writeFile(generatedPath, 'generated docs\n', 'utf-8');
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: '0.1.0',
          mode: 'configured-sdk',
          source: {
            resolvedSpecPath: 'config/source.yml',
            byteSize: await byteSize(sourcePath),
            contentHash: await sha256File(sourcePath),
          },
          generatedOutputs: [
            {
              path: 'llm-docs/output.txt',
              kind: 'llm-docs',
              byteSize: await byteSize(generatedPath),
              hash: await sha256File(generatedPath),
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );
    await rm(sourcePath, { force: true });

    const result = await runCliWithExit(['verify', '--manifest', manifestPath], join(dir, 'cwd'));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`missing file at ${sourcePath}`);
  });

  it('reports malformed and unsupported manifests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-cli-'));
    tempDirs.push(dir);
    const malformedManifestPath = join(dir, 'malformed.json');
    const unsupportedManifestPath = join(dir, 'unsupported.json');

    await writeFile(malformedManifestPath, '{', 'utf-8');
    await writeFile(
      unsupportedManifestPath,
      JSON.stringify({ schemaVersion: '99.0.0', mode: 'configured-sdk' }),
      'utf-8'
    );

    const malformedResult = await runCliWithExit(['verify', '--manifest', malformedManifestPath]);
    const unsupportedResult = await runCliWithExit([
      'verify',
      '--manifest',
      unsupportedManifestPath,
    ]);

    expect(malformedResult.exitCode).toBe(1);
    expect(malformedResult.stderr).toContain('malformed manifest JSON');
    expect(unsupportedResult.exitCode).toBe(1);
    expect(unsupportedResult.stderr).toContain('unsupported manifest schemaVersion');
  });

  it('reports unsupported manifest modes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-cli-'));
    tempDirs.push(dir);
    const manifestPath = join(dir, 'unsupported-mode.json');

    await writeFile(
      manifestPath,
      JSON.stringify({ schemaVersion: '0.1.0', mode: 'repo-source' }),
      'utf-8'
    );

    const unsupportedModeResult = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(unsupportedModeResult.exitCode).toBe(1);
    expect(unsupportedModeResult.stderr).toContain('unsupported manifest mode');
  });

  it('rejects absolute and escaping generated output paths before checking files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-cli-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'source.yml');
    const manifestPath = join(dir, 'manifest.json');

    await writeFile(sourcePath, testSpecYaml, 'utf-8');
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: '0.1.0',
          mode: 'configured-sdk',
          source: {
            resolvedSpecPath: sourcePath,
            byteSize: await byteSize(sourcePath),
            contentHash: await sha256File(sourcePath),
          },
          generatedOutputs: [
            {
              path: join(dir, 'absolute-output.txt'),
              kind: 'llm-docs',
              byteSize: 0,
              hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            },
            {
              path: '../outside-output.txt',
              kind: 'llm-docs',
              byteSize: 0,
              hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Checked files: 0');
    expect(result.stderr).toContain('path must be relative');
    expect(result.stderr).toContain('path escapes manifest directory');
  });

  it('rejects invalid generated output kinds before checking files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-cli-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'source.yml');
    const outputPath = join(dir, 'llm-docs/output.txt');
    const manifestPath = join(dir, 'manifest.json');

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(sourcePath, testSpecYaml, 'utf-8');
    await writeFile(outputPath, 'generated docs\n', 'utf-8');
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: '0.1.0',
          mode: 'configured-sdk',
          source: {
            resolvedSpecPath: sourcePath,
            byteSize: await byteSize(sourcePath),
            contentHash: await sha256File(sourcePath),
          },
          generatedOutputs: [
            {
              path: 'llm-docs/output.txt',
              kind: 'repo-source',
              byteSize: await byteSize(outputPath),
              hash: await sha256File(outputPath),
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Checked files: 0');
    expect(result.stderr).toContain('kind must be parsed-spec-json or llm-docs');
  });

  it('does not claim repo or source-code verification', async () => {
    const { manifestPath } = await generateSwiftFixture();

    const result = await runCli(['verify', '--manifest', manifestPath]);
    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();

    expect(output).not.toContain('repo');
    expect(output).not.toContain('source-code');
    expect(output).not.toContain('source code');
  });

  it('continues to resolve validate without --version to the latest configured SDK version', async () => {
    const configDir = await createTestConfig();

    const { stdout } = await runCli(['validate', '--sdk', 'swift', '--config-dir', configDir]);

    expect(stdout).toContain('Validating swift latest');
    expect(stdout).toContain('Validation successful!');
    expect(stdout).toContain('Version: v2');
  });
});
