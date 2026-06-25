/**
 * CLI regression tests for documented compatibility commands.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverLocalSource, discoverLocalSources } from '../../src/core/discovery.js';
import { discoverRepo } from '../../src/core/repo-discovery.js';
import type { SourceTruthInspectionReport } from '../../src/core/source-truth.js';
import type {
  SourceTruthDocsFailure,
  SourceTruthDocsManifest,
} from '../../src/core/source-truth-docs.js';
import { discoverWebsite } from '../../src/core/website-discovery.js';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = join(repoRoot, 'src/cli.ts');
const tsxBin = join(
  repoRoot,
  'node_modules/.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
);

const tempDirs: string[] = [];
const servers: Server[] = [];
interface ManifestFileEntry {
  path: string;
  kind: string;
  byteSize: number;
  hash: string;
  lineCount?: number;
  estimatedTokenCount?: number;
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
  evidence: {
    category: string;
    signals: string[];
  };
  order: number;
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

interface WebsiteDiscoveryReport {
  schemaVersion: string;
  mode: string;
  generatedAt: string;
  website: {
    input: string;
    normalizedUrl: string;
    origin: string;
  };
  inspectedResources: Array<{
    url: string;
    status: number | null;
    contentType: string | null;
    byteSize: number;
    truncated: boolean;
    sourceRole: string;
  }>;
  crawlPolicy: {
    inspectedResourceUrls: string[];
    sameOriginWellKnownResources: string[];
    linkedCandidateFetches: false;
    renderedJavaScript: false;
    timeoutMs: number;
    maxBytesPerResponse: number;
    maxCandidates: number;
    candidateLimitReached: boolean;
  };
  output: {
    reportPath: string;
  };
  candidates: Array<{
    url: string;
    sameOrigin: boolean;
    external: boolean;
    order: number;
    evidence: {
      relations: string[];
      flags: string[];
      signals: string[];
    };
    sourceResources: Array<{
      url: string;
      sourceRole: string;
      evidence: string;
    }>;
  }>;
  warnings: string[];
}

interface CapabilitiesContract {
  schemaVersion: string;
  generator: {
    packageName: string;
    packageVersion: string;
    cliName: string;
    binary: string;
  };
  productBoundary: {
    cliRole: string;
    agentRole: string;
    sourceAuthority: string;
    taskFit: string;
    sourceSelection: string;
    discoveryReports: string;
    statement: string;
  };
  implemented: Array<{
    id: string;
    command: string;
    mode: string;
    status: string;
    inputBoundary: string;
    outputFiles: string[];
    summary: string;
    limitations: string[];
    factFamilies?: string[];
    options?: string[];
  }>;
  sourceTruth: {
    status: string;
    supportedFactFamilies: string[];
    limitations: string[];
  };
  plannedUnsupported: Array<{
    id: string;
    command: string;
    status: string;
    reason: string;
  }>;
}

interface AgentContextContract {
  schemaVersion: string;
  mode: string;
  generator: {
    packageName: string;
    packageVersion: string;
    cliName: string;
    binary: string;
  };
  contextArtifacts: Array<{
    id: string;
    name: string;
    path: string;
    byteSize: number;
    sha256: string;
    intendedUse: string;
  }>;
  skillArtifacts: Array<{
    id: string;
    name: string;
    path: string;
    byteSize: number;
    sha256: string;
    intendedUse: string;
  }>;
  limitations: string[];
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

async function startTestServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{ baseUrl: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    handler(request, response);
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });

  servers.push(server);
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    if (!server.listening) {
      resolvePromise();
      return;
    }

    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolvePromise();
    });
  });
}

async function reserveUnusedLocalPort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolvePromise();
    });
  });

  const address = server.address() as AddressInfo;
  await closeServer(server);

  return address.port;
}

function writeHttpResponse(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string
): void {
  response.writeHead(status, { 'content-type': contentType });
  response.end(body);
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

function countTextLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  const newlineCount = [...text].filter((character) => character === '\n').length;

  return text.endsWith('\n') ? newlineCount : newlineCount + 1;
}

function estimateTextTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.ceil(Array.from(text).length / 4);
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

async function listPackageRelativeFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const entryPath = join(root, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await listPackageRelativeFiles(entryPath)));
    } else {
      found.push(relative(repoRoot, entryPath).split(sep).join('/'));
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
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('CLI compatibility behavior', () => {
  it('includes agent context files in the npm package file list', async () => {
    const packageMetadata = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8')) as {
      files: string[];
    };

    expect(packageMetadata.files).toEqual(
      expect.arrayContaining([
        'AGENT_CONTEXT.md',
        'index.md',
        'skills/llm-docs-generator/SKILL.md',
        'skills/repo-docs-discovery/SKILL.md',
      ])
    );
    expect(packageMetadata.files).not.toContain('skills');
    expect(
      packageMetadata.files
        .filter((file) => file.startsWith('skills/'))
        .sort(compareStringsByCodeUnit)
    ).toEqual([
      'skills/llm-docs-generator/SKILL.md',
      'skills/repo-docs-discovery/SKILL.md',
    ]);
  });

  it('ships valid bundled skill frontmatter for agent workflows', async () => {
    const skillPaths = [
      'skills/llm-docs-generator/SKILL.md',
      'skills/repo-docs-discovery/SKILL.md',
    ];

    for (const skillPath of skillPaths) {
      const content = await readFile(join(repoRoot, skillPath), 'utf-8');
      const match = content.match(/^---\n([\s\S]*?)\n---\n/);

      expect(match, `${skillPath} frontmatter`).not.toBeNull();

      const entries = new Map<string, string>();

      for (const line of match?.[1].split('\n') ?? []) {
        const separatorIndex = line.indexOf(':');
        expect(separatorIndex, `${skillPath} frontmatter line ${line}`).toBeGreaterThan(0);
        entries.set(line.slice(0, separatorIndex), line.slice(separatorIndex + 1).trim());
      }

      expect([...entries.keys()].sort()).toEqual(['description', 'name']);
      expect(entries.get('name')).toMatch(/^[a-z0-9-]+$/);
      expect(entries.get('description')).toBeTruthy();
      expect(content).toContain('llm-docs capabilities --json');
      expect(content).toContain('agent install codex');
      expect(content).toContain('agent doctor');
      expect(content).toMatch(/unsupported unless|unavailable unless|unless .*reports/i);
      expect(content).not.toContain('automatically register');
      expect(content).not.toContain('always use the top candidate');
    }
  });

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

  it('exposes capabilities help and root help for agents', async () => {
    const rootHelp = await runCli(['--help']);
    const capabilitiesHelp = await runCli(['capabilities', '--help']);
    const agentHelp = await runCli(['agent', '--help']);
    const agentContextHelp = await runCli(['agent', 'context', '--help']);

    expect(rootHelp.stdout).toContain('capabilities');
    expect(rootHelp.stdout).toContain('agent');
    expect(rootHelp.stdout).toContain('Report implemented and planned CLI capabilities for');
    expect(rootHelp.stdout).toContain('agents');
    expect(capabilitiesHelp.stdout).toContain('Report implemented and planned CLI capabilities for agents');
    expect(capabilitiesHelp.stdout).toContain('--json');
    expect(capabilitiesHelp.stdout).toContain(
      'Print the deterministic machine-readable capabilities contract'
    );
    expect(agentHelp.stdout).toContain('Report read-only agent metadata packaged with this CLI');
    expect(agentHelp.stdout).toContain('context');
    expect(agentContextHelp.stdout).toContain('Report packaged read-only agent context metadata');
    expect(agentContextHelp.stdout).toContain('--json');
    expect(agentContextHelp.stdout).toContain(
      'Print deterministic machine-readable agent context metadata'
    );
    expect(`${agentHelp.stdout}\n${agentContextHelp.stdout}`).not.toMatch(
      /\bagent (install|doctor)\b/i
    );
  }, 15000);

  it('describes generate options as configured SDK guards or planned unsupported modes', async () => {
    const { stdout } = await runCli(['generate', '--help']);

    expect(stdout).toMatch(
      /--source <path>\s+Planned general source generation input \(currently\s+unsupported\)/
    );
    expect(stdout).toMatch(
      /--format <format>\s+Configured SDK format guard: openref or openref-0\.1/
    );
    expect(stdout).toMatch(
      /--preset <name>\s+Planned preset generation input \(currently\s+unsupported\)/
    );
    expect(stdout).not.toContain('General generation format');
    expect(stdout).not.toContain('Generate from source');
  });

  it('prints deterministic agent context JSON metadata for packaged artifacts', async () => {
    const first = await runCli(['agent', 'context', '--json']);
    const second = await runCli(['agent', 'context', '--json']);
    const context = JSON.parse(first.stdout) as AgentContextContract;
    const artifacts = new Map(
      context.contextArtifacts.map((artifact) => [artifact.id, artifact])
    );

    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout.endsWith('\n')).toBe(true);
    expect(first.stdout).not.toContain('generatedAt');
    expect(context).toMatchObject({
      schemaVersion: '0.2.0',
      mode: 'agent-context-packaged-metadata',
      generator: {
        packageName: 'llm-docs-generator',
        packageVersion: '1.0.0',
        cliName: 'supabase-llm-docs',
        binary: 'llm-docs',
      },
      limitations: [
        'Reports packaged context and skill metadata only.',
        'Does not install or register skills.',
        'Does not write user config.',
        'Does not probe environment state.',
        'Does not perform network access.',
      ],
    });
    expect(context.contextArtifacts.map((artifact) => artifact.id)).toEqual([
      'agent-context',
      'project-index',
    ]);
    expect(artifacts.get('agent-context')).toMatchObject({
      name: 'Agent Context',
      path: 'AGENT_CONTEXT.md',
      byteSize: await byteSize(join(repoRoot, 'AGENT_CONTEXT.md')),
      sha256: await sha256FileHex(join(repoRoot, 'AGENT_CONTEXT.md')),
    });
    expect(artifacts.get('project-index')).toMatchObject({
      name: 'Project Index',
      path: 'index.md',
      byteSize: await byteSize(join(repoRoot, 'index.md')),
      sha256: await sha256FileHex(join(repoRoot, 'index.md')),
    });
    expect(context.contextArtifacts.every((artifact) => artifact.intendedUse.length > 0)).toBe(
      true
    );
    expect(context.skillArtifacts.map((artifact) => artifact.id)).toEqual([
      'llm-docs-generator',
      'repo-docs-discovery',
    ]);
    expect(context.skillArtifacts.map((artifact) => artifact.path)).toEqual([
      'skills/llm-docs-generator/SKILL.md',
      'skills/repo-docs-discovery/SKILL.md',
    ]);
    expect(context.skillArtifacts).toHaveLength(2);
    expect(await listPackageRelativeFiles(join(repoRoot, 'skills'))).toEqual(
      context.skillArtifacts
        .map((artifact) => artifact.path)
        .sort(compareStringsByCodeUnit)
    );

    for (const artifact of context.skillArtifacts) {
      expect(artifact.path).toMatch(/^skills\/[a-z0-9-]+\/SKILL\.md$/);
      expect(artifact.byteSize).toBe(await byteSize(join(repoRoot, artifact.path)));
      expect(artifact.sha256).toBe(await sha256FileHex(join(repoRoot, artifact.path)));
      expect(artifact.intendedUse.length).toBeGreaterThan(0);
    }
  });

  it('prints concise non-JSON agent context text without installer or doctor claims', async () => {
    const { stdout, stderr } = await runCli(['agent', 'context']);
    const output = `${stdout}\n${stderr}`;

    expect(stdout).toContain('llm-docs agent context');
    expect(stdout).toContain('Schema: 0.2.0');
    expect(stdout).toContain('Package: llm-docs-generator@1.0.0');
    expect(stdout).toContain('Binary: llm-docs');
    expect(stdout).toContain('Agent Context (agent-context)');
    expect(stdout).toContain('Project Index (project-index)');
    expect(stdout).toContain('Packaged skills:');
    expect(stdout).toContain('llm-docs-generator (llm-docs-generator)');
    expect(stdout).toContain('repo-docs-discovery (repo-docs-discovery)');
    expect(stdout).toContain('Path: AGENT_CONTEXT.md');
    expect(stdout).toContain('Path: index.md');
    expect(stdout).toContain('Path: skills/llm-docs-generator/SKILL.md');
    expect(stdout).toContain('Path: skills/repo-docs-discovery/SKILL.md');
    expect(stdout).toContain('Does not install or register skills.');
    expect(stdout).toContain('Use --json for the stable agent metadata contract.');
    expect(output).not.toMatch(/\bcopies bundled skills\b/i);
    expect(output).not.toMatch(/\bchecks that the binary is on PATH\b/i);
    expect(output).not.toMatch(/\bhost skill installation is writable\b/i);
  });

  it(
    'prints a deterministic capabilities JSON contract without generatedAt',
    async () => {
      const first = await runCli(['capabilities', '--json']);
      const second = await runCli(['capabilities', '--json']);
      const capabilities = JSON.parse(first.stdout) as CapabilitiesContract;

      expect(first.stdout).toBe(second.stdout);
      expect(first.stdout.endsWith('\n')).toBe(true);
      expect(first.stdout).not.toContain('generatedAt');
      expect(capabilities).toMatchObject({
        schemaVersion: '0.1.0',
        generator: {
          packageName: 'llm-docs-generator',
          packageVersion: '1.0.0',
          cliName: 'supabase-llm-docs',
          binary: 'llm-docs',
        },
      });
    },
    15000
  );

  it('separates implemented capabilities from planned or unsupported capabilities', async () => {
    const { stdout } = await runCli(['capabilities', '--json']);
    const capabilities = JSON.parse(stdout) as CapabilitiesContract;
    const implemented = new Map(
      capabilities.implemented.map((capability) => [capability.id, capability])
    );
    const planned = new Map(
      capabilities.plannedUnsupported.map((capability) => [capability.id, capability])
    );

    expect([...implemented.keys()]).toEqual([
      'discover-source',
      'discover-repo',
      'discover-url',
      'source-truth-inspect',
      'source-truth-generate',
      'agent-context',
      'generate-sdk',
      'verify-configured-sdk',
      'list-sdks',
      'validate-sdk',
    ]);
    expect([...planned.keys()]).toEqual([
      'generate-source',
      'generate-preset',
      'refresh',
      'source-code-verification',
      'broad-crawling',
      'automatic-source-selection',
      'framework-route-understanding',
      'behavior-level-code-docs',
      'agent-install-codex',
      'agent-doctor',
    ]);
    expect(capabilities.implemented.every((capability) => capability.status === 'implemented')).toBe(
      true
    );
    expect(
      capabilities.plannedUnsupported.every(
        (capability) => capability.status === 'planned-unsupported'
      )
    ).toBe(true);
    expect(implemented.get('discover-source')?.outputFiles).toEqual(['discovery-report.json']);
    expect(implemented.get('discover-repo')?.outputFiles).toEqual(['discovery-report.json']);
    expect(implemented.get('discover-url')?.outputFiles).toEqual(['discovery-report.json']);
    expect(implemented.get('source-truth-inspect')?.outputFiles).toEqual([
      'stdout JSON evidence report',
    ]);
    expect(implemented.get('source-truth-generate')?.outputFiles).toEqual([
      'source-truth-report.json',
      'source-truth.md',
      'manifest.json',
      'failure.json',
    ]);
    expect(implemented.get('agent-context')?.outputFiles).toEqual(['stdout JSON metadata']);
    expect(implemented.get('agent-context')?.limitations).toContain(
      'does not install/register skills'
    );
    expect(implemented.get('agent-context')?.inputBoundary).toBe(
      'packaged context and skill files only'
    );
    expect(implemented.get('generate-sdk')?.outputFiles).toEqual([
      'manifest.json',
      'parsed/<sdk>-<resolved-version>-spec.json',
      'llm-docs/*-llms.txt',
    ]);
    expect(implemented.get('generate-sdk')?.options).toEqual([
      '--sdk <sdk>',
      '--sdk-version <version>',
      '--format openref|openref-0.1',
    ]);
    expect(implemented.get('generate-sdk')?.limitations).toContain('no preset generation');
    expect(planned.get('generate-source')?.reason).toBe(
      'top-level general generate --source is not implemented; explicit local source evidence generation is available only through source-truth generate --source --output-dir'
    );
    expect(planned.get('generate-source')?.reason).toContain(
      'source-truth generate --source --output-dir'
    );
    expect(planned.get('generate-source')?.reason).not.toContain(
      'no current CLI generation workflow consumes explicit sources'
    );
    expect(planned.get('generate-preset')?.reason).toBe(
      'preset generation is not implemented; the current generate command only supports configured OpenRef SDK generation through generate --sdk'
    );
    expect([...implemented.values()].map((capability) => capability.mode)).not.toContain(
      'generate --source'
    );
    expect([...implemented.values()].map((capability) => capability.command)).not.toContain(
      'refresh'
    );
    expect([...implemented.values()].map((capability) => capability.command)).not.toContain(
      'agent install codex'
    );
    expect([...implemented.values()].map((capability) => capability.command)).not.toContain(
      'agent doctor'
    );
    expect(planned.get('agent-install-codex')?.reason).toContain(
      'no current CLI skill installer'
    );
    expect(planned.get('agent-doctor')?.reason).toContain('no current CLI host diagnostics');
  });

  it('reports source-truth fact families and explicit limitations', async () => {
    const { stdout } = await runCli(['capabilities', '--json']);
    const capabilities = JSON.parse(stdout) as CapabilitiesContract;
    const sourceTruthInspect = capabilities.implemented.find(
      (capability) => capability.id === 'source-truth-inspect'
    );
    const sourceTruthGenerate = capabilities.implemented.find(
      (capability) => capability.id === 'source-truth-generate'
    );
    const expectedFactFamilies = [
      'export facts',
      'optional direct-declaration AST signatures',
      'package/config facts',
      'path/filename test/example context facts',
    ];
    const expectedLimitations = [
      'no behavior inference',
      'no assertion parsing',
      'no test execution',
      'no framework inference',
      'no route inference',
      'no re-export resolution',
      'local explicit sources only',
    ];

    expect(capabilities.sourceTruth.supportedFactFamilies).toEqual(expectedFactFamilies);
    expect(capabilities.sourceTruth.limitations).toEqual(expectedLimitations);
    expect(sourceTruthInspect?.factFamilies).toEqual(expectedFactFamilies);
    expect(sourceTruthInspect?.limitations).toEqual(expectedLimitations);
    expect(sourceTruthGenerate?.factFamilies).toEqual(expectedFactFamilies);
    expect(sourceTruthGenerate?.limitations).toEqual(expectedLimitations);
  });

  it('states the product boundary without promoting unsupported behavior', async () => {
    const { stdout } = await runCli(['capabilities', '--json']);
    const capabilities = JSON.parse(stdout) as CapabilitiesContract;
    const implementedText = JSON.stringify(capabilities.implemented);
    const contractText = JSON.stringify(capabilities);

    expect(capabilities.productBoundary).toMatchObject({
      cliRole: 'deterministic-scriptable-capability-layer',
      agentRole: 'intelligent-planner',
      sourceAuthority: 'agent-owned',
      taskFit: 'agent-owned',
      sourceSelection: 'agent-owned-explicit-decision',
      discoveryReports: 'candidate-evidence-not-source-selection',
    });
    expect(capabilities.productBoundary.statement).toContain(
      'The agent owns source authority, task fit, and selected source decisions.'
    );
    expect(implementedText).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(implementedText).not.toMatch(/\bcorrect(?:ness)?\b/i);
    expect(implementedText).not.toMatch(/\bautomatically selects\b/i);
    expect(implementedText).not.toMatch(/\bunderstands routes\b/i);
    expect(implementedText).not.toMatch(/\bbehavior-level\b/i);
    expect(contractText).not.toMatch(/\btrust score\b/i);
    expect(contractText).not.toMatch(/\bclaims correctness\b/i);
    expect(contractText).not.toMatch(/\bchooses authoritative\b/i);
  });

  it('prints concise non-JSON capabilities text without writing reports', async () => {
    const { stdout } = await runCli(['capabilities']);

    expect(stdout).toContain('llm-docs capabilities');
    expect(stdout).toContain('Schema: 0.1.0');
    expect(stdout).toContain('Package: llm-docs-generator@1.0.0');
    expect(stdout).toContain('Implemented modes: 10');
    expect(stdout).toContain('Planned or unsupported modes: 10');
    expect(stdout).toContain('Use --json for the stable agent contract.');
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
    await writeFile(join(sourceDir, 'package.json'), '{"name":"fixture"}\n', 'utf-8');
    await writeFile(join(sourceDir, 'settings.yaml'), 'enabled: true\n', 'utf-8');
    await writeFile(join(sourceDir, 'spec/openapi.json'), '{"openapi":"3.1.0"}\n', 'utf-8');
    await writeFile(join(sourceDir, 'spec/openref.yml'), 'functions: []\n', 'utf-8');
    await writeFile(join(sourceDir, 'node_modules/pkg/ignored.md'), '# Ignored\n', 'utf-8');
    await writeFile(join(sourceDir, 'dist/ignored.md'), '# Ignored\n', 'utf-8');

    const { stdout } = await runCli(['discover', '--source', sourceDir, '--output-dir', outputDir]);
    const reportPath = join(outputDir, 'discovery-report.json');
    const reportText = await readFile(reportPath, 'utf-8');
    const report = JSON.parse(reportText) as DiscoveryReport;
    const unknownFile = join(sourceDir, 'notes.txt');
    await writeFile(unknownFile, 'plain notes\n', 'utf-8');
    const unknownReport = await discoverLocalSource({
      source: unknownFile,
      outputDir: join(dir, 'unknown-report'),
    });

    expect(stdout).toContain('Local source discovery');
    expect(stdout).toContain('Candidate files: 9');
    expect(stdout).toContain(`Report: ${reportPath}`);
    expect(reportText.endsWith('\n')).toBe(true);
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
    expect(report).toMatchObject({
      schemaVersion: '0.2.0',
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
        candidateCount: 9,
        truncated: false,
      },
    });
    expect(report.traversal.skippedDirectoryNames).toContain('node_modules');
    expect(report.candidates.map((candidate) => candidate.path)).toEqual([
      'spec/openapi.json',
      'spec/openref.yml',
      'docs/components.mdx',
      'docs/reference.md',
      'guide.docc/Tutorial.md',
      'readme.rst',
      'index.html',
      'package.json',
      'settings.yaml',
    ]);
    expect(report.candidates.map((candidate) => candidate.kind)).toEqual([
      'openapi-json',
      'openref-yaml',
      'mdx',
      'markdown',
      'docc',
      'rst',
      'html',
      'json',
      'yaml',
    ]);
    expect(report.candidates.map((candidate) => candidate.order)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(report.candidates.map((candidate) => candidate.evidence.category)).toEqual([
      'machine-readable-spec',
      'machine-readable-spec',
      'structured-doc-source',
      'structured-doc-source',
      'structured-doc-source',
      'structured-doc-source',
      'rendered-html',
      'generic-data',
      'generic-data',
    ]);
    expect(report.candidates[0]?.formatHints).toEqual(['json', 'openapi-json']);
    expect(report.candidates[0]?.evidence.signals).toContain('content:openapi-field');
    expect(report.candidates[0]?.evidence.signals).toContain('path:openapi-or-swagger-name');
    expect(report.candidates[1]?.formatHints).toEqual(['openref-yaml', 'yaml']);
    expect(report.candidates[1]?.evidence.signals).toContain('content:functions-field');
    expect(report.candidates[4]?.formatHints).toEqual(['docc-marker', 'markdown']);
    expect(report.candidates[7]?.evidence.signals).toContain('kind:json');
    expect(report.candidates[8]?.evidence.signals).toContain('kind:yaml');
    expect(unknownReport.candidates[0]).toMatchObject({
      path: 'notes.txt',
      kind: 'unknown',
      evidence: {
        category: 'unknown',
      },
      order: 1,
    });

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
      evidence: {
        category: 'machine-readable-spec',
      },
      order: 1,
      byteSize: await byteSize(sourcePath),
      sha256: await sha256FileHex(sourcePath),
    });
    expect(report.candidates[0]?.evidence.signals).toContain('content:openapi-field');
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

  it('describes source-truth help as neutral local evidence instead of export-only docs', async () => {
    const { stdout, stderr } = await runCli(['source-truth', '--help']);
    const combinedOutput = `${stdout}\n${stderr}`;

    expect(combinedOutput).toContain(
      'Inspect explicit local source paths and generate bounded source evidence docs'
    );
    expect(combinedOutput).not.toContain('source-truth export docs');
    expect(combinedOutput).not.toContain('export docs');
    expect(combinedOutput).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(combinedOutput).not.toMatch(/\bcorrect(?:ness)?\b/i);
    expect(combinedOutput).not.toMatch(/\bverified\b/i);
  });

  it('prints a deterministic source-truth evidence report as JSON for an explicit local source', async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-source-truth-cli-'));
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, 'index.ts'),
      [
        'export const value: number = 1;',
        'export function makeValue(input: string): number {',
        '  return value;',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    const { stdout, stderr } = await runCli(['source-truth', 'inspect', '--source', sourceDir]);
    const report = JSON.parse(stdout) as SourceTruthInspectionReport;

    expect(stdout.endsWith('\n')).toBe(true);
    expect(report).toMatchObject({
      schemaVersion: '0.1.0',
      mode: 'source-truth-local-evidence',
      source: {
        input: sourceDir,
        resolvedPath: sourceDir,
        type: 'directory',
      },
      traversal: {
        followSymlinks: false,
        inspectedFiles: 1,
        skippedFiles: 0,
        truncated: false,
      },
      warnings: [],
    });
    expect(report.files.map((file) => file.path)).toEqual(['index.ts']);
    expect(
      report.facts.map((fact) => ({
        kind: fact.kind,
        symbolKind: fact.symbolKind,
        name: fact.name,
        exportedName: fact.exportedName,
        provenance: fact.provenance,
      }))
    ).toEqual([
      {
        kind: 'exported-symbol',
        symbolKind: 'value',
        name: 'value',
        exportedName: 'value',
        provenance: {
          path: 'index.ts',
          lineRange: { start: 1, end: 1 },
        },
      },
      {
        kind: 'exported-symbol',
        symbolKind: 'function',
        name: 'makeValue',
        exportedName: 'makeValue',
        provenance: {
          path: 'index.ts',
          lineRange: { start: 2, end: 4 },
        },
      },
    ]);
    expect(report.facts[0]?.signature).toEqual({
      declarationKind: 'variable',
      text: 'export const value: number',
      variableKind: 'const',
      variables: [{ name: 'value', type: 'number' }],
    });
    expect(report.facts[1]?.signature).toEqual({
      declarationKind: 'function',
      text: 'export function makeValue(input: string): number',
      name: 'makeValue',
      parameters: [
        {
          name: 'input',
          type: 'string',
          optional: false,
          rest: false,
          hasDefault: false,
        },
      ],
      returnType: 'number',
    });
    expect(stdout).not.toContain('return value');
    expect(stdout).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(stdout).not.toMatch(/\bofficial\b/i);
    expect(stdout).not.toMatch(/\bcorrect(?:ness)?\b/i);
    expect(stdout).not.toMatch(/\bverified\b/i);
    expect(stdout).not.toMatch(/\bsummary\b/i);
    expect(stderr).not.toContain('Source-truth inspection failed');
  });

  it('generates source-truth Markdown, evidence report, and manifest for an explicit local source', async () => {
    const dir = await mkdtemp(
      join(await realpath(tmpdir()), 'llm-docs-source-truth-generate-cli-')
    );
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    const source = [
      'export const value = 1;',
      "export { value as renamedValue } from './value';",
      '',
    ].join('\n');
    await writeFile(join(sourceDir, 'index.ts'), source, 'utf-8');

    const { stdout, stderr } = await runCli([
      'source-truth',
      'generate',
      '--source',
      sourceDir,
      '--output-dir',
      outputDir,
    ]);
    const manifest = JSON.parse(
      await readFile(join(outputDir, 'manifest.json'), 'utf-8')
    ) as SourceTruthDocsManifest;
    const report = JSON.parse(
      await readFile(join(outputDir, 'source-truth-report.json'), 'utf-8')
    ) as SourceTruthInspectionReport;
    const markdown = await readFile(join(outputDir, 'source-truth.md'), 'utf-8');

    expect(stdout).toContain('Source-truth docs generated');
    expect(stdout).toContain(`Export facts: ${report.facts.length}`);
    expect(stdout).toContain(`Package/config facts: ${report.configFacts.length}`);
    expect(stdout).toContain(`Context facts: ${report.contextFacts.length}`);
    expect(stderr).not.toContain('Source-truth generation failed');
    expect(report.facts.map((fact) => fact.exportedName)).toEqual(['value', 'renamedValue']);
    expect(report.configFacts).toEqual([]);
    expect(markdown).toContain('### `index.ts`');
    expect(markdown).toContain('- `renamedValue`');
    expect(markdown).toContain('  - Original name: `value`');
    expect(markdown).toContain('  - Module specifier: `./value`');
    expect(manifest).toMatchObject({
      schemaVersion: '0.1.0',
      mode: 'source-truth-local-docs',
      source: {
        input: sourceDir,
        resolvedPath: sourceDir,
        type: 'directory',
      },
      inspection: {
        mode: 'source-truth-local-evidence',
        warnings: [],
      },
      sourceFiles: [
        {
          path: 'index.ts',
          resolvedPath: join(sourceDir, 'index.ts'),
          byteSize: Buffer.byteLength(source),
          hash: `sha256:${createHash('sha256').update(source).digest('hex')}`,
          factCount: 2,
          exportFactCount: 2,
          configFactCount: 0,
          contextFactCount: 0,
        },
      ],
    });
    expect(manifest.generatedOutputs.map((output) => output.path)).toEqual([
      'source-truth-report.json',
      'source-truth.md',
    ]);

    const combinedOutput = `${stdout}\n${stderr}\n${markdown}\n${JSON.stringify(manifest)}`;
    expect(combinedOutput).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(combinedOutput).not.toMatch(/\bofficial\b/i);
    expect(combinedOutput).not.toMatch(/\bverified\b/i);
  });

  it('generates source-truth docs for config-only evidence through the CLI', async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-source-truth-config-cli-'));
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    const packageJson = [
      '{',
      '  "name": "cli-config-only",',
      '  "version": "1.0.0",',
      '  "scripts": {',
      '    "test": "vitest"',
      '  }',
      '}',
      '',
    ].join('\n');
    await writeFile(join(sourceDir, 'package.json'), packageJson, 'utf-8');

    const { stdout, stderr } = await runCli([
      'source-truth',
      'generate',
      '--source',
      sourceDir,
      '--output-dir',
      outputDir,
    ]);
    const report = JSON.parse(
      await readFile(join(outputDir, 'source-truth-report.json'), 'utf-8')
    ) as SourceTruthInspectionReport;
    const manifest = JSON.parse(
      await readFile(join(outputDir, 'manifest.json'), 'utf-8')
    ) as SourceTruthDocsManifest;
    const markdown = await readFile(join(outputDir, 'source-truth.md'), 'utf-8');

    expect(stdout).toContain('Source-truth docs generated');
    expect(stdout).toContain('Export facts: 0');
    expect(stdout).toContain(`Package/config facts: ${report.configFacts.length}`);
    expect(stdout).toContain('Context facts: 0');
    expect(stderr).not.toContain('Source-truth generation failed');
    expect(report.facts).toEqual([]);
    expect(report.configFacts.map((fact) => fact.kind)).toEqual([
      'package-name',
      'package-version',
      'package-script-name',
    ]);
    expect(markdown).toContain('## Package And Config Facts');
    expect(markdown).toContain('No TypeScript/JavaScript export facts were observed.');
    expect(manifest.sourceFiles).toMatchObject([
      {
        path: 'package.json',
        factCount: 3,
        exportFactCount: 0,
        configFactCount: 3,
        contextFactCount: 0,
      },
    ]);
  });

  it('generates source-truth docs for context-only evidence through the CLI', async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-source-truth-context-cli-'));
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'out');
    await mkdir(join(sourceDir, 'tests'), { recursive: true });
    const testSource = ['it("keeps evidence path-only", () => {', '  expect(true).toBe(true);', '});', ''].join(
      '\n'
    );
    await writeFile(join(sourceDir, 'tests/path.spec.ts'), testSource, 'utf-8');

    const { stdout, stderr } = await runCli([
      'source-truth',
      'generate',
      '--source',
      sourceDir,
      '--output-dir',
      outputDir,
    ]);
    const report = JSON.parse(
      await readFile(join(outputDir, 'source-truth-report.json'), 'utf-8')
    ) as SourceTruthInspectionReport;
    const manifest = JSON.parse(
      await readFile(join(outputDir, 'manifest.json'), 'utf-8')
    ) as SourceTruthDocsManifest;
    const markdown = await readFile(join(outputDir, 'source-truth.md'), 'utf-8');

    expect(stdout).toContain('Source-truth docs generated');
    expect(stdout).toContain('Export facts: 0');
    expect(stdout).toContain('Package/config facts: 0');
    expect(stdout).toContain('Context facts: 1');
    expect(stderr).not.toContain('Source-truth generation failed');
    expect(report.facts).toEqual([]);
    expect(report.configFacts).toEqual([]);
    expect(report.contextFacts).toMatchObject([
      {
        kind: 'test-file',
        path: 'tests/path.spec.ts',
        evidenceSignals: ['filename-pattern:*.spec.*', 'path-segment:tests'],
        byteSize: Buffer.byteLength(testSource),
        sha256: createHash('sha256').update(testSource).digest('hex'),
        provenance: {
          path: 'tests/path.spec.ts',
          lineRange: { start: 1, end: 3 },
        },
        lineRangeGranularity: 'file',
        order: 1,
      },
    ]);
    expect(markdown).toContain('## Test And Example Context Facts');
    expect(markdown).toContain('### `tests/path.spec.ts`');
    expect(markdown).toContain('- `test-file`');
    expect(markdown).toContain(
      '  - Evidence signals: `filename-pattern:*.spec.*`; `path-segment:tests`'
    );
    expect(manifest.sourceFiles).toMatchObject([
      {
        path: 'tests/path.spec.ts',
        factCount: 1,
        exportFactCount: 0,
        configFactCount: 0,
        contextFactCount: 1,
      },
    ]);

    const combinedOutput = `${stdout}\n${stderr}\n${markdown}\n${JSON.stringify(report)}\n${JSON.stringify(
      manifest
    )}`;
    expect(combinedOutput).not.toContain('expect(true)');
    expect(combinedOutput).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(combinedOutput).not.toMatch(/\bofficial\b/i);
    expect(combinedOutput).not.toMatch(/\bcorrect(?:ness)?\b/i);
    expect(combinedOutput).not.toMatch(/\bverified\b/i);
  });

  it('fails source-truth generation with failure details when no facts are found', async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-source-truth-empty-cli-'));
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'notes.md'), '# Notes\n', 'utf-8');

    const result = await runCliWithExit([
      'source-truth',
      'generate',
      '--source',
      sourceDir,
      '--output-dir',
      outputDir,
    ]);
    const failure = JSON.parse(
      await readFile(join(outputDir, 'failure.json'), 'utf-8')
    ) as SourceTruthDocsFailure;
    const report = JSON.parse(
      await readFile(join(outputDir, 'source-truth-report.json'), 'utf-8')
    ) as SourceTruthInspectionReport;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Source-truth generation failed');
    expect(result.stderr).toContain('Failure report:');
    expect(result.stderr).toContain('Evidence report:');
    await expect(readFile(join(outputDir, 'source-truth.md'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(outputDir, 'manifest.json'), 'utf-8')).rejects.toThrow();
    expect(failure.reason).toBe('no-extractable-source-truth-facts');
    expect(failure.evidenceReport).toEqual({ path: 'source-truth-report.json' });
    expect(report.facts).toEqual([]);
    expect(report.configFacts).toEqual([]);
    expect(report.contextFacts).toEqual([]);
  });

  it('writes a bounded website discovery report from an explicit URL and same-origin well-known resources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-url-discover-'));
    tempDirs.push(dir);

    const { baseUrl, requests } = await startTestServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? ''}`);
      const origin = `http://${request.headers.host ?? ''}`;

      switch (requestUrl.pathname) {
        case '/docs/page':
          writeHttpResponse(
            response,
            200,
            'text/html; charset=utf-8',
            [
              '<!doctype html>',
              '<html>',
              '<head><link rel="canonical" href="/docs/page?view=canonical#section"></head>',
              '<body>',
              '<a href="/docs/api#intro">API</a>',
              '<a href="https://github.com/example/repo">GitHub</a>',
              '<a href="/openapi.json">Spec</a>',
              '<a href="/pricing">Pricing</a>',
              '<a href="/blog">Blog</a>',
              '</body>',
              '</html>',
            ].join('')
          );
          return;
        case '/llms.txt':
          writeHttpResponse(
            response,
            200,
            'text/plain',
            [
              '# Links',
              '',
              '[Guide](/docs/llms-guide.md)',
              'https://external.example/openapi.json',
              '',
            ].join('\n')
          );
          return;
        case '/sitemap.xml':
          writeHttpResponse(
            response,
            200,
            'application/xml',
            [
              '<?xml version="1.0" encoding="UTF-8"?>',
              '<urlset>',
              `<url><loc>${origin}/docs/sitemap-entry</loc></url>`,
              `<url><loc>${origin}/docs/api</loc></url>`,
              '</urlset>',
            ].join('')
          );
          return;
        default:
          writeHttpResponse(
            response,
            500,
            'text/plain',
            `Unexpected request: ${requestUrl.pathname}`
          );
      }
    });

    const outputDir = join(dir, 'reports');
    const explicitUrl = `${baseUrl}/docs/page`;
    const { stdout } = await runCli(['discover', '--url', explicitUrl, '--output-dir', outputDir]);
    const reportPath = join(outputDir, 'discovery-report.json');
    const reportText = await readFile(reportPath, 'utf-8');
    const report = JSON.parse(reportText) as WebsiteDiscoveryReport;

    expect(stdout).toContain('Website discovery');
    expect(stdout).toContain(`URL: ${explicitUrl}`);
    expect(stdout).toContain('Resources inspected: 3');
    expect(stdout).toContain('Candidate URLs: 7');
    expect(stdout).toContain('Warnings: 0');
    expect(stdout).toContain(`Report: ${reportPath}`);
    expect(reportText.endsWith('\n')).toBe(true);
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
    expect(requests.map((requestPath) => new URL(requestPath, baseUrl).pathname)).toEqual([
      '/docs/page',
      '/llms.txt',
      '/sitemap.xml',
    ]);
    expect(report).toMatchObject({
      schemaVersion: '0.2.0',
      mode: 'website-bounded-inspection',
      website: {
        input: explicitUrl,
        normalizedUrl: explicitUrl,
        origin: baseUrl,
      },
      output: {
        reportPath,
      },
      crawlPolicy: {
        inspectedResourceUrls: [explicitUrl, `${baseUrl}/llms.txt`, `${baseUrl}/sitemap.xml`],
        sameOriginWellKnownResources: [`${baseUrl}/llms.txt`, `${baseUrl}/sitemap.xml`],
        linkedCandidateFetches: false,
        renderedJavaScript: false,
        timeoutMs: 10000,
        maxBytesPerResponse: 65536,
        maxCandidates: 200,
        candidateLimitReached: false,
      },
      warnings: [],
    });
    expect(report.inspectedResources).toEqual([
      {
        url: explicitUrl,
        status: 200,
        contentType: 'text/html',
        byteSize: expect.any(Number),
        truncated: false,
        sourceRole: 'explicit-url',
      },
      {
        url: `${baseUrl}/llms.txt`,
        status: 200,
        contentType: 'text/plain',
        byteSize: expect.any(Number),
        truncated: false,
        sourceRole: 'llms-txt',
      },
      {
        url: `${baseUrl}/sitemap.xml`,
        status: 200,
        contentType: 'application/xml',
        byteSize: expect.any(Number),
        truncated: false,
        sourceRole: 'sitemap-xml',
      },
    ]);
    expect(report.candidates.map((candidate) => candidate.url)).toEqual([
      `${baseUrl}/docs/page?view=canonical`,
      `${baseUrl}/docs/api`,
      'https://github.com/example/repo',
      `${baseUrl}/openapi.json`,
      `${baseUrl}/docs/llms-guide.md`,
      'https://external.example/openapi.json',
      `${baseUrl}/docs/sitemap-entry`,
    ]);
    expect(report.candidates.map((candidate) => candidate.url)).not.toContain(`${baseUrl}/pricing`);
    expect(report.candidates.map((candidate) => candidate.url)).not.toContain(`${baseUrl}/blog`);
    expect(report.candidates.map((candidate) => candidate.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const apiCandidate = report.candidates.find(
      (candidate) => candidate.url === `${baseUrl}/docs/api`
    );
    expect(apiCandidate).toMatchObject({
      sameOrigin: true,
      external: false,
      evidence: {
        relations: ['link', 'sitemap-loc'],
        flags: ['docs-like-url'],
      },
    });
    expect(apiCandidate?.sourceResources).toEqual([
      {
        url: explicitUrl,
        sourceRole: 'explicit-url',
        evidence: 'link',
      },
      {
        url: `${baseUrl}/sitemap.xml`,
        sourceRole: 'sitemap-xml',
        evidence: 'sitemap-loc',
      },
    ]);

    const githubCandidate = report.candidates.find(
      (candidate) => candidate.url === 'https://github.com/example/repo'
    );
    expect(githubCandidate?.evidence.flags).toEqual(['github-url']);
    expect(githubCandidate?.sameOrigin).toBe(false);
    expect(githubCandidate?.external).toBe(true);

    const specCandidate = report.candidates.find(
      (candidate) => candidate.url === `${baseUrl}/openapi.json`
    );
    expect(specCandidate?.evidence.flags).toEqual(['machine-readable-url']);
    expect(specCandidate?.evidence.signals).toContain('path:machine-readable-like');
  });

  it('rejects unsupported website URL schemes with a non-zero exit', async () => {
    const result = await runCliWithExit(['discover', '--url', 'ftp://example.com/docs']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Discovery failed: Unsupported URL scheme for discover --url');
    expect(result.stderr).toContain('ftp:');
  });

  it('rejects malformed website URLs with a non-zero exit', async () => {
    const result = await runCliWithExit(['discover', '--url', 'not-a-url']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Discovery failed: Malformed URL for discover --url');
    expect(result.stderr).not.toContain('not-a-url');
  });

  it('rejects malformed credential-like website URLs without echoing userinfo', async () => {
    const result = await runCliWithExit(['discover', '--url', 'https://user:secret@']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Discovery failed: Malformed URL for discover --url');
    expect(result.stderr).not.toContain('user:secret');
    expect(result.stderr).not.toContain('secret');
  });

  it('rejects explicit website URLs with embedded credentials without echoing userinfo', async () => {
    const result = await runCliWithExit([
      'discover',
      '--url',
      'https://user:secret@example.com/docs',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Discovery failed: Embedded credentials are not supported in discover --url.'
    );
    expect(result.stderr).not.toContain('user:secret');
    expect(result.stderr).not.toContain('secret@example.com');
  });

  it('validates discover input exclusivity and repo-only options', async () => {
    const noInput = await runCliWithExit(['discover']);
    const sourceAndUrl = await runCliWithExit([
      'discover',
      '--source',
      '.',
      '--url',
      'https://example.com/docs',
    ]);
    const repoAndUrl = await runCliWithExit([
      'discover',
      '--repo',
      'https://github.com/example/repo',
      '--url',
      'https://example.com/docs',
    ]);
    const urlWithScope = await runCliWithExit([
      'discover',
      '--url',
      'https://example.com/docs',
      '--scope',
      'docs',
    ]);
    const urlWithCacheDir = await runCliWithExit([
      'discover',
      '--url',
      'https://example.com/docs',
      '--cache-dir',
      'cache',
    ]);

    expect(noInput.exitCode).toBe(1);
    expect(noInput.stderr).toContain(
      'Discovery failed: discover requires exactly one of --source, --repo, or --url.'
    );
    expect(sourceAndUrl.exitCode).toBe(1);
    expect(sourceAndUrl.stderr).toContain(
      'Discovery failed: discover requires exactly one of --source, --repo, or --url.'
    );
    expect(repoAndUrl.exitCode).toBe(1);
    expect(repoAndUrl.stderr).toContain(
      'Discovery failed: discover requires exactly one of --source, --repo, or --url.'
    );
    expect(urlWithScope.exitCode).toBe(1);
    expect(urlWithScope.stderr).toContain(
      'Discovery failed: discover --scope and --cache-dir are only supported with --repo.'
    );
    expect(urlWithCacheDir.exitCode).toBe(1);
    expect(urlWithCacheDir.stderr).toContain(
      'Discovery failed: discover --scope and --cache-dir are only supported with --repo.'
    );
  }, 20000);

  it('warns without failing when same-origin well-known resources return non-2xx responses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-url-404-'));
    tempDirs.push(dir);

    const { baseUrl } = await startTestServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? ''}`);

      if (requestUrl.pathname === '/docs/page') {
        writeHttpResponse(
          response,
          200,
          'text/html',
          '<html><body><a href="/docs/reference">Reference</a></body></html>'
        );
        return;
      }

      writeHttpResponse(response, 404, 'text/plain', 'not found');
    });

    const outputDir = join(dir, 'reports');
    const { stdout, stderr } = await runCli([
      'discover',
      '--url',
      `${baseUrl}/docs/page`,
      '--output-dir',
      outputDir,
    ]);
    const report = JSON.parse(
      await readFile(join(outputDir, 'discovery-report.json'), 'utf-8')
    ) as WebsiteDiscoveryReport;

    expect(stdout).toContain('Website discovery');
    expect(stdout).toContain('Warnings: 2');
    expect(stderr).toContain(
      `Warning: Non-2xx HTTP 404 for llms-txt resource: ${baseUrl}/llms.txt`
    );
    expect(stderr).toContain(
      `Warning: Non-2xx HTTP 404 for sitemap-xml resource: ${baseUrl}/sitemap.xml`
    );
    expect(report.inspectedResources.map((resource) => resource.status)).toEqual([200, 404, 404]);
    expect(report.warnings).toContain(
      `Non-2xx HTTP 404 for llms-txt resource: ${baseUrl}/llms.txt`
    );
    expect(report.warnings).toContain(
      `Non-2xx HTTP 404 for sitemap-xml resource: ${baseUrl}/sitemap.xml`
    );
    expect(report.candidates.map((candidate) => candidate.url)).toEqual([
      `${baseUrl}/docs/reference`,
    ]);
  });

  it('enforces the per-resource timeout through body reads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-url-timeout-'));
    tempDirs.push(dir);

    const { baseUrl } = await startTestServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? ''}`);

      if (requestUrl.pathname === '/docs/slow') {
        response.on('error', () => undefined);
        response.writeHead(200, { 'content-type': 'text/html' });
        response.write('<html><body>');
        setTimeout(() => {
          if (!response.destroyed) {
            response.end('<a href="/docs/late">Late</a></body></html>');
          }
        }, 500);
        return;
      }

      if (requestUrl.pathname === '/llms.txt') {
        writeHttpResponse(response, 200, 'text/plain', '');
        return;
      }

      if (requestUrl.pathname === '/sitemap.xml') {
        writeHttpResponse(response, 200, 'application/xml', '<urlset></urlset>');
        return;
      }

      writeHttpResponse(response, 404, 'text/plain', 'not found');
    });

    const startedAt = Date.now();
    const { report } = await discoverWebsite({
      url: `${baseUrl}/docs/slow`,
      outputDir: join(dir, 'reports'),
      timeoutMs: 50,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1000);
    expect(report.inspectedResources[0]).toMatchObject({
      url: `${baseUrl}/docs/slow`,
      status: 200,
      contentType: 'text/html',
      truncated: false,
      sourceRole: 'explicit-url',
    });
    expect(report.inspectedResources[0]?.byteSize).toBeGreaterThan(0);
    expect(report.warnings).toContain(
      `Fetch failed for explicit-url resource: ${baseUrl}/docs/slow. Timed out after 50 ms`
    );
    expect(report.candidates.map((candidate) => candidate.url)).not.toContain(
      `${baseUrl}/docs/late`
    );
  });

  it('warns and skips extracted candidate URLs with unsupported schemes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-url-candidate-schemes-'));
    tempDirs.push(dir);

    const { baseUrl } = await startTestServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? ''}`);

      switch (requestUrl.pathname) {
        case '/docs/page':
          writeHttpResponse(
            response,
            200,
            'text/html',
            [
              '<html><body>',
              '<a href="mailto:test@example.com">Mail</a>',
              '<a href="ftp://example.com/file">FTP</a>',
              '<a href="javascript:alert(1)">Script</a>',
              '<a href="https://user:leaky-secret@">Malformed credential candidate</a>',
              '<a href="https://user:secret@example.com/docs/private">Credential candidate</a>',
              '</body></html>',
            ].join('')
          );
          return;
        case '/llms.txt':
          writeHttpResponse(response, 200, 'text/plain', '');
          return;
        case '/sitemap.xml':
          writeHttpResponse(response, 200, 'application/xml', '<urlset></urlset>');
          return;
        default:
          writeHttpResponse(response, 404, 'text/plain', 'not found');
      }
    });

    const outputDir = join(dir, 'reports');
    const { stderr } = await runCli([
      'discover',
      '--url',
      `${baseUrl}/docs/page`,
      '--output-dir',
      outputDir,
    ]);
    const reportText = await readFile(join(outputDir, 'discovery-report.json'), 'utf-8');
    const report = JSON.parse(reportText) as WebsiteDiscoveryReport;

    expect(stderr).toContain(
      'Warning: Skipped unsupported candidate URL scheme mailto: in explicit-url resource.'
    );
    expect(stderr).toContain(
      'Warning: Skipped unsupported candidate URL scheme ftp: in explicit-url resource.'
    );
    expect(stderr).toContain(
      'Warning: Skipped unsupported candidate URL scheme javascript: in explicit-url resource.'
    );
    expect(stderr).toContain('Warning: Skipped malformed candidate URL in explicit-url resource.');
    expect(report.warnings).toContain(
      'Scrubbed embedded credentials from candidate URL in explicit-url resource.'
    );
    expect(report.warnings).toContain('Skipped malformed candidate URL in explicit-url resource.');
    expect(report.candidates.map((candidate) => candidate.url)).toEqual([
      'https://example.com/docs/private',
    ]);
    expect(stderr).not.toContain('leaky-secret');
    expect(reportText).not.toContain('user:secret');
    expect(reportText).not.toContain('secret@example.com');
    expect(reportText).not.toContain('leaky-secret');
    expect(reportText).not.toContain('javascript:alert');
  });

  it('reports candidate limit behavior without fetching linked candidates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-url-candidate-limit-'));
    tempDirs.push(dir);

    const { baseUrl, requests } = await startTestServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? ''}`);

      switch (requestUrl.pathname) {
        case '/docs/page':
          writeHttpResponse(
            response,
            200,
            'text/html',
            [
              '<html><body>',
              '<a href="/docs/one">One</a>',
              '<a href="/docs/two">Two</a>',
              '<a href="/docs/three">Three</a>',
              '<a href="/docs/four">Four</a>',
              '</body></html>',
            ].join('')
          );
          return;
        case '/llms.txt':
          writeHttpResponse(response, 200, 'text/plain', '');
          return;
        case '/sitemap.xml':
          writeHttpResponse(response, 200, 'application/xml', '<urlset></urlset>');
          return;
        default:
          writeHttpResponse(
            response,
            500,
            'text/plain',
            `Unexpected request: ${requestUrl.pathname}`
          );
      }
    });

    const { report } = await discoverWebsite({
      url: `${baseUrl}/docs/page`,
      outputDir: join(dir, 'reports'),
      maxCandidates: 2,
    });

    expect(requests.map((requestPath) => new URL(requestPath, baseUrl).pathname)).toEqual([
      '/docs/page',
      '/llms.txt',
      '/sitemap.xml',
    ]);
    expect(report.crawlPolicy).toMatchObject({
      maxCandidates: 2,
      candidateLimitReached: true,
      linkedCandidateFetches: false,
      renderedJavaScript: false,
    });
    expect(report.candidates.map((candidate) => candidate.url)).toEqual([
      `${baseUrl}/docs/one`,
      `${baseUrl}/docs/two`,
    ]);
    expect(report.warnings).toContain(
      'Candidate limit reached: 2; additional normalized URLs were not recorded.'
    );
  });

  it('writes fetch failure warnings without crashing when resources cannot connect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-url-fetch-failure-'));
    tempDirs.push(dir);

    const port = await reserveUnusedLocalPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const { report } = await discoverWebsite({
      url: `${baseUrl}/docs/page`,
      outputDir: join(dir, 'reports'),
      timeoutMs: 200,
    });

    expect(report.inspectedResources).toEqual([
      {
        url: `${baseUrl}/docs/page`,
        status: null,
        contentType: null,
        byteSize: 0,
        truncated: false,
        sourceRole: 'explicit-url',
      },
      {
        url: `${baseUrl}/llms.txt`,
        status: null,
        contentType: null,
        byteSize: 0,
        truncated: false,
        sourceRole: 'llms-txt',
      },
      {
        url: `${baseUrl}/sitemap.xml`,
        status: null,
        contentType: null,
        byteSize: 0,
        truncated: false,
        sourceRole: 'sitemap-xml',
      },
    ]);
    expect(report.candidates).toEqual([]);
    expect(report.warnings).toHaveLength(3);
    expect(report.warnings[0]).toContain(
      `Fetch failed for explicit-url resource: ${baseUrl}/docs/page.`
    );
    expect(report.warnings[1]).toContain(
      `Fetch failed for llms-txt resource: ${baseUrl}/llms.txt.`
    );
    expect(report.warnings[2]).toContain(
      `Fetch failed for sitemap-xml resource: ${baseUrl}/sitemap.xml.`
    );
  });

  it('warns and skips parsing resources with unsupported content types', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-url-content-type-'));
    tempDirs.push(dir);

    const { baseUrl } = await startTestServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? ''}`);

      if (requestUrl.pathname === '/data') {
        writeHttpResponse(response, 200, 'application/json', '{"links":["/docs/reference"]}');
        return;
      }

      writeHttpResponse(response, 404, 'text/plain', 'not found');
    });

    const outputDir = join(dir, 'reports');
    const { stderr } = await runCli([
      'discover',
      '--url',
      `${baseUrl}/data`,
      '--output-dir',
      outputDir,
    ]);
    const report = JSON.parse(
      await readFile(join(outputDir, 'discovery-report.json'), 'utf-8')
    ) as WebsiteDiscoveryReport;

    expect(stderr).toContain(
      `Warning: Unsupported content type for explicit-url resource: application/json at ${baseUrl}/data`
    );
    expect(report.candidates).toEqual([]);
    expect(report.warnings).toContain(
      `Unsupported content type for explicit-url resource: application/json at ${baseUrl}/data`
    );
  });

  it('does not make unsupported source authority claims in website discovery output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-url-claims-'));
    tempDirs.push(dir);

    const { baseUrl } = await startTestServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? ''}`);

      switch (requestUrl.pathname) {
        case '/docs/page':
          writeHttpResponse(
            response,
            200,
            'text/html',
            '<html><body><a href="/docs/reference">Reference</a></body></html>'
          );
          return;
        case '/llms.txt':
          writeHttpResponse(response, 200, 'text/plain', '[Guide](/docs/guide.md)\n');
          return;
        case '/sitemap.xml':
          writeHttpResponse(response, 200, 'application/xml', '<urlset></urlset>');
          return;
        default:
          writeHttpResponse(response, 404, 'text/plain', 'not found');
      }
    });

    const outputDir = join(dir, 'reports');
    const { stdout, stderr } = await runCli([
      'discover',
      '--url',
      `${baseUrl}/docs/page`,
      '--output-dir',
      outputDir,
    ]);
    const reportText = await readFile(join(outputDir, 'discovery-report.json'), 'utf-8');
    const combinedOutput = `${stdout}\n${stderr}\n${reportText}`;

    expect(combinedOutput).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(combinedOutput).not.toMatch(/\bofficial\b/i);
    expect(combinedOutput).not.toMatch(/\bscore\b/i);
    expect(combinedOutput).not.toMatch(/\bselected\b/i);
    expect(combinedOutput).not.toMatch(/\bsource[-\s]?truth\b/i);
  });

  it('reports truncated website resources when response bytes exceed the cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-url-truncated-'));
    tempDirs.push(dir);

    const { baseUrl } = await startTestServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? ''}`);

      if (requestUrl.pathname === '/docs/page') {
        writeHttpResponse(
          response,
          200,
          'text/html',
          `<html><body><a href="/docs/first">First</a>${'x'.repeat(
            70_000
          )}<a href="/docs/late">Late</a></body></html>`
        );
        return;
      }

      writeHttpResponse(response, 404, 'text/plain', 'not found');
    });

    const outputDir = join(dir, 'reports');
    const { stderr } = await runCli([
      'discover',
      '--url',
      `${baseUrl}/docs/page`,
      '--output-dir',
      outputDir,
    ]);
    const report = JSON.parse(
      await readFile(join(outputDir, 'discovery-report.json'), 'utf-8')
    ) as WebsiteDiscoveryReport;

    expect(stderr).toContain(
      `Warning: Response truncated at 65536 bytes for explicit-url resource: ${baseUrl}/docs/page`
    );
    expect(report.inspectedResources[0]).toMatchObject({
      url: `${baseUrl}/docs/page`,
      status: 200,
      contentType: 'text/html',
      byteSize: 65536,
      truncated: true,
      sourceRole: 'explicit-url',
    });
    expect(report.warnings).toContain(
      `Response truncated at 65536 bytes for explicit-url resource: ${baseUrl}/docs/page`
    );
    expect(report.candidates.map((candidate) => candidate.url)).toContain(`${baseUrl}/docs/first`);
    expect(report.candidates.map((candidate) => candidate.url)).not.toContain(
      `${baseUrl}/docs/late`
    );
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
      schemaVersion: '0.2.0',
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
      'docs/openapi.json',
      'README.md',
      'docs/guide.md',
    ]);
    expect(report.candidates.map((candidate) => candidate.order)).toEqual([1, 2, 3]);
    expect(report.candidates.map((candidate) => candidate.evidence.category)).toEqual([
      'machine-readable-spec',
      'structured-doc-source',
      'structured-doc-source',
    ]);
    expect(report.candidates[0]?.evidence.signals).toContain('content:openapi-field');
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
      'openapi.json',
      'guide.md',
    ]);
    expect(report.candidates.map((candidate) => candidate.order)).toEqual([1, 2]);
    expect(report.candidates.map((candidate) => candidate.evidence.category)).toEqual([
      'machine-readable-spec',
      'structured-doc-source',
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
    await writeFile(join(sourceDir, 'b-openapi.json'), '{"openapi":"3.1.0"}\n', 'utf-8');
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
    expect(report.candidates.map((candidate) => candidate.path)).toEqual([
      'b-openapi.json',
      'a.md',
    ]);
    expect(report.candidates.map((candidate) => candidate.order)).toEqual([1, 2]);
    expect(report.candidates.map((candidate) => candidate.evidence.category)).toEqual([
      'machine-readable-spec',
      'structured-doc-source',
    ]);
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
    ) as {
      info: {
        id: string;
        title: string;
        description: string;
      };
      operations: Array<{
        id: string;
        title: string;
        description: string;
        notes: string;
        examples: Array<{
          id: string;
          name: string;
          code: string;
          description: string;
          dataSql: string;
          response: string;
          isSpotlight: boolean;
        }>;
        overwriteParams: unknown[];
      }>;
    };
    expect(parsedSpec.info).toMatchObject({
      id: 'swift',
      title: 'Supabase Swift SDK',
      description: 'Test fixture',
    });
    expect(parsedSpec.operations).toHaveLength(1);
    expect(parsedSpec.operations[0]).toMatchObject({
      id: 'select',
      title: 'Select data',
      description: 'Read rows',
      notes: '',
      overwriteParams: [],
    });
    expect(parsedSpec.operations[0]?.examples).toEqual([
      {
        id: 'select-basic',
        name: 'Basic select',
        code: 'supabase.from("todos").select()',
        description: '',
        dataSql: '',
        response: '',
        isSpotlight: false,
      },
    ]);

    const fullDoc = await readFile(
      join(outputDir, 'swift/v2/llm-docs/supabase-swift-v2-full-llms.txt'),
      'utf-8'
    );
    expect(fullDoc).toContain(
      '<SYSTEM>This is the complete developer documentation for Supabase Swift SDK v2.</SYSTEM>'
    );
    expect(fullDoc).toContain('# Supabase Swift SDK v2 Reference');
    expect(fullDoc).toContain(
      `<!-- Generated from: ${join(configDir, 'supabase_swift_v2.yml')} -->`
    );
    expect(fullDoc).not.toContain('<!-- Generated from:  -->');
    expect(fullDoc).toContain('<!-- SDK: swift, Version: v2, Generated: ');
    expect(fullDoc).toContain('## 1. Database');
    expect(fullDoc).toContain('### 1.1. Select data');
    expect(fullDoc).toContain('#### 1.1.1. Basic select');
    expect(fullDoc).toContain('Read rows');
    expect(fullDoc).toContain('supabase.from("todos").select()');

    const moduleDoc = await readFile(
      join(outputDir, 'swift/v2/llm-docs/supabase-swift-v2-database-llms.txt'),
      'utf-8'
    );
    expect(moduleDoc).toContain(
      '<SYSTEM>Database operations for Supabase Swift SDK v2.</SYSTEM>'
    );
    expect(moduleDoc).toContain('# Supabase Swift SDK v2 Database Documentation');
    expect(moduleDoc).toContain('Database operations');
    expect(moduleDoc).toContain('# 1. Select data');
    expect(moduleDoc).toContain('## 1.1. Basic select');
    expect(moduleDoc).toContain('supabase.from("todos").select()');

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
    expect(outputPaths).toEqual([...outputPaths].sort(compareStringsByCodeUnit));
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
      const text = await readFile(actualPath, 'utf-8');
      expect(output.byteSize).toBe(await byteSize(actualPath));
      expect(output.hash).toBe(await sha256File(actualPath));
      expect(output.lineCount).toBe(countTextLines(text));
      expect(output.estimatedTokenCount).toBe(estimateTextTokens(text));
    }
  });

  it.each(['openref', 'openref-0.1'])(
    'accepts --format %s for configured OpenRef SDK generation',
    async (format) => {
      const configDir = await createTestConfig();
      const outputDir = join(configDir, 'output');

      const { stdout } = await runCli([
        'generate',
        '--sdk',
        'swift',
        '--sdk-version',
        'v2',
        '--format',
        format,
        '--config-dir',
        configDir,
        '--output-dir',
        outputDir,
      ]);

      const manifestPath = join(outputDir, 'swift/v2/manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as GenerationManifest;

      expect(stdout).toContain('Processing 1 SDK/version pair');
      expect(stdout).toContain('Generation complete!');
      expect(stdout).toContain('Successful: 1');
      expect(manifest.mode).toBe('configured-sdk');
      expect(manifest.source.format).toBe('openref-0.1');
      expect(manifest.parser.format).toBe('openref-0.1');
      expect(await pathExists(join(outputDir, 'swift/v2/parsed/swift-v2-spec.json'))).toBe(true);
      expect(
        await pathExists(join(outputDir, 'swift/v2/llm-docs/supabase-swift-v2-full-llms.txt'))
      ).toBe(true);
    }
  );

  it('rejects unsupported generate --format values before configured SDK generation', async () => {
    const configDir = await createTestConfig();
    const outputDir = join(configDir, 'output');

    const result = await runCliWithExit([
      'generate',
      '--sdk',
      'swift',
      '--sdk-version',
      'v2',
      '--format',
      'markdown',
      '--config-dir',
      configDir,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Generate failed: --format markdown is not supported for configured generate --sdk'
    );
    expect(result.stderr).toContain(
      'General generate --source and preset generation are planned/unsupported in the current CLI.'
    );
    expect(result.stderr).toContain(
      'source-truth generate --source <path> --output-dir <dir>'
    );
    expect(result.stdout).not.toContain('Processing');
    expect(await pathExists(outputDir)).toBe(false);
    expect(await findManifestFiles(configDir)).toEqual([]);
  });

  it('rejects generate --format openref without --sdk before config or output work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-format-no-sdk-'));
    tempDirs.push(dir);
    const configDir = join(dir, 'missing-config');
    const outputDir = join(dir, 'output');

    const result = await runCliWithExit([
      'generate',
      '--format',
      'openref',
      '--config-dir',
      configDir,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Generate failed: generate requires --sdk for the current configured OpenRef SDK path.'
    );
    expect(result.stderr).toContain(
      'Current supported generation mode: generate --sdk <sdk> [--sdk-version <version>] [--format openref|openref-0.1].'
    );
    expect(result.stderr).toContain(
      'General generate --source and preset generation are planned/unsupported in the current CLI.'
    );
    expect(result.stderr).not.toContain('Fatal error');
    expect(result.stderr).not.toContain(configDir);
    expect(result.stdout).not.toContain('Processing');
    expect(await pathExists(outputDir)).toBe(false);
    expect(await pathExists(configDir)).toBe(false);
  });

  it('rejects whitespace-only generate --sdk before config or output work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-blank-sdk-'));
    tempDirs.push(dir);
    const configDir = join(dir, 'missing-config');
    const outputDir = join(dir, 'output');

    const result = await runCliWithExit([
      'generate',
      '--sdk',
      '   ',
      '--format',
      'openref',
      '--config-dir',
      configDir,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Generate failed: generate requires --sdk for the current configured OpenRef SDK path.'
    );
    expect(result.stderr).toContain(
      'Current supported generation mode: generate --sdk <sdk> [--sdk-version <version>] [--format openref|openref-0.1].'
    );
    expect(result.stderr).not.toContain('Fatal error');
    expect(result.stderr).not.toContain(configDir);
    expect(result.stdout).not.toContain('Processing');
    expect(await pathExists(outputDir)).toBe(false);
    expect(await pathExists(configDir)).toBe(false);
  });

  it('rejects plain generate before config or output work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-no-options-'));
    tempDirs.push(dir);
    const configDir = join(dir, 'missing-config');
    const outputDir = join(dir, 'output');

    const result = await runCliWithExit([
      'generate',
      '--config-dir',
      configDir,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Generate failed: generate requires --sdk for the current configured OpenRef SDK path.'
    );
    expect(result.stderr).toContain(
      'Current supported generation mode: generate --sdk <sdk> [--sdk-version <version>] [--format openref|openref-0.1].'
    );
    expect(result.stderr).not.toContain('Fatal error');
    expect(result.stderr).not.toContain(configDir);
    expect(result.stdout).not.toContain('Processing');
    expect(await pathExists(outputDir)).toBe(false);
    expect(await pathExists(configDir)).toBe(false);
  });

  it('rejects generate --preset honestly without requiring configured SDK generation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-preset-'));
    tempDirs.push(dir);
    const outputDir = join(dir, 'output');

    const result = await runCliWithExit([
      'generate',
      '--preset',
      'swift-book',
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Generate failed: generate --preset is not implemented for the current configured SDK path.'
    );
    expect(result.stderr).toContain(
      'General generate --source and preset generation are planned/unsupported in the current CLI.'
    );
    expect(result.stderr).toContain('generate --sdk <sdk>');
    expect(result.stdout).not.toContain('Processing');
    expect(await pathExists(outputDir)).toBe(false);
  });

  it('rejects generate --preset before configured SDK generation even with sdk and format', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-preset-with-sdk-'));
    tempDirs.push(dir);
    const configDir = join(dir, 'missing-config');
    const outputDir = join(dir, 'output');

    const result = await runCliWithExit([
      'generate',
      '--preset',
      'swift-book',
      '--sdk',
      'swift',
      '--format',
      'openref',
      '--config-dir',
      configDir,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Generate failed: generate --preset is not implemented for the current configured SDK path.'
    );
    expect(result.stderr).toContain(
      'General generate --source and preset generation are planned/unsupported in the current CLI.'
    );
    expect(result.stderr).not.toContain('Fatal error');
    expect(result.stderr).not.toContain(configDir);
    expect(result.stdout).not.toContain('Processing');
    expect(await pathExists(outputDir)).toBe(false);
    expect(await pathExists(configDir)).toBe(false);
  });

  it('rejects top-level generate --source without implying source generation is implemented', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-source-'));
    tempDirs.push(dir);
    const outputDir = join(dir, 'output');

    const result = await runCliWithExit([
      'generate',
      '--source',
      './docs',
      '--format',
      'markdown',
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Generate failed: top-level general generate --source is not implemented.'
    );
    expect(result.stderr).toContain(
      'General generate --source and preset generation are planned/unsupported in the current CLI.'
    );
    expect(result.stderr).toContain(
      'source-truth generate --source <path> --output-dir <dir>'
    );
    expect(result.stdout).not.toContain('Processing');
    expect(await pathExists(outputDir)).toBe(false);
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

  it('rejects invalid optional generated output RAG metadata before checking files', async () => {
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
              kind: 'llm-docs',
              byteSize: await byteSize(outputPath),
              hash: await sha256File(outputPath),
              lineCount: -1,
              estimatedTokenCount: -1,
            },
            {
              path: 'llm-docs/output.txt',
              kind: 'llm-docs',
              byteSize: await byteSize(outputPath),
              hash: await sha256File(outputPath),
              lineCount: 1.5,
              estimatedTokenCount: 2.5,
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
    expect(result.stderr).toContain('output[0].lineCount must be a non-negative integer');
    expect(result.stderr).toContain(
      'output[0].estimatedTokenCount must be a non-negative integer'
    );
    expect(result.stderr).toContain('output[1].lineCount must be a non-negative integer');
    expect(result.stderr).toContain(
      'output[1].estimatedTokenCount must be a non-negative integer'
    );
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
