/**
 * CLI regression tests for documented compatibility commands.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
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
import type {
  SourceVerificationFailure,
  SourceVerificationManifest,
  SourceVerificationReport,
} from '../../src/core/source-verification.js';
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
const repoPathRestorations: Array<{ originalPath: string; backupPath: string }> = [];
const repoContentRestorations: Array<{ path: string; content: string }> = [];
interface ManifestFileEntry {
  path: string;
  kind: string;
  name?: string;
  byteSize: number;
  hash: string;
  lineCount?: number;
  estimatedTokenCount?: number;
}

interface SemanticChunkManifestIndex {
  path: string;
  format: string;
  chunkCount: number;
  aggregateHash: string;
  warningCount: number;
  chunks: Array<{
    id: string;
    order: number;
    title: string;
    path: string[];
    nodePath: string[];
    contentHash: string;
    characterCount: number;
    estimatedTokenCount: number;
    sourceFormat?: string;
    sourcePath?: string;
    warningCount: number;
  }>;
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
    plugin?: {
      manifestPath: string;
      resolvedManifestPath: string;
      manifestByteSize: number;
      manifestHash: string;
      name: string;
      version: string;
      module: {
        path: string;
        resolvedPath: string;
      };
      format: {
        id: string;
        displayName: string;
        extensions: string[];
        mediaTypes?: string[];
        directorySupport?: boolean;
      };
      execution: {
        codeExecuted: true;
        trust: string;
        sandboxed: false;
        statement: string;
      };
    };
  };
  formatter: {
    name: string;
    version: string;
    format: string;
  };
  generatedOutputs: ManifestFileEntry[];
  warnings: string[];
}

interface SourceDocsManifest {
  schemaVersion: string;
  generatedAt: string;
  generator: {
    name: string;
    version: string;
    cliName: string;
  };
  mode: string;
  source: {
    input: string;
    resolvedPath: string;
    type: string;
    formatHint: string;
    resolvedFormat: string;
    byteSize?: number;
    hash?: string;
    fileCount?: number;
    aggregateHash?: string;
  };
  sourceFiles: Array<{
    path: string;
    resolvedPath: string;
    byteSize: number;
    hash: string;
    lineCount: number;
    estimatedTokenCount: number;
    format: string;
  }>;
  parser: {
    name: string;
    version: string;
    format: string;
    plugin?: {
      manifestPath: string;
      resolvedManifestPath: string;
      manifestByteSize: number;
      manifestHash: string;
      name: string;
      version: string;
      module: {
        path: string;
        resolvedPath: string;
      };
      format: {
        id: string;
        displayName: string;
        extensions: string[];
        mediaTypes?: string[];
        directorySupport?: boolean;
      };
      execution: {
        codeExecuted: true;
        trust: string;
        sandboxed: false;
        statement: string;
      };
    };
  };
  formatter: {
    name: string;
    version: string;
    format: string;
  };
  generatedOutputs: ManifestFileEntry[];
  semanticChunkIndexes?: SemanticChunkManifestIndex[];
  preset?: {
    name: string;
    configPath: string;
    displayName: string;
    description?: string;
    defaults: {
      format: string;
      filenamePrefix: string;
      title: string;
      systemPrompt: string;
      outputFormats?: string[];
    };
    metadata?: Record<string, unknown>;
    limitations: string[];
  };
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

interface DiscoveryReportManifest {
  schemaVersion: string;
  generator: {
    name: string;
    version: string;
    cliName: string;
  };
  mode: string;
  discovery: {
    kind: string;
    reportPath: string;
    reportSchemaVersion: string;
    reportMode: string;
    candidateCount: number;
    warningCount: number;
    urlResourceCount?: number;
  };
  candidateEvidenceIndex?: CandidateEvidenceManifestIndex;
  generatedOutputs: ManifestFileEntry[];
}

interface CandidateEvidenceManifestIndex {
  candidateCount: number;
  aggregateHash: string;
  context: Record<string, unknown>;
  candidates: Array<{
    path?: string;
    url?: string;
    order: number;
    kind?: string;
    format?: string;
    hints?: string[];
    formatHints?: string[];
    evidence: {
      category?: string;
      signals?: string[];
      relations?: string[];
      flags?: string[];
    };
    byteSize?: number;
    sha256?: string;
    sameOrigin?: boolean;
    external?: boolean;
    sourceResources?: Array<{
      url: string;
      sourceRole: string;
      evidence: string;
    }>;
  }>;
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

interface AgentDoctorContract {
  schemaVersion: string;
  mode: string;
  generator: {
    packageName: string;
    packageVersion: string;
    cliName: string;
    binary: string;
  };
  summary: {
    overallStatus: string;
    totalChecks: number;
    passed: number;
    warnings: number;
    failed: number;
    skipped: number;
    hardFailureCount: number;
    packagedArtifactCount: number;
    contextArtifactCount: number;
    skillArtifactCount: number;
    pathBinaryFound: boolean;
  };
  checks: Array<{
    id: string;
    name: string;
    status: string;
    summary: string;
    facts: Record<string, unknown>;
  }>;
  limitations: string[];
}

interface ParserPluginManifestValidationResult {
  schemaVersion: string;
  manifestPath: string;
  valid: boolean;
  manifest?: {
    schemaVersion: string;
    kind: string;
    name: string;
    version: string;
    module: string;
    formats: Array<{
      id: string;
      displayName: string;
      extensions: string[];
      mediaTypes?: string[];
      directorySupport?: boolean;
    }>;
  };
  errors: Array<{
    code: string;
    path: string;
    message: string;
  }>;
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

async function createTestConfig(
  versionOrder: Array<'v1' | 'v2'> = ['v2', 'v1'],
  specFormat = 'openref-0.1'
): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-cli-'));
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
          format: specFormat,
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

async function runCliWithEnv(
  args: string[],
  envOverrides: NodeJS.ProcessEnv,
  cwd = repoRoot
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [tsxBin, cliPath, ...args], {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: '1',
      ...envOverrides,
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

function aggregateSourceFilesHashForTest(files: SourceDocsManifest['sourceFiles']): string {
  const hash = createHash('sha256');
  hash.update('llm-docs-generator:source-docs-directory:v1\n');

  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.byteSize));
    hash.update('\0');
    hash.update(file.hash);
    hash.update('\n');
  }

  return `sha256:${hash.digest('hex')}`;
}

async function createParserPluginFixture(options: {
  dir: string;
  formatId?: string;
  manifestName?: string;
  moduleName?: string;
  moduleSource?: string;
  manifestOverrides?: Record<string, unknown>;
}): Promise<{
  manifestPath: string;
  modulePath: string;
  sideEffectPath: string;
  formatId: string;
}> {
  const formatId = options.formatId ?? 'custom-doc';
  const manifestName = options.manifestName ?? 'parser-plugin.json';
  const moduleName = options.moduleName ?? 'plugin.mjs';
  const manifestPath = join(options.dir, manifestName);
  const modulePath = join(options.dir, moduleName);
  const sideEffectPath = join(options.dir, 'plugin-side-effects.log');
  const moduleSource =
    options.moduleSource ??
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      `const sideEffectPath = ${JSON.stringify(sideEffectPath)};`,
      "appendFileSync(sideEffectPath, 'import\\n');",
      'export const parser = {',
      "  name: 'Fixture Custom Parser',",
      `  format: ${JSON.stringify(formatId)},`,
      '  async detect(sourcePath) {',
      "    appendFileSync(sideEffectPath, 'detect\\n');",
      '    return true;',
      '  },',
      '  async parse(sourcePath) {',
      "    appendFileSync(sideEffectPath, 'parse\\n');",
      "    const sourceText = readFileSync(sourcePath, 'utf-8').trim();",
      '    return {',
      "      type: 'root',",
      "      id: 'fixture-custom-root',",
      "      title: 'Fixture Custom Docs',",
      "      description: '',",
      '      content: [],',
      '      children: [',
      '        {',
      "          type: 'section',",
      "          id: 'fixture-custom-section',",
      "          title: 'Parsed Payload',",
      "          description: '',",
      '          content: [{ type: "prose", content: `Plugin parsed: ${sourceText}` }],',
      '          children: [],',
      "          metadata: new Map([['format', 'custom-doc'], ['sourcePath', sourcePath]]),",
      '        },',
      '      ],',
      "      metadata: new Map([['format', 'custom-doc'], ['sourcePath', sourcePath]]),",
      '    };',
      '  },',
      '};',
      'export default parser;',
      '',
    ].join('\n');

  await mkdir(dirname(modulePath), { recursive: true });
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(modulePath, moduleSource, 'utf-8');
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: '0.1.0',
        kind: 'parser-plugin',
        name: 'fixture-parser-plugin',
        version: '1.2.3',
        module: moduleName,
        formats: [
          {
            id: formatId,
            displayName: 'Fixture Custom Format',
            extensions: ['fixture'],
            mediaTypes: ['text/x-fixture'],
            directorySupport: false,
          },
        ],
        ...options.manifestOverrides,
      },
      null,
      2
    )}\n`,
    'utf-8'
  );

  return { manifestPath, modulePath, sideEffectPath, formatId };
}

function semanticChunkIndexAggregateHashForTest(index: SemanticChunkManifestIndex): string {
  const hash = createHash('sha256');
  hash.update('llm-docs-generator:source-docs-semantic-chunks-jsonl-index:v1\n');
  hash.update(
    JSON.stringify({
      path: index.path,
      format: index.format,
      chunkCount: index.chunkCount,
      warningCount: index.warningCount,
      chunks: index.chunks.map((chunk) => ({
        id: chunk.id,
        order: chunk.order,
        title: chunk.title,
        path: chunk.path,
        nodePath: chunk.nodePath,
        contentHash: chunk.contentHash,
        characterCount: chunk.characterCount,
        estimatedTokenCount: chunk.estimatedTokenCount,
        warningCount: chunk.warningCount,
        ...(chunk.sourceFormat === undefined ? {} : { sourceFormat: chunk.sourceFormat }),
        ...(chunk.sourcePath === undefined ? {} : { sourcePath: chunk.sourcePath }),
      })),
    })
  );
  hash.update('\n');

  return `sha256:${hash.digest('hex')}`;
}

function candidateEvidenceIndexAggregateHashForTest(index: CandidateEvidenceManifestIndex): string {
  const hash = createHash('sha256');
  hash.update('llm-docs-generator:discovery-candidate-evidence-index:v1\n');
  hash.update(
    JSON.stringify({
      candidateCount: index.candidateCount,
      context: index.context,
      candidates: index.candidates,
    })
  );
  hash.update('\n');

  return `sha256:${hash.digest('hex')}`;
}

function expectLocalCandidateEvidenceIndex(
  index: CandidateEvidenceManifestIndex | undefined,
  report: { candidates: DiscoveryCandidate[] },
  expectedContext: CandidateEvidenceManifestIndex['context']
): asserts index is CandidateEvidenceManifestIndex {
  expect(index).toBeDefined();
  expect(index).toMatchObject({
    candidateCount: report.candidates.length,
    context: expectedContext,
  });
  expect(index.aggregateHash).toBe(candidateEvidenceIndexAggregateHashForTest(index));
  expect(index.candidates).toEqual(
    report.candidates.map((candidate) => ({
      path: candidate.path,
      order: candidate.order,
      kind: candidate.kind,
      format: candidate.format,
      ...(candidate.hints.length === 0 ? {} : { hints: candidate.hints }),
      ...(candidate.formatHints.length === 0 ? {} : { formatHints: candidate.formatHints }),
      evidence: candidate.evidence,
      byteSize: candidate.byteSize,
      sha256: candidate.sha256,
    }))
  );
}

function expectWebsiteCandidateEvidenceIndex(
  index: CandidateEvidenceManifestIndex | undefined,
  report: WebsiteDiscoveryReport
): asserts index is CandidateEvidenceManifestIndex {
  expect(index).toBeDefined();
  expect(index).toMatchObject({
    candidateCount: report.candidates.length,
    context: {
      website: report.website,
      crawlPolicy: {
        linkedCandidateFetches: false,
        renderedJavaScript: false,
        inspectedResourceCount: report.inspectedResources.length,
        sameOriginWellKnownResourceCount: report.crawlPolicy.sameOriginWellKnownResources.length,
      },
    },
  });
  expect(index.aggregateHash).toBe(candidateEvidenceIndexAggregateHashForTest(index));
  expect(index.candidates).toEqual(
    report.candidates.map((candidate) => ({
      url: candidate.url,
      order: candidate.order,
      evidence: candidate.evidence,
      sameOrigin: candidate.sameOrigin,
      external: candidate.external,
      ...(candidate.sourceResources.length === 0
        ? {}
        : { sourceResources: candidate.sourceResources }),
    }))
  );
}

function expectCandidateEvidenceIndexHasNoReportContent(
  index: CandidateEvidenceManifestIndex
): void {
  const text = JSON.stringify(index);

  expect(text).not.toContain('Stable docs.');
  expect(text).not.toContain('<h1>Home</h1>');
  expect(text).not.toContain('Readme\\n======');
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

function validConfiguredSdkManifestMetadata(): Pick<
  GenerationManifest,
  'generator' | 'sdk' | 'parser' | 'formatter'
> {
  return {
    generator: {
      name: 'llm-docs-generator',
      version: '1.0.0',
      cliName: 'supabase-llm-docs',
    },
    sdk: {
      name: 'swift',
      resolvedVersion: 'v2',
      displayName: 'Supabase Swift SDK v2',
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
  };
}

async function generateSourceDocsFixture(): Promise<{
  sourceDir: string;
  outputDir: string;
  manifestPath: string;
  manifest: SourceDocsManifest;
}> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-source-verify-'));
  tempDirs.push(dir);
  const sourceDir = join(dir, 'docs');
  const outputDir = join(dir, 'agent-docs');
  const manifestPath = join(outputDir, 'manifest.json');

  await mkdir(join(sourceDir, 'guides'), { recursive: true });
  await writeFile(
    join(sourceDir, 'index.md'),
    '# Local Docs\n\nWelcome to the local docs.\n',
    'utf-8'
  );
  await writeFile(
    join(sourceDir, 'guides/usage.mdx'),
    '# Usage\n\n```ts\nexport const value = 1;\n```\n',
    'utf-8'
  );

  await runCli([
    'generate',
    '--source',
    sourceDir,
    '--format',
    'markdown',
    '--output-dir',
    outputDir,
  ]);

  return {
    sourceDir,
    outputDir,
    manifestPath,
    manifest: JSON.parse(await readFile(manifestPath, 'utf-8')) as SourceDocsManifest,
  };
}

async function generateSourceTruthDocsFixture(prefix = 'llm-docs-source-truth-verify-'): Promise<{
  sourceDir: string;
  outputDir: string;
  manifestPath: string;
  manifest: SourceTruthDocsManifest;
}> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  tempDirs.push(dir);
  const sourceDir = join(dir, 'source');
  const outputDir = join(dir, 'source-truth-docs');
  const manifestPath = join(outputDir, 'manifest.json');

  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
  await writeFile(
    join(sourceDir, 'package.json'),
    ['{', '  "name": "source-truth-fixture",', '  "version": "1.0.0"', '}', ''].join('\n'),
    'utf-8'
  );

  await runCli(['source-truth', 'generate', '--source', sourceDir, '--output-dir', outputDir]);

  return {
    sourceDir,
    outputDir,
    manifestPath,
    manifest: JSON.parse(await readFile(manifestPath, 'utf-8')) as SourceTruthDocsManifest,
  };
}

async function createSourceDiscoveryVerifyFixture(prefix = 'llm-docs-discovery-verify-'): Promise<{
  dir: string;
  sourceDir: string;
  outputDir: string;
  reportPath: string;
  manifestPath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  const sourceDir = join(dir, 'docs');
  const outputDir = join(dir, 'reports');
  const reportPath = join(outputDir, 'discovery-report.json');
  const manifestPath = join(outputDir, 'manifest.json');

  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, 'guide.md'), '# Guide\n\nStable docs.\n', 'utf-8');
  await runCli(['discover', '--source', sourceDir, '--output-dir', outputDir]);

  return {
    dir,
    sourceDir,
    outputDir,
    reportPath,
    manifestPath,
  };
}

async function refreshDiscoveryManifestReportMetadata(
  manifestPath: string,
  reportPath: string
): Promise<DiscoveryReportManifest> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as DiscoveryReportManifest;
  const reportText = await readFile(reportPath, 'utf-8');
  const output = manifest.generatedOutputs[0];

  if (output === undefined) {
    throw new Error('expected discovery manifest output metadata');
  }

  output.byteSize = await byteSize(reportPath);
  output.hash = await sha256File(reportPath);
  output.lineCount = countTextLines(reportText);
  output.estimatedTokenCount = estimateTextTokens(reportText);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  return manifest;
}

async function refreshSourceTruthReportOutputMetadata(
  manifestPath: string,
  reportPath: string
): Promise<SourceTruthDocsManifest> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as SourceTruthDocsManifest;
  const reportText = await readFile(reportPath, 'utf-8');
  const reportOutput = manifest.generatedOutputs.find(
    (output) => output.kind === 'source-truth-report-json'
  );

  if (reportOutput === undefined) {
    throw new Error('expected source-truth report output metadata');
  }

  reportOutput.byteSize = await byteSize(reportPath);
  reportOutput.hash = await sha256File(reportPath);
  reportOutput.lineCount = countTextLines(reportText);
  reportOutput.estimatedTokenCount = estimateTextTokens(reportText);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

  return manifest;
}

async function refreshGeneratedTextOutputMetadata(
  outputPath: string,
  output: ManifestFileEntry
): Promise<void> {
  const outputText = await readFile(outputPath, 'utf-8');

  output.byteSize = await byteSize(outputPath);
  output.hash = await sha256File(outputPath);
  output.lineCount = countTextLines(outputText);
  output.estimatedTokenCount = estimateTextTokens(outputText);
}

async function createSwiftBookSourceFixture(prefix = 'llm-docs-swift-book-'): Promise<{
  dir: string;
  sourceDir: string;
  outputDir: string;
}> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  tempDirs.push(dir);
  const sourceDir = join(dir, 'TSPL.docc');
  const outputDir = join(dir, 'output');

  await mkdir(join(sourceDir, 'LanguageGuide'), { recursive: true });
  await mkdir(join(sourceDir, 'ReferenceManual', 'Declarations'), { recursive: true });
  await writeFile(
    join(sourceDir, 'GuidedTour.md'),
    ['# A Swift Tour', '', 'Swift lets you write expressive code.', ''].join('\n'),
    'utf-8'
  );
  await writeFile(
    join(sourceDir, 'LanguageGuide', 'BasicOperators.md'),
    [
      '# Basic Operators',
      '',
      'Operators are unary, binary, or ternary.',
      '',
      '## Assignment Operator',
      '',
      'Assignment updates a value.',
      '',
    ].join('\n'),
    'utf-8'
  );
  await writeFile(
    join(sourceDir, 'ReferenceManual', 'Declarations', 'Attributes.md'),
    [
      '# Attributes',
      '',
      'Attributes provide more information about declarations.',
      '',
      '## Declaration Attributes',
      '',
      '@available describes platform availability.',
      '',
    ].join('\n'),
    'utf-8'
  );

  return { dir, sourceDir, outputDir };
}

async function createPresetConfigDir(presetConfig: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-preset-config-'));
  tempDirs.push(dir);

  await mkdir(join(dir, 'presets'), { recursive: true });
  await writeFile(
    join(dir, 'presets', 'swift-book.json'),
    `${JSON.stringify(presetConfig, null, 2)}\n`,
    'utf-8'
  );

  return dir;
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

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function restoreRepoPath(restoration: {
  originalPath: string;
  backupPath: string;
}): Promise<void> {
  try {
    await rename(restoration.backupPath, restoration.originalPath);
  } catch (error) {
    if (!isErrnoCode(error, 'ENOENT')) {
      throw error;
    }

    await stat(restoration.originalPath);
  }
}

function forgetRestoration<T>(restorations: T[], restoration: T): void {
  const index = restorations.indexOf(restoration);

  if (index >= 0) {
    restorations.splice(index, 1);
  }
}

afterEach(async () => {
  const pathRestorations = repoPathRestorations.splice(0).reverse();
  for (const restoration of pathRestorations) {
    await restoreRepoPath(restoration);
  }

  const contentRestorations = repoContentRestorations.splice(0).reverse();
  for (const restoration of contentRestorations) {
    await writeFile(restoration.path, restoration.content, 'utf-8');
  }

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
    ).toEqual(['skills/llm-docs-generator/SKILL.md', 'skills/repo-docs-discovery/SKILL.md']);
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

  it('documents explicit parser plugin generation without broad workflow or sandbox claims', async () => {
    const docs = new Map(
      await Promise.all(
        [
          'README.md',
          'AGENT_CONTEXT.md',
          'IMPLEMENTATION.md',
          'index.md',
          'skills/llm-docs-generator/SKILL.md',
        ].map(async (path) => [path, await readFile(join(repoRoot, path), 'utf-8')] as const)
      )
    );
    const combined = [...docs.values()].join('\n');

    expect(docs.get('README.md')).toContain(
      'generate --source <local-file> --parser-plugin-manifest <path>'
    );
    expect(docs.get('AGENT_CONTEXT.md')).toMatch(
      /Plugin code is trusted\s+local code and is not sandboxed/
    );
    expect(docs.get('index.md')).toMatch(
      /verify` checks recorded plugin metadata\s+against the plugin manifest/
    );
    expect(docs.get('README.md')).toMatch(
      /Parser-plugin `local-source-docs`\s+manifests are not refreshed\s+yet/
    );
    expect(docs.get('IMPLEMENTATION.md')).toContain('- [ ] Plugin system for custom parsers');
    expect(docs.get('IMPLEMENTATION.md')).toContain(
      '- [x] Explicit single-file parser plugin execution'
    );
    expect(docs.get('skills/llm-docs-generator/SKILL.md')).toContain(
      'one local source file plus one explicit local'
    );
    expect(combined).toContain('Plugin discovery');
    expect(combined.toLowerCase()).toContain('sandboxing');
    expect(combined).not.toContain(
      'Parser plugin execution and custom parser generation remain planned/unsupported'
    );
    expect(combined).not.toMatch(/\bplugin code is sandboxed\b/i);
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

  it('ships the swift-book preset without source path or section-selection defaults', async () => {
    const preset = JSON.parse(
      await readFile(join(repoRoot, 'config/presets/swift-book.json'), 'utf-8')
    ) as Record<string, unknown>;

    expect(preset).toMatchObject({
      id: 'swift-book',
      name: 'Swift Programming Language',
      format: 'markdown',
      output: {
        filenamePrefix: 'swift-book',
        title: 'Swift Programming Language',
      },
    });
    expect(preset).not.toHaveProperty('source');
    expect(preset).not.toHaveProperty('sources');
    expect(preset).not.toHaveProperty('path');
    expect(preset).not.toHaveProperty('sections');
  });

  it('keeps the root --version option available', async () => {
    const { stdout } = await runCli(['--version']);

    expect(stdout.trim()).toBe('1.0.0');
  });

  it('exposes capabilities help and root help for agents', async () => {
    const rootHelp = await runCli(['--help']);
    const capabilitiesHelp = await runCli(['capabilities', '--help']);
    const refreshHelp = await runCli(['refresh', '--help']);
    const agentHelp = await runCli(['agent', '--help']);
    const agentContextHelp = await runCli(['agent', 'context', '--help']);
    const agentDoctorHelp = await runCli(['agent', 'doctor', '--help']);
    const pluginsHelp = await runCli(['plugins', '--help']);
    const pluginsValidateHelp = await runCli(['plugins', 'validate', '--help']);

    expect(rootHelp.stdout).toContain('capabilities');
    expect(rootHelp.stdout).toContain('refresh');
    expect(rootHelp.stdout).toContain('agent');
    expect(rootHelp.stdout).toContain('plugins');
    expect(rootHelp.stdout).toContain('Report implemented and planned CLI capabilities for');
    expect(rootHelp.stdout).toContain('agents');
    expect(capabilitiesHelp.stdout).toContain(
      'Report implemented and planned CLI capabilities for agents'
    );
    expect(capabilitiesHelp.stdout).toContain('--json');
    expect(capabilitiesHelp.stdout).toContain(
      'Print the deterministic machine-readable capabilities contract'
    );
    expect(refreshHelp.stdout).toMatch(
      /Refresh built-in local source docs, source-truth docs, or local\s+configured SDK\s+docs from an existing explicit local manifest/
    );
    expect(refreshHelp.stdout).toContain('--manifest <path>');
    expect(refreshHelp.stdout).toContain('--output-dir <dir>');
    expect(agentHelp.stdout).toContain('Report read-only agent metadata packaged with this CLI');
    expect(agentHelp.stdout).toContain('context');
    expect(agentHelp.stdout).toContain('doctor');
    expect(agentContextHelp.stdout).toContain('Report packaged read-only agent context metadata');
    expect(agentContextHelp.stdout).toContain('--json');
    expect(agentContextHelp.stdout).toContain(
      'Print deterministic machine-readable agent context metadata'
    );
    expect(agentDoctorHelp.stdout).toContain('Run read-only agent packaging and PATH diagnostics');
    expect(agentDoctorHelp.stdout).toContain('--json');
    expect(agentDoctorHelp.stdout).toContain(
      'Print deterministic machine-readable agent doctor diagnostics'
    );
    expect(pluginsHelp.stdout).toContain('Validate explicit local parser plugin manifests');
    expect(pluginsHelp.stdout).toContain('validate');
    expect(pluginsValidateHelp.stdout).toContain(
      'Validate an explicit local parser plugin manifest without loading plugin code'
    );
    expect(pluginsValidateHelp.stdout).toContain('--manifest <path>');
    expect(pluginsValidateHelp.stdout).toContain('--json');
    expect(
      `${agentHelp.stdout}\n${agentContextHelp.stdout}\n${agentDoctorHelp.stdout}`
    ).not.toMatch(/\bagent install\b/i);
  }, 15000);

  it('describes generate options as local source mode, scoped preset mode, or configured SDK guards', async () => {
    const { stdout } = await runCli(['generate', '--help']);

    expect(stdout).toMatch(
      /--source <path>\s+Explicit local file or directory to parse\s+and format/
    );
    expect(stdout).toMatch(
      /--format <format>[\s\S]*Source parser hint: auto, markdown, mdx,\s+openapi, openref, rst, html; explicit parser\s+plugin format id; SDK guard: openref or\s+openref-0\.1/
    );
    expect(stdout).toMatch(/--chunks <format>\s+Source-only semantic chunk export: jsonl/);
    expect(stdout).toMatch(
      /--parser-plugin-manifest <path>\s+Explicit local parser plugin manifest/
    );
    expect(stdout).toMatch(/--preset <name>\s+Source-only deterministic preset: swift-book/);
    expect(stdout).not.toContain('candidate');
  });

  it('prints deterministic agent context JSON metadata for packaged artifacts', async () => {
    const first = await runCli(['agent', 'context', '--json']);
    const second = await runCli(['agent', 'context', '--json']);
    const context = JSON.parse(first.stdout) as AgentContextContract;
    const artifacts = new Map(context.contextArtifacts.map((artifact) => [artifact.id, artifact]));

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
      context.skillArtifacts.map((artifact) => artifact.path).sort(compareStringsByCodeUnit)
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

  it('prints deterministic agent doctor JSON with warning-only missing PATH diagnostics', async () => {
    const first = await runCliWithEnv(['agent', 'doctor', '--json'], { PATH: '', Path: '' });
    const second = await runCliWithEnv(['agent', 'doctor', '--json'], { PATH: '', Path: '' });
    const doctor = JSON.parse(first.stdout) as AgentDoctorContract;
    const checks = new Map(doctor.checks.map((check) => [check.id, check]));

    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout.endsWith('\n')).toBe(true);
    expect(first.stdout).not.toContain('generatedAt');
    expect(doctor).toMatchObject({
      schemaVersion: '0.1.0',
      mode: 'agent-doctor-read-only-diagnostics',
      generator: {
        packageName: 'llm-docs-generator',
        packageVersion: '1.0.0',
        cliName: 'supabase-llm-docs',
        binary: 'llm-docs',
      },
      summary: {
        overallStatus: 'warning',
        totalChecks: 4,
        passed: 2,
        warnings: 1,
        failed: 0,
        skipped: 1,
        hardFailureCount: 0,
        packagedArtifactCount: 4,
        contextArtifactCount: 2,
        skillArtifactCount: 2,
        pathBinaryFound: false,
      },
      limitations: [
        'Read-only diagnostics only.',
        'Does not install or register skills.',
        'Does not write user config.',
        'Does not mutate host skill directories.',
        'Does not perform network access.',
        'Does not infer source authority, source truth, or task fit.',
        'Missing llm-docs on PATH is reported as a warning for development installs.',
        'Codex host skill installation is not checked without an explicit supported configuration.',
      ],
    });
    expect([...checks.keys()]).toEqual([
      'packaged-agent-artifacts',
      'expected-binary-name',
      'path-binary',
      'codex-skill-installation',
    ]);
    expect(checks.get('packaged-agent-artifacts')).toMatchObject({
      status: 'pass',
      facts: {
        contextArtifactCount: 2,
        skillArtifactCount: 2,
      },
    });
    expect(checks.get('expected-binary-name')).toMatchObject({
      status: 'pass',
      facts: {
        expectedBinary: 'llm-docs',
        packageBinEntry: './dist/cli.js',
      },
    });
    expect(checks.get('path-binary')).toMatchObject({
      status: 'warning',
      facts: {
        expectedBinary: 'llm-docs',
        pathConfigured: false,
        pathEntryCount: 0,
        found: false,
        matches: [],
      },
    });
    expect(checks.get('codex-skill-installation')).toMatchObject({
      status: 'skipped',
      facts: {
        checked: false,
        reason: 'not-configured',
      },
    });

    const artifactFacts = checks.get('packaged-agent-artifacts')?.facts;
    const artifacts = (artifactFacts?.artifacts ?? []) as AgentContextContract['contextArtifacts'];
    expect(artifacts.map((artifact) => artifact.id)).toEqual([
      'agent-context',
      'project-index',
      'llm-docs-generator',
      'repo-docs-discovery',
    ]);

    for (const artifact of artifacts) {
      expect(artifact.byteSize).toBe(await byteSize(join(repoRoot, artifact.path)));
      expect(artifact.sha256).toBe(await sha256FileHex(join(repoRoot, artifact.path)));
    }
  });

  it('reports PATH-found agent doctor diagnostics without requiring host skill checks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-path-'));
    tempDirs.push(dir);

    const binaryName = process.platform === 'win32' ? 'llm-docs.cmd' : 'llm-docs';
    const binaryPath = join(dir, binaryName);
    await writeFile(binaryPath, '#!/bin/sh\nexit 0\n', 'utf-8');

    if (process.platform !== 'win32') {
      await chmod(binaryPath, 0o755);
    }

    const { stdout } = await runCliWithEnv(['agent', 'doctor', '--json'], {
      PATH: dir,
      Path: dir,
      PATHEXT: '.CMD;.EXE;.BAT;.COM',
    });
    const doctor = JSON.parse(stdout) as AgentDoctorContract;
    const pathCheck = doctor.checks.find((check) => check.id === 'path-binary');

    expect(doctor.summary).toMatchObject({
      overallStatus: 'pass',
      totalChecks: 4,
      passed: 3,
      warnings: 0,
      failed: 0,
      skipped: 1,
      pathBinaryFound: true,
    });
    expect(pathCheck).toMatchObject({
      status: 'pass',
      facts: {
        expectedBinary: 'llm-docs',
        pathConfigured: true,
        pathEntryCount: 1,
        found: true,
        matches: [binaryPath],
      },
    });
    expect(doctor.checks.find((check) => check.id === 'codex-skill-installation')).toMatchObject({
      status: 'skipped',
      summary:
        'No explicit Codex home or skill-installation location was provided; host skill installation was not checked.',
    });
  });

  it('prints concise non-JSON agent doctor text without install/write/network claims', async () => {
    const { stdout, stderr } = await runCliWithEnv(['agent', 'doctor'], {
      PATH: '',
      Path: '',
    });
    const output = `${stdout}\n${stderr}`;

    expect(stdout).toContain('llm-docs agent doctor');
    expect(stdout).toContain('Schema: 0.1.0');
    expect(stdout).toContain('Package: llm-docs-generator@1.0.0');
    expect(stdout).toContain('Binary: llm-docs');
    expect(stdout).toContain('Overall: warning');
    expect(stdout).toContain('Checks: 2 passed, 1 warning, 0 failed, 1 skipped');
    expect(stdout).toContain('Packaged artifacts: 4 readable/hashable');
    expect(stdout).toContain('PATH llm-docs: not found (warning only)');
    expect(stdout).toContain('Codex skill installation: skipped (not configured)');
    expect(stdout).toContain(
      'Read-only: no installs, config writes, host mutations, or network access.'
    );
    expect(stdout).toContain('Use --json for the stable diagnostics contract.');
    expect(output).not.toMatch(/\bcopies bundled skills\b/i);
    expect(output).not.toMatch(/\bwrites user config\b/i);
    expect(output).not.toMatch(/\bhost skill installation is writable\b/i);
    expect(output).not.toMatch(/\bperforms network\b/i);
  });

  it('exits nonzero when agent doctor cannot read a packaged artifact', async () => {
    const artifactPath = join(repoRoot, 'skills/repo-docs-discovery/SKILL.md');
    const backupDir = await mkdtemp(join(tmpdir(), 'llm-docs-agent-doctor-artifact-'));
    tempDirs.push(backupDir);
    const backupPath = join(backupDir, 'SKILL.md');
    const restoration = { originalPath: artifactPath, backupPath };
    let result!: CliResult;

    repoPathRestorations.push(restoration);
    await rename(artifactPath, backupPath);

    try {
      result = await runCliWithExit(['agent', 'doctor', '--json']);
    } finally {
      await restoreRepoPath(restoration);
      forgetRestoration(repoPathRestorations, restoration);
    }

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Agent doctor failed: packaged agent artifact unavailable');
    expect(result.stderr).toContain('skills/repo-docs-discovery/SKILL.md');
    expect(result.stderr).toContain('ENOENT');
  }, 15000);

  it('exits nonzero when agent doctor package binary metadata is malformed', async () => {
    const packagePath = join(repoRoot, 'package.json');
    const originalPackageJson = await readFile(packagePath, 'utf-8');
    const malformedPackageJson = JSON.parse(originalPackageJson) as Record<string, unknown>;
    const restoration = { path: packagePath, content: originalPackageJson };
    let result!: CliResult;

    malformedPackageJson.bin = {};

    try {
      repoContentRestorations.push(restoration);
      await writeFile(packagePath, `${JSON.stringify(malformedPackageJson, null, 2)}\n`, 'utf-8');
      result = await runCliWithExit(['agent', 'doctor', '--json']);
    } finally {
      await writeFile(restoration.path, restoration.content, 'utf-8');
      forgetRestoration(repoContentRestorations, restoration);
    }

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'Agent doctor failed: malformed package metadata: expected llm-docs bin entry'
    );
  }, 15000);

  it('prints a deterministic capabilities JSON contract without generatedAt', async () => {
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
  }, 15000);

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
      'source-truth-verify-docs',
      'agent-context',
      'agent-doctor',
      'parser-plugin-manifest-validate',
      'generate-source',
      'parser-plugin-execution',
      'generate-preset-swift-book',
      'generate-sdk',
      'verify-discovery-report',
      'verify-configured-sdk',
      'verify-source-docs',
      'verify-source-truth-docs',
      'verify-source-verification',
      'refresh-source-docs',
      'refresh-source-truth-docs',
      'refresh-configured-sdk',
      'list-sdks',
      'validate-sdk',
    ]);
    expect([...planned.keys()]).toEqual([
      'generate-preset-additional',
      'refresh-unsupported-manifests',
      'source-code-verification',
      'broad-crawling',
      'automatic-source-selection',
      'framework-route-understanding',
      'behavior-level-code-docs',
      'parser-plugin-broader-workflows',
      'agent-install-codex',
    ]);
    expect(
      capabilities.implemented.every((capability) => capability.status === 'implemented')
    ).toBe(true);
    expect(
      capabilities.plannedUnsupported.every(
        (capability) => capability.status === 'planned-unsupported'
      )
    ).toBe(true);
    expect(implemented.get('discover-source')?.outputFiles).toEqual([
      'discovery-report.json',
      'manifest.json',
    ]);
    expect(implemented.get('discover-repo')?.outputFiles).toEqual([
      'discovery-report.json',
      'manifest.json',
    ]);
    expect(implemented.get('discover-url')?.outputFiles).toEqual([
      'discovery-report.json',
      'manifest.json',
    ]);
    expect(implemented.get('source-truth-inspect')?.outputFiles).toEqual([
      'stdout JSON evidence report',
    ]);
    expect(implemented.get('source-truth-generate')?.outputFiles).toEqual([
      'source-truth-report.json',
      'source-truth.md',
      'manifest.json',
      'failure.json',
    ]);
    expect(implemented.get('source-truth-verify-docs')).toMatchObject({
      command: 'source-truth verify-docs',
      mode: 'source-truth verify-docs --source --docs --output-dir',
      status: 'implemented',
      inputBoundary:
        'explicit local source file or directory plus explicit local Markdown/MDX docs file or directory',
      options: ['--source <path>', '--docs <path>', '--output-dir <dir>'],
      outputFiles: ['source-verification-report.json', 'manifest.json', 'failure.json'],
      limitations: expect.arrayContaining([
        'explicit local paths only',
        'Markdown/MDX-style text docs only',
        'exact matches are lexical exported-name evidence only',
        'unmatched references are observations, not failures',
        'no behavior inference',
        'no automatic source selection',
      ]),
    });
    expect(implemented.get('agent-context')?.outputFiles).toEqual(['stdout JSON metadata']);
    expect(implemented.get('agent-context')?.limitations).toContain(
      'does not install/register skills'
    );
    expect(implemented.get('agent-context')?.inputBoundary).toBe(
      'packaged context and skill files only'
    );
    expect(implemented.get('agent-doctor')).toMatchObject({
      command: 'agent doctor',
      mode: 'agent doctor --json',
      status: 'implemented',
      inputBoundary: 'packaged artifacts and explicit process environment PATH only',
      options: ['--json'],
      outputFiles: ['stdout diagnostics', 'stdout JSON diagnostics'],
      limitations: expect.arrayContaining([
        'does not install/register skills',
        'does not write user config',
        'does not mutate host skill directories',
        'does not perform network access',
        'PATH check is informational and may warn in development',
        'host skill installation check is skipped unless a future explicit option is implemented',
        'no source-selection or task-fit inference',
      ]),
    });
    expect(implemented.get('parser-plugin-manifest-validate')).toMatchObject({
      command: 'plugins validate',
      mode: 'plugins validate --manifest',
      status: 'implemented',
      inputBoundary: 'explicit local JSON parser plugin manifest file',
      options: ['--manifest <path>', '--json'],
      outputFiles: ['stdout validation result', 'stdout JSON validation result'],
      summary: expect.stringContaining('without loading plugin modules'),
      limitations: expect.arrayContaining([
        'manifest validation only',
        'does not load, import, or execute plugin modules',
        'does not enable custom parser execution',
        'does not generate custom parsers',
        'does not select plugin manifests or sources',
        'no network',
        'no file writes',
      ]),
    });
    expect(implemented.get('generate-source')?.outputFiles).toEqual([
      'manifest.json',
      'llm-docs/*-llms.txt',
      'chunks/semantic-chunks.jsonl',
    ]);
    expect(implemented.get('generate-source')?.options).toEqual([
      '--source <path>',
      '--format auto|markdown|mdx|openapi|openref|rst|html',
      '--parser-plugin-manifest <path> with explicit custom --format <plugin-format-id>',
      '--chunks jsonl',
      '--preset swift-book',
    ]);
    expect(implemented.get('generate-source')?.limitations).toEqual(
      expect.arrayContaining([
        'local files and directories only',
        'no URL fetching',
        'no discovery report consumption',
        'no candidate auto-selection',
        'parser plugin generation requires --source <local-file>, --parser-plugin-manifest <path>, and a custom explicit --format id',
        'parser plugin code is trusted local code executed for generation and is not sandboxed',
        'no parser plugin discovery, installation, package resolution, or auto-selection',
        'no parser plugin directory source generation',
        'swift-book preset requires explicit --source and adds deterministic output defaults only',
        'no source selection decision',
        'semantic chunk JSONL is emitted only when --chunks jsonl is requested',
      ])
    );
    expect(implemented.get('parser-plugin-execution')).toMatchObject({
      command: 'generate',
      mode: 'generate --source <local-file> --parser-plugin-manifest <path> --format <plugin-format-id>',
      status: 'implemented',
      inputBoundary:
        'one explicit local source file, one explicit local parser plugin manifest, and one explicit custom plugin format id',
      options: ['--source <local-file>', '--parser-plugin-manifest <path>', '--format <id>'],
      outputFiles: ['manifest.json', 'llm-docs/*-llms.txt'],
      summary: expect.stringContaining('explicit single-file parser plugin execution'),
      limitations: expect.arrayContaining([
        'explicit local source files only',
        'requires a custom plugin format id declared by the manifest',
        'rejects built-in formats and --format auto',
        'no directory source generation through parser plugins',
        'no --chunks support with parser plugins',
        'no --preset support with parser plugins',
        'no parser plugin discovery or auto-selection',
        'no plugin installation or package resolution',
        'plugin code is trusted local code and is not sandboxed',
        'verify checks recorded plugin manifest metadata and hashes without importing plugin code',
        'no network added by the CLI',
      ]),
    });
    expect(implemented.get('generate-preset-swift-book')).toMatchObject({
      command: 'generate',
      mode: 'generate --source --preset swift-book',
      status: 'implemented',
      inputBoundary: 'explicit local Markdown or DocC-style source path',
      options: ['--source <path>', '--preset swift-book', '--format markdown', '--chunks jsonl'],
      outputFiles: [
        'manifest.json',
        'llm-docs/swift-book-full-llms.txt',
        'chunks/semantic-chunks.jsonl',
      ],
      limitations: expect.arrayContaining([
        'requires explicit --source',
        'Markdown parser only',
        'no TSPL.docc path inference',
        'no repo clone or cache',
        'no automatic source selection',
      ]),
    });
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
    expect(implemented.get('verify-configured-sdk')?.summary).toContain(
      'recorded generator/sdk/parser/formatter metadata'
    );
    expect(implemented.get('verify-configured-sdk')?.summary).toContain('when present');
    expect(implemented.get('verify-discovery-report')).toMatchObject({
      command: 'verify',
      mode: 'verify --manifest or verify --output-dir',
      status: 'implemented',
      inputBoundary: 'discovery-report manifest.json',
      limitations: expect.arrayContaining([
        'discovery-report manifest mode only',
        'candidate evidence for agent review only',
        'no task fit decision',
        'no source selection',
        'verify does not refresh discovery reports',
        'no source-code verification',
      ]),
    });
    expect(implemented.get('verify-source-docs')?.inputBoundary).toBe(
      'local-source-docs manifest.json'
    );
    expect(implemented.get('verify-source-docs')?.summary).toContain(
      'recorded generator/parser/formatter metadata'
    );
    expect(implemented.get('verify-source-docs')?.summary).toContain(
      'source file hash, byte-size, line-count, estimated-token'
    );
    expect(implemented.get('verify-source-docs')?.limitations).toEqual(
      expect.arrayContaining([
        'local-source-docs manifest mode only',
        'verify does not refresh outputs',
        'no repo freshness check',
        'no source-code verification',
      ])
    );
    expect(implemented.get('verify-source-truth-docs')).toMatchObject({
      command: 'verify',
      mode: 'verify --manifest or verify --output-dir',
      status: 'implemented',
      inputBoundary: 'source-truth-local-docs manifest.json',
      outputFiles: ['stdout verification result'],
      limitations: expect.arrayContaining([
        'source-truth-local-docs manifest mode only',
        'verify does not refresh outputs',
        'no repo freshness check',
        'no source-code verification',
        'no behavior inference',
      ]),
    });
    const sourceVerificationVerify = implemented.get('verify-source-verification');
    expect(sourceVerificationVerify?.summary).toEqual(expect.stringContaining('report integrity'));
    expect(sourceVerificationVerify?.summary).toEqual(expect.stringContaining('provenance'));
    expect(sourceVerificationVerify?.summary).toEqual(
      expect.stringContaining('manifest/report summary')
    );
    expect(sourceVerificationVerify?.summary).toEqual(expect.stringContaining('report-body count'));
    expect(sourceVerificationVerify?.summary).toEqual(
      expect.stringContaining('sourceInspection.source consistency')
    );
    expect(sourceVerificationVerify).toMatchObject({
      command: 'verify',
      mode: 'verify --manifest or verify --output-dir',
      status: 'implemented',
      inputBoundary: 'source-verification-local-evidence manifest.json',
      outputFiles: ['stdout verification result'],
      limitations: expect.arrayContaining([
        'source-verification-local-evidence manifest mode only',
        'verify does not refresh outputs or sources',
        'no additional source/docs inspection',
        'no broad official-docs claim checking',
        'no source-code behavior validation',
        'no task-fit, source-truth, or source-selection decision',
        'no proof that docs statements are correct',
      ]),
    });
    expect(implemented.get('refresh-source-docs')).toMatchObject({
      command: 'refresh',
      mode: 'refresh --manifest or refresh --output-dir for local-source-docs',
      status: 'implemented',
      inputBoundary:
        'existing built-in-parser local-source-docs manifest.json with recorded local source path',
      options: ['--manifest <path>', '--output-dir <dir>'],
      outputFiles: ['manifest.json', 'llm-docs/*-llms.txt', 'chunks/semantic-chunks.jsonl'],
      summary: expect.stringContaining('manifest integrity verification'),
      limitations: expect.arrayContaining([
        'built-in-parser local-source-docs manifests only',
        'parser-plugin local-source-docs manifests are not refreshed; rerun explicit generate --source --parser-plugin-manifest --format',
        'uses only source.resolvedPath, source.formatHint, preset metadata, and prior chunk-output presence from the existing manifest',
        'no URLs',
        'no repo freshness check',
        'no crawling',
        'no source selection',
        'no discovery report refresh',
        'no source-code verification',
        'no remote network work',
        'no source project script execution',
      ]),
    });
    expect(implemented.get('refresh-source-truth-docs')).toMatchObject({
      command: 'refresh',
      mode: 'refresh --manifest or refresh --output-dir for source-truth-local-docs',
      status: 'implemented',
      inputBoundary:
        'existing source-truth-local-docs manifest.json with recorded local source path',
      options: ['--manifest <path>', '--output-dir <dir>'],
      outputFiles: ['source-truth-report.json', 'source-truth.md', 'manifest.json'],
      summary: expect.stringContaining('manifest integrity verification'),
      limitations: expect.arrayContaining([
        'source-truth-local-docs manifests only',
        'uses only source.resolvedPath from the existing manifest',
        'no URLs',
        'no repo freshness check',
        'no crawling',
        'no source selection',
        'no discovery report refresh',
        'no source-code verification',
        'no remote network work',
        'no source project script execution',
        'no behavior inference',
      ]),
    });
    expect(implemented.get('refresh-configured-sdk')).toMatchObject({
      command: 'refresh',
      mode: 'refresh --manifest or refresh --output-dir for configured-sdk',
      status: 'implemented',
      inputBoundary:
        'existing configured-sdk manifest.json with recorded absolute local source.resolvedSpecPath',
      options: ['--manifest <path>', '--output-dir <dir>'],
      outputFiles: [
        'manifest.json',
        'parsed/<sdk>-<resolved-version>-spec.json',
        'llm-docs/*-llms.txt',
      ],
      summary: expect.stringContaining('manifest-recorded absolute local spec path'),
      limitations: expect.arrayContaining([
        'configured-sdk manifests only',
        'requires source.resolvedSpecPath to be an absolute local non-symlink file outside the output directory',
        'uses only the recorded local spec path, SDK metadata, parser/formatter metadata, and manifest-recorded filename prefix',
        'OpenRef parser and legacy LLM formatter only',
        'no registry lookup',
        'no URL fetching',
        'no discovery report refresh',
        'no candidate report consumption',
        'no candidate auto-selection',
        'no remote network work',
      ]),
    });
    expect(planned.has('generate-source')).toBe(false);
    expect(planned.get('generate-preset-additional')?.reason).toBe(
      'only --preset swift-book over an explicit local --source path is implemented; additional presets remain planned'
    );
    expect([...implemented.values()].map((capability) => capability.mode)).toContain(
      'generate --source'
    );
    expect(planned.get('refresh-unsupported-manifests')?.reason).toContain(
      'only explicit built-in-parser local-source-docs, source-truth-local-docs, and configured-sdk manifests with recorded absolute local spec paths can be refreshed'
    );
    expect(planned.get('refresh-unsupported-manifests')?.reason).toContain(
      'parser-plugin source-docs'
    );
    expect(planned.get('source-code-verification')?.reason).toContain(
      'broad official-docs behavior/API claim verification remains planned'
    );
    expect(planned.get('source-code-verification')?.reason).toContain(
      'source-truth verify-docs is explicit-local lexical evidence only'
    );
    expect(planned.has('parser-plugin-execution')).toBe(false);
    expect(planned.get('parser-plugin-broader-workflows')?.reason).toContain(
      'only explicit single-file local parser plugin generation is implemented'
    );
    expect(planned.get('parser-plugin-broader-workflows')?.reason).toContain(
      'discovery, install, package resolution, auto-selection, directory source generation, sandboxing, and broad custom parser workflows remain planned/unsupported'
    );
    expect([...implemented.values()].map((capability) => capability.command)).not.toContain(
      'agent install codex'
    );
    expect([...implemented.values()].map((capability) => capability.command)).toContain(
      'agent doctor'
    );
    expect(planned.get('agent-install-codex')?.reason).toContain('no current CLI skill installer');
    expect(planned.has('agent-doctor')).toBe(false);
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
      'AST-observed test-case label context facts',
    ];
    const expectedLimitations = [
      'no behavior inference',
      'no assertion parsing',
      'no test body serialization',
      'test-case labels are not behavior or correctness proof',
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
    expect(implementedText).not.toMatch(
      /\bclaims correctness\b|\bproves correctness\b|\bguarantees correctness\b/i
    );
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
    expect(stdout).toContain('Implemented modes: 23');
    expect(stdout).toContain('Planned or unsupported modes: 9');
    expect(stdout).toContain('Use --json for the stable agent contract.');
  });

  it('validates parser plugin manifests with human output without loading plugin code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-plugin-'));
    tempDirs.push(dir);
    const manifestPath = join(dir, 'parser-plugin.json');
    const sideEffectPath = join(dir, 'loaded.txt');

    await writeFile(
      join(dir, 'throwing-plugin.js'),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sideEffectPath)}, 'loaded');\nthrow new Error('plugin code was loaded');\n`,
      'utf-8'
    );
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: '0.1.0',
          kind: 'parser-plugin',
          name: 'Fixture Parser',
          version: '1.2.3',
          module: 'throwing-plugin.js',
          formats: [
            {
              id: 'fixture-docs',
              displayName: 'Fixture Docs',
              extensions: ['fixture', 'fixture-docs'],
              mediaTypes: ['text/fixture'],
              directorySupport: true,
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    const { stdout } = await runCli(['plugins', 'validate', '--manifest', manifestPath]);

    expect(stdout).toContain('Parser plugin manifest validation');
    expect(stdout).toContain(`Manifest: ${manifestPath}`);
    expect(stdout).toContain('Result: passed');
    expect(stdout).toContain('Name: Fixture Parser');
    expect(stdout).toContain('Version: 1.2.3');
    expect(stdout).toContain('Formats: 1');
    expect(stdout).toContain('fixture-docs: Fixture Docs (.fixture, .fixture-docs)');
    expect(stdout).toContain('Scope: validation only');
    expect(stdout).toContain('generate --source --parser-plugin-manifest --format');
    expect(await pathExists(sideEffectPath)).toBe(false);
  }, 15000);

  it('prints deterministic parser plugin manifest validation JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-plugin-'));
    tempDirs.push(dir);
    const manifestPath = join(dir, 'parser-plugin.json');

    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: '0.1.0',
          kind: 'parser-plugin',
          name: 'Fixture Parser',
          version: '1.2.3',
          module: './parser/index.js',
          formats: [
            {
              id: 'fixture',
              displayName: 'Fixture',
              extensions: ['fixture'],
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    const first = await runCli(['plugins', 'validate', '--manifest', manifestPath, '--json']);
    const second = await runCli(['plugins', 'validate', '--manifest', manifestPath, '--json']);
    const validation = JSON.parse(first.stdout) as ParserPluginManifestValidationResult;

    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout.endsWith('\n')).toBe(true);
    expect(first.stdout).not.toContain('generatedAt');
    expect(validation).toEqual({
      schemaVersion: '0.1.0',
      manifestPath,
      valid: true,
      manifest: {
        schemaVersion: '0.1.0',
        kind: 'parser-plugin',
        name: 'Fixture Parser',
        version: '1.2.3',
        module: './parser/index.js',
        formats: [
          {
            id: 'fixture',
            displayName: 'Fixture',
            extensions: ['fixture'],
          },
        ],
      },
      errors: [],
      warnings: [],
    });
  }, 15000);

  it('reports parser plugin malformed root and field errors as JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-plugin-'));
    tempDirs.push(dir);
    const rootArrayPath = join(dir, 'root-array.json');
    const malformedFieldsPath = join(dir, 'malformed-fields.json');

    await writeFile(rootArrayPath, '[]\n', 'utf-8');
    await writeFile(
      malformedFieldsPath,
      JSON.stringify(
        {
          schemaVersion: '0.2.0',
          kind: 'parser',
          name: '',
          version: ' ',
          module: '',
          formats: [
            {
              id: 'Fixture',
              displayName: '',
              extensions: ['.md', 'MD'],
              mediaTypes: ['text/markdown', ''],
              directorySupport: 'yes',
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    const rootResult = await runCliWithExit([
      'plugins',
      'validate',
      '--manifest',
      rootArrayPath,
      '--json',
    ]);
    const fieldResult = await runCliWithExit([
      'plugins',
      'validate',
      '--manifest',
      malformedFieldsPath,
      '--json',
    ]);
    const rootValidation = JSON.parse(rootResult.stdout) as ParserPluginManifestValidationResult;
    const fieldValidation = JSON.parse(fieldResult.stdout) as ParserPluginManifestValidationResult;

    expect(rootResult.exitCode).toBe(1);
    expect(rootValidation.valid).toBe(false);
    expect(rootValidation.errors).toContainEqual({
      code: 'root-object',
      path: '$',
      message: 'manifest root must be a JSON object.',
    });
    expect(fieldResult.exitCode).toBe(1);
    expect(fieldValidation.valid).toBe(false);
    expect(fieldValidation.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining([
        'schemaVersion-invalid',
        'kind-invalid',
        'name-non-empty-string',
        'version-non-empty-string',
        'module-non-empty-string',
        'format-id-invalid',
        'displayName-non-empty-string',
        'extension-invalid',
        'media-type-non-empty-string',
        'directory-support-boolean',
      ])
    );
  }, 15000);

  it('rejects URL-like absolute and traversal parser plugin module paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-plugin-'));
    tempDirs.push(dir);
    const cases = [
      {
        filename: 'url.json',
        module: 'https://example.com/parser.js',
        code: 'module-url-like',
      },
      {
        filename: 'absolute.json',
        module: '/tmp/parser.js',
        code: 'module-absolute',
      },
      {
        filename: 'traversal.json',
        module: '../parser.js',
        code: 'module-traversal',
      },
      {
        filename: 'empty-segment.json',
        module: 'src//parser.js',
        code: 'module-empty-segment',
      },
    ];

    for (const testCase of cases) {
      const manifestPath = join(dir, testCase.filename);
      await writeFile(
        manifestPath,
        JSON.stringify(
          {
            schemaVersion: '0.1.0',
            kind: 'parser-plugin',
            name: 'Fixture Parser',
            version: '1.0.0',
            module: testCase.module,
            formats: [
              {
                id: 'fixture',
                displayName: 'Fixture',
                extensions: ['fixture'],
              },
            ],
          },
          null,
          2
        ),
        'utf-8'
      );

      const result = await runCliWithExit([
        'plugins',
        'validate',
        '--manifest',
        manifestPath,
        '--json',
      ]);
      const validation = JSON.parse(result.stdout) as ParserPluginManifestValidationResult;

      expect(result.exitCode).toBe(1);
      expect(validation.valid).toBe(false);
      expect(validation.errors.map((error) => error.code)).toContain(testCase.code);
      expect(validation.errors.map((error) => error.path)).toContain('$.module');
    }
  }, 15000);

  it('rejects Windows-style parser plugin module paths that are not relative safe paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-plugin-'));
    tempDirs.push(dir);
    const cases = [
      {
        filename: 'windows-absolute.json',
        module: 'C:\\Users\\fixture\\parser.js',
        codes: ['module-url-like', 'module-absolute'],
      },
      {
        filename: 'windows-unc.json',
        module: '\\\\server\\share\\parser.js',
        codes: ['module-url-like', 'module-absolute'],
      },
      {
        filename: 'windows-traversal.json',
        module: 'src\\..\\parser.js',
        codes: ['module-traversal'],
      },
      {
        filename: 'windows-empty-segment.json',
        module: 'src\\\\parser.js',
        codes: ['module-empty-segment'],
      },
    ];

    for (const testCase of cases) {
      const manifestPath = join(dir, testCase.filename);
      await writeFile(
        manifestPath,
        JSON.stringify(
          {
            schemaVersion: '0.1.0',
            kind: 'parser-plugin',
            name: 'Fixture Parser',
            version: '1.0.0',
            module: testCase.module,
            formats: [
              {
                id: 'fixture',
                displayName: 'Fixture',
                extensions: ['fixture'],
              },
            ],
          },
          null,
          2
        ),
        'utf-8'
      );

      const result = await runCliWithExit([
        'plugins',
        'validate',
        '--manifest',
        manifestPath,
        '--json',
      ]);
      const validation = JSON.parse(result.stdout) as ParserPluginManifestValidationResult;
      const errorCodes = validation.errors.map((error) => error.code);

      expect(result.exitCode).toBe(1);
      expect(validation.valid).toBe(false);
      for (const expectedCode of testCase.codes) {
        expect(errorCodes).toContain(expectedCode);
      }
      expect(validation.errors.map((error) => error.path)).toContain('$.module');
    }
  }, 15000);

  it('rejects missing non-array and empty parser plugin formats', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-plugin-'));
    tempDirs.push(dir);
    const baseManifest = {
      schemaVersion: '0.1.0',
      kind: 'parser-plugin',
      name: 'Fixture Parser',
      version: '1.0.0',
      module: 'parser.js',
    };
    const cases = [
      {
        filename: 'missing-formats.json',
        manifest: baseManifest,
      },
      {
        filename: 'non-array-formats.json',
        manifest: { ...baseManifest, formats: { id: 'fixture' } },
      },
      {
        filename: 'empty-formats.json',
        manifest: { ...baseManifest, formats: [] },
      },
    ];

    for (const testCase of cases) {
      const manifestPath = join(dir, testCase.filename);
      await writeFile(manifestPath, JSON.stringify(testCase.manifest, null, 2), 'utf-8');

      const result = await runCliWithExit([
        'plugins',
        'validate',
        '--manifest',
        manifestPath,
        '--json',
      ]);
      const validation = JSON.parse(result.stdout) as ParserPluginManifestValidationResult;

      expect(result.exitCode).toBe(1);
      expect(validation.valid).toBe(false);
      expect(validation.errors).toContainEqual({
        code: 'formats-array',
        path: '$.formats',
        message: 'formats must be a non-empty array of format objects.',
      });
    }
  }, 15000);

  it('rejects duplicate parser plugin format ids and duplicate extensions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-plugin-'));
    tempDirs.push(dir);
    const manifestPath = join(dir, 'duplicates.json');

    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: '0.1.0',
          kind: 'parser-plugin',
          name: 'Fixture Parser',
          version: '1.0.0',
          module: 'parser.js',
          formats: [
            {
              id: 'fixture',
              displayName: 'Fixture',
              extensions: ['fixture', 'fixture'],
            },
            {
              id: 'fixture',
              displayName: 'Fixture Duplicate',
              extensions: ['fixture-2'],
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    const result = await runCliWithExit([
      'plugins',
      'validate',
      '--manifest',
      manifestPath,
      '--json',
    ]);
    const validation = JSON.parse(result.stdout) as ParserPluginManifestValidationResult;

    expect(result.exitCode).toBe(1);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        {
          code: 'duplicate-extension',
          path: '$.formats[0].extensions[1]',
          message:
            "duplicate extension 'fixture' in format 'fixture'; first declared at $.formats[0].extensions[0] in format 'fixture'.",
        },
        {
          code: 'duplicate-format-id',
          path: '$.formats[1].id',
          message: "duplicate format id 'fixture'.",
        },
      ])
    );
  }, 15000);

  it('rejects duplicate parser plugin extensions across separate formats', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-plugin-'));
    tempDirs.push(dir);
    const manifestPath = join(dir, 'duplicate-extension-across-formats.json');

    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: '0.1.0',
          kind: 'parser-plugin',
          name: 'Fixture Parser',
          version: '1.0.0',
          module: 'parser.js',
          formats: [
            {
              id: 'first',
              displayName: 'First',
              extensions: ['dup'],
            },
            {
              id: 'second',
              displayName: 'Second',
              extensions: ['dup'],
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    const result = await runCliWithExit([
      'plugins',
      'validate',
      '--manifest',
      manifestPath,
      '--json',
    ]);
    const validation = JSON.parse(result.stdout) as ParserPluginManifestValidationResult;

    expect(result.exitCode).toBe(1);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual([
      {
        code: 'duplicate-extension',
        path: '$.formats[1].extensions[0]',
        message:
          "duplicate extension 'dup' in format 'second'; first declared at $.formats[0].extensions[0] in format 'first'.",
      },
    ]);
  }, 15000);

  it('rejects unsupported parser plugin manifest keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-plugin-'));
    tempDirs.push(dir);
    const manifestPath = join(dir, 'unsupported-keys.json');

    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: '0.1.0',
          kind: 'parser-plugin',
          name: 'Fixture Parser',
          version: '1.0.0',
          module: 'parser.js',
          trustScore: 100,
          formats: [
            {
              id: 'fixture',
              displayName: 'Fixture',
              extensions: ['fixture'],
              loader: 'default',
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    const result = await runCliWithExit([
      'plugins',
      'validate',
      '--manifest',
      manifestPath,
      '--json',
    ]);
    const validation = JSON.parse(result.stdout) as ParserPluginManifestValidationResult;

    expect(result.exitCode).toBe(1);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        {
          code: 'unsupported-root-key',
          path: '$.trustScore',
          message: "unsupported root key 'trustScore'.",
        },
        {
          code: 'unsupported-format-key',
          path: '$.formats[0].loader',
          message: "unsupported format key 'loader'.",
        },
      ])
    );
  }, 15000);

  it('reports missing and malformed parser plugin manifest files with non-zero exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-plugin-'));
    tempDirs.push(dir);
    const missingPath = join(dir, 'missing.json');
    const malformedPath = join(dir, 'malformed.json');

    await writeFile(malformedPath, '{ not json\n', 'utf-8');

    const missingResult = await runCliWithExit([
      'plugins',
      'validate',
      '--manifest',
      missingPath,
      '--json',
    ]);
    const malformedResult = await runCliWithExit([
      'plugins',
      'validate',
      '--manifest',
      malformedPath,
    ]);
    const missingValidation = JSON.parse(
      missingResult.stdout
    ) as ParserPluginManifestValidationResult;

    expect(missingResult.exitCode).toBe(1);
    expect(missingValidation).toMatchObject({
      schemaVersion: '0.1.0',
      manifestPath: missingPath,
      valid: false,
      errors: [
        {
          code: 'manifest-unreadable',
          path: '$',
          message: `manifest file could not be read (ENOENT): ${missingPath}`,
        },
      ],
      warnings: [],
    });
    expect(malformedResult.exitCode).toBe(1);
    expect(malformedResult.stdout).toContain('Parser plugin manifest validation');
    expect(malformedResult.stdout).toContain('Result: failed');
    expect(malformedResult.stderr).toContain('manifest file must contain valid JSON');
  }, 15000);

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
    const manifestPath = join(outputDir, 'manifest.json');
    const reportText = await readFile(reportPath, 'utf-8');
    const report = JSON.parse(reportText) as DiscoveryReport;
    const manifestText = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestText) as DiscoveryReportManifest;
    const unknownFile = join(sourceDir, 'notes.txt');
    await writeFile(unknownFile, 'plain notes\n', 'utf-8');
    const unknownReport = await discoverLocalSource({
      source: unknownFile,
      outputDir: join(dir, 'unknown-report'),
    });

    expect(stdout).toContain('Local source discovery');
    expect(stdout).toContain('Candidate files: 9');
    expect(stdout).toContain(`Report: ${reportPath}`);
    expect(stdout).toContain(`Manifest: ${manifestPath}`);
    expect(reportText.endsWith('\n')).toBe(true);
    expect(manifestText.endsWith('\n')).toBe(true);
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
    expect(manifest).toMatchObject({
      schemaVersion: '0.1.0',
      generator: {
        name: 'llm-docs-generator',
        version: '1.0.0',
        cliName: 'supabase-llm-docs',
      },
      mode: 'discovery-report',
      discovery: {
        kind: 'source',
        reportPath: 'discovery-report.json',
        reportSchemaVersion: '0.2.0',
        reportMode: 'local-bounded-inspection',
        candidateCount: 9,
        warningCount: 2,
      },
      generatedOutputs: [
        {
          path: 'discovery-report.json',
          kind: 'discovery-report',
          byteSize: await byteSize(reportPath),
          hash: await sha256File(reportPath),
          lineCount: countTextLines(reportText),
          estimatedTokenCount: estimateTextTokens(reportText),
        },
      ],
    });
    expect(manifest.discovery).not.toHaveProperty('urlResourceCount');
    expectLocalCandidateEvidenceIndex(manifest.candidateEvidenceIndex, report, {
      source: {
        input: sourceDir,
        resolvedPath: sourceDir,
        type: 'directory',
      },
    });
    expectCandidateEvidenceIndexHasNoReportContent(manifest.candidateEvidenceIndex);
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

  it('clears stale local discovery artifacts before a failed rerun', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-discover-missing-'));
    tempDirs.push(dir);
    const sourceDir = join(dir, 'source');
    const missingPath = join(dir, 'missing-docs');
    const outputDir = join(dir, 'reports');
    const reportPath = join(outputDir, 'discovery-report.json');
    const manifestPath = join(outputDir, 'manifest.json');
    const userFilePath = join(outputDir, 'notes.txt');

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'guide.md'), '# Guide\n', 'utf-8');
    await runCli(['discover', '--source', sourceDir, '--output-dir', outputDir]);
    await writeFile(userFilePath, 'keep me\n', 'utf-8');

    expect(await pathExists(reportPath)).toBe(true);
    expect(await pathExists(manifestPath)).toBe(true);

    const result = await runCliWithExit([
      'discover',
      '--source',
      missingPath,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Discovery failed: source path not found');
    expect(result.stderr).toContain(missingPath);
    expect(await pathExists(manifestPath)).toBe(false);
    expect(await pathExists(reportPath)).toBe(false);
    expect(await readFile(userFilePath, 'utf-8')).toBe('keep me\n');
  });

  it('preserves non-discovery manifest artifacts before a failed discovery rerun', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-discover-preserve-manifest-'));
    tempDirs.push(dir);
    const missingPath = join(dir, 'missing-docs');
    const outputDir = join(dir, 'reports');
    const manifestPath = join(outputDir, 'manifest.json');
    const reportPath = join(outputDir, 'discovery-report.json');
    const manifestText = `${JSON.stringify(
      {
        schemaVersion: '0.1.0',
        mode: 'configured-sdk',
        source: {
          resolvedSpecPath: 'config/source.yml',
        },
      },
      null,
      2
    )}\n`;
    const reportText = `${JSON.stringify(
      {
        note: 'user-owned report-like file',
      },
      null,
      2
    )}\n`;

    await mkdir(outputDir, { recursive: true });
    await writeFile(manifestPath, manifestText, 'utf-8');
    await writeFile(reportPath, reportText, 'utf-8');

    const result = await runCliWithExit([
      'discover',
      '--source',
      missingPath,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Discovery failed: source path not found');
    expect(result.stderr).toContain(missingPath);
    expect(await readFile(manifestPath, 'utf-8')).toBe(manifestText);
    expect(await readFile(reportPath, 'utf-8')).toBe(reportText);
  });

  it('removes a report-only artifact when discovery manifest writing fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-discover-manifest-dir-'));
    tempDirs.push(dir);
    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'reports');
    const reportPath = join(outputDir, 'discovery-report.json');
    const manifestPath = join(outputDir, 'manifest.json');

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'guide.md'), '# Guide\n', 'utf-8');
    await mkdir(manifestPath, { recursive: true });

    const result = await runCliWithExit([
      'discover',
      '--source',
      sourceDir,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Discovery failed:');
    expect(result.stderr).toContain('manifest.json');
    expect(await pathExists(reportPath)).toBe(false);
    expect(await pathExists(manifestPath)).toBe(true);
  });

  it('does not follow a pre-existing discovery report symlink', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-discover-report-symlink-'));
    tempDirs.push(dir);
    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'reports');
    const reportPath = join(outputDir, 'discovery-report.json');
    const targetPath = join(dir, 'outside-report-target.json');
    const originalTarget = 'outside report target\n';

    await mkdir(sourceDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(sourceDir, 'guide.md'), '# Guide\n', 'utf-8');
    await writeFile(targetPath, originalTarget, 'utf-8');
    await symlink(targetPath, reportPath, 'file');

    const result = await runCliWithExit([
      'discover',
      '--source',
      sourceDir,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Discovery failed:');
    expect(result.stderr).toContain('discovery-report.json');
    expect(result.stderr).toContain('not a regular file');
    expect((await lstat(reportPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(targetPath, 'utf-8')).toBe(originalTarget);
  });

  it('does not follow a pre-existing discovery manifest symlink or leave report-only output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-discover-manifest-symlink-'));
    tempDirs.push(dir);
    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'reports');
    const reportPath = join(outputDir, 'discovery-report.json');
    const manifestPath = join(outputDir, 'manifest.json');
    const targetPath = join(dir, 'outside-manifest-target.json');
    const originalTarget = 'outside manifest target\n';

    await mkdir(sourceDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(sourceDir, 'guide.md'), '# Guide\n', 'utf-8');
    await writeFile(targetPath, originalTarget, 'utf-8');
    await symlink(targetPath, manifestPath, 'file');

    const result = await runCliWithExit([
      'discover',
      '--source',
      sourceDir,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Discovery failed:');
    expect(result.stderr).toContain('manifest.json');
    expect(result.stderr).toContain('not a regular file');
    expect(await pathExists(reportPath)).toBe(false);
    expect((await lstat(manifestPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(targetPath, 'utf-8')).toBe(originalTarget);
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
    expect(combinedOutput).not.toMatch(
      /\bclaims correctness\b|\bproves correctness\b|\bguarantees correctness\b/i
    );
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
    const testSource = [
      'it("keeps evidence path-only", () => {',
      '  expect(true).toBe(true);',
      '});',
      '',
    ].join('\n');
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
    expect(stdout).toContain('Context facts: 2');
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
      {
        kind: 'test-case',
        path: 'tests/path.spec.ts',
        name: 'keeps evidence path-only',
        call: 'it',
        modifiers: [],
        provenance: {
          path: 'tests/path.spec.ts',
          lineRange: { start: 1, end: 1 },
        },
        lineRangeGranularity: 'test-label',
        order: 2,
      },
    ]);
    expect(markdown).toContain('## Test And Example Context Facts');
    expect(markdown).toContain('### `tests/path.spec.ts`');
    expect(markdown).toContain('- `test-file`');
    expect(markdown).toContain('- `test-case`');
    expect(markdown).toContain('  - Name: `keeps evidence path-only`');
    expect(markdown).toContain('  - Call: `it`');
    expect(markdown).toContain('  - Modifiers: `none`');
    expect(markdown).toContain(
      '  - Evidence signals: `filename-pattern:*.spec.*`; `path-segment:tests`'
    );
    expect(manifest.sourceFiles).toMatchObject([
      {
        path: 'tests/path.spec.ts',
        factCount: 2,
        exportFactCount: 0,
        configFactCount: 0,
        contextFactCount: 2,
      },
    ]);

    const combinedOutput = `${stdout}\n${stderr}\n${markdown}\n${JSON.stringify(report)}\n${JSON.stringify(
      manifest
    )}`;
    expect(combinedOutput).not.toContain('expect(true)');
    expect(combinedOutput).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(combinedOutput).not.toMatch(/\bofficial\b/i);
    expect(combinedOutput).not.toMatch(
      /\bclaims correctness\b|\bproves correctness\b|\bguarantees correctness\b/i
    );
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

  it('writes local source/docs reference evidence with exact export matches and unmatched references', async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-source-verify-cli-'));
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      join(sourceDir, 'index.ts'),
      ['export function makeClient(): Client {', '  return {} as Client;', '}', ''].join('\n'),
      'utf-8'
    );
    await writeFile(
      join(docsDir, 'guide.mdx'),
      ['# Guide', '', 'Call `makeClient()` before using `MissingClient`.', ''].join('\n'),
      'utf-8'
    );

    const { stdout, stderr } = await runCli([
      'source-truth',
      'verify-docs',
      '--source',
      sourceDir,
      '--docs',
      docsDir,
      '--output-dir',
      outputDir,
    ]);
    const report = JSON.parse(
      await readFile(join(outputDir, 'source-verification-report.json'), 'utf-8')
    ) as SourceVerificationReport;
    const manifest = JSON.parse(
      await readFile(join(outputDir, 'manifest.json'), 'utf-8')
    ) as SourceVerificationManifest;
    const verifyResult = await runCli(['verify', '--output-dir', outputDir]);
    const combinedOutput = `${stdout}\n${stderr}\n${JSON.stringify(report)}\n${JSON.stringify(
      manifest
    )}`;

    expect(stdout).toContain('Local source/docs evidence generated');
    expect(stdout).toContain('Docs references: 2');
    expect(stdout).toContain('Exact export matches: 1');
    expect(stdout).toContain('Unmatched references: 1');
    expect(stderr).not.toContain('Local source/docs evidence failed');
    expect(report.summary).toMatchObject({
      docsReferenceCount: 2,
      exactMatchCount: 1,
      unmatchedReferenceCount: 1,
    });
    expect(report.comparison.matches).toMatchObject([
      {
        classification: 'exact-export-match',
        reference: {
          rawText: 'makeClient()',
          identifier: 'makeClient',
        },
      },
    ]);
    expect(report.comparison.unmatchedReferences).toMatchObject([
      {
        classification: 'unmatched-reference',
        reference: {
          rawText: 'MissingClient',
          identifier: 'MissingClient',
        },
      },
    ]);
    expect(manifest).toMatchObject({
      mode: 'source-verification-local-evidence',
      sourceVerification: {
        reportPath: 'source-verification-report.json',
        reportMode: 'source-verification-local-evidence',
        summary: report.summary,
      },
      generatedOutputs: [
        {
          path: 'source-verification-report.json',
          kind: 'source-verification-report-json',
        },
      ],
    });
    expect(verifyResult.stdout).toContain('Manifest verification');
    expect(verifyResult.stdout).toContain('Failures: 0');
    expect(verifyResult.stdout).toContain('Verification passed');
    expect(combinedOutput).not.toMatch(/\bofficial\b/i);
    expect(combinedOutput).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(combinedOutput).not.toMatch(
      /\bclaims correctness\b|\bproves correctness\b|\bguarantees correctness\b/i
    );
    expect(combinedOutput).not.toMatch(/\bverified\b/i);
    expect(combinedOutput).not.toMatch(/\bbehavior\b/i);
  });

  it('rejects URL-like and git-like source/docs inputs for local source/docs evidence', async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-source-verify-url-'));
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(docsDir, 'guide.md'), 'Use `value`.\n', 'utf-8');

    const sourceResult = await runCliWithExit([
      'source-truth',
      'verify-docs',
      '--source',
      'https://example.com/source',
      '--docs',
      docsDir,
      '--output-dir',
      join(dir, 'out-source'),
    ]);
    const docsResult = await runCliWithExit([
      'source-truth',
      'verify-docs',
      '--source',
      sourceDir,
      '--docs',
      'git@github.com:owner/repo.git',
      '--output-dir',
      join(dir, 'out-docs'),
    ]);

    expect(sourceResult.exitCode).toBe(1);
    expect(sourceResult.stderr).toContain('URL-like and git inputs are not supported');
    expect(docsResult.exitCode).toBe(1);
    expect(docsResult.stderr).toContain('URL-like and git inputs are not supported');
  });

  it('rejects source/docs evidence output directories inside either input tree', async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-source-verify-output-'));
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(docsDir, 'guide.md'), 'Use `value`.\n', 'utf-8');

    const sourceOutputResult = await runCliWithExit([
      'source-truth',
      'verify-docs',
      '--source',
      sourceDir,
      '--docs',
      docsDir,
      '--output-dir',
      join(sourceDir, 'reports'),
    ]);
    const docsOutputResult = await runCliWithExit([
      'source-truth',
      'verify-docs',
      '--source',
      sourceDir,
      '--docs',
      docsDir,
      '--output-dir',
      join(docsDir, 'reports'),
    ]);

    expect(sourceOutputResult.exitCode).toBe(1);
    expect(sourceOutputResult.stderr).toContain(
      'must not be the same as, or inside, the explicit --source or --docs path'
    );
    expect(docsOutputResult.exitCode).toBe(1);
    expect(docsOutputResult.stderr).toContain(
      'must not be the same as, or inside, the explicit --source or --docs path'
    );
    expect(await pathExists(join(sourceDir, 'reports'))).toBe(false);
    expect(await pathExists(join(docsDir, 'reports'))).toBe(false);
  });

  it('fails source/docs evidence with report details when docs have no supported references', async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-source-verify-empty-'));
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(docsDir, 'guide.md'), '# Guide\n\nNo references here.\n', 'utf-8');

    const result = await runCliWithExit([
      'source-truth',
      'verify-docs',
      '--source',
      sourceDir,
      '--docs',
      docsDir,
      '--output-dir',
      outputDir,
    ]);
    const report = JSON.parse(
      await readFile(join(outputDir, 'source-verification-report.json'), 'utf-8')
    ) as SourceVerificationReport;
    const failure = JSON.parse(
      await readFile(join(outputDir, 'failure.json'), 'utf-8')
    ) as SourceVerificationFailure;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Local source/docs evidence failed');
    expect(result.stderr).toContain('Failure report:');
    expect(result.stderr).toContain('Evidence report:');
    expect(report.summary.docsReferenceCount).toBe(0);
    expect(report.summary.exactMatchCount).toBe(0);
    expect(failure.reason).toBe('no-doc-reference-evidence');
    expect(failure.evidenceReport).toEqual({ path: 'source-verification-report.json' });
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(false);
  });

  it('fails source/docs evidence with failure artifacts when docs contain no supported files', async () => {
    const dir = await mkdtemp(
      join(await realpath(tmpdir()), 'llm-docs-source-verify-unsupported-')
    );
    tempDirs.push(dir);

    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(docsDir, 'guide.txt'), 'Use `value`.\n', 'utf-8');

    const result = await runCliWithExit([
      'source-truth',
      'verify-docs',
      '--source',
      sourceDir,
      '--docs',
      docsDir,
      '--output-dir',
      outputDir,
    ]);
    const report = JSON.parse(
      await readFile(join(outputDir, 'source-verification-report.json'), 'utf-8')
    ) as SourceVerificationReport;
    const failure = JSON.parse(
      await readFile(join(outputDir, 'failure.json'), 'utf-8')
    ) as SourceVerificationFailure;

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Local source/docs evidence failed');
    expect(result.stderr).toContain(
      'No supported local Markdown/MDX docs files were available for reference extraction.'
    );
    expect(result.stderr).toContain('Failure report:');
    expect(result.stderr).toContain('Evidence report:');
    expect(report.summary).toMatchObject({
      docsFileCount: 0,
      docsReferenceCount: 0,
      exactMatchCount: 0,
      unmatchedReferenceCount: 0,
    });
    expect(report.docs.files).toMatchObject([
      {
        path: 'guide.txt',
        status: 'skipped',
        supported: false,
        skipReason: 'unsupported-extension',
      },
    ]);
    expect(failure.reason).toBe('no-supported-docs-files');
    expect(failure.evidenceReport).toEqual({ path: 'source-verification-report.json' });
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(false);
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
    const manifestPath = join(outputDir, 'manifest.json');
    const reportText = await readFile(reportPath, 'utf-8');
    const report = JSON.parse(reportText) as WebsiteDiscoveryReport;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as DiscoveryReportManifest;

    expect(stdout).toContain('Website discovery');
    expect(stdout).toContain(`URL: ${explicitUrl}`);
    expect(stdout).toContain('Resources inspected: 3');
    expect(stdout).toContain('Candidate URLs: 7');
    expect(stdout).toContain('Warnings: 0');
    expect(stdout).toContain(`Report: ${reportPath}`);
    expect(stdout).toContain(`Manifest: ${manifestPath}`);
    expect(reportText.endsWith('\n')).toBe(true);
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
    expect(manifest).toMatchObject({
      schemaVersion: '0.1.0',
      mode: 'discovery-report',
      discovery: {
        kind: 'url',
        reportPath: 'discovery-report.json',
        reportSchemaVersion: '0.2.0',
        reportMode: 'website-bounded-inspection',
        candidateCount: 7,
        warningCount: 0,
        urlResourceCount: 3,
      },
      generatedOutputs: [
        {
          path: 'discovery-report.json',
          kind: 'discovery-report',
          byteSize: await byteSize(reportPath),
          hash: await sha256File(reportPath),
          lineCount: countTextLines(reportText),
          estimatedTokenCount: estimateTextTokens(reportText),
        },
      ],
    });
    expectWebsiteCandidateEvidenceIndex(manifest.candidateEvidenceIndex, report);
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
    const manifestPath = join(outputDir, 'manifest.json');
    const reportText = await readFile(reportPath, 'utf-8');
    const report = JSON.parse(reportText) as RepoDiscoveryReport;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as DiscoveryReportManifest;

    expect(stdout).toContain('Repo discovery');
    expect(stdout).toContain(`Report: ${reportPath}`);
    expect(stdout).toContain(`Manifest: ${manifestPath}`);
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
    expect(manifest).toMatchObject({
      schemaVersion: '0.1.0',
      mode: 'discovery-report',
      discovery: {
        kind: 'repo',
        reportPath: 'discovery-report.json',
        reportSchemaVersion: '0.2.0',
        reportMode: 'repo-bounded-inspection',
        candidateCount: report.candidates.length,
        warningCount: report.warnings.length,
      },
      generatedOutputs: [
        {
          path: 'discovery-report.json',
          kind: 'discovery-report',
          byteSize: await byteSize(reportPath),
          hash: await sha256File(reportPath),
          lineCount: countTextLines(reportText),
          estimatedTokenCount: estimateTextTokens(reportText),
        },
      ],
    });
    expect(manifest.discovery).not.toHaveProperty('urlResourceCount');
    expectLocalCandidateEvidenceIndex(manifest.candidateEvidenceIndex, report, {
      repo: {
        input: report.repo.input,
        normalizedInput: report.repo.normalizedInput,
        commit: report.repo.git.commit,
        dirty: report.repo.git.dirty,
      },
      scope: {
        input: report.scope.input,
        path: report.scope.path,
        resolvedPath: report.scope.resolvedPath,
        type: report.scope.type,
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
    expect(moduleDoc).toContain('<SYSTEM>Database operations for Supabase Swift SDK v2.</SYSTEM>');
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

  it('canonicalizes configured SDK manifest format metadata for openref config aliases', async () => {
    const configDir = await createTestConfig(['v2', 'v1'], 'openref');
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

    const manifestPath = join(outputDir, 'swift/v2/manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as GenerationManifest;
    const verifyResult = await runCli(['verify', '--manifest', manifestPath]);

    expect(manifest.mode).toBe('configured-sdk');
    expect(manifest.source.format).toBe('openref-0.1');
    expect(manifest.parser.format).toBe('openref-0.1');
    expect(verifyResult.stdout).toContain('Manifest verification');
    expect(verifyResult.stdout).toContain(`Checked files: ${manifest.generatedOutputs.length + 1}`);
    expect(verifyResult.stdout).toContain('Failures: 0');
    expect(verifyResult.stdout).toContain('Verification passed');
  });

  it('generates local Markdown and MDX directory source docs with manifest provenance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-source-dir-'));
    tempDirs.push(dir);
    const sourceDir = join(dir, 'docs-source');
    const outsideLinkedDoc = join(dir, 'outside-linked.md');
    const outputDir = join(dir, 'output');

    await mkdir(join(sourceDir, 'guides'), { recursive: true });
    await writeFile(
      join(sourceDir, 'index.md'),
      ['# Project Docs', '', 'Intro text.', '', '## Install', '', 'Run setup.', ''].join('\n'),
      'utf-8'
    );
    await writeFile(
      join(sourceDir, 'guides', 'usage.mdx'),
      [
        "import { Note } from './Note'",
        '',
        '# Usage Guide',
        '',
        '<Note>Use the public API.</Note>',
        '',
        '## Example',
        '',
        '```tsx',
        'export const example = <Widget />',
        '```',
        '',
      ].join('\n'),
      'utf-8'
    );
    await writeFile(join(sourceDir, 'ignored.txt'), '# Not parsed\n', 'utf-8');
    await writeFile(outsideLinkedDoc, '# Linked Secret\n\nThis must not be parsed.\n', 'utf-8');
    await symlink(outsideLinkedDoc, join(sourceDir, 'linked.md'), 'file');

    const { stdout } = await runCli(['generate', '--source', sourceDir, '--output-dir', outputDir]);

    const manifestPath = join(outputDir, 'manifest.json');
    const manifestText = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestText) as SourceDocsManifest;
    const outputPaths = manifest.generatedOutputs.map((output) => output.path);

    expect(stdout).toContain('Local source docs generated');
    expect(stdout).toContain('Format: markdown');
    expect(manifestText.endsWith('\n')).toBe(true);
    expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt);
    expect(manifest).toMatchObject({
      schemaVersion: '0.1.0',
      generator: {
        name: 'llm-docs-generator',
        version: '1.0.0',
        cliName: 'supabase-llm-docs',
      },
      mode: 'local-source-docs',
      source: {
        input: sourceDir,
        resolvedPath: sourceDir,
        type: 'directory',
        formatHint: 'auto',
        resolvedFormat: 'markdown',
        fileCount: 2,
      },
      parser: {
        name: 'Markdown Parser',
        version: '1.0.0',
        format: 'markdown',
      },
      formatter: {
        name: 'UniversalFormatter',
        version: '1.0.0',
        format: 'universal-llm-docs',
      },
    });
    expect(manifest.source.aggregateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.sourceFiles.map((file) => file.path)).toEqual(['guides/usage.mdx', 'index.md']);
    expect(manifest.sourceFiles.map((file) => file.format)).toEqual(['markdown', 'markdown']);
    expect(manifest.warnings).toContain('Skipped symlinked source entry: linked.md');
    expect(manifest.sourceFiles.map((file) => file.hash)).toEqual([
      await sha256File(join(sourceDir, 'guides', 'usage.mdx')),
      await sha256File(join(sourceDir, 'index.md')),
    ]);
    expect(manifest.sourceFiles.map((file) => file.byteSize)).toEqual([
      await byteSize(join(sourceDir, 'guides', 'usage.mdx')),
      await byteSize(join(sourceDir, 'index.md')),
    ]);
    for (const sourceFile of manifest.sourceFiles) {
      const text = await readFile(sourceFile.resolvedPath, 'utf-8');
      expect(sourceFile.lineCount).toBe(countTextLines(text));
      expect(sourceFile.estimatedTokenCount).toBe(estimateTextTokens(text));
    }
    expect(outputPaths).toEqual(['llm-docs/docs-source-full-llms.txt']);

    const fullDocPath = join(outputDir, outputPaths[0] ?? '');
    const fullDoc = await readFile(fullDocPath, 'utf-8');
    expect(fullDoc).toContain('# docs-source');
    expect(fullDoc).toContain('Project Docs');
    expect(fullDoc).toContain('Usage Guide');
    expect(fullDoc).toContain('export const example = <Widget />');
    expect(fullDoc).not.toContain("import { Note } from './Note'");
    expect(fullDoc).not.toContain('Linked Secret');
    expect(fullDoc).not.toContain('<!-- Format: markdown');

    for (const output of manifest.generatedOutputs) {
      expect(isAbsolute(output.path)).toBe(false);
      expect(output.path.startsWith('..')).toBe(false);
      expect(output.path.includes('\\')).toBe(false);
      expect(output.kind).toBe('llm-docs');

      const actualPath = join(outputDir, output.path);
      const text = await readFile(actualPath, 'utf-8');
      expect(output.byteSize).toBe(await byteSize(actualPath));
      expect(output.hash).toBe(await sha256File(actualPath));
      expect(output.lineCount).toBe(countTextLines(text));
      expect(output.estimatedTokenCount).toBe(estimateTextTokens(text));
    }
  });

  it('generates docs from an explicit single-file parser plugin and verifies without executing plugin code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-parser-plugin-generate-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'source.fixture');
    const outputDir = join(dir, 'output');

    await writeFile(sourcePath, 'Custom source payload\n', 'utf-8');
    const {
      manifestPath: pluginManifestPath,
      modulePath,
      sideEffectPath,
      formatId,
    } = await createParserPluginFixture({ dir });

    const { stdout } = await runCli([
      'generate',
      '--source',
      sourcePath,
      '--parser-plugin-manifest',
      pluginManifestPath,
      '--format',
      formatId,
      '--output-dir',
      outputDir,
    ]);

    const manifestPath = join(outputDir, 'manifest.json');
    const manifestText = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestText) as SourceDocsManifest;
    const fullDocPath = join(outputDir, 'llm-docs', 'source-full-llms.txt');
    const fullDoc = await readFile(fullDocPath, 'utf-8');
    const sourceText = await readFile(sourcePath, 'utf-8');

    expect(stdout).toContain('Local source docs generated');
    expect(stdout).toContain('Format: custom-doc');
    expect(stdout).toContain('Parser plugin: fixture-parser-plugin 1.2.3');
    expect(await readFile(sideEffectPath, 'utf-8')).toBe('import\ndetect\nparse\n');
    expect(fullDoc).toContain('# Fixture Custom Docs');
    expect(fullDoc).toContain('Plugin parsed: Custom source payload');
    expect(manifest).toMatchObject({
      mode: 'local-source-docs',
      source: {
        input: sourcePath,
        resolvedPath: sourcePath,
        type: 'file',
        formatHint: 'custom-doc',
        resolvedFormat: 'custom-doc',
        byteSize: await byteSize(sourcePath),
        hash: await sha256File(sourcePath),
      },
      parser: {
        name: 'Fixture Custom Parser',
        version: '1.2.3',
        format: 'custom-doc',
        plugin: {
          manifestPath: pluginManifestPath,
          resolvedManifestPath: pluginManifestPath,
          manifestByteSize: await byteSize(pluginManifestPath),
          manifestHash: await sha256File(pluginManifestPath),
          name: 'fixture-parser-plugin',
          version: '1.2.3',
          module: {
            path: 'plugin.mjs',
            resolvedPath: await realpath(modulePath),
          },
          format: {
            id: 'custom-doc',
            displayName: 'Fixture Custom Format',
            extensions: ['fixture'],
            mediaTypes: ['text/x-fixture'],
            directorySupport: false,
          },
          execution: {
            codeExecuted: true,
            trust: 'trusted-local-code',
            sandboxed: false,
          },
        },
      },
      formatter: {
        name: 'UniversalFormatter',
        version: '1.0.0',
        format: 'universal-llm-docs',
      },
    });
    expect(manifest.parser.plugin?.execution.statement).toContain('not sandboxed');
    expect(manifest.sourceFiles).toEqual([
      {
        path: 'source.fixture',
        resolvedPath: sourcePath,
        byteSize: await byteSize(sourcePath),
        hash: await sha256File(sourcePath),
        lineCount: countTextLines(sourceText),
        estimatedTokenCount: estimateTextTokens(sourceText),
        format: 'custom-doc',
      },
    ]);
    expect(manifest.generatedOutputs).toHaveLength(1);
    expect(manifest.generatedOutputs[0]).toMatchObject({
      path: 'llm-docs/source-full-llms.txt',
      kind: 'llm-docs',
      name: 'agent-readable docs text',
      byteSize: await byteSize(fullDocPath),
      hash: await sha256File(fullDocPath),
      lineCount: countTextLines(fullDoc),
      estimatedTokenCount: estimateTextTokens(fullDoc),
    });
    expect(manifest.semanticChunkIndexes).toBeUndefined();

    await writeFile(
      modulePath,
      [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(sideEffectPath)}, 'verify-import\\n');`,
        "throw new Error('verify imported plugin code');",
        '',
      ].join('\n'),
      'utf-8'
    );

    const verifyResult = await runCli(['verify', '--manifest', manifestPath]);

    expect(verifyResult.stdout).toContain('Manifest verification');
    expect(verifyResult.stdout).toContain(
      `Checked files: ${manifest.generatedOutputs.length + manifest.sourceFiles.length + 1}`
    );
    expect(verifyResult.stdout).toContain('Failures: 0');
    expect(verifyResult.stdout).toContain('Verification passed');
    expect(await readFile(sideEffectPath, 'utf-8')).toBe('import\ndetect\nparse\n');
  });

  it('rejects parser plugin manifest and module paths inside source-doc output artifacts without deleting them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-parser-plugin-artifact-inputs-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'source.fixture');

    await writeFile(sourcePath, 'Custom source payload\n', 'utf-8');

    const cases: Array<{
      name: string;
      manifestName?: string;
      moduleName?: string;
      expected: string;
    }> = [
      {
        name: 'manifest output path',
        manifestName: 'output-manifest/manifest.json',
        expected: 'parser plugin manifest path must not be the source-docs manifest path',
      },
      {
        name: 'manifest generated docs directory',
        manifestName: 'output-manifest-docs/llm-docs/parser-plugin.json',
        expected:
          'parser plugin manifest path must not be inside the source-docs generated docs directory',
      },
      {
        name: 'manifest generated chunks directory',
        manifestName: 'output-manifest-chunks/chunks/parser-plugin.json',
        expected:
          'parser plugin manifest path must not be inside the source-docs generated chunks directory',
      },
      {
        name: 'module generated docs directory',
        moduleName: 'output-module-docs/llm-docs/plugin.mjs',
        expected:
          'parser plugin module path must not be inside the source-docs generated docs directory',
      },
      {
        name: 'module generated chunks directory',
        moduleName: 'output-module-chunks/chunks/plugin.mjs',
        expected:
          'parser plugin module path must not be inside the source-docs generated chunks directory',
      },
    ];

    for (const testCase of cases) {
      const artifactRoot = (testCase.manifestName ?? testCase.moduleName)?.split('/')[0];

      if (artifactRoot === undefined) {
        throw new Error(`expected artifact root for ${testCase.name}`);
      }

      const outputDir = join(dir, artifactRoot);
      const manifestName = testCase.manifestName ?? `${artifactRoot}-parser-plugin.json`;
      const moduleName = testCase.moduleName ?? `${artifactRoot}-plugin.mjs`;
      const {
        manifestPath: pluginManifestPath,
        modulePath,
        sideEffectPath,
        formatId,
      } = await createParserPluginFixture({
        dir,
        manifestName,
        moduleName,
      });
      const manifestBefore = await readFile(pluginManifestPath, 'utf-8');
      const moduleBefore = await readFile(modulePath, 'utf-8');

      const result = await runCliWithExit([
        'generate',
        '--source',
        sourcePath,
        '--parser-plugin-manifest',
        pluginManifestPath,
        '--format',
        formatId,
        '--output-dir',
        outputDir,
      ]);

      expect(result.exitCode, testCase.name).toBe(1);
      expect(result.stderr, testCase.name).toContain(testCase.expected);
      expect(await readFile(pluginManifestPath, 'utf-8')).toBe(manifestBefore);
      expect(await readFile(modulePath, 'utf-8')).toBe(moduleBefore);
      await expect(readFile(sideEffectPath, 'utf-8')).rejects.toThrow();
    }
  });

  it('accepts parser plugin module filenames that start with two dots without parent traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-parser-plugin-dotfile-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'source.fixture');
    const outputDir = join(dir, 'output');

    await writeFile(sourcePath, 'Custom source payload\n', 'utf-8');
    const { manifestPath, formatId } = await createParserPluginFixture({
      dir,
      moduleName: '..parser.mjs',
    });

    await runCli([
      'generate',
      '--source',
      sourcePath,
      '--parser-plugin-manifest',
      manifestPath,
      '--format',
      formatId,
      '--output-dir',
      outputDir,
    ]);

    const verifyResult = await runCli(['verify', '--manifest', join(outputDir, 'manifest.json')]);

    expect(verifyResult.stdout).toContain('Failures: 0');
    expect(verifyResult.stdout).toContain('Verification passed');
  });

  it('verify fails when generated parser plugin metadata is tampered without executing plugin code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-parser-plugin-tamper-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'source.fixture');
    const outputDir = join(dir, 'output');

    await writeFile(sourcePath, 'Custom source payload\n', 'utf-8');
    const {
      manifestPath: pluginManifestPath,
      modulePath,
      sideEffectPath,
      formatId,
    } = await createParserPluginFixture({ dir });

    await runCli([
      'generate',
      '--source',
      sourcePath,
      '--parser-plugin-manifest',
      pluginManifestPath,
      '--format',
      formatId,
      '--output-dir',
      outputDir,
    ]);

    const generatedManifestPath = join(outputDir, 'manifest.json');
    const generatedManifest = JSON.parse(
      await readFile(generatedManifestPath, 'utf-8')
    ) as SourceDocsManifest;

    if (generatedManifest.parser.plugin === undefined) {
      throw new Error('expected generated parser plugin metadata');
    }

    generatedManifest.parser.plugin.name = 'tampered-parser-plugin';
    generatedManifest.parser.plugin.version = '9.9.9';
    generatedManifest.parser.plugin.module.path = 'tampered.mjs';
    generatedManifest.parser.plugin.format.displayName = 'Tampered Format';
    generatedManifest.parser.plugin.format.extensions = ['tampered'];
    generatedManifest.parser.plugin.format.mediaTypes = ['text/x-tampered'];
    generatedManifest.parser.plugin.format.directorySupport = true;

    await writeFile(
      generatedManifestPath,
      `${JSON.stringify(generatedManifest, null, 2)}\n`,
      'utf-8'
    );
    await writeFile(
      modulePath,
      [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(sideEffectPath)}, 'verify-import\\n');`,
        "throw new Error('verify imported plugin code');",
        '',
      ].join('\n'),
      'utf-8'
    );

    const verifyResult = await runCliWithExit(['verify', '--manifest', generatedManifestPath]);

    expect(verifyResult.exitCode).toBe(1);
    expect(verifyResult.stdout).toContain('Manifest verification');
    expect(verifyResult.stdout).toContain('Failures:');
    expect(verifyResult.stderr).toContain(
      'parser.plugin.name must match parser plugin manifest name'
    );
    expect(verifyResult.stderr).toContain(
      'parser.plugin.version must match parser plugin manifest version'
    );
    expect(verifyResult.stderr).toContain(
      'parser.plugin.module.path must match parser plugin manifest module'
    );
    expect(verifyResult.stderr).toContain(
      'parser.plugin.format.displayName must match parser plugin manifest selected format'
    );
    expect(verifyResult.stderr).toContain(
      'parser.plugin.format.extensions must match parser plugin manifest selected format'
    );
    expect(verifyResult.stderr).toContain(
      'parser.plugin.format.mediaTypes must match parser plugin manifest selected format'
    );
    expect(verifyResult.stderr).toContain(
      'parser.plugin.format.directorySupport must match parser plugin manifest selected format'
    );
    expect(await readFile(sideEffectPath, 'utf-8')).toBe('import\ndetect\nparse\n');
  });

  it('verify rejects parser plugin manifests that claim semantic chunk outputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-parser-plugin-chunk-claim-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'source.fixture');
    const outputDir = join(dir, 'output');

    await writeFile(sourcePath, 'Custom source payload\n', 'utf-8');
    const {
      manifestPath: pluginManifestPath,
      modulePath,
      sideEffectPath,
      formatId,
    } = await createParserPluginFixture({ dir });

    await runCli([
      'generate',
      '--source',
      sourcePath,
      '--parser-plugin-manifest',
      pluginManifestPath,
      '--format',
      formatId,
      '--output-dir',
      outputDir,
    ]);

    const chunkDir = join(outputDir, 'chunks');
    const chunkPath = join(chunkDir, 'semantic-chunks.jsonl');
    const chunkText = '{"id":"fake","content":"plugin chunks are unsupported"}\n';
    await mkdir(chunkDir, { recursive: true });
    await writeFile(chunkPath, chunkText, 'utf-8');

    const generatedManifestPath = join(outputDir, 'manifest.json');
    const generatedManifest = JSON.parse(
      await readFile(generatedManifestPath, 'utf-8')
    ) as SourceDocsManifest;
    generatedManifest.generatedOutputs.push({
      path: 'chunks/semantic-chunks.jsonl',
      kind: 'semantic-chunks-jsonl',
      name: 'semantic chunk records',
      byteSize: await byteSize(chunkPath),
      hash: await sha256File(chunkPath),
      lineCount: countTextLines(chunkText),
      estimatedTokenCount: estimateTextTokens(chunkText),
    });
    await writeFile(
      generatedManifestPath,
      `${JSON.stringify(generatedManifest, null, 2)}\n`,
      'utf-8'
    );
    await writeFile(
      modulePath,
      [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(sideEffectPath)}, 'verify-import\\n');`,
        "throw new Error('verify imported plugin code');",
        '',
      ].join('\n'),
      'utf-8'
    );

    const verifyResult = await runCliWithExit(['verify', '--manifest', generatedManifestPath]);

    expect(verifyResult.exitCode).toBe(1);
    expect(verifyResult.stderr).toContain(
      'generatedOutputs[1].kind must not be semantic-chunks-jsonl for parser.plugin source manifests'
    );
    expect(await readFile(sideEffectPath, 'utf-8')).toBe('import\ndetect\nparse\n');
  });

  it('refresh rejects parser plugin local-source-docs manifests without executing plugin code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-parser-plugin-refresh-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'source.fixture');
    const outputDir = join(dir, 'output');

    await writeFile(sourcePath, 'Custom source payload\n', 'utf-8');
    const {
      manifestPath: pluginManifestPath,
      modulePath,
      sideEffectPath,
      formatId,
    } = await createParserPluginFixture({ dir });

    await runCli([
      'generate',
      '--source',
      sourcePath,
      '--parser-plugin-manifest',
      pluginManifestPath,
      '--format',
      formatId,
      '--output-dir',
      outputDir,
    ]);

    await writeFile(
      modulePath,
      [
        "import { appendFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(sideEffectPath)}, 'refresh-import\\n');`,
        "throw new Error('refresh imported plugin code');",
        '',
      ].join('\n'),
      'utf-8'
    );

    const refreshResult = await runCliWithExit([
      'refresh',
      '--manifest',
      join(outputDir, 'manifest.json'),
    ]);

    expect(refreshResult.exitCode).toBe(1);
    expect(refreshResult.stderr).toContain(
      'refresh does not support parser-plugin local-source-docs manifests'
    );
    expect(refreshResult.stderr).toContain('generate --source --parser-plugin-manifest --format');
    expect(await readFile(sideEffectPath, 'utf-8')).toBe('import\ndetect\nparse\n');
  });

  it('rejects unsupported explicit parser plugin generate option combinations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-parser-plugin-combos-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'source.fixture');
    const sourceDir = join(dir, 'source-dir');
    const outputDir = join(dir, 'output');

    await writeFile(sourcePath, 'Custom source payload\n', 'utf-8');
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, 'source.fixture'), 'Directory payload\n', 'utf-8');
    const { manifestPath, formatId } = await createParserPluginFixture({ dir });

    const cases: Array<{ name: string; args: string[]; expected: string }> = [
      {
        name: 'missing format',
        args: [
          'generate',
          '--source',
          sourcePath,
          '--parser-plugin-manifest',
          manifestPath,
          '--output-dir',
          outputDir,
        ],
        expected: 'requires explicit --format <plugin-format-id>',
      },
      {
        name: 'auto format',
        args: [
          'generate',
          '--source',
          sourcePath,
          '--parser-plugin-manifest',
          manifestPath,
          '--format',
          'auto',
          '--output-dir',
          outputDir,
        ],
        expected: "'auto' is a built-in source format",
      },
      {
        name: 'built-in format',
        args: [
          'generate',
          '--source',
          sourcePath,
          '--parser-plugin-manifest',
          manifestPath,
          '--format',
          'markdown',
          '--output-dir',
          outputDir,
        ],
        expected: "'markdown' is a built-in source format",
      },
      {
        name: 'sdk',
        args: [
          'generate',
          '--sdk',
          'swift',
          '--source',
          sourcePath,
          '--parser-plugin-manifest',
          manifestPath,
          '--format',
          formatId,
          '--output-dir',
          outputDir,
        ],
        expected: 'cannot be used with --sdk',
      },
      {
        name: 'preset',
        args: [
          'generate',
          '--source',
          sourcePath,
          '--parser-plugin-manifest',
          manifestPath,
          '--format',
          formatId,
          '--preset',
          'swift-book',
          '--output-dir',
          outputDir,
        ],
        expected: 'cannot be combined with --preset',
      },
      {
        name: 'chunks',
        args: [
          'generate',
          '--source',
          sourcePath,
          '--parser-plugin-manifest',
          manifestPath,
          '--format',
          formatId,
          '--chunks',
          'jsonl',
          '--output-dir',
          outputDir,
        ],
        expected: 'cannot be combined with --chunks',
      },
      {
        name: 'directory source',
        args: [
          'generate',
          '--source',
          sourceDir,
          '--parser-plugin-manifest',
          manifestPath,
          '--format',
          formatId,
          '--output-dir',
          outputDir,
        ],
        expected: 'supports explicit local source files only',
      },
    ];

    for (const testCase of cases) {
      const result = await runCliWithExit(testCase.args);

      expect(result.exitCode, testCase.name).toBe(1);
      expect(result.stderr, testCase.name).toContain(testCase.expected);
      expect(result.stdout, testCase.name).not.toContain('Local source docs generated');
    }
  });

  it('rejects invalid parser plugin manifests modules exports detection and DocNode output', async () => {
    const cases: Array<{
      name: string;
      setup: (dir: string) => Promise<{ args: string[]; expected: string }>;
    }> = [
      {
        name: 'format not declared',
        setup: async (dir) => {
          const sourcePath = join(dir, 'source.fixture');
          await writeFile(sourcePath, 'payload\n', 'utf-8');
          const { manifestPath } = await createParserPluginFixture({ dir });

          return {
            args: [
              'generate',
              '--source',
              sourcePath,
              '--parser-plugin-manifest',
              manifestPath,
              '--format',
              'other-doc',
              '--output-dir',
              join(dir, 'output'),
            ],
            expected: "does not declare requested format 'other-doc'",
          };
        },
      },
      {
        name: 'invalid manifest',
        setup: async (dir) => {
          const sourcePath = join(dir, 'source.fixture');
          await writeFile(sourcePath, 'payload\n', 'utf-8');
          const { manifestPath, formatId } = await createParserPluginFixture({
            dir,
            manifestOverrides: { schemaVersion: '9.9.9' },
          });

          return {
            args: [
              'generate',
              '--source',
              sourcePath,
              '--parser-plugin-manifest',
              manifestPath,
              '--format',
              formatId,
              '--output-dir',
              join(dir, 'output'),
            ],
            expected: 'parser plugin manifest invalid',
          };
        },
      },
      {
        name: 'missing module',
        setup: async (dir) => {
          const sourcePath = join(dir, 'source.fixture');
          await writeFile(sourcePath, 'payload\n', 'utf-8');
          const { manifestPath, modulePath, formatId } = await createParserPluginFixture({ dir });
          await rm(modulePath);

          return {
            args: [
              'generate',
              '--source',
              sourcePath,
              '--parser-plugin-manifest',
              manifestPath,
              '--format',
              formatId,
              '--output-dir',
              join(dir, 'output'),
            ],
            expected: 'parser plugin module file not found',
          };
        },
      },
      {
        name: 'symlink module',
        setup: async (dir) => {
          const sourcePath = join(dir, 'source.fixture');
          const outsideModulePath = join(dir, 'outside-plugin.mjs');
          await writeFile(sourcePath, 'payload\n', 'utf-8');
          await writeFile(outsideModulePath, 'export default {};\n', 'utf-8');
          const { manifestPath, modulePath, formatId } = await createParserPluginFixture({ dir });
          await rm(modulePath);
          await symlink(outsideModulePath, modulePath, 'file');

          return {
            args: [
              'generate',
              '--source',
              sourcePath,
              '--parser-plugin-manifest',
              manifestPath,
              '--format',
              formatId,
              '--output-dir',
              join(dir, 'output'),
            ],
            expected: 'parser plugin module must not be a symbolic link',
          };
        },
      },
      {
        name: 'bad export',
        setup: async (dir) => {
          const sourcePath = join(dir, 'source.fixture');
          await writeFile(sourcePath, 'payload\n', 'utf-8');
          const { manifestPath, formatId } = await createParserPluginFixture({
            dir,
            moduleSource: 'export const notParser = {};\n',
          });

          return {
            args: [
              'generate',
              '--source',
              sourcePath,
              '--parser-plugin-manifest',
              manifestPath,
              '--format',
              formatId,
              '--output-dir',
              join(dir, 'output'),
            ],
            expected: "must export a parser object as default or named 'parser'",
          };
        },
      },
      {
        name: 'format mismatch',
        setup: async (dir) => {
          const sourcePath = join(dir, 'source.fixture');
          await writeFile(sourcePath, 'payload\n', 'utf-8');
          const { manifestPath, formatId } = await createParserPluginFixture({
            dir,
            moduleSource:
              "export default { name: 'Mismatch Parser', format: 'wrong-doc', parse() { return {}; } };\n",
          });

          return {
            args: [
              'generate',
              '--source',
              sourcePath,
              '--parser-plugin-manifest',
              manifestPath,
              '--format',
              formatId,
              '--output-dir',
              join(dir, 'output'),
            ],
            expected: "parser.format must exactly match requested --format 'custom-doc'",
          };
        },
      },
      {
        name: 'detect false',
        setup: async (dir) => {
          const sourcePath = join(dir, 'source.fixture');
          await writeFile(sourcePath, 'payload\n', 'utf-8');
          const { manifestPath, formatId } = await createParserPluginFixture({
            dir,
            moduleSource: [
              'export default {',
              "  name: 'Detect False Parser',",
              "  format: 'custom-doc',",
              '  detect() { return false; },',
              "  parse() { throw new Error('parse should not run'); },",
              '};',
              '',
            ].join('\n'),
          });

          return {
            args: [
              'generate',
              '--source',
              sourcePath,
              '--parser-plugin-manifest',
              manifestPath,
              '--format',
              formatId,
              '--output-dir',
              join(dir, 'output'),
            ],
            expected: 'detect returned false',
          };
        },
      },
      {
        name: 'invalid DocNode',
        setup: async (dir) => {
          const sourcePath = join(dir, 'source.fixture');
          await writeFile(sourcePath, 'payload\n', 'utf-8');
          const { manifestPath, formatId } = await createParserPluginFixture({
            dir,
            moduleSource:
              "export default { name: 'Invalid Output Parser', format: 'custom-doc', parse() { return { type: 'not-a-node' }; } };\n",
          });

          return {
            args: [
              'generate',
              '--source',
              sourcePath,
              '--parser-plugin-manifest',
              manifestPath,
              '--format',
              formatId,
              '--output-dir',
              join(dir, 'output'),
            ],
            expected: 'parse returned invalid DocNode',
          };
        },
      },
    ];

    for (const testCase of cases) {
      const dir = await mkdtemp(join(tmpdir(), `llm-docs-parser-plugin-${testCase.name}-`));
      tempDirs.push(dir);
      const { args, expected } = await testCase.setup(dir);
      const result = await runCliWithExit(args);

      expect(result.exitCode, testCase.name).toBe(1);
      expect(result.stderr, testCase.name).toContain(expected);
      expect(result.stdout, testCase.name).not.toContain('Local source docs generated');
    }
  });

  it('generates swift-book preset docs from an explicit nested DocC-style Markdown directory', async () => {
    const { sourceDir, outputDir } = await createSwiftBookSourceFixture();

    const { stdout } = await runCli([
      'generate',
      '--source',
      sourceDir,
      '--preset',
      'swift-book',
      '--output-dir',
      outputDir,
    ]);

    const manifestPath = join(outputDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as SourceDocsManifest;
    const outputPath = join(outputDir, 'llm-docs', 'swift-book-full-llms.txt');
    const fullDoc = await readFile(outputPath, 'utf-8');
    const verifyResult = await runCli(['verify', '--output-dir', outputDir]);

    expect(stdout).toContain('Local source docs generated');
    expect(stdout).toContain('Format: markdown');
    expect(stdout).toContain('Preset: swift-book');
    expect(manifest.source).toMatchObject({
      input: sourceDir,
      resolvedPath: sourceDir,
      type: 'directory',
      formatHint: 'markdown',
      resolvedFormat: 'markdown',
      fileCount: 3,
    });
    expect(manifest.sourceFiles.map((file) => file.path)).toEqual([
      'GuidedTour.md',
      'LanguageGuide/BasicOperators.md',
      'ReferenceManual/Declarations/Attributes.md',
    ]);
    expect(manifest.generatedOutputs.map((output) => output.path)).toEqual([
      'llm-docs/swift-book-full-llms.txt',
    ]);
    expect(manifest.preset).toMatchObject({
      name: 'swift-book',
      configPath: join(repoRoot, 'config/presets/swift-book.json'),
      displayName: 'Swift Programming Language',
      defaults: {
        format: 'markdown',
        filenamePrefix: 'swift-book',
        title: 'Swift Programming Language',
        systemPrompt:
          'Generated Swift Programming Language docs from an explicit local source path supplied by the user or agent, formatted for LLM and AI coding assistant consumption.',
        outputFormats: ['txt'],
      },
      metadata: {
        sourceSelection: 'explicit-local-source-required',
        sourceVerification: 'not-performed',
        sourceTruthClaim: 'not-claimed',
      },
      limitations: expect.arrayContaining([
        'Requires an explicit local --source path.',
        'Does not select or infer source paths.',
        'Does not claim source truth.',
      ]),
    });
    expect(manifest.source.resolvedPath).toBe(sourceDir);
    expect(manifest.sourceFiles.every((file) => file.resolvedPath.startsWith(sourceDir))).toBe(
      true
    );
    expect(fullDoc).toContain(
      '<SYSTEM>Generated Swift Programming Language docs from an explicit local source path supplied by the user or agent, formatted for LLM and AI coding assistant consumption.</SYSTEM>'
    );
    expect(fullDoc).not.toContain('Complete Swift Programming Language documentation');
    expect(fullDoc).toContain('# Swift Programming Language');
    expect(fullDoc).toContain('A Swift Tour');
    expect(fullDoc).toContain('Basic Operators');
    expect(fullDoc).toContain('Attributes');
    expect(fullDoc).not.toContain('# TSPL.docc');
    expect(verifyResult.stdout).toContain('Manifest verification');
    expect(verifyResult.stdout).toContain('Failures: 0');
    expect(verifyResult.stdout).toContain('Verification passed');
  });

  it('preserves semantic chunk JSONL compatibility for the swift-book preset', async () => {
    const { sourceDir, outputDir } = await createSwiftBookSourceFixture(
      'llm-docs-swift-book-chunks-'
    );

    const { stdout } = await runCli([
      'generate',
      '--source',
      sourceDir,
      '--preset',
      'swift-book',
      '--chunks',
      'jsonl',
      '--output-dir',
      outputDir,
    ]);

    const manifest = JSON.parse(
      await readFile(join(outputDir, 'manifest.json'), 'utf-8')
    ) as SourceDocsManifest;
    const chunkOutput = manifest.generatedOutputs.find(
      (output) => output.kind === 'semantic-chunks-jsonl'
    );
    const chunkPath = join(outputDir, 'chunks', 'semantic-chunks.jsonl');
    const chunkJsonl = await readFile(chunkPath, 'utf-8');
    const verifyResult = await runCli(['verify', '--output-dir', outputDir]);

    expect(stdout).toContain('Preset: swift-book');
    expect(stdout).toContain('Chunk export: chunks/semantic-chunks.jsonl');
    expect(manifest.generatedOutputs.map((output) => output.path)).toEqual([
      'chunks/semantic-chunks.jsonl',
      'llm-docs/swift-book-full-llms.txt',
    ]);
    expect(chunkOutput).toMatchObject({
      path: 'chunks/semantic-chunks.jsonl',
      kind: 'semantic-chunks-jsonl',
      name: 'semantic chunks JSONL export',
    });
    expect(chunkJsonl.endsWith('\n')).toBe(true);
    expect(chunkJsonl).toContain('Basic Operators');
    expect(verifyResult.stdout).toContain('Failures: 0');
    expect(verifyResult.stdout).toContain('Verification passed');
  });

  it('generates opt-in semantic chunk JSONL for local source docs and verifies the manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-source-chunks-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'chunk-docs.md');
    const outputDir = join(dir, 'output');
    const secondOutputDir = join(dir, 'output-second');

    await writeFile(
      sourcePath,
      [
        '# Chunk Docs',
        '',
        'Intro text for the document.',
        '',
        '## Install',
        '',
        'Run setup once.',
        '',
        '## Install',
        '',
        'Run setup again.',
        '',
        '```ts',
        'export const value = 1;',
        '```',
        '',
      ].join('\n'),
      'utf-8'
    );

    const { stdout } = await runCli([
      'generate',
      '--source',
      sourcePath,
      '--format',
      'markdown',
      '--chunks',
      'jsonl',
      '--output-dir',
      outputDir,
    ]);

    await runCli([
      'generate',
      '--source',
      sourcePath,
      '--format',
      'markdown',
      '--chunks',
      'jsonl',
      '--output-dir',
      secondOutputDir,
    ]);

    const manifestPath = join(outputDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as SourceDocsManifest;
    const secondManifest = JSON.parse(
      await readFile(join(secondOutputDir, 'manifest.json'), 'utf-8')
    ) as SourceDocsManifest;
    const chunkOutput = manifest.generatedOutputs.find(
      (output) => output.kind === 'semantic-chunks-jsonl'
    );
    const llmOutput = manifest.generatedOutputs.find((output) => output.kind === 'llm-docs');

    expect(stdout).toContain('Local source docs generated');
    expect(stdout).toContain('Generated files: 2');
    expect(stdout).toContain('Chunk export: chunks/semantic-chunks.jsonl');
    expect(manifest.generatedOutputs.map((output) => output.path)).toEqual([
      'chunks/semantic-chunks.jsonl',
      'llm-docs/chunk-docs-full-llms.txt',
    ]);
    expect(chunkOutput).toMatchObject({
      path: 'chunks/semantic-chunks.jsonl',
      kind: 'semantic-chunks-jsonl',
      name: 'semantic chunks JSONL export',
    });
    expect(llmOutput).toMatchObject({
      path: 'llm-docs/chunk-docs-full-llms.txt',
      kind: 'llm-docs',
      name: 'agent-readable docs text',
    });

    if (chunkOutput === undefined) {
      throw new Error('expected semantic chunk JSONL manifest output');
    }

    const chunkPath = join(outputDir, chunkOutput.path);
    const chunkJsonl = await readFile(chunkPath, 'utf-8');
    const secondChunkJsonl = await readFile(
      join(secondOutputDir, 'chunks/semantic-chunks.jsonl'),
      'utf-8'
    );
    const lines = chunkJsonl.trimEnd().split('\n');
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const semanticChunkIndex = manifest.semanticChunkIndexes?.[0];

    expect(chunkJsonl).toBe(secondChunkJsonl);
    expect(chunkJsonl.endsWith('\n')).toBe(true);
    expect(records.map((record) => record.id)).toEqual([
      'chunk-docs/chunk-docs',
      'chunk-docs/chunk-docs/install',
      'chunk-docs/chunk-docs/install~2',
    ]);
    expect(records.map((record) => record.ordinal)).toEqual([1, 2, 3]);

    for (const [index, record] of records.entries()) {
      expect(record).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          ordinal: index + 1,
          title: expect.any(String),
          path: expect.any(Array),
          nodePath: expect.any(Array),
          content: expect.any(String),
          contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          characterCount: expect.any(Number),
          estimatedTokenCount: expect.any(Number),
          warnings: expect.any(Array),
          metadata: expect.any(Object),
        })
      );
      expect(record.contentHash).toBe(
        createHash('sha256').update(String(record.content)).digest('hex')
      );
      expect(record.characterCount).toBe(String(record.content).length);
    }

    expect(records[0]?.sourceFormat).toBe('markdown');
    expect(records[0]?.sourcePath).toBe(sourcePath);
    expect(String(records[0]?.content)).toContain('# Chunk Docs');
    expect(String(records[2]?.content)).toContain('```ts\nexport const value = 1;\n```');
    expect(records[2]?.warnings).toEqual([
      {
        code: 'duplicate_node_id',
        nodePath: ['chunk-docs', 'chunk-docs', 'install~2'],
        message: 'Duplicate sibling node id "install" was disambiguated as "install~2".',
        chunkId: 'chunk-docs/chunk-docs/install~2',
      },
    ]);
    expect(chunkOutput.byteSize).toBe(await byteSize(chunkPath));
    expect(chunkOutput.hash).toBe(await sha256File(chunkPath));
    expect(chunkOutput.lineCount).toBe(records.length);
    expect(chunkOutput.estimatedTokenCount).toBe(estimateTextTokens(chunkJsonl));
    expect(manifest.semanticChunkIndexes).toHaveLength(1);
    expect(semanticChunkIndex).toMatchObject({
      path: 'chunks/semantic-chunks.jsonl',
      format: 'jsonl',
      chunkCount: records.length,
      warningCount: 1,
      aggregateHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(semanticChunkIndex?.chunks).toEqual([
      {
        id: 'chunk-docs/chunk-docs',
        order: 1,
        title: 'Chunk Docs',
        path: ['Chunk Docs', 'Chunk Docs'],
        nodePath: ['chunk-docs', 'chunk-docs'],
        contentHash: records[0]?.contentHash,
        characterCount: records[0]?.characterCount,
        estimatedTokenCount: records[0]?.estimatedTokenCount,
        sourceFormat: 'markdown',
        sourcePath,
        warningCount: 0,
      },
      {
        id: 'chunk-docs/chunk-docs/install',
        order: 2,
        title: 'Install',
        path: ['Chunk Docs', 'Chunk Docs', 'Install'],
        nodePath: ['chunk-docs', 'chunk-docs', 'install'],
        contentHash: records[1]?.contentHash,
        characterCount: records[1]?.characterCount,
        estimatedTokenCount: records[1]?.estimatedTokenCount,
        sourceFormat: 'markdown',
        sourcePath,
        warningCount: 0,
      },
      {
        id: 'chunk-docs/chunk-docs/install~2',
        order: 3,
        title: 'Install',
        path: ['Chunk Docs', 'Chunk Docs', 'Install'],
        nodePath: ['chunk-docs', 'chunk-docs', 'install~2'],
        contentHash: records[2]?.contentHash,
        characterCount: records[2]?.characterCount,
        estimatedTokenCount: records[2]?.estimatedTokenCount,
        sourceFormat: 'markdown',
        sourcePath,
        warningCount: 1,
      },
    ]);
    expect(semanticChunkIndex?.chunks[0]).not.toHaveProperty('content');
    expect(secondManifest.semanticChunkIndexes?.[0]?.aggregateHash).toBe(
      semanticChunkIndex?.aggregateHash
    );
    expect(secondManifest.semanticChunkIndexes?.[0]?.chunks).toEqual(semanticChunkIndex?.chunks);

    const verifyResult = await runCli(['verify', '--output-dir', outputDir]);

    expect(verifyResult.stdout).toContain('Manifest verification');
    expect(verifyResult.stdout).toContain(
      `Checked files: ${manifest.sourceFiles.length + manifest.generatedOutputs.length}`
    );
    expect(verifyResult.stdout).toContain('Failures: 0');
    expect(verifyResult.stdout).toContain('Verification passed');
  });

  it('rejects stale semantic chunk manifest index metadata during verify', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-source-chunk-index-stale-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'indexed-docs.md');
    const outputDir = join(dir, 'output');
    const manifestPath = join(outputDir, 'manifest.json');

    await writeFile(
      sourcePath,
      ['# Indexed Docs', '', 'Stable chunk text.', '', '## Usage', '', 'Use it.', ''].join('\n'),
      'utf-8'
    );
    await runCli([
      'generate',
      '--source',
      sourcePath,
      '--format',
      'markdown',
      '--chunks',
      'jsonl',
      '--output-dir',
      outputDir,
    ]);

    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as SourceDocsManifest;
    const semanticChunkIndex = manifest.semanticChunkIndexes?.[0];

    if (semanticChunkIndex === undefined || semanticChunkIndex.chunks[0] === undefined) {
      throw new Error('expected generated semantic chunk index');
    }

    semanticChunkIndex.chunks[0].title = 'Stale Title';
    semanticChunkIndex.aggregateHash = semanticChunkIndexAggregateHashForTest(semanticChunkIndex);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Checked files: ${manifest.sourceFiles.length + manifest.generatedOutputs.length}`
    );
    expect(result.stderr).toContain(
      'semantic chunk index chunks/semantic-chunks.jsonl: manifest metadata does not match JSONL records'
    );
    expect(result.stderr).not.toContain('hash mismatch');
  });

  it('rejects malformed semantic chunk JSONL when manifest output metadata is current', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-source-chunk-index-malformed-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'malformed-index-docs.md');
    const outputDir = join(dir, 'output');
    const manifestPath = join(outputDir, 'manifest.json');

    await writeFile(sourcePath, '# Malformed Index Docs\n\nStable chunk text.\n', 'utf-8');
    await runCli([
      'generate',
      '--source',
      sourcePath,
      '--format',
      'markdown',
      '--chunks',
      'jsonl',
      '--output-dir',
      outputDir,
    ]);

    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as SourceDocsManifest;
    const chunkOutput = manifest.generatedOutputs.find(
      (output) => output.kind === 'semantic-chunks-jsonl'
    );

    if (chunkOutput === undefined) {
      throw new Error('expected semantic chunk output metadata');
    }

    const chunkPath = join(outputDir, chunkOutput.path);
    await writeFile(chunkPath, 'not-json\n', 'utf-8');
    await refreshGeneratedTextOutputMetadata(chunkPath, chunkOutput);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Checked files: ${manifest.sourceFiles.length + manifest.generatedOutputs.length}`
    );
    expect(result.stderr).toContain('semantic chunk index chunks/semantic-chunks.jsonl');
    expect(result.stderr).toContain('malformed JSON');
    expect(result.stderr).not.toContain('hash mismatch');
  });

  it('rejects mixed-format directory source auto-detection before output work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-source-mixed-'));
    tempDirs.push(dir);
    const sourceDir = join(dir, 'docs-source');
    const outputDir = join(dir, 'output');

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.md'), '# Markdown Docs\n', 'utf-8');
    await writeFile(
      join(sourceDir, 'page.html'),
      '<!doctype html><html><body><h1>HTML Docs</h1></body></html>\n',
      'utf-8'
    );

    const result = await runCliWithExit([
      'generate',
      '--source',
      sourceDir,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Directory auto-detection for generate --source is ambiguous');
    expect(result.stderr).toContain('Specify --format markdown, rst, or html');
    expect(result.stdout).not.toContain('Local source docs generated');
    expect(await pathExists(outputDir)).toBe(false);
  });

  it('uses an explicit markdown format hint for a local file that auto-detection cannot classify', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-source-hint-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'Guide Notes.txt');
    const outputDir = join(dir, 'output');

    await writeFile(
      sourcePath,
      [
        '# Guide Notes',
        '',
        'Plain markdown in a text file.',
        '',
        '## Steps',
        '',
        'Run it.',
        '',
      ].join('\n'),
      'utf-8'
    );

    const { stdout } = await runCli([
      'generate',
      '--source',
      sourcePath,
      '--format',
      'markdown',
      '--output-dir',
      outputDir,
    ]);

    const manifest = JSON.parse(
      await readFile(join(outputDir, 'manifest.json'), 'utf-8')
    ) as SourceDocsManifest;
    const sourceText = await readFile(sourcePath, 'utf-8');

    expect(stdout).toContain('Local source docs generated');
    expect(manifest.source).toMatchObject({
      input: sourcePath,
      resolvedPath: sourcePath,
      type: 'file',
      formatHint: 'markdown',
      resolvedFormat: 'markdown',
      byteSize: await byteSize(sourcePath),
      hash: await sha256File(sourcePath),
    });
    expect(manifest.sourceFiles).toHaveLength(1);
    expect(manifest.sourceFiles[0]).toMatchObject({
      path: 'Guide Notes.txt',
      resolvedPath: sourcePath,
      byteSize: await byteSize(sourcePath),
      hash: await sha256File(sourcePath),
      lineCount: countTextLines(sourceText),
      estimatedTokenCount: estimateTextTokens(sourceText),
    });
    expect(manifest.generatedOutputs.map((output) => output.path)).toEqual([
      'llm-docs/guide-notes-full-llms.txt',
    ]);
  });

  it('auto-detects static HTML source generation without fetching linked resources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-source-html-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'page.html');
    const outputDir = join(dir, 'output');

    await writeFile(
      sourcePath,
      [
        '<!doctype html>',
        '<html><head><title>HTML Docs</title><script src="https://example.com/app.js"></script></head>',
        '<body><h1>HTML Docs</h1><h2>Overview</h2><p>Static content only.</p></body></html>',
        '',
      ].join('\n'),
      'utf-8'
    );

    const { stdout } = await runCli([
      'generate',
      '--source',
      sourcePath,
      '--output-dir',
      outputDir,
    ]);
    const manifest = JSON.parse(
      await readFile(join(outputDir, 'manifest.json'), 'utf-8')
    ) as SourceDocsManifest;
    const fullDoc = await readFile(join(outputDir, 'llm-docs/page-full-llms.txt'), 'utf-8');

    expect(stdout).toContain('Format: html');
    expect(manifest.source.formatHint).toBe('auto');
    expect(manifest.source.resolvedFormat).toBe('html');
    expect(manifest.parser.name).toBe('Static HTML Parser');
    expect(fullDoc).toContain('Static content only.');
    expect(fullDoc).not.toContain('https://example.com/app.js');
  });

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
      'Supported generation modes: generate --source <local-file-or-directory>'
    );
    expect(result.stderr).toContain(
      'Preset generation is limited to --preset swift-book with an explicit --source path'
    );
    expect(result.stdout).not.toContain('Processing');
    expect(await pathExists(outputDir)).toBe(false);
    expect(await findManifestFiles(configDir)).toEqual([]);
  });

  it('rejects generate --chunks with configured SDK generation before config or output work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-sdk-chunks-'));
    tempDirs.push(dir);
    const configDir = join(dir, 'missing-config');
    const outputDir = join(dir, 'output');

    const result = await runCliWithExit([
      'generate',
      '--sdk',
      'swift',
      '--chunks',
      'jsonl',
      '--config-dir',
      configDir,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Generate failed: generate --chunks is supported only for generate --source.'
    );
    expect(result.stderr).toContain('[--chunks jsonl]');
    expect(result.stderr).not.toContain('Fatal error');
    expect(result.stderr).not.toContain(configDir);
    expect(result.stdout).not.toContain('Processing');
    expect(await pathExists(outputDir)).toBe(false);
    expect(await pathExists(configDir)).toBe(false);
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
      'Generate failed: generate requires exactly one of --source or --sdk.'
    );
    expect(result.stderr).toContain(
      'Supported generation modes: generate --source <local-file-or-directory>'
    );
    expect(result.stderr).toContain('generate --sdk <sdk>');
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
      'Generate failed: generate requires exactly one of --source or --sdk.'
    );
    expect(result.stderr).toContain(
      'Supported generation modes: generate --source <local-file-or-directory>'
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
      'Generate failed: generate requires exactly one of --source or --sdk.'
    );
    expect(result.stderr).toContain(
      'Supported generation modes: generate --source <local-file-or-directory>'
    );
    expect(result.stderr).not.toContain('Fatal error');
    expect(result.stderr).not.toContain(configDir);
    expect(result.stdout).not.toContain('Processing');
    expect(await pathExists(outputDir)).toBe(false);
    expect(await pathExists(configDir)).toBe(false);
  });

  it('rejects generate --preset without an explicit source before output work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-preset-no-source-'));
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
      'Generate failed: generate --preset swift-book requires --source <explicit-local-docs-path>; presets do not select source paths.'
    );
    expect(result.stderr).toContain(
      'Preset generation is limited to --preset swift-book with an explicit --source path'
    );
    expect(result.stderr).toContain('generate --source <local-file-or-directory>');
    expect(result.stderr).toContain('generate --sdk <sdk>');
    expect(result.stdout).not.toContain('Processing');
    expect(await pathExists(outputDir)).toBe(false);
  });

  it('removes stale source-doc artifacts after preset validation fails without source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-preset-no-source-stale-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'docs.md');
    const outputDir = join(dir, 'output');
    const keepPath = join(outputDir, 'keep.txt');

    await writeFile(sourcePath, '# Docs\n\n## Intro\n\nHello.\n', 'utf-8');
    await runCli([
      'generate',
      '--source',
      sourcePath,
      '--format',
      'markdown',
      '--chunks',
      'jsonl',
      '--output-dir',
      outputDir,
    ]);
    await writeFile(keepPath, 'keep me\n', 'utf-8');

    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(true);
    expect(await pathExists(join(outputDir, 'llm-docs'))).toBe(true);
    expect(await pathExists(join(outputDir, 'chunks'))).toBe(true);

    const result = await runCliWithExit([
      'generate',
      '--preset',
      'swift-book',
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Generate failed: generate --preset swift-book requires --source <explicit-local-docs-path>; presets do not select source paths.'
    );
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(false);
    expect(await pathExists(join(outputDir, 'llm-docs'))).toBe(false);
    expect(await pathExists(join(outputDir, 'chunks'))).toBe(false);
    expect(await readFile(keepPath, 'utf-8')).toBe('keep me\n');
  });

  it('rejects generate --preset with configured SDK generation before config or output work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-preset-sdk-'));
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
      'Generate failed: generate --preset is supported only with explicit --source and cannot be used with --sdk.'
    );
    expect(result.stderr).not.toContain('Fatal error');
    expect(result.stderr).not.toContain(configDir);
    expect(result.stdout).not.toContain('Processing');
    expect(await pathExists(outputDir)).toBe(false);
    expect(await pathExists(configDir)).toBe(false);
  });

  it('rejects unknown generate --preset names before output work', async () => {
    const { sourceDir, outputDir } = await createSwiftBookSourceFixture(
      'llm-docs-generate-preset-unknown-'
    );

    const result = await runCliWithExit([
      'generate',
      '--source',
      sourceDir,
      '--preset',
      'unknown-preset',
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Generate failed: Unknown preset 'unknown-preset'. Supported source-generation presets: swift-book."
    );
    expect(result.stdout).not.toContain('Local source docs generated');
    expect(await pathExists(outputDir)).toBe(false);
  });

  it('rejects incompatible explicit formats for the swift-book preset before output work', async () => {
    const { sourceDir, outputDir } = await createSwiftBookSourceFixture(
      'llm-docs-generate-preset-format-'
    );

    const result = await runCliWithExit([
      'generate',
      '--source',
      sourceDir,
      '--preset',
      'swift-book',
      '--format',
      'html',
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Generate failed: --format html is not compatible with --preset swift-book; supported preset formats are markdown.'
    );
    expect(result.stdout).not.toContain('Local source docs generated');
    expect(await pathExists(outputDir)).toBe(false);
  });

  it('rejects invalid swift-book preset config schemas before output work', async () => {
    const { sourceDir, outputDir } = await createSwiftBookSourceFixture(
      'llm-docs-generate-preset-invalid-config-'
    );
    const configDir = await createPresetConfigDir({
      id: 'swift-book',
      name: 'Swift Programming Language',
      format: 'markdown',
      output: {
        filenamePrefix: 'swift-book',
      },
      systemPrompt: 'Generated docs from an explicit local source.',
    });

    const result = await runCliWithExit([
      'generate',
      '--source',
      sourceDir,
      '--preset',
      'swift-book',
      '--config-dir',
      configDir,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Generate failed:');
    expect(result.stderr).toContain('output');
    expect(result.stderr).toContain('title');
    expect(result.stdout).not.toContain('Local source docs generated');
    expect(await pathExists(outputDir)).toBe(false);
  });

  it('rejects swift-book preset configs with nested source-selection fields', async () => {
    const { sourceDir, outputDir } = await createSwiftBookSourceFixture(
      'llm-docs-generate-preset-nested-source-'
    );
    const configDir = await createPresetConfigDir({
      id: 'swift-book',
      name: 'Swift Programming Language',
      format: 'markdown',
      output: {
        filenamePrefix: 'swift-book',
        title: 'Swift Programming Language',
        formats: ['txt'],
      },
      systemPrompt: 'Generated docs from an explicit local source.',
      manifest: {
        sourceSelection: 'explicit-local-source-required',
        sourceVerification: 'not-performed',
        sourceTruthClaim: 'not-claimed',
        source: 'TSPL.docc',
      },
    });

    const result = await runCliWithExit([
      'generate',
      '--source',
      sourceDir,
      '--preset',
      'swift-book',
      '--config-dir',
      configDir,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Generate failed: Preset 'swift-book' must not define source paths or source-selection fields; pass --source explicitly"
    );
    expect(result.stdout).not.toContain('Local source docs generated');
    expect(await pathExists(outputDir)).toBe(false);
  });

  it('rejects custom swift-book preset metadata and prompt claims before generation writes', async () => {
    const { sourceDir, outputDir } = await createSwiftBookSourceFixture(
      'llm-docs-generate-preset-bad-metadata-'
    );
    const keepPath = join(outputDir, 'keep.txt');
    const configDir = await createPresetConfigDir({
      id: 'swift-book',
      name: 'Swift Programming Language',
      format: 'markdown',
      output: {
        filenamePrefix: 'swift-book',
        title: 'Swift Programming Language',
        formats: ['txt'],
      },
      systemPrompt:
        'Complete Swift Programming Language documentation verified against source truth, authoritative and official.',
      manifest: {
        sourceSelection: 'automatic-authoritative-selection',
        sourceVerification: 'performed',
        sourceTruthClaim: 'verified',
      },
    });

    await runCli([
      'generate',
      '--source',
      sourceDir,
      '--preset',
      'swift-book',
      '--chunks',
      'jsonl',
      '--output-dir',
      outputDir,
    ]);
    await writeFile(keepPath, 'keep me\n', 'utf-8');

    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(true);
    expect(await pathExists(join(outputDir, 'llm-docs'))).toBe(true);
    expect(await pathExists(join(outputDir, 'chunks'))).toBe(true);

    const result = await runCliWithExit([
      'generate',
      '--source',
      sourceDir,
      '--preset',
      'swift-book',
      '--chunks',
      'jsonl',
      '--config-dir',
      configDir,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Generate failed: Preset 'swift-book' violates the non-authoritative source contract:"
    );
    expect(result.stderr).toContain(
      'preset.metadata.sourceSelection must be explicit-local-source-required'
    );
    expect(result.stderr).toContain('preset.metadata.sourceVerification must be not-performed');
    expect(result.stderr).toContain('preset.metadata.sourceTruthClaim must be not-claimed');
    expect(result.stderr).toContain('preset.defaults.systemPrompt must not claim completeness');
    expect(result.stderr).toContain('source truth');
    expect(result.stderr).toContain('source verification');
    expect(result.stderr).toContain('authority or official status');
    expect(result.stdout).not.toContain('Local source docs generated');
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(false);
    expect(await pathExists(join(outputDir, 'llm-docs'))).toBe(false);
    expect(await pathExists(join(outputDir, 'chunks'))).toBe(false);
    expect(await readFile(keepPath, 'utf-8')).toBe('keep me\n');
  });

  it('rejects generate --source plus --sdk before config or output work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-source-sdk-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'docs.md');
    const configDir = join(dir, 'missing-config');
    const outputDir = join(dir, 'output');
    await writeFile(sourcePath, '# Docs\n', 'utf-8');

    const result = await runCliWithExit([
      'generate',
      '--source',
      sourcePath,
      '--sdk',
      'swift',
      '--config-dir',
      configDir,
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Generate failed: generate --source and --sdk are mutually exclusive.'
    );
    expect(result.stderr).not.toContain(configDir);
    expect(result.stdout).not.toContain('Processing');
    expect(await pathExists(outputDir)).toBe(false);
    expect(await pathExists(configDir)).toBe(false);
  });

  it('rejects unsupported source-mode formats before output work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-source-format-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'docs.md');
    const outputDir = join(dir, 'output');
    await writeFile(sourcePath, '# Docs\n', 'utf-8');

    const result = await runCliWithExit([
      'generate',
      '--source',
      sourcePath,
      '--format',
      'asciidoc',
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Generate failed: --format asciidoc is not supported for generate --source'
    );
    expect(result.stderr).toContain(
      'supported source formats are auto, markdown, mdx, openapi, openref, rst, html'
    );
    expect(result.stdout).not.toContain('Local source docs generated');
    expect(await pathExists(outputDir)).toBe(false);
  });

  it('rejects unsupported source-mode chunk export values before output work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-source-chunks-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'docs.md');
    const outputDir = join(dir, 'output');
    await writeFile(sourcePath, '# Docs\n', 'utf-8');

    const result = await runCliWithExit([
      'generate',
      '--source',
      sourcePath,
      '--chunks',
      'xml',
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Generate failed: --chunks xml is not supported for generate --source'
    );
    expect(result.stderr).toContain('supported chunk export formats are jsonl');
    expect(result.stdout).not.toContain('Local source docs generated');
    expect(await pathExists(outputDir)).toBe(false);
  });

  it('rejects URL-like generate --source inputs without fetching network resources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-source-url-'));
    tempDirs.push(dir);
    const outputDir = join(dir, 'output');

    const result = await runCliWithExit([
      'generate',
      '--source',
      'https://example.com/docs',
      '--format',
      'html',
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Generate failed: generate --source accepts explicit local file or directory paths only'
    );
    expect(result.stdout).not.toContain('Local source docs generated');
    expect(await pathExists(outputDir)).toBe(false);
  });

  it('rejects missing generate --source paths without writing a manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-source-missing-'));
    tempDirs.push(dir);
    const missingPath = join(dir, 'missing.md');
    const outputDir = join(dir, 'output');

    const result = await runCliWithExit([
      'generate',
      '--source',
      missingPath,
      '--format',
      'markdown',
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `Generate failed: generate --source path not found: ${missingPath}`
    );
    expect(result.stdout).not.toContain('Local source docs generated');
    expect(await pathExists(outputDir)).toBe(false);
  });

  it('removes stale source docs and chunk artifacts after early source-mode validation failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-source-early-stale-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'docs.md');
    const missingPath = join(dir, 'missing.md');
    const missingOutputDir = join(dir, 'missing-output');
    const unsupportedFormatOutputDir = join(dir, 'unsupported-format-output');

    await writeFile(sourcePath, '# Docs\n\n## Intro\n\nHello.\n', 'utf-8');

    await runCli([
      'generate',
      '--source',
      sourcePath,
      '--format',
      'markdown',
      '--chunks',
      'jsonl',
      '--output-dir',
      missingOutputDir,
    ]);
    await runCli([
      'generate',
      '--source',
      sourcePath,
      '--format',
      'markdown',
      '--chunks',
      'jsonl',
      '--output-dir',
      unsupportedFormatOutputDir,
    ]);

    expect(await pathExists(join(missingOutputDir, 'manifest.json'))).toBe(true);
    expect(await pathExists(join(missingOutputDir, 'llm-docs'))).toBe(true);
    expect(await pathExists(join(missingOutputDir, 'chunks'))).toBe(true);
    expect(await pathExists(join(unsupportedFormatOutputDir, 'manifest.json'))).toBe(true);
    expect(await pathExists(join(unsupportedFormatOutputDir, 'llm-docs'))).toBe(true);
    expect(await pathExists(join(unsupportedFormatOutputDir, 'chunks'))).toBe(true);

    const missingResult = await runCliWithExit([
      'generate',
      '--source',
      missingPath,
      '--format',
      'markdown',
      '--output-dir',
      missingOutputDir,
    ]);
    const unsupportedFormatResult = await runCliWithExit([
      'generate',
      '--source',
      sourcePath,
      '--format',
      'asciidoc',
      '--output-dir',
      unsupportedFormatOutputDir,
    ]);

    expect(missingResult.exitCode).toBe(1);
    expect(missingResult.stderr).toContain(
      `Generate failed: generate --source path not found: ${missingPath}`
    );
    expect(unsupportedFormatResult.exitCode).toBe(1);
    expect(unsupportedFormatResult.stderr).toContain(
      'Generate failed: --format asciidoc is not supported for generate --source'
    );
    expect(await pathExists(join(missingOutputDir, 'manifest.json'))).toBe(false);
    expect(await pathExists(join(missingOutputDir, 'llm-docs'))).toBe(false);
    expect(await pathExists(join(missingOutputDir, 'chunks'))).toBe(false);
    expect(await pathExists(join(unsupportedFormatOutputDir, 'manifest.json'))).toBe(false);
    expect(await pathExists(join(unsupportedFormatOutputDir, 'llm-docs'))).toBe(false);
    expect(await pathExists(join(unsupportedFormatOutputDir, 'chunks'))).toBe(false);
  });

  it('preserves parser plugin files under output artifacts after CLI validation failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-parser-plugin-cli-cleanup-'));
    tempDirs.push(dir);

    const cases: Array<{
      name: string;
      args: (fixture: Awaited<ReturnType<typeof createParserPluginFixture>>) => string[];
      expected: string;
    }> = [
      {
        name: 'missing format',
        args: ({ manifestPath }) => [
          'generate',
          '--source',
          join(dir, 'missing-format-source.fixture'),
          '--parser-plugin-manifest',
          manifestPath,
        ],
        expected: 'generate --parser-plugin-manifest requires explicit --format <plugin-format-id>',
      },
      {
        name: 'chunks option',
        args: ({ manifestPath, formatId }) => [
          'generate',
          '--source',
          join(dir, 'chunks-source.fixture'),
          '--parser-plugin-manifest',
          manifestPath,
          '--format',
          formatId,
          '--chunks',
          'jsonl',
        ],
        expected: 'generate --parser-plugin-manifest cannot be combined with --chunks',
      },
    ];

    for (const testCase of cases) {
      const caseDir = join(dir, testCase.name.replaceAll(' ', '-'));
      const outputDir = join(caseDir, 'output');
      const builtInSourcePath = join(caseDir, 'docs.md');
      const pluginSourcePath = join(dir, `${testCase.name.replaceAll(' ', '-')}-source.fixture`);

      await mkdir(caseDir, { recursive: true });
      await writeFile(builtInSourcePath, '# Stale Docs\n\nGenerated before failure.\n', 'utf-8');
      await writeFile(pluginSourcePath, 'Custom source payload\n', 'utf-8');
      await runCli([
        'generate',
        '--source',
        builtInSourcePath,
        '--format',
        'markdown',
        '--output-dir',
        outputDir,
      ]);

      const staleManifestPath = join(outputDir, 'manifest.json');
      const staleManifestText = await readFile(staleManifestPath, 'utf-8');
      const fixture = await createParserPluginFixture({
        dir: join(outputDir, 'llm-docs'),
      });
      const pluginManifestText = await readFile(fixture.manifestPath, 'utf-8');
      const pluginModuleText = await readFile(fixture.modulePath, 'utf-8');

      const result = await runCliWithExit([...testCase.args(fixture), '--output-dir', outputDir]);

      expect(result.exitCode, testCase.name).toBe(1);
      expect(result.stderr, testCase.name).toContain(testCase.expected);
      expect(await readFile(staleManifestPath, 'utf-8')).toBe(staleManifestText);
      expect(await readFile(fixture.manifestPath, 'utf-8')).toBe(pluginManifestText);
      expect(await readFile(fixture.modulePath, 'utf-8')).toBe(pluginModuleText);
      await expect(readFile(fixture.sideEffectPath, 'utf-8')).rejects.toThrow();
    }
  });

  it('does not remove non-source manifests after source-mode validation failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-source-non-source-manifest-'));
    tempDirs.push(dir);
    const outputDir = join(dir, 'output');
    const manifestPath = join(outputDir, 'manifest.json');
    const preservedDocPath = join(outputDir, 'llm-docs', 'keep.txt');
    const missingPath = join(dir, 'missing.md');
    const manifestText = `${JSON.stringify(
      {
        schemaVersion: '0.1.0',
        mode: 'configured-sdk',
      },
      null,
      2
    )}\n`;

    await mkdir(dirname(preservedDocPath), { recursive: true });
    await writeFile(manifestPath, manifestText, 'utf-8');
    await writeFile(preservedDocPath, 'keep me\n', 'utf-8');

    const result = await runCliWithExit([
      'generate',
      '--source',
      missingPath,
      '--format',
      'markdown',
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `Generate failed: generate --source path not found: ${missingPath}`
    );
    expect(await readFile(manifestPath, 'utf-8')).toBe(manifestText);
    expect(await readFile(preservedDocPath, 'utf-8')).toBe('keep me\n');
  });

  it('rejects source files inside source-mode output artifacts without deleting them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-source-protected-'));
    tempDirs.push(dir);
    const outputDir = join(dir, 'output');
    const manifestSourcePath = join(outputDir, 'manifest.json');
    const generatedSourcePath = join(outputDir, 'llm-docs', 'input.md');
    const manifestSourceText = '# Manifest Source\n\nDo not delete.\n';
    const generatedSourceText = '# Generated Source\n\nDo not delete.\n';

    await mkdir(dirname(generatedSourcePath), { recursive: true });
    await writeFile(manifestSourcePath, manifestSourceText, 'utf-8');
    await writeFile(generatedSourcePath, generatedSourceText, 'utf-8');

    const manifestResult = await runCliWithExit([
      'generate',
      '--source',
      manifestSourcePath,
      '--format',
      'markdown',
      '--output-dir',
      outputDir,
    ]);
    const generatedResult = await runCliWithExit([
      'generate',
      '--source',
      generatedSourcePath,
      '--format',
      'markdown',
      '--output-dir',
      outputDir,
    ]);

    expect(manifestResult.exitCode).toBe(1);
    expect(manifestResult.stderr).toContain('file input must not be the source-mode manifest path');
    expect(generatedResult.exitCode).toBe(1);
    expect(generatedResult.stderr).toContain(
      'file input must not be inside the source-mode generated docs directory'
    );
    expect(await readFile(manifestSourcePath, 'utf-8')).toBe(manifestSourceText);
    expect(await readFile(generatedSourcePath, 'utf-8')).toBe(generatedSourceText);
  });

  it('rejects whitespace-wrapped source files inside source-mode output artifacts without deleting them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-source-protected-spaces-'));
    tempDirs.push(dir);
    const outputDir = join(dir, 'output');
    const manifestSourcePath = join(outputDir, 'manifest.json');
    const generatedSourcePath = join(outputDir, 'llm-docs', 'input.md');
    const manifestSourceText = `${JSON.stringify(
      {
        schemaVersion: '0.1.0',
        mode: 'local-source-docs',
      },
      null,
      2
    )}\n`;
    const generatedSourceText = '# Generated Source\n\nDo not delete.\n';

    await mkdir(dirname(generatedSourcePath), { recursive: true });
    await writeFile(manifestSourcePath, manifestSourceText, 'utf-8');
    await writeFile(generatedSourcePath, generatedSourceText, 'utf-8');

    const manifestResult = await runCliWithExit([
      'generate',
      '--source',
      ` ${manifestSourcePath} `,
      '--format',
      'markdown',
      '--output-dir',
      outputDir,
    ]);
    const generatedResult = await runCliWithExit([
      'generate',
      '--source',
      ` ${generatedSourcePath} `,
      '--format',
      'markdown',
      '--output-dir',
      outputDir,
    ]);

    expect(manifestResult.exitCode).toBe(1);
    expect(manifestResult.stderr).toContain('file input must not be the source-mode manifest path');
    expect(generatedResult.exitCode).toBe(1);
    expect(generatedResult.stderr).toContain(
      'file input must not be inside the source-mode generated docs directory'
    );
    expect(await readFile(manifestSourcePath, 'utf-8')).toBe(manifestSourceText);
    expect(await readFile(generatedSourcePath, 'utf-8')).toBe(generatedSourceText);
  });

  it('rejects source output directories inside source before output work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-source-inside-'));
    tempDirs.push(dir);
    const sourceDir = join(dir, 'docs');
    const outputDir = join(sourceDir, 'agent-docs');

    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.md'), '# Docs\n', 'utf-8');

    const result = await runCliWithExit([
      'generate',
      '--source',
      sourceDir,
      '--format',
      'markdown',
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'generate --source --output-dir must not be the same as, or inside, the explicit --source directory'
    );
    expect(result.stdout).not.toContain('Local source docs generated');
    expect(await pathExists(outputDir)).toBe(false);
  });

  it('rejects discovery reports as generate --source inputs without choosing candidates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-source-report-'));
    tempDirs.push(dir);
    const reportPath = join(dir, 'candidate-evidence.json');
    const outputDir = join(dir, 'output');

    await writeFile(
      reportPath,
      JSON.stringify(
        {
          schemaVersion: '0.1.0',
          candidates: [
            {
              path: 'docs.md',
              evidence: {
                category: 'structured-doc-source',
                signals: ['extension:md'],
              },
            },
          ],
        },
        null,
        2
      ),
      'utf-8'
    );

    const result = await runCliWithExit([
      'generate',
      '--source',
      reportPath,
      '--format',
      'markdown',
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('discovery reports are candidate evidence for agent review');
    expect(result.stderr).toContain('not consumed automatically');
    expect(result.stdout).not.toContain('Processing');
    expect(result.stdout).not.toContain('Local source docs generated');
    expect(await pathExists(outputDir)).toBe(false);
  });

  it('removes stale source docs artifacts after a source generation parse failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-generate-source-stale-'));
    tempDirs.push(dir);
    const goodSourcePath = join(dir, 'docs.md');
    const badSourcePath = join(dir, 'bad-openapi.json');
    const outputDir = join(dir, 'output');

    await writeFile(goodSourcePath, '# Docs\n\n## Intro\n\nHello.\n', 'utf-8');
    await writeFile(
      badSourcePath,
      JSON.stringify({ openapi: '3.1.0', info: { title: 'Bad API' }, paths: [] }, null, 2),
      'utf-8'
    );

    await runCli([
      'generate',
      '--source',
      goodSourcePath,
      '--format',
      'markdown',
      '--output-dir',
      outputDir,
    ]);
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(true);
    expect(await pathExists(join(outputDir, 'llm-docs'))).toBe(true);

    const result = await runCliWithExit([
      'generate',
      '--source',
      badSourcePath,
      '--format',
      'openapi',
      '--output-dir',
      outputDir,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('OpenAPI / Swagger document must contain a paths object');
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(false);
    expect(await pathExists(join(outputDir, 'llm-docs'))).toBe(false);
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

  it('refreshes a local source docs manifest after output tamper and source edit', async () => {
    const {
      manifestPath,
      sourceDir,
      outputDir,
      manifest: firstManifest,
    } = await generateSourceDocsFixture();
    const sourceFile = firstManifest.sourceFiles.find((file) => file.path === 'index.md');
    const outputFile = firstManifest.generatedOutputs.find((output) => output.kind === 'llm-docs');

    if (sourceFile === undefined || outputFile === undefined) {
      throw new Error('expected generated source docs fixture files');
    }

    await writeFile(
      join(sourceDir, sourceFile.path),
      '# Local Docs\n\nWelcome to the refreshed local docs.\n',
      'utf-8'
    );
    await writeFile(join(outputDir, outputFile.path), 'tampered output\n', 'utf-8');

    const refreshResult = await runCli(['refresh', '--manifest', manifestPath]);
    const refreshedManifest = JSON.parse(
      await readFile(manifestPath, 'utf-8')
    ) as SourceDocsManifest;
    const refreshedSourceFile = refreshedManifest.sourceFiles.find(
      (file) => file.path === sourceFile.path
    );
    const refreshedOutput = refreshedManifest.generatedOutputs.find(
      (output) => output.kind === 'llm-docs'
    );
    const expectedRefreshCheckedFiles =
      refreshedManifest.sourceFiles.length + refreshedManifest.generatedOutputs.length;

    if (refreshedSourceFile === undefined || refreshedOutput === undefined) {
      throw new Error('expected refreshed source docs output');
    }

    const refreshedSourcePath = join(sourceDir, refreshedSourceFile.path);
    const refreshedSourceText = await readFile(refreshedSourcePath, 'utf-8');
    const refreshedText = await readFile(join(outputDir, refreshedOutput.path), 'utf-8');
    const verifyResult = await runCli(['verify', '--manifest', manifestPath]);

    expect(refreshResult.stdout).toContain('Manifest refresh');
    expect(refreshResult.stdout).toContain('Mode: local-source-docs');
    expect(refreshResult.stdout).toContain('Post-refresh verification: passed');
    expect(refreshResult.stdout).toContain(`Checked files: ${expectedRefreshCheckedFiles}`);
    expect(refreshResult.stdout).toContain('Refresh complete');
    expect(refreshedManifest.source.input).toBe(firstManifest.source.resolvedPath);
    expect(refreshedManifest.source.resolvedPath).toBe(firstManifest.source.resolvedPath);
    expect(refreshedManifest.source.formatHint).toBe(firstManifest.source.formatHint);
    expect(refreshedSourceFile.hash).toBe(await sha256File(refreshedSourcePath));
    expect(refreshedSourceFile.byteSize).toBe(await byteSize(refreshedSourcePath));
    expect(refreshedSourceFile.lineCount).toBe(countTextLines(refreshedSourceText));
    expect(refreshedSourceFile.estimatedTokenCount).toBe(estimateTextTokens(refreshedSourceText));
    expect(refreshedText).toContain('refreshed local docs');
    expect(refreshedText).not.toContain('tampered output');
    expect(verifyResult.stdout).toContain('Failures: 0');
    expect(verifyResult.stdout).toContain('Verification passed');
  });

  it('refresh preserves semantic chunk JSONL for local source docs', async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-refresh-chunks-'));
    tempDirs.push(dir);
    const sourcePath = join(dir, 'chunk-docs.md');
    const outputDir = join(dir, 'output');
    const manifestPath = join(outputDir, 'manifest.json');

    await writeFile(
      sourcePath,
      ['# Chunk Docs', '', 'Original text.', '', '## First', '', 'One.', ''].join('\n'),
      'utf-8'
    );
    await runCli([
      'generate',
      '--source',
      sourcePath,
      '--format',
      'markdown',
      '--chunks',
      'jsonl',
      '--output-dir',
      outputDir,
    ]);
    const firstManifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as SourceDocsManifest;
    const firstSemanticChunkIndex = firstManifest.semanticChunkIndexes?.[0];

    if (firstSemanticChunkIndex === undefined) {
      throw new Error('expected initial semantic chunk index');
    }

    await writeFile(
      sourcePath,
      ['# Chunk Docs', '', 'Updated text.', '', '## Added', '', 'Two.', ''].join('\n'),
      'utf-8'
    );
    await writeFile(join(outputDir, 'chunks', 'semantic-chunks.jsonl'), 'tampered\n', 'utf-8');

    const refreshResult = await runCli(['refresh', '--output-dir', outputDir]);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as SourceDocsManifest;
    const chunkOutput = manifest.generatedOutputs.find(
      (output) => output.kind === 'semantic-chunks-jsonl'
    );

    if (chunkOutput === undefined) {
      throw new Error('expected refreshed semantic chunk output');
    }

    const chunkJsonl = await readFile(join(outputDir, chunkOutput.path), 'utf-8');
    const verifyResult = await runCli(['verify', '--output-dir', outputDir]);

    expect(refreshResult.stdout).toContain('Chunk export: chunks/semantic-chunks.jsonl');
    expect(manifest.generatedOutputs.map((output) => output.path)).toEqual([
      'chunks/semantic-chunks.jsonl',
      'llm-docs/chunk-docs-full-llms.txt',
    ]);
    expect(manifest.semanticChunkIndexes).toHaveLength(1);
    expect(manifest.semanticChunkIndexes?.[0]).toMatchObject({
      path: 'chunks/semantic-chunks.jsonl',
      format: 'jsonl',
      chunkCount: 2,
      warningCount: 0,
      aggregateHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(manifest.semanticChunkIndexes?.[0]?.aggregateHash).not.toBe(
      firstSemanticChunkIndex.aggregateHash
    );
    expect(manifest.semanticChunkIndexes?.[0]?.chunks.map((chunk) => chunk.title)).toEqual([
      'Chunk Docs',
      'Added',
    ]);
    expect(chunkJsonl).toContain('Updated text');
    expect(chunkJsonl).toContain('Added');
    expect(chunkJsonl).not.toContain('tampered');
    expect(verifyResult.stdout).toContain('Failures: 0');
    expect(verifyResult.stdout).toContain('Verification passed');
  });

  it('refresh preserves swift-book preset output and chunk behavior from the manifest', async () => {
    const { sourceDir, outputDir } = await createSwiftBookSourceFixture(
      'llm-docs-refresh-swift-book-'
    );
    const manifestPath = join(outputDir, 'manifest.json');

    await runCli([
      'generate',
      '--source',
      sourceDir,
      '--preset',
      'swift-book',
      '--chunks',
      'jsonl',
      '--output-dir',
      outputDir,
    ]);

    const firstManifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as SourceDocsManifest;

    if (firstManifest.preset === undefined) {
      throw new Error('expected swift-book preset metadata');
    }

    await writeFile(
      join(sourceDir, 'LanguageGuide', 'BasicOperators.md'),
      [
        '# Basic Operators',
        '',
        'Operators can be refreshed from the manifest.',
        '',
        '## Assignment Operator',
        '',
        'Assignment is still present.',
        '',
      ].join('\n'),
      'utf-8'
    );
    await writeFile(
      join(outputDir, 'llm-docs', 'swift-book-full-llms.txt'),
      'tampered swift output\n',
      'utf-8'
    );
    await writeFile(join(outputDir, 'chunks', 'semantic-chunks.jsonl'), 'tampered\n', 'utf-8');

    const refreshResult = await runCli(['refresh', '--manifest', manifestPath]);
    const refreshedManifest = JSON.parse(
      await readFile(manifestPath, 'utf-8')
    ) as SourceDocsManifest;
    const swiftOutput = await readFile(
      join(outputDir, 'llm-docs', 'swift-book-full-llms.txt'),
      'utf-8'
    );
    const chunkJsonl = await readFile(join(outputDir, 'chunks', 'semantic-chunks.jsonl'), 'utf-8');
    const verifyResult = await runCli(['verify', '--output-dir', outputDir]);

    expect(refreshResult.stdout).toContain('Preset: swift-book');
    expect(refreshResult.stdout).toContain('Chunk export: chunks/semantic-chunks.jsonl');
    expect(refreshedManifest.generatedOutputs.map((output) => output.path)).toEqual([
      'chunks/semantic-chunks.jsonl',
      'llm-docs/swift-book-full-llms.txt',
    ]);
    expect(refreshedManifest.preset?.configPath).toBe(firstManifest.preset.configPath);
    expect(refreshedManifest.preset?.defaults.filenamePrefix).toBe('swift-book');
    expect(swiftOutput).toContain('# Swift Programming Language');
    expect(swiftOutput).toContain('Operators can be refreshed from the manifest.');
    expect(swiftOutput).not.toContain('tampered swift output');
    expect(chunkJsonl).toContain('Operators can be refreshed from the manifest.');
    expect(chunkJsonl).not.toContain('tampered');
    expect(verifyResult.stdout).toContain('Failures: 0');
    expect(verifyResult.stdout).toContain('Verification passed');
  });

  it('refreshes source-truth docs from the manifest recorded local source path', async () => {
    const { manifestPath, outputDir, sourceDir } = await generateSourceTruthDocsFixture(
      'llm-docs-refresh-source-truth-'
    );

    await writeFile(
      join(sourceDir, 'index.ts'),
      ['export const value = 2;', 'export function run() {', '  return value;', '}', ''].join('\n'),
      'utf-8'
    );
    await writeFile(join(outputDir, 'source-truth.md'), '# Tampered\n', 'utf-8');

    const refreshResult = await runCli(['refresh', '--manifest', manifestPath]);
    const markdown = await readFile(join(outputDir, 'source-truth.md'), 'utf-8');
    const report = JSON.parse(
      await readFile(join(outputDir, 'source-truth-report.json'), 'utf-8')
    ) as SourceTruthInspectionReport;
    const verifyResult = await runCli(['verify', '--output-dir', outputDir]);
    const refreshedManifest = JSON.parse(
      await readFile(manifestPath, 'utf-8')
    ) as SourceTruthDocsManifest;
    const expectedRefreshCheckedFiles =
      refreshedManifest.sourceFiles.length + refreshedManifest.generatedOutputs.length;

    expect(refreshResult.stdout).toContain('Mode: source-truth-local-docs');
    expect(refreshResult.stdout).toContain('Post-refresh verification: passed');
    expect(refreshResult.stdout).toContain(`Checked files: ${expectedRefreshCheckedFiles}`);
    expect(refreshResult.stdout).toContain('Refresh complete');
    expect(report.facts.map((fact) => fact.exportedName)).toEqual(
      expect.arrayContaining(['value', 'run'])
    );
    expect(markdown).toContain('run');
    expect(markdown).not.toContain('# Tampered');
    expect(verifyResult.stdout).toContain('Failures: 0');
    expect(verifyResult.stdout).toContain('Verification passed');
  });

  it('refreshes configured SDK docs from the manifest recorded local OpenRef spec path', async () => {
    const { manifestPath, outputDir } = await generateSwiftFixture();
    const firstManifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as GenerationManifest;
    const sourcePath = firstManifest.source.resolvedSpecPath;
    const outputFile = firstManifest.generatedOutputs.find((output) => output.kind === 'llm-docs');

    if (outputFile === undefined) {
      throw new Error('expected configured SDK generated docs output');
    }

    await writeFile(
      sourcePath,
      [
        'info:',
        '  id: swift',
        '  title: Supabase Swift SDK',
        '  description: Test fixture',
        'functions:',
        '  - id: select',
        '    title: Select refreshed data',
        '    description: Read refreshed rows',
        '    examples:',
        '      - id: select-basic',
        '        name: Basic refreshed select',
        '        code: supabase.from("todos").select("id")',
        '',
      ].join('\n'),
      'utf-8'
    );
    await writeFile(join(outputDir, outputFile.path), 'tampered configured output\n', 'utf-8');

    const refreshResult = await runCli(['refresh', '--manifest', manifestPath]);
    const refreshedManifest = JSON.parse(
      await readFile(manifestPath, 'utf-8')
    ) as GenerationManifest;
    const refreshedFullOutput = refreshedManifest.generatedOutputs.find((output) =>
      output.path.endsWith('-full-llms.txt')
    );
    const expectedRefreshCheckedFiles = refreshedManifest.generatedOutputs.length + 1;

    if (refreshedFullOutput === undefined) {
      throw new Error('expected refreshed configured SDK full output');
    }

    const refreshedText = await readFile(join(outputDir, refreshedFullOutput.path), 'utf-8');
    const parsedSpec = JSON.parse(
      await readFile(join(outputDir, 'parsed', 'swift-v2-spec.json'), 'utf-8')
    ) as { operations: Array<{ title: string; description: string }> };
    const verifyResult = await runCli(['verify', '--manifest', manifestPath]);

    expect(refreshResult.stdout).toContain('Manifest refresh');
    expect(refreshResult.stdout).toContain('Mode: configured-sdk');
    expect(refreshResult.stdout).toContain(`Source: ${sourcePath}`);
    expect(refreshResult.stdout).toContain('Post-refresh verification: passed');
    expect(refreshResult.stdout).toContain(`Checked files: ${expectedRefreshCheckedFiles}`);
    expect(refreshResult.stdout).toContain('Refresh complete');
    expect(refreshedManifest.source.resolvedSpecPath).toBe(sourcePath);
    expect(refreshedManifest.source.contentHash).toBe(await sha256File(sourcePath));
    expect(refreshedManifest.generatedOutputs.map((output) => output.path)).toEqual([
      'llm-docs/supabase-swift-v2-database-llms.txt',
      'llm-docs/supabase-swift-v2-full-llms.txt',
      'parsed/swift-v2-spec.json',
    ]);
    expect(parsedSpec.operations[0]).toMatchObject({
      title: 'Select refreshed data',
      description: 'Read refreshed rows',
    });
    expect(refreshedText).toContain('Select refreshed data');
    expect(refreshedText).toContain('Basic refreshed select');
    expect(refreshedText).not.toContain('tampered configured output');
    expect(verifyResult.stdout).toContain('Failures: 0');
    expect(verifyResult.stdout).toContain('Verification passed');

    await writeFile(
      sourcePath,
      testSpecYaml.replace('Select data', 'Select via output dir refresh'),
      'utf-8'
    );

    const outputDirRefresh = await runCli(['refresh', '--output-dir', outputDir]);
    const outputDirRefreshedText = await readFile(
      join(outputDir, 'llm-docs', 'supabase-swift-v2-full-llms.txt'),
      'utf-8'
    );

    expect(outputDirRefresh.stdout).toContain('Mode: configured-sdk');
    expect(outputDirRefreshedText).toContain('Select via output dir refresh');
  });

  it('refresh rejects unsafe configured SDK filename metadata before writing outside output', async () => {
    const { manifestPath, outputDir } = await generateSwiftFixture();
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as GenerationManifest;
    const outsidePath = resolve(outputDir, 'parsed', '../../outside-v2-spec.json');

    manifest.sdk.name = '../../outside';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['refresh', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('sdk.name must be a safe filename component');
    expect(await pathExists(outsidePath)).toBe(false);
  });

  it('refresh rejects unsafe manifest-derived configured SDK filename prefixes', async () => {
    const { manifestPath, outputDir } = await generateSwiftFixture();
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as GenerationManifest;
    const fullOutput = manifest.generatedOutputs.find((output) =>
      output.path.endsWith('-full-llms.txt')
    );
    const escapedFullPath = join(outputDir, 'escape-full-llms.txt');
    const escapedModulePath = join(outputDir, 'escape-database-llms.txt');

    if (fullOutput === undefined) {
      throw new Error('expected configured SDK full output');
    }

    fullOutput.path = 'llm-docs/../escape-full-llms.txt';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['refresh', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'generatedOutputs[1] full-doc filename prefix must be a safe filename component'
    );
    expect(await pathExists(escapedFullPath)).toBe(false);
    expect(await pathExists(escapedModulePath)).toBe(false);
  });

  it.each([
    {
      name: 'parsed output directory',
      setup: async (fixture: { outputDir: string; outsideDir: string }) => {
        await rm(join(fixture.outputDir, 'parsed'), { recursive: true, force: true });
        await symlink(fixture.outsideDir, join(fixture.outputDir, 'parsed'), 'dir');

        return join(fixture.outsideDir, 'swift-v2-spec.json');
      },
      expected: 'configured-sdk parsed output path: symbolic links are not allowed',
      outsideContent: undefined,
    },
    {
      name: 'llm-docs output directory',
      setup: async (fixture: { outputDir: string; outsideDir: string }) => {
        await rm(join(fixture.outputDir, 'llm-docs'), { recursive: true, force: true });
        await symlink(fixture.outsideDir, join(fixture.outputDir, 'llm-docs'), 'dir');

        return join(fixture.outsideDir, 'supabase-swift-v2-full-llms.txt');
      },
      expected: 'configured-sdk llm-docs output directory: symbolic links are not allowed',
      outsideContent: undefined,
    },
    {
      name: 'llm-docs output file',
      setup: async (fixture: { outputDir: string; outsideDir: string }) => {
        const outsidePath = join(fixture.outsideDir, 'outside-full-llms.txt');
        const targetPath = join(
          fixture.outputDir,
          'llm-docs',
          'supabase-swift-v2-full-llms.txt'
        );

        await writeFile(outsidePath, 'preserve outside full doc\n', 'utf-8');
        await rm(targetPath, { force: true });
        await symlink(outsidePath, targetPath, 'file');

        return outsidePath;
      },
      expected: 'configured-sdk llm-docs output path: symbolic links are not allowed',
      outsideContent: 'preserve outside full doc\n',
    },
  ])(
    'refresh rejects configured SDK symlinked $name before writing outside output',
    async (testCase) => {
      const { manifestPath, outputDir } = await generateSwiftFixture();
      const outsideDir = join(dirname(outputDir), `outside-${testCase.name.replaceAll(' ', '-')}`);

      await mkdir(outsideDir, { recursive: true });
      const outsidePath = await testCase.setup({ outputDir, outsideDir });

      const result = await runCliWithExit(['refresh', '--manifest', manifestPath]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(testCase.expected);

      if (testCase.outsideContent === undefined) {
        expect(await pathExists(outsidePath)).toBe(false);
      } else {
        expect(await readFile(outsidePath, 'utf-8')).toBe(testCase.outsideContent);
      }
    }
  );

  it.each([
    {
      name: 'URL-like',
      setup: async (fixture: { manifest: GenerationManifest }) => {
        fixture.manifest.source.resolvedSpecPath = 'https://example.com/spec.yml';
      },
      expected: 'source.resolvedSpecPath must be a local path',
    },
    {
      name: 'relative',
      setup: async (fixture: { manifest: GenerationManifest }) => {
        fixture.manifest.source.resolvedSpecPath = 'config/source.yml';
      },
      expected: 'source.resolvedSpecPath must be absolute',
    },
    {
      name: 'missing',
      setup: async (fixture: { dir: string; manifest: GenerationManifest }) => {
        fixture.manifest.source.resolvedSpecPath = join(fixture.dir, 'missing.yml');
      },
      expected: 'source.resolvedSpecPath not found',
    },
    {
      name: 'symlinked',
      setup: async (fixture: { dir: string; sourcePath: string; manifest: GenerationManifest }) => {
        const linkPath = join(fixture.dir, 'linked-spec.yml');
        await symlink(fixture.sourcePath, linkPath, 'file');
        fixture.manifest.source.resolvedSpecPath = linkPath;
      },
      expected: 'source.resolvedSpecPath must not be a symbolic link',
    },
    {
      name: 'directory',
      setup: async (fixture: { dir: string; manifest: GenerationManifest }) => {
        const specDir = join(fixture.dir, 'spec-dir');
        await mkdir(specDir, { recursive: true });
        fixture.manifest.source.resolvedSpecPath = specDir;
      },
      expected: 'source.resolvedSpecPath must be an existing local OpenRef spec file',
    },
    {
      name: 'inside output',
      setup: async (fixture: {
        outputDir: string;
        manifest: GenerationManifest;
        preservedOutputPath: string;
      }) => {
        const insideSpecPath = join(fixture.outputDir, 'source.yml');
        await writeFile(insideSpecPath, testSpecYaml, 'utf-8');
        await writeFile(fixture.preservedOutputPath, 'preserve configured output\n', 'utf-8');
        fixture.manifest.source.resolvedSpecPath = insideSpecPath;
      },
      expected: 'manifest source path must not be the same as, or inside, the manifest output directory',
    },
  ])('refresh rejects configured SDK manifests with $name resolvedSpecPath', async (testCase) => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-refresh-sdk-path-'));
    tempDirs.push(dir);
    const outputDir = join(dir, 'output');
    const manifestPath = join(outputDir, 'manifest.json');
    const sourcePath = join(dir, 'source.yml');
    const preservedOutputPath = join(
      outputDir,
      'llm-docs',
      'supabase-swift-v2-full-llms.txt'
    );

    await mkdir(dirname(preservedOutputPath), { recursive: true });
    await writeFile(sourcePath, testSpecYaml, 'utf-8');

    const manifest: GenerationManifest = {
      schemaVersion: '0.1.0',
      generatedAt: new Date(0).toISOString(),
      mode: 'configured-sdk',
      ...validConfiguredSdkManifestMetadata(),
      source: {
        configuredUrl: 'http://127.0.0.1:9/supabase_swift_v2.yml',
        configuredLocalPath: sourcePath,
        resolvedSpecPath: sourcePath,
        format: 'openref-0.1',
        byteSize: await byteSize(sourcePath),
        contentHash: await sha256File(sourcePath),
      },
      generatedOutputs: [
        {
          path: 'llm-docs/supabase-swift-v2-full-llms.txt',
          kind: 'llm-docs',
          byteSize: 0,
          hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        },
      ],
      warnings: [],
    };

    await testCase.setup({ dir, outputDir, sourcePath, preservedOutputPath, manifest });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['refresh', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(testCase.expected);

    if (testCase.name === 'inside output') {
      expect(await readFile(preservedOutputPath, 'utf-8')).toBe('preserve configured output\n');
    }
  });

  it.each([
    {
      name: 'empty sdk name',
      mutate: (manifest: GenerationManifest) => {
        manifest.sdk.name = '';
      },
      expected: 'sdk.name must be a non-empty string',
    },
    {
      name: 'unsafe resolved version',
      mutate: (manifest: GenerationManifest) => {
        manifest.sdk.resolvedVersion = '../v2';
      },
      expected: 'sdk.resolvedVersion must be a safe filename component',
    },
    {
      name: 'missing source byte size',
      mutate: (manifest: GenerationManifest) => {
        delete (manifest.source as Record<string, unknown>).byteSize;
      },
      expected: 'source.byteSize must be a non-negative integer',
    },
    {
      name: 'malformed source byte size',
      mutate: (manifest: GenerationManifest) => {
        manifest.source.byteSize = -1;
      },
      expected: 'source.byteSize must be a non-negative integer',
    },
    {
      name: 'missing source content hash',
      mutate: (manifest: GenerationManifest) => {
        delete (manifest.source as Record<string, unknown>).contentHash;
      },
      expected: 'source.contentHash must be a sha256 hash',
    },
    {
      name: 'malformed source content hash',
      mutate: (manifest: GenerationManifest) => {
        manifest.source.contentHash = 'sha256:not-a-real-hash';
      },
      expected: 'source.contentHash must be a sha256 hash',
    },
    {
      name: 'invalid configured URL',
      mutate: (manifest: GenerationManifest) => {
        manifest.source.configuredUrl = 'not-a-url';
      },
      expected: 'source.configuredUrl must be a valid URL',
    },
    {
      name: 'missing configured local path',
      mutate: (manifest: GenerationManifest) => {
        delete (manifest.source as Record<string, unknown>).configuredLocalPath;
      },
      expected: 'source.configuredLocalPath must be a non-empty string or null',
    },
    {
      name: 'unsupported source format',
      mutate: (manifest: GenerationManifest) => {
        manifest.source.format = 'openref';
      },
      expected: 'source.format must be openref-0.1',
    },
    {
      name: 'unsupported parser format',
      mutate: (manifest: GenerationManifest) => {
        manifest.parser.format = 'openapi';
      },
      expected: 'parser.format must be openref-0.1',
    },
    {
      name: 'unsupported formatter format',
      mutate: (manifest: GenerationManifest) => {
        manifest.formatter.format = 'universal-llm-docs';
      },
      expected: 'formatter.format must be legacy-llm-docs',
    },
    {
      name: 'missing full docs output',
      mutate: (manifest: GenerationManifest) => {
        manifest.generatedOutputs = [
          {
            path: 'parsed/swift-v2-spec.json',
            kind: 'parsed-spec-json',
            byteSize: 0,
            hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
          },
        ];
      },
      expected: 'requires exactly one llm-docs/*-full-llms.txt generated output',
    },
  ])('refresh rejects configured SDK manifests with $name metadata', async (testCase) => {
    const fixture = await generateSwiftFixture();
    const manifest = JSON.parse(await readFile(fixture.manifestPath, 'utf-8')) as GenerationManifest;

    testCase.mutate(manifest);
    await writeFile(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['refresh', '--manifest', fixture.manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(testCase.expected);
  });

  it('refresh rejects local source docs manifests whose source is inside the output directory', async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-refresh-source-in-output-'));
    tempDirs.push(dir);
    const outputDir = join(dir, 'output');
    const sourcePath = join(outputDir, 'source.md');
    const outputPath = join(outputDir, 'llm-docs', 'old.txt');
    const manifestPath = join(outputDir, 'manifest.json');
    const preservedOutput = 'preserve source-docs output on refresh failure\n';

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(sourcePath, '# Source Inside Output\n', 'utf-8');
    await writeFile(outputPath, preservedOutput, 'utf-8');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: '0.1.0',
          mode: 'local-source-docs',
          source: {
            resolvedPath: sourcePath,
            formatHint: 'markdown',
          },
          generatedOutputs: [],
        },
        null,
        2
      )}\n`,
      'utf-8'
    );

    const result = await runCliWithExit(['refresh', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'manifest source path must not be the same as, or inside, the manifest output directory'
    );
    expect(await readFile(outputPath, 'utf-8')).toBe(preservedOutput);
    expect(await readFile(sourcePath, 'utf-8')).toBe('# Source Inside Output\n');
  });

  it('refresh rejects source-truth manifests whose source is inside the output directory', async () => {
    const dir = await mkdtemp(
      join(await realpath(tmpdir()), 'llm-docs-refresh-source-truth-in-output-')
    );
    tempDirs.push(dir);
    const outputDir = join(dir, 'output');
    const sourcePath = join(outputDir, 'source.ts');
    const reportPath = join(outputDir, 'source-truth-report.json');
    const markdownPath = join(outputDir, 'source-truth.md');
    const manifestPath = join(outputDir, 'manifest.json');
    const preservedReport = '{"preserve":true}\n';
    const preservedMarkdown = '# Preserve Source Truth Output\n';

    await mkdir(outputDir, { recursive: true });
    await writeFile(sourcePath, 'export const value = 1;\n', 'utf-8');
    await writeFile(reportPath, preservedReport, 'utf-8');
    await writeFile(markdownPath, preservedMarkdown, 'utf-8');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: '0.1.0',
          mode: 'source-truth-local-docs',
          source: {
            resolvedPath: sourcePath,
          },
          generatedOutputs: [],
        },
        null,
        2
      )}\n`,
      'utf-8'
    );

    const result = await runCliWithExit(['refresh', '--output-dir', outputDir]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'manifest source path must not be the same as, or inside, the manifest output directory'
    );
    expect(await readFile(reportPath, 'utf-8')).toBe(preservedReport);
    expect(await readFile(markdownPath, 'utf-8')).toBe(preservedMarkdown);
    expect(await readFile(sourcePath, 'utf-8')).toBe('export const value = 1;\n');
  });

  it('refresh rejects local source docs manifests whose source is under a symlinked parent', async () => {
    const dir = await mkdtemp(
      join(await realpath(tmpdir()), 'llm-docs-refresh-source-link-parent-')
    );
    tempDirs.push(dir);
    const actualParent = join(dir, 'actual-parent');
    const linkedParent = join(dir, 'linked-parent');
    const sourceDir = join(linkedParent, 'docs');
    const outputDir = join(dir, 'output');
    const outputPath = join(outputDir, 'llm-docs', 'old.txt');
    const manifestPath = join(outputDir, 'manifest.json');
    const preservedOutput = 'preserve source-docs output after symlink-parent failure\n';

    await mkdir(join(actualParent, 'docs'), { recursive: true });
    await symlink(actualParent, linkedParent, 'dir');
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(join(actualParent, 'docs', 'index.md'), '# Linked Parent Source\n', 'utf-8');
    await writeFile(outputPath, preservedOutput, 'utf-8');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: '0.1.0',
          mode: 'local-source-docs',
          source: {
            resolvedPath: sourceDir,
            formatHint: 'markdown',
          },
          generatedOutputs: [],
        },
        null,
        2
      )}\n`,
      'utf-8'
    );

    const result = await runCliWithExit(['refresh', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'manifest source path must not contain a symbolic link component'
    );
    expect(result.stderr).toContain(linkedParent);
    expect(await readFile(outputPath, 'utf-8')).toBe(preservedOutput);
  });

  it('refresh rejects source-truth manifests whose source is under a symlinked parent', async () => {
    const dir = await mkdtemp(
      join(await realpath(tmpdir()), 'llm-docs-refresh-source-truth-link-parent-')
    );
    tempDirs.push(dir);
    const actualParent = join(dir, 'actual-parent');
    const linkedParent = join(dir, 'linked-parent');
    const sourceDir = join(linkedParent, 'source');
    const outputDir = join(dir, 'output');
    const reportPath = join(outputDir, 'source-truth-report.json');
    const markdownPath = join(outputDir, 'source-truth.md');
    const manifestPath = join(outputDir, 'manifest.json');
    const preservedReport = '{"preserve":"source-truth-report"}\n';
    const preservedMarkdown = '# Preserve Source Truth Symlink Parent Output\n';

    await mkdir(join(actualParent, 'source'), { recursive: true });
    await symlink(actualParent, linkedParent, 'dir');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(actualParent, 'source', 'index.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(reportPath, preservedReport, 'utf-8');
    await writeFile(markdownPath, preservedMarkdown, 'utf-8');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: '0.1.0',
          mode: 'source-truth-local-docs',
          source: {
            resolvedPath: sourceDir,
          },
          generatedOutputs: [],
        },
        null,
        2
      )}\n`,
      'utf-8'
    );

    const result = await runCliWithExit(['refresh', '--output-dir', outputDir]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'manifest source path must not contain a symbolic link component'
    );
    expect(result.stderr).toContain(linkedParent);
    expect(await readFile(reportPath, 'utf-8')).toBe(preservedReport);
    expect(await readFile(markdownPath, 'utf-8')).toBe(preservedMarkdown);
  });

  it('refresh rejects discovery report manifests', async () => {
    const discoveryFixture = await createSourceDiscoveryVerifyFixture(
      'llm-docs-refresh-discovery-'
    );

    const discoveryResult = await runCliWithExit([
      'refresh',
      '--output-dir',
      discoveryFixture.outputDir,
    ]);

    expect(discoveryResult.exitCode).toBe(1);
    expect(discoveryResult.stderr).toContain('refresh does not support discovery-report manifests');
    expect(discoveryResult.stderr).toContain('candidate evidence');
  });

  it('refresh requires one manifest location and reports missing or malformed local manifests', async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'llm-docs-refresh-invalid-'));
    tempDirs.push(dir);
    const malformedManifestPath = join(dir, 'malformed.json');
    const invalidLocalManifestPath = join(dir, 'invalid-local.json');
    const missingSourceManifestPath = join(dir, 'missing-source-output', 'manifest.json');
    const missingSourceOutputPath = join(dir, 'missing-source-output', 'llm-docs', 'old.txt');
    const missingPath = join(dir, 'missing-manifest.json');
    const missingSourcePath = join(dir, 'missing-source');

    await writeFile(malformedManifestPath, '{', 'utf-8');
    await writeFile(
      invalidLocalManifestPath,
      `${JSON.stringify(
        {
          schemaVersion: '0.1.0',
          mode: 'local-source-docs',
          source: {
            resolvedPath: 'relative/docs',
            formatHint: 'markdown',
          },
          generatedOutputs: [],
        },
        null,
        2
      )}\n`,
      'utf-8'
    );
    await mkdir(dirname(missingSourceManifestPath), { recursive: true });
    await mkdir(dirname(missingSourceOutputPath), { recursive: true });
    await writeFile(
      missingSourceManifestPath,
      `${JSON.stringify(
        {
          schemaVersion: '0.1.0',
          mode: 'local-source-docs',
          source: {
            resolvedPath: missingSourcePath,
            formatHint: 'markdown',
          },
          generatedOutputs: [],
        },
        null,
        2
      )}\n`,
      'utf-8'
    );
    await writeFile(missingSourceOutputPath, 'preserve on refresh failure\n', 'utf-8');

    const missingOptionResult = await runCliWithExit(['refresh']);
    const duplicateOptionResult = await runCliWithExit([
      'refresh',
      '--manifest',
      malformedManifestPath,
      '--output-dir',
      dir,
    ]);
    const missingManifestResult = await runCliWithExit(['refresh', '--manifest', missingPath]);
    const malformedManifestResult = await runCliWithExit([
      'refresh',
      '--manifest',
      malformedManifestPath,
    ]);
    const invalidLocalManifestResult = await runCliWithExit([
      'refresh',
      '--manifest',
      invalidLocalManifestPath,
    ]);
    const missingSourceResult = await runCliWithExit([
      'refresh',
      '--manifest',
      missingSourceManifestPath,
    ]);

    expect(missingOptionResult.exitCode).toBe(1);
    expect(missingOptionResult.stderr).toContain(
      'provide exactly one of --manifest or --output-dir'
    );
    expect(duplicateOptionResult.exitCode).toBe(1);
    expect(duplicateOptionResult.stderr).toContain(
      'provide exactly one of --manifest or --output-dir'
    );
    expect(missingManifestResult.exitCode).toBe(1);
    expect(missingManifestResult.stderr).toContain('manifest not found');
    expect(malformedManifestResult.exitCode).toBe(1);
    expect(malformedManifestResult.stderr).toContain('malformed manifest JSON');
    expect(invalidLocalManifestResult.exitCode).toBe(1);
    expect(invalidLocalManifestResult.stderr).toContain('source.resolvedPath must be absolute');
    expect(missingSourceResult.exitCode).toBe(1);
    expect(missingSourceResult.stderr).toContain('manifest source path not found');
    expect(await readFile(missingSourceOutputPath, 'utf-8')).toBe('preserve on refresh failure\n');
  });

  it('verifies a generated configured SDK manifest by output directory', async () => {
    const { outputDir } = await generateSwiftFixture();

    const result = await runCli(['verify', '--output-dir', outputDir]);

    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain('Checked files: 4');
    expect(result.stdout).toContain('Failures: 0');
    expect(result.stdout).toContain('Verification passed');
  });

  it('verifies a generated local source docs manifest by output directory', async () => {
    const { outputDir, manifest } = await generateSourceDocsFixture();

    const result = await runCli(['verify', '--output-dir', outputDir]);

    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain(
      `Checked files: ${manifest.sourceFiles.length + manifest.generatedOutputs.length}`
    );
    expect(result.stdout).toContain('Failures: 0');
    expect(result.stdout).toContain('Verification passed');
  });

  it('verifies a generated source-truth docs manifest by output directory and manifest path', async () => {
    const { outputDir, manifestPath, manifest } = await generateSourceTruthDocsFixture();

    const outputDirResult = await runCli(['verify', '--output-dir', outputDir]);
    const manifestResult = await runCli(['verify', '--manifest', manifestPath]);
    const expectedCheckedFiles = manifest.sourceFiles.length + manifest.generatedOutputs.length;

    expect(outputDirResult.stdout).toContain('Manifest verification');
    expect(outputDirResult.stdout).toContain(`Checked files: ${expectedCheckedFiles}`);
    expect(outputDirResult.stdout).toContain('Failures: 0');
    expect(outputDirResult.stdout).toContain('Verification passed');
    expect(manifestResult.stdout).toContain('Manifest verification');
    expect(manifestResult.stdout).toContain(`Checked files: ${expectedCheckedFiles}`);
    expect(manifestResult.stdout).toContain('Failures: 0');
    expect(manifestResult.stdout).toContain('Verification passed');
  });

  it('verifies a source discovery manifest and rejects a tampered report', async () => {
    const { outputDir, reportPath } = await createSourceDiscoveryVerifyFixture();

    const passResult = await runCli(['verify', '--output-dir', outputDir]);
    expect(passResult.stdout).toContain('Manifest verification');
    expect(passResult.stdout).toContain('Checked files: 1');
    expect(passResult.stdout).toContain('Failures: 0');
    expect(passResult.stdout).toContain('Verification passed');

    const reportText = await readFile(reportPath, 'utf-8');
    await writeFile(reportPath, `${reportText}tampered\n`, 'utf-8');

    const tamperedResult = await runCliWithExit(['verify', '--output-dir', outputDir]);
    expect(tamperedResult.exitCode).toBe(1);
    expect(tamperedResult.stdout).toContain('Manifest verification');
    expect(tamperedResult.stdout).toContain('Checked files: 1');
    expect(tamperedResult.stderr).toContain('output discovery-report.json');
    expect(tamperedResult.stderr).toContain('hash mismatch');
  });

  it('rejects discovery report mode drift after file metadata still matches', async () => {
    const { outputDir, reportPath, manifestPath } = await createSourceDiscoveryVerifyFixture(
      'llm-docs-discovery-report-mode-'
    );
    const report = JSON.parse(await readFile(reportPath, 'utf-8')) as DiscoveryReport;

    report.mode = 'repo-bounded-inspection';
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
    await refreshDiscoveryManifestReportMetadata(manifestPath, reportPath);

    const result = await runCliWithExit(['verify', '--output-dir', outputDir]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain('Checked files: 1');
    expect(result.stderr).toContain('discovery report: mode mismatch');
    expect(result.stderr).not.toContain('hash mismatch');
  });

  it('rejects discovery manifest and report count/path consistency drift', async () => {
    const countFixture = await createSourceDiscoveryVerifyFixture('llm-docs-discovery-count-');
    const countManifest = JSON.parse(
      await readFile(countFixture.manifestPath, 'utf-8')
    ) as DiscoveryReportManifest;

    countManifest.discovery.candidateCount += 1;
    await writeFile(
      countFixture.manifestPath,
      `${JSON.stringify(countManifest, null, 2)}\n`,
      'utf-8'
    );

    const countResult = await runCliWithExit(['verify', '--output-dir', countFixture.outputDir]);

    expect(countResult.exitCode).toBe(1);
    expect(countResult.stdout).toContain('Manifest verification');
    expect(countResult.stdout).toContain('Checked files: 1');
    expect(countResult.stderr).toContain('discovery report: candidate count mismatch');
    expect(countResult.stderr).not.toContain('hash mismatch');

    const pathFixture = await createSourceDiscoveryVerifyFixture('llm-docs-discovery-path-');
    const pathManifest = JSON.parse(
      await readFile(pathFixture.manifestPath, 'utf-8')
    ) as DiscoveryReportManifest;

    pathManifest.discovery.reportPath = 'other-report.json';
    await writeFile(
      pathFixture.manifestPath,
      `${JSON.stringify(pathManifest, null, 2)}\n`,
      'utf-8'
    );

    const pathResult = await runCliWithExit(['verify', '--output-dir', pathFixture.outputDir]);

    expect(pathResult.exitCode).toBe(1);
    expect(pathResult.stdout).toContain('Manifest verification');
    expect(pathResult.stdout).toContain('Checked files: 0');
    expect(pathResult.stderr).toContain('generatedOutputs[0].path must match discovery.reportPath');
    expect(pathResult.stderr).not.toContain('hash mismatch');
  });

  it('rejects stale discovery candidate evidence index metadata', async () => {
    const { outputDir, reportPath, manifestPath } = await createSourceDiscoveryVerifyFixture(
      'llm-docs-discovery-candidate-index-stale-'
    );
    const report = JSON.parse(await readFile(reportPath, 'utf-8')) as DiscoveryReport;
    const firstCandidate = report.candidates[0];

    if (firstCandidate === undefined) {
      throw new Error('expected discovery report candidate');
    }

    firstCandidate.formatHints.push('stale-index-test-hint');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
    await refreshDiscoveryManifestReportMetadata(manifestPath, reportPath);

    const result = await runCliWithExit(['verify', '--output-dir', outputDir]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain('Checked files: 1');
    expect(result.stderr).toContain(
      'discovery candidate evidence index: manifest metadata does not match discovery-report.json'
    );
    expect(result.stderr).not.toContain('hash mismatch');
  });

  it('rejects discovery candidate evidence index content leakage and score fields', async () => {
    const { outputDir, manifestPath } = await createSourceDiscoveryVerifyFixture(
      'llm-docs-discovery-candidate-index-leak-'
    );
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf-8')
    ) as DiscoveryReportManifest & {
      candidateEvidenceIndex: CandidateEvidenceManifestIndex & {
        score?: number;
      };
    };
    const firstCandidate = manifest.candidateEvidenceIndex.candidates[0] as
      | (CandidateEvidenceManifestIndex['candidates'][number] & {
          content?: string;
          authorityScore?: number;
        })
      | undefined;

    if (firstCandidate === undefined) {
      throw new Error('expected discovery candidate evidence index candidate');
    }

    manifest.candidateEvidenceIndex.score = 0.99;
    firstCandidate.content = '# Leaked report content\n';
    firstCandidate.authorityScore = 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--output-dir', outputDir]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain('Checked files: 0');
    expect(result.stderr).toContain('candidateEvidenceIndex.score is not supported');
    expect(result.stderr).toContain(
      'candidateEvidenceIndex.candidates[0].content is not supported'
    );
    expect(result.stderr).toContain(
      'candidateEvidenceIndex.candidates[0].authorityScore is not supported'
    );
  });

  it('rejects URL-only fields on path discovery candidate evidence indexes', async () => {
    const { outputDir, manifestPath } = await createSourceDiscoveryVerifyFixture(
      'llm-docs-discovery-candidate-index-path-wrong-kind-'
    );
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf-8')
    ) as DiscoveryReportManifest & {
      candidateEvidenceIndex: CandidateEvidenceManifestIndex;
    };
    const firstCandidate = manifest.candidateEvidenceIndex.candidates[0];

    if (firstCandidate === undefined) {
      throw new Error('expected discovery candidate evidence index candidate');
    }

    firstCandidate.url = 'https://example.com/not-a-path-candidate';
    firstCandidate.sourceResources = [
      {
        url: 'https://example.com/source-with-report-content',
        sourceRole: 'explicit-url',
        evidence: 'link',
      },
    ];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--output-dir', outputDir]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain('Checked files: 0');
    expect(result.stderr).toContain('candidateEvidenceIndex.candidates[0].url is not supported');
    expect(result.stderr).toContain(
      'candidateEvidenceIndex.candidates[0].sourceResources is not supported'
    );
  });

  it('rejects path-only fields on URL discovery candidate evidence indexes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-docs-discovery-candidate-index-url-wrong-kind-'));
    tempDirs.push(dir);
    const { baseUrl } = await startTestServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');

      switch (requestUrl.pathname) {
        case '/docs':
          writeHttpResponse(response, 200, 'text/html', '<a href="/docs/api">API reference</a>\n');
          return;
        case '/llms.txt':
          writeHttpResponse(response, 200, 'text/plain', '');
          return;
        case '/sitemap.xml':
          writeHttpResponse(response, 200, 'application/xml', '<urlset></urlset>\n');
          return;
        default:
          writeHttpResponse(response, 404, 'text/plain', 'missing\n');
      }
    });
    const outputDir = join(dir, 'reports');
    const manifestPath = join(outputDir, 'manifest.json');

    await runCli(['discover', '--url', `${baseUrl}/docs`, '--output-dir', outputDir]);

    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf-8')
    ) as DiscoveryReportManifest & {
      candidateEvidenceIndex: CandidateEvidenceManifestIndex;
    };
    const firstCandidate = manifest.candidateEvidenceIndex.candidates[0];

    if (firstCandidate === undefined) {
      throw new Error('expected URL discovery candidate evidence index candidate');
    }

    firstCandidate.path = 'docs/api.md';
    firstCandidate.kind = 'markdown';
    firstCandidate.format = 'markdown';
    firstCandidate.byteSize = 42;
    firstCandidate.sha256 = '0'.repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--output-dir', outputDir]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain('Checked files: 0');
    expect(result.stderr).toContain('candidateEvidenceIndex.candidates[0].path is not supported');
    expect(result.stderr).toContain('candidateEvidenceIndex.candidates[0].kind is not supported');
    expect(result.stderr).toContain('candidateEvidenceIndex.candidates[0].format is not supported');
    expect(result.stderr).toContain(
      'candidateEvidenceIndex.candidates[0].byteSize is not supported'
    );
    expect(result.stderr).toContain('candidateEvidenceIndex.candidates[0].sha256 is not supported');
  });

  it('accepts older discovery manifests without a candidate evidence index', async () => {
    const { outputDir, manifestPath } = await createSourceDiscoveryVerifyFixture(
      'llm-docs-discovery-candidate-index-backcompat-'
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as DiscoveryReportManifest;

    delete manifest.candidateEvidenceIndex;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCli(['verify', '--output-dir', outputDir]);

    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain('Checked files: 1');
    expect(result.stdout).toContain('Failures: 0');
    expect(result.stdout).toContain('Verification passed');
  });

  it('rejects tampered swift-book preset metadata during source docs verification', async () => {
    const { sourceDir, outputDir } = await createSwiftBookSourceFixture(
      'llm-docs-verify-preset-tamper-'
    );

    await runCli([
      'generate',
      '--source',
      sourceDir,
      '--preset',
      'swift-book',
      '--output-dir',
      outputDir,
    ]);

    const manifestPath = join(outputDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as SourceDocsManifest;

    if (manifest.preset === undefined) {
      throw new Error('expected generated swift-book preset metadata');
    }

    manifest.preset.metadata = {
      sourceSelection: 'explicit-local-source-required',
      sourceVerification: 'performed',
      sourceTruthClaim: 'verified',
    };
    manifest.preset.defaults.systemPrompt = '';
    manifest.preset.limitations = [];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain('Checked files: 0');
    expect(result.stderr).toContain('preset.metadata.sourceVerification must be not-performed');
    expect(result.stderr).toContain('preset.metadata.sourceTruthClaim must be not-claimed');
    expect(result.stderr).toContain('preset.defaults.systemPrompt must be a non-empty string');
    expect(result.stderr).toContain(
      'preset.limitations must include "Requires an explicit local --source path."'
    );
    expect(result.stderr).toContain(
      'preset.limitations must include "Does not perform source-code verification."'
    );
    expect(result.stderr).toContain(
      'preset.limitations must include "Does not claim source truth."'
    );
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

  it('reports configured SDK generated output line metadata drift', async () => {
    const { manifestPath } = await generateSwiftFixture();
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as GenerationManifest;
    const outputFile = manifest.generatedOutputs.find((output) => output.kind === 'llm-docs');

    if (outputFile === undefined || outputFile.lineCount === undefined) {
      throw new Error('expected configured SDK generated output line metadata');
    }

    outputFile.lineCount += 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain(`Checked files: ${manifest.generatedOutputs.length + 1}`);
    expect(result.stderr).toContain(`output ${outputFile.path}: line count mismatch`);
    expect(result.stderr).not.toContain('hash mismatch');
    expect(result.stderr).not.toContain('estimated token count mismatch');
  });

  it('reports configured SDK generated output estimated token metadata drift', async () => {
    const { manifestPath } = await generateSwiftFixture();
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as GenerationManifest;
    const outputFile = manifest.generatedOutputs.find((output) => output.kind === 'llm-docs');

    if (outputFile === undefined || outputFile.estimatedTokenCount === undefined) {
      throw new Error('expected configured SDK generated output token metadata');
    }

    outputFile.estimatedTokenCount += 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain(`Checked files: ${manifest.generatedOutputs.length + 1}`);
    expect(result.stderr).toContain(`output ${outputFile.path}: estimated token count mismatch`);
    expect(result.stderr).not.toContain('hash mismatch');
    expect(result.stderr).not.toContain('line count mismatch');
  });

  it.each([
    {
      label: 'only lineCount',
      mutate(output: ManifestFileEntry): void {
        delete output.estimatedTokenCount;
      },
    },
    {
      label: 'only estimatedTokenCount',
      mutate(output: ManifestFileEntry): void {
        delete output.lineCount;
      },
    },
    {
      label: 'neither optional text metadata field',
      mutate(output: ManifestFileEntry): void {
        delete output.lineCount;
        delete output.estimatedTokenCount;
      },
    },
  ])('accepts configured SDK generated outputs with $label present', async ({ mutate }) => {
    const { manifestPath } = await generateSwiftFixture();
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as GenerationManifest;

    for (const output of manifest.generatedOutputs) {
      mutate(output);
    }

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCli(['verify', '--manifest', manifestPath]);

    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain(`Checked files: ${manifest.generatedOutputs.length + 1}`);
    expect(result.stdout).toContain('Failures: 0');
    expect(result.stdout).toContain('Verification passed');
  });

  it('rejects mixed valid and invalid optional generated output metadata before file checks', async () => {
    const { manifestPath } = await generateSwiftFixture();
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as GenerationManifest;
    const outputFile = manifest.generatedOutputs.find((output) => output.kind === 'llm-docs') as
      | (ManifestFileEntry & { estimatedTokenCount: unknown })
      | undefined;

    if (outputFile === undefined || outputFile.lineCount === undefined) {
      throw new Error('expected configured SDK generated output line metadata');
    }

    outputFile.estimatedTokenCount = -1;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain('Checked files: 0');
    expect(result.stderr).toContain(
      'estimatedTokenCount must be a non-negative integer when present'
    );
    expect(result.stderr).not.toContain('hash mismatch');
    expect(result.stderr).not.toContain('line count mismatch');
  });

  it('rejects missing or malformed configured SDK manifest metadata before file checks', async () => {
    const { manifestPath } = await generateSwiftFixture();
    const validManifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as GenerationManifest;
    const cases: Array<{
      name: string;
      mutate(manifest: GenerationManifest & Record<string, unknown>): void;
      expectedFailures: string[];
    }> = [
      {
        name: 'missing generator',
        mutate(nextManifest): void {
          delete (nextManifest as Partial<GenerationManifest>).generator;
        },
        expectedFailures: ['missing generator object'],
      },
      {
        name: 'non-object generator',
        mutate(nextManifest): void {
          (nextManifest as Record<string, unknown>).generator = 'llm-docs-generator';
        },
        expectedFailures: ['missing generator object'],
      },
      {
        name: 'malformed generator',
        mutate(nextManifest): void {
          nextManifest.generator = {
            name: '',
            version: '',
            cliName: '',
          };
        },
        expectedFailures: [
          'generator.name must be a non-empty string',
          'generator.version must be a non-empty string',
          'generator.cliName must be a non-empty string when present',
        ],
      },
      {
        name: 'missing sdk',
        mutate(nextManifest): void {
          delete (nextManifest as Partial<GenerationManifest>).sdk;
        },
        expectedFailures: ['missing sdk object'],
      },
      {
        name: 'non-object sdk',
        mutate(nextManifest): void {
          (nextManifest as Record<string, unknown>).sdk = null;
        },
        expectedFailures: ['missing sdk object'],
      },
      {
        name: 'malformed sdk',
        mutate(nextManifest): void {
          nextManifest.sdk = {
            name: '',
            resolvedVersion: '',
            displayName: '',
          };
        },
        expectedFailures: [
          'sdk.name must be a non-empty string',
          'sdk.resolvedVersion must be a non-empty string',
          'sdk.displayName must be a non-empty string',
        ],
      },
      {
        name: 'missing parser',
        mutate(nextManifest): void {
          delete (nextManifest as Partial<GenerationManifest>).parser;
        },
        expectedFailures: ['missing parser object'],
      },
      {
        name: 'non-object parser',
        mutate(nextManifest): void {
          (nextManifest as Record<string, unknown>).parser = [];
        },
        expectedFailures: ['missing parser object'],
      },
      {
        name: 'malformed parser',
        mutate(nextManifest): void {
          nextManifest.parser = {
            name: '',
            version: '',
            format: '',
          };
        },
        expectedFailures: [
          'parser.name must be a non-empty string',
          'parser.version must be a non-empty string',
          'parser.format must be openref-0.1',
        ],
      },
      {
        name: 'parser name mismatch',
        mutate(nextManifest): void {
          nextManifest.parser.name = 'MarkdownParser';
        },
        expectedFailures: ['parser.name must be OpenRefParser'],
      },
      {
        name: 'parser format mismatch',
        mutate(nextManifest): void {
          nextManifest.parser.format = 'openapi';
        },
        expectedFailures: ['parser.format must be openref-0.1'],
      },
      {
        name: 'missing formatter',
        mutate(nextManifest): void {
          delete (nextManifest as Partial<GenerationManifest>).formatter;
        },
        expectedFailures: ['missing formatter object'],
      },
      {
        name: 'non-object formatter',
        mutate(nextManifest): void {
          (nextManifest as Record<string, unknown>).formatter = 'LLMFormatter';
        },
        expectedFailures: ['missing formatter object'],
      },
      {
        name: 'malformed formatter',
        mutate(nextManifest): void {
          nextManifest.formatter = {
            name: '',
            version: '',
            format: '',
          };
        },
        expectedFailures: [
          'formatter.name must be LLMFormatter',
          'formatter.version must be a non-empty string',
          'formatter.format must be legacy-llm-docs',
        ],
      },
      {
        name: 'formatter format mismatch',
        mutate(nextManifest): void {
          nextManifest.formatter.format = 'universal-llm-docs';
        },
        expectedFailures: ['formatter.format must be legacy-llm-docs'],
      },
    ];

    for (const testCase of cases) {
      const nextManifest = structuredClone(validManifest) as GenerationManifest &
        Record<string, unknown>;
      testCase.mutate(nextManifest);
      await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf-8');

      const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

      expect(result.exitCode, testCase.name).toBe(1);
      expect(result.stdout, testCase.name).toContain('Manifest verification');
      expect(result.stdout, testCase.name).toContain('Checked files: 0');
      for (const expectedFailure of testCase.expectedFailures) {
        expect(result.stderr, testCase.name).toContain(expectedFailure);
      }
      expect(result.stderr, testCase.name).not.toContain('hash mismatch');
    }
  }, 30_000);

  it('continues to follow configured SDK generated output symlinks during verification', async () => {
    const { outputDir, manifestPath } = await generateSwiftFixture();
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as GenerationManifest;
    const outputFile = manifest.generatedOutputs.find((output) => output.kind === 'llm-docs');

    if (outputFile === undefined) {
      throw new Error('expected configured SDK generated output');
    }

    const outputPath = join(outputDir, outputFile.path);
    const linkedTargetPath = join(dirname(outputDir), 'configured-sdk-output-target.txt');
    const originalOutput = await readFile(outputPath, 'utf-8');

    await writeFile(linkedTargetPath, originalOutput, 'utf-8');
    await rm(outputPath, { force: true });
    await symlink(linkedTargetPath, outputPath, 'file');

    const result = await runCli(['verify', '--manifest', manifestPath]);

    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain(`Checked files: ${manifest.generatedOutputs.length + 1}`);
    expect(result.stdout).toContain('Failures: 0');
    expect(result.stdout).toContain('Verification passed');
  });

  it('reports local source docs source drift', async () => {
    const { manifestPath, sourceDir, manifest } = await generateSourceDocsFixture();
    const sourceFile = manifest.sourceFiles[0];

    if (sourceFile === undefined) {
      throw new Error('expected generated source docs fixture source file');
    }

    await writeFile(join(sourceDir, sourceFile.path), '# Changed Source\n\nDrifted.\n', 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Checked files: ${manifest.sourceFiles.length + manifest.generatedOutputs.length}`
    );
    expect(result.stderr).toContain('sourceFiles[0]');
    expect(result.stderr).toContain('hash mismatch');
  });

  it('reports local source docs source file line and token metadata drift', async () => {
    const { manifestPath, manifest } = await generateSourceDocsFixture();
    const sourceFile = manifest.sourceFiles[0];

    if (sourceFile === undefined) {
      throw new Error('expected generated source docs fixture source file');
    }

    sourceFile.lineCount += 1;
    sourceFile.estimatedTokenCount += 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Checked files: ${manifest.sourceFiles.length + manifest.generatedOutputs.length}`
    );
    expect(result.stderr).toContain('sourceFiles[0]: line count mismatch');
    expect(result.stderr).toContain('sourceFiles[0]: estimated token count mismatch');
    expect(result.stderr).not.toContain('hash mismatch');
  });

  it('requires source docs source file line and token metadata before file checks', async () => {
    const { manifestPath, manifest } = await generateSourceDocsFixture();
    const sourceFile = manifest.sourceFiles[0] as
      | (Partial<SourceDocsManifest['sourceFiles'][number]> & Record<string, unknown>)
      | undefined;

    if (sourceFile === undefined) {
      throw new Error('expected generated source docs fixture source file');
    }

    delete sourceFile.lineCount;
    delete sourceFile.estimatedTokenCount;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Checked files: 0');
    expect(result.stderr).toContain('sourceFiles[0].lineCount must be a non-negative integer');
    expect(result.stderr).toContain(
      'sourceFiles[0].estimatedTokenCount must be a non-negative integer'
    );
    expect(result.stderr).not.toContain('hash mismatch');
  });

  it('rejects malformed source docs source file line and token metadata before file checks', async () => {
    const { manifestPath, manifest } = await generateSourceDocsFixture();
    const sourceFile = manifest.sourceFiles[0] as
      | (SourceDocsManifest['sourceFiles'][number] & Record<string, unknown>)
      | undefined;

    if (sourceFile === undefined) {
      throw new Error('expected generated source docs fixture source file');
    }

    sourceFile.lineCount = -1;
    sourceFile.estimatedTokenCount = 1.5;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Checked files: 0');
    expect(result.stderr).toContain('sourceFiles[0].lineCount must be a non-negative integer');
    expect(result.stderr).toContain(
      'sourceFiles[0].estimatedTokenCount must be a non-negative integer'
    );
    expect(result.stderr).not.toContain('hash mismatch');
  });

  it('reports missing local source docs source and output files', async () => {
    const { manifestPath, sourceDir, outputDir, manifest } = await generateSourceDocsFixture();
    const sourceFile = manifest.sourceFiles[0];
    const outputFile = manifest.generatedOutputs[0];

    if (sourceFile === undefined || outputFile === undefined) {
      throw new Error('expected generated source docs fixture files');
    }

    await rm(join(sourceDir, sourceFile.path), { force: true });
    await rm(join(outputDir, outputFile.path), { force: true });

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Checked files: ${manifest.sourceFiles.length + manifest.generatedOutputs.length}`
    );
    expect(result.stderr).toContain('sourceFiles[0]: missing file');
    expect(result.stderr).toContain(`output ${outputFile.path}: missing file`);
  });

  it('reports local source docs generated output line and token metadata drift', async () => {
    const { manifestPath, manifest } = await generateSourceDocsFixture();
    const outputFile = manifest.generatedOutputs[0];

    if (outputFile === undefined) {
      throw new Error('expected generated source docs fixture output file');
    }

    outputFile.lineCount += 1;
    outputFile.estimatedTokenCount += 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Checked files: ${manifest.sourceFiles.length + manifest.generatedOutputs.length}`
    );
    expect(result.stderr).toContain('line count mismatch');
    expect(result.stderr).toContain('estimated token count mismatch');
  });

  it('rejects malformed local source docs generation metadata before file checks', async () => {
    const { manifestPath, manifest } = await generateSourceDocsFixture();
    const validManifest = structuredClone(manifest);
    const scenarios: Array<{
      name: string;
      mutate(manifest: SourceDocsManifest & Record<string, unknown>): void;
      expectedFailures: string[];
    }> = [
      {
        name: 'missing generator',
        mutate(nextManifest): void {
          delete (nextManifest as Partial<SourceDocsManifest>).generator;
        },
        expectedFailures: ['missing generator object'],
      },
      {
        name: 'malformed generator',
        mutate(nextManifest): void {
          nextManifest.generator = {
            name: '',
            version: '',
            cliName: '',
          };
        },
        expectedFailures: [
          'generator.name must be a non-empty string',
          'generator.version must be a non-empty string',
          'generator.cliName must be a non-empty string when present',
        ],
      },
      {
        name: 'missing parser',
        mutate(nextManifest): void {
          delete (nextManifest as Partial<SourceDocsManifest>).parser;
        },
        expectedFailures: ['missing parser object'],
      },
      {
        name: 'malformed parser',
        mutate(nextManifest): void {
          nextManifest.parser = {
            name: '',
            version: '',
            format: 'asciidoc',
          };
        },
        expectedFailures: [
          'parser.name must be a non-empty string',
          'parser.version must be a non-empty string',
          'parser.format must be a supported source format',
        ],
      },
      {
        name: 'parser format mismatch',
        mutate(nextManifest): void {
          nextManifest.parser.format = 'html';
        },
        expectedFailures: ['parser.format must match source.resolvedFormat'],
      },
      {
        name: 'missing formatter',
        mutate(nextManifest): void {
          delete (nextManifest as Partial<SourceDocsManifest>).formatter;
        },
        expectedFailures: ['missing formatter object'],
      },
      {
        name: 'malformed formatter',
        mutate(nextManifest): void {
          nextManifest.formatter = {
            name: 'OtherFormatter',
            version: '',
            format: 'markdown',
          };
        },
        expectedFailures: [
          'formatter.name must be UniversalFormatter',
          'formatter.version must be a non-empty string',
          'formatter.format must be universal-llm-docs',
        ],
      },
    ];

    for (const scenario of scenarios) {
      const nextManifest = structuredClone(validManifest) as SourceDocsManifest &
        Record<string, unknown>;
      scenario.mutate(nextManifest);
      await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf-8');

      const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

      expect(result.exitCode, scenario.name).toBe(1);
      expect(result.stdout, scenario.name).toContain('Manifest verification');
      expect(result.stdout, scenario.name).toContain('Checked files: 0');
      for (const expectedFailure of scenario.expectedFailures) {
        expect(result.stderr, scenario.name).toContain(expectedFailure);
      }
      expect(result.stderr, scenario.name).not.toContain('hash mismatch');
    }
  });

  it('requires source docs generated output line and token metadata before file checks', async () => {
    const { manifestPath, manifest } = await generateSourceDocsFixture();
    const outputFile = manifest.generatedOutputs[0];

    if (outputFile === undefined) {
      throw new Error('expected generated source docs fixture output file');
    }

    delete outputFile.lineCount;
    delete outputFile.estimatedTokenCount;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Manifest verification');
    expect(result.stdout).toContain('Checked files: 0');
    expect(result.stderr).toContain('output[0].lineCount must be a non-negative integer');
    expect(result.stderr).toContain('output[0].estimatedTokenCount must be a non-negative integer');
    expect(result.stderr).not.toContain('hash mismatch');
  });

  it('reports source-truth docs generated output drift', async () => {
    const { manifestPath, outputDir, manifest } = await generateSourceTruthDocsFixture(
      'llm-docs-source-truth-output-drift-'
    );
    const outputFile = manifest.generatedOutputs.find(
      (output) => output.kind === 'source-truth-markdown'
    );

    if (outputFile === undefined) {
      throw new Error('expected source-truth markdown output');
    }

    await writeFile(join(outputDir, outputFile.path), '# Drifted Source Truth\n', 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Checked files: ${manifest.sourceFiles.length + manifest.generatedOutputs.length}`
    );
    expect(result.stderr).toContain(`output ${outputFile.path}`);
    expect(result.stderr).toContain('hash mismatch');
    expect(result.stderr).toContain('line count mismatch');
    expect(result.stderr).toContain('estimated token count mismatch');
  });

  it('reports source-truth docs source drift and missing source files', async () => {
    const { manifestPath, sourceDir, manifest } = await generateSourceTruthDocsFixture(
      'llm-docs-source-truth-source-drift-'
    );
    const sourceFile = manifest.sourceFiles.find((file) => file.path === 'index.ts');
    const missingFile = manifest.sourceFiles.find((file) => file.path === 'package.json');

    if (sourceFile === undefined || missingFile === undefined) {
      throw new Error('expected generated source-truth fixture source files');
    }

    await writeFile(join(sourceDir, sourceFile.path), 'export const value = 2;\n', 'utf-8');
    await rm(join(sourceDir, missingFile.path), { force: true });

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Checked files: ${manifest.sourceFiles.length + manifest.generatedOutputs.length}`
    );
    expect(result.stderr).toContain('sourceFiles[0]');
    expect(result.stderr).toContain('hash mismatch');
    expect(result.stderr).toContain('sourceFiles[1]: missing file');
  });

  it('rejects source-truth report versus manifest count drift', async () => {
    const { manifestPath, manifest } = await generateSourceTruthDocsFixture(
      'llm-docs-source-truth-report-count-'
    );
    const sourceFile = manifest.sourceFiles[0];

    if (sourceFile === undefined) {
      throw new Error('expected source-truth manifest source file');
    }

    sourceFile.exportFactCount += 1;
    sourceFile.factCount += 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Checked files: ${manifest.sourceFiles.length + manifest.generatedOutputs.length}`
    );
    expect(result.stderr).toContain('source-truth report: export fact count mismatch');
    expect(result.stderr).toContain('source-truth report: sourceFiles[0].factCount mismatch');
    expect(result.stderr).not.toContain('hash mismatch');
  });

  it('rejects malformed source-truth inspection schema and traversal shape', async () => {
    const { manifestPath, manifest } = await generateSourceTruthDocsFixture(
      'llm-docs-source-truth-inspection-shape-'
    );
    const inspection = manifest.inspection as unknown as Record<string, unknown>;
    const traversal = manifest.inspection.traversal as unknown as Record<string, unknown>;

    inspection.schemaVersion = '99.0.0';
    inspection.mode = 'source-truth-local-docs';
    traversal.maxFiles = 'many';
    traversal.skippedDirectoryNames = 'node_modules';
    traversal.truncated = 'false';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Checked files: 0');
    expect(result.stderr).toContain('inspection.schemaVersion must be 0.1.0');
    expect(result.stderr).toContain('inspection.mode must be source-truth-local-evidence');
    expect(result.stderr).toContain('inspection.traversal.maxFiles must be a non-negative integer');
    expect(result.stderr).toContain(
      'inspection.traversal.skippedDirectoryNames must be an array of strings'
    );
    expect(result.stderr).toContain('inspection.traversal.truncated must be a boolean');
  });

  it('rejects source-truth source and output symlinked ancestor directories', async () => {
    const sourceAncestorFixture = await generateSourceTruthDocsFixture(
      'llm-docs-source-truth-source-ancestor-'
    );
    const sourceParentLink = join(dirname(sourceAncestorFixture.sourceDir), 'linked-source-parent');
    const linkedSourceDir = join(sourceParentLink, basename(sourceAncestorFixture.sourceDir));
    const sourceAncestorReportPath = join(
      sourceAncestorFixture.outputDir,
      'source-truth-report.json'
    );

    await symlink(dirname(sourceAncestorFixture.sourceDir), sourceParentLink, 'dir');

    sourceAncestorFixture.manifest.source.input = linkedSourceDir;
    sourceAncestorFixture.manifest.source.resolvedPath = linkedSourceDir;

    for (const sourceFile of sourceAncestorFixture.manifest.sourceFiles) {
      sourceFile.resolvedPath = join(linkedSourceDir, sourceFile.path);
    }

    const sourceAncestorReport = JSON.parse(
      await readFile(sourceAncestorReportPath, 'utf-8')
    ) as SourceTruthInspectionReport;
    sourceAncestorReport.source.input = linkedSourceDir;
    sourceAncestorReport.source.resolvedPath = linkedSourceDir;

    for (const reportFile of sourceAncestorReport.files) {
      reportFile.resolvedPath = join(linkedSourceDir, reportFile.path);
    }

    await writeFile(
      sourceAncestorReportPath,
      `${JSON.stringify(sourceAncestorReport, null, 2)}\n`,
      'utf-8'
    );
    await writeFile(
      sourceAncestorFixture.manifestPath,
      `${JSON.stringify(sourceAncestorFixture.manifest, null, 2)}\n`,
      'utf-8'
    );
    await refreshSourceTruthReportOutputMetadata(
      sourceAncestorFixture.manifestPath,
      sourceAncestorReportPath
    );

    const sourceResult = await runCliWithExit([
      'verify',
      '--manifest',
      sourceAncestorFixture.manifestPath,
    ]);

    expect(sourceResult.exitCode).toBe(1);
    expect(sourceResult.stdout).toContain('Checked files: 0');
    expect(sourceResult.stderr).toContain('source: symbolic links are not allowed in path');
    expect(sourceResult.stderr).toContain(sourceParentLink);
    expect(sourceResult.stderr).not.toContain('hash mismatch');

    const outputAncestorFixture = await generateSourceTruthDocsFixture(
      'llm-docs-source-truth-output-ancestor-'
    );
    const outputParentLink = join(dirname(outputAncestorFixture.outputDir), 'linked-output-parent');
    const linkedManifestPath = join(
      outputParentLink,
      basename(outputAncestorFixture.outputDir),
      'manifest.json'
    );

    await symlink(dirname(outputAncestorFixture.outputDir), outputParentLink, 'dir');

    const outputResult = await runCliWithExit(['verify', '--manifest', linkedManifestPath]);

    expect(outputResult.exitCode).toBe(1);
    expect(outputResult.stdout).toContain(
      `Checked files: ${
        outputAncestorFixture.manifest.sourceFiles.length +
        outputAncestorFixture.manifest.generatedOutputs.length
      }`
    );
    expect(outputResult.stderr).toContain(
      'output source-truth-report.json: symbolic links are not allowed in path'
    );
    expect(outputResult.stderr).toContain(outputParentLink);
    expect(outputResult.stderr).not.toContain('hash mismatch');
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
          ...validConfiguredSdkManifestMetadata(),
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
          ...validConfiguredSdkManifestMetadata(),
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
          ...validConfiguredSdkManifestMetadata(),
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

  it('rejects source docs source file paths that escape the recorded source root', async () => {
    const { manifestPath, manifest } = await generateSourceDocsFixture();
    const sourceFile = manifest.sourceFiles[0];
    const outputFile = manifest.generatedOutputs[0];

    if (sourceFile === undefined || outputFile === undefined) {
      throw new Error('expected generated source docs fixture files');
    }

    sourceFile.path = '../outside.md';
    outputFile.path = '../outside-output.txt';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Checked files: 0');
    expect(result.stderr).toContain('sourceFiles[0].path escapes source root');
    expect(result.stderr).toContain('output[0].path escapes manifest directory');
  });

  it('rejects source docs source file symlinks before following outside content', async () => {
    const { manifestPath, sourceDir, manifest } = await generateSourceDocsFixture();
    const sourceFile = manifest.sourceFiles[0];
    const outsidePath = join(dirname(sourceDir), 'outside.md');
    const linkPath = join(sourceDir, 'link.md');

    if (sourceFile === undefined) {
      throw new Error('expected generated source docs fixture source file');
    }

    await writeFile(outsidePath, '# Outside Target\n\nThis is outside the source root.\n', 'utf-8');
    await symlink(outsidePath, linkPath, 'file');

    sourceFile.path = 'link.md';
    sourceFile.resolvedPath = linkPath;
    sourceFile.byteSize = await byteSize(outsidePath);
    sourceFile.hash = await sha256File(outsidePath);
    manifest.source.aggregateHash = aggregateSourceFilesHashForTest(manifest.sourceFiles);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('sourceFiles[0]: symbolic links are not allowed');
    expect(result.stderr).not.toContain('hash mismatch');
  });

  it('rejects source docs source file symlinked parent directories', async () => {
    const { manifestPath, sourceDir, manifest } = await generateSourceDocsFixture();
    const sourceFile = manifest.sourceFiles[0];
    const outsideDir = join(dirname(sourceDir), 'outside-source-dir');
    const outsidePath = join(outsideDir, 'file.md');
    const linkPath = join(sourceDir, 'link');

    if (sourceFile === undefined) {
      throw new Error('expected generated source docs fixture source file');
    }

    await mkdir(outsideDir, { recursive: true });
    await writeFile(outsidePath, '# Outside Parent Target\n\nOutside source root.\n', 'utf-8');
    await symlink(outsideDir, linkPath, 'dir');

    sourceFile.path = 'link/file.md';
    sourceFile.resolvedPath = join(sourceDir, 'link/file.md');
    sourceFile.byteSize = await byteSize(outsidePath);
    sourceFile.hash = await sha256File(outsidePath);
    manifest.source.aggregateHash = aggregateSourceFilesHashForTest(manifest.sourceFiles);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('sourceFiles[0]: symbolic links are not allowed');
    expect(result.stderr).not.toContain('hash mismatch');
  });

  it('rejects source docs generated output symlinks before following outside content', async () => {
    const { manifestPath, outputDir, manifest } = await generateSourceDocsFixture();
    const outputFile = manifest.generatedOutputs[0];

    if (outputFile === undefined) {
      throw new Error('expected generated source docs fixture output file');
    }

    const outputPath = join(outputDir, outputFile.path);
    const outsidePath = join(dirname(outputDir), 'outside-output.txt');
    const originalOutput = await readFile(outputPath, 'utf-8');

    await writeFile(outsidePath, originalOutput, 'utf-8');
    await rm(outputPath, { force: true });
    await symlink(outsidePath, outputPath, 'file');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`output ${outputFile.path}: symbolic links are not allowed`);
    expect(result.stderr).not.toContain('hash mismatch');
  });

  it('rejects source docs generated output symlinked parent directories', async () => {
    const { manifestPath, outputDir, manifest } = await generateSourceDocsFixture();
    const outputFile = manifest.generatedOutputs[0];

    if (outputFile === undefined) {
      throw new Error('expected generated source docs fixture output file');
    }

    const originalOutputPath = join(outputDir, outputFile.path);
    const originalOutput = await readFile(originalOutputPath, 'utf-8');
    const outsideDir = join(dirname(outputDir), 'outside-output-dir');
    const outsidePath = join(outsideDir, 'file.txt');
    const linkPath = join(outputDir, 'llm-docs/link');

    await mkdir(outsideDir, { recursive: true });
    await writeFile(outsidePath, originalOutput, 'utf-8');
    await symlink(outsideDir, linkPath, 'dir');

    outputFile.path = 'llm-docs/link/file.txt';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`output ${outputFile.path}: symbolic links are not allowed`);
    expect(result.stderr).not.toContain('hash mismatch');
  });

  it('rejects malformed, escaping, and symlinked source-truth manifest paths', async () => {
    const pathFixture = await generateSourceTruthDocsFixture('llm-docs-source-truth-paths-');
    const pathSourceFile = pathFixture.manifest.sourceFiles[0];
    const pathOutputFile = pathFixture.manifest.generatedOutputs[0];

    if (pathSourceFile === undefined || pathOutputFile === undefined) {
      throw new Error('expected source-truth manifest files');
    }

    pathSourceFile.path = '../outside.ts';
    pathOutputFile.path = join(dirname(pathFixture.outputDir), 'absolute-output.json');
    pathOutputFile.kind = 'llm-docs';
    await writeFile(
      pathFixture.manifestPath,
      `${JSON.stringify(pathFixture.manifest, null, 2)}\n`,
      'utf-8'
    );

    const pathResult = await runCliWithExit(['verify', '--manifest', pathFixture.manifestPath]);

    expect(pathResult.exitCode).toBe(1);
    expect(pathResult.stdout).toContain('Checked files: 0');
    expect(pathResult.stderr).toContain('sourceFiles[0].path escapes source root');
    expect(pathResult.stderr).toContain('output[0].path must be relative');
    expect(pathResult.stderr).toContain(
      'kind must be source-truth-report-json or source-truth-markdown'
    );

    const sourceLinkFixture = await generateSourceTruthDocsFixture(
      'llm-docs-source-truth-source-link-'
    );
    const sourceLinkFile = sourceLinkFixture.manifest.sourceFiles[0];
    const outsideSourcePath = join(dirname(sourceLinkFixture.sourceDir), 'outside.ts');
    const sourceLinkPath = join(sourceLinkFixture.sourceDir, 'link.ts');

    if (sourceLinkFile === undefined) {
      throw new Error('expected source-truth manifest source file');
    }

    await writeFile(outsideSourcePath, 'export const outside = true;\n', 'utf-8');
    await symlink(outsideSourcePath, sourceLinkPath, 'file');

    sourceLinkFile.path = 'link.ts';
    sourceLinkFile.resolvedPath = sourceLinkPath;
    sourceLinkFile.byteSize = await byteSize(outsideSourcePath);
    sourceLinkFile.hash = await sha256File(outsideSourcePath);
    await writeFile(
      sourceLinkFixture.manifestPath,
      `${JSON.stringify(sourceLinkFixture.manifest, null, 2)}\n`,
      'utf-8'
    );

    const sourceLinkResult = await runCliWithExit([
      'verify',
      '--manifest',
      sourceLinkFixture.manifestPath,
    ]);

    expect(sourceLinkResult.exitCode).toBe(1);
    expect(sourceLinkResult.stderr).toContain('sourceFiles[0]: symbolic links are not allowed');
    expect(sourceLinkResult.stderr).not.toContain('hash mismatch');

    const outputLinkFixture = await generateSourceTruthDocsFixture(
      'llm-docs-source-truth-output-link-'
    );
    const outputLinkFile = outputLinkFixture.manifest.generatedOutputs.find(
      (output) => output.kind === 'source-truth-markdown'
    );

    if (outputLinkFile === undefined) {
      throw new Error('expected source-truth markdown output');
    }

    const outputPath = join(outputLinkFixture.outputDir, outputLinkFile.path);
    const outsideOutputPath = join(dirname(outputLinkFixture.outputDir), 'outside-output.md');
    const originalOutput = await readFile(outputPath, 'utf-8');

    await writeFile(outsideOutputPath, originalOutput, 'utf-8');
    await rm(outputPath, { force: true });
    await symlink(outsideOutputPath, outputPath, 'file');

    const outputLinkResult = await runCliWithExit([
      'verify',
      '--manifest',
      outputLinkFixture.manifestPath,
    ]);

    expect(outputLinkResult.exitCode).toBe(1);
    expect(outputLinkResult.stderr).toContain(
      `output ${outputLinkFile.path}: symbolic links are not allowed`
    );
    expect(outputLinkResult.stderr).not.toContain('hash mismatch');
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
          ...validConfiguredSdkManifestMetadata(),
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

  it('rejects invalid source docs generated output kinds before checking files', async () => {
    const { manifestPath, manifest } = await generateSourceDocsFixture();
    const outputFile = manifest.generatedOutputs[0];

    if (outputFile === undefined) {
      throw new Error('expected generated source docs fixture output file');
    }

    outputFile.kind = 'repo-source';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Checked files: 0');
    expect(result.stderr).toContain('kind must be llm-docs or semantic-chunks-jsonl');
  });

  it('rejects source docs manifests without source file format metadata', async () => {
    const { manifestPath, manifest } = await generateSourceDocsFixture();
    const sourceFile = manifest.sourceFiles[0] as
      | (Partial<SourceDocsManifest['sourceFiles'][number]> & Record<string, unknown>)
      | undefined;

    if (sourceFile === undefined) {
      throw new Error('expected generated source docs fixture source file');
    }

    delete sourceFile.format;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const result = await runCliWithExit(['verify', '--manifest', manifestPath]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Checked files: 0');
    expect(result.stderr).toContain('sourceFiles[0].format must be a non-empty string');
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
          ...validConfiguredSdkManifestMetadata(),
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
    expect(result.stderr).toContain('output[0].estimatedTokenCount must be a non-negative integer');
    expect(result.stderr).toContain('output[1].lineCount must be a non-negative integer');
    expect(result.stderr).toContain('output[1].estimatedTokenCount must be a non-negative integer');
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
