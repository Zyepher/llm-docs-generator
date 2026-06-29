#!/usr/bin/env node

/**
 * CLI Entry Point for llm-docs-generator
 *
 * Performance considerations:
 * - Lazy module loading (only load what's needed)
 * - Parallel SDK processing where possible
 * - Efficient error handling
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import packageJson from '../package.json';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, readFile, rm, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigLoader } from './config/loader.js';
import {
  DISCOVERY_REPORT_SCHEMA_VERSION,
  LOCAL_BOUNDED_INSPECTION_MODE,
  discoverLocalSource,
} from './core/discovery.js';
import { REPO_BOUNDED_INSPECTION_MODE, discoverRepo } from './core/repo-discovery.js';
import type { SourceDocsPresetMetadata } from './core/source-docs.js';
import { WEBSITE_BOUNDED_INSPECTION_MODE, discoverWebsite } from './core/website-discovery.js';
import { OpenRefParser } from './parsers/openref/parser.js';
import { LLMFormatter } from './core/formatter.js';
import {
  DISCOVERY_REPORT_MODE,
  MANIFEST_SCHEMA_VERSION,
  SOURCE_DOCS_SWIFT_BOOK_PRESET_LIMITATIONS,
  validateSourceDocsPresetContract,
  verifyGenerationManifest,
  writeDiscoveryReportManifest,
  writeGenerationManifest,
} from './core/manifest.js';
import { validateParserPluginManifestFile } from './core/parser-plugin-manifest.js';
import { SOURCE_VERIFICATION_MODE } from './core/source-verification.js';
import { fetchSpec } from './utils/fetcher.js';
import { isObjectRecord, isNonNegativeInteger } from './utils/guards.js';
import { sha256Hex } from './utils/hash.js';
import { Logger, LogLevel } from './utils/logger.js';

// ============================================================================
// CLI PROGRAM
// ============================================================================

const program = new Command();
const CLI_NAME = 'llm-docs';
const GENERATOR_NAME = packageJson.name;
const GENERATOR_VERSION = packageJson.version;
// Mode-aware `generate --output-dir` defaults. The legacy configured-SDK
// default writes to a Supabase-monorepo path; generic source generation must
// not inherit it (it escapes the CWD), so it defaults to a CWD-local dir.
const SDK_DEFAULT_OUTPUT_DIR = '../../public/llms-openref';
const SOURCE_DEFAULT_OUTPUT_DIR = './llm-docs';
const LEGACY_FORMATTER_FORMAT = 'legacy-llm-docs';
const CAPABILITIES_SCHEMA_VERSION = '0.1.0';
const AGENT_CONTEXT_SCHEMA_VERSION = '0.2.0';
const AGENT_DOCTOR_SCHEMA_VERSION = '0.1.0';
const EXPECTED_BINARY_NAME = 'llm-docs';
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIGURED_SDK_GENERATE_FORMATS = ['openref', 'openref-0.1'] as const;
const CONFIGURED_SDK_CANONICAL_MANIFEST_FORMAT = 'openref-0.1';
const SOURCE_GENERATE_FORMATS = [
  'auto',
  'markdown',
  'mdx',
  'openapi',
  'openref',
  'rst',
  'html',
] as const;
const BUILT_IN_SOURCE_GENERATE_FORMATS = new Set<string>(SOURCE_GENERATE_FORMATS);
const SOURCE_GENERATE_CHUNK_FORMATS = ['jsonl'] as const;
const SOURCE_GENERATE_PRESETS = ['swift-book'] as const;
const SWIFT_BOOK_PRESET_FORMATS = ['markdown'] as const;
const DISCOVERY_REPORT_FILE = 'discovery-report.json';
const DISCOVERY_MANIFEST_FILE = 'manifest.json';
const DISCOVERY_REPORT_OUTPUT_KIND = 'discovery-report';
const DISCOVERY_REPORT_MODES = new Set([
  LOCAL_BOUNDED_INSPECTION_MODE,
  REPO_BOUNDED_INSPECTION_MODE,
  WEBSITE_BOUNDED_INSPECTION_MODE,
]);
const DISCOVERY_MANIFEST_KINDS = new Set(['source', 'repo', 'url']);
type CliDiscoveryKind = 'source' | 'repo' | 'url';

const AGENT_CONTEXT_ARTIFACTS = [
  {
    id: 'agent-context',
    name: 'Agent Context',
    path: 'AGENT_CONTEXT.md',
    intendedUse:
      'Agent-facing product boundary, intent router, current capabilities, limitations, and workflow rules.',
  },
  {
    id: 'project-index',
    name: 'Project Index',
    path: 'index.md',
    intendedUse:
      'Navigation map for agents, humans, engineers, current CLI commands, and source files.',
  },
] as const;

const AGENT_SKILL_ARTIFACTS = [
  {
    id: 'llm-docs-generator',
    name: 'llm-docs-generator',
    path: 'skills/llm-docs-generator/SKILL.md',
    intendedUse:
      'Agent workflow for using and maintaining this CLI while preserving the deterministic CLI boundary.',
  },
  {
    id: 'repo-docs-discovery',
    name: 'repo-docs-discovery',
    path: 'skills/repo-docs-discovery/SKILL.md',
    intendedUse:
      'Agent workflow for investigating repo, website, package, or local docs targets before calling the CLI with explicit inputs.',
  },
] as const;

type AgentContextArtifact = {
  id: string;
  name: string;
  path: string;
  byteSize: number;
  sha256: string;
  intendedUse: string;
};

type AgentContextContract = {
  schemaVersion: string;
  mode: string;
  generator: {
    packageName: string;
    packageVersion: string;
    cliName: string;
    binary: string;
  };
  contextArtifacts: AgentContextArtifact[];
  skillArtifacts: AgentContextArtifact[];
  limitations: string[];
};

type AgentDoctorCheckStatus = 'pass' | 'warning' | 'fail' | 'skipped';

type AgentDoctorCheck = {
  id: string;
  name: string;
  status: AgentDoctorCheckStatus;
  summary: string;
  facts: Record<string, unknown>;
};

type AgentDoctorContract = {
  schemaVersion: string;
  mode: string;
  generator: AgentContextContract['generator'];
  summary: {
    overallStatus: AgentDoctorCheckStatus;
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
  checks: AgentDoctorCheck[];
  limitations: string[];
};

async function writeCliDiscoveryReportManifest(options: {
  discoveryKind: CliDiscoveryKind;
  reportPath: string;
  report: unknown;
}): Promise<string> {
  const manifestPath = resolve(dirname(options.reportPath), DISCOVERY_MANIFEST_FILE);

  try {
    await writeDiscoveryReportManifest({
      manifestPath,
      generator: {
        name: GENERATOR_NAME,
        version: GENERATOR_VERSION,
        cliName: CLI_NAME,
      },
      discoveryKind: options.discoveryKind,
      reportPath: options.reportPath,
      report: options.report,
    });
  } catch (error) {
    await removeJustWrittenDiscoveryReport(options.reportPath);
    throw error;
  }

  return manifestPath;
}

async function removeKnownDiscoveryArtifacts(outputDir: string): Promise<void> {
  const resolvedOutputDir = resolve(outputDir);

  await Promise.all([
    removeOwnedDiscoveryReportArtifact(resolve(resolvedOutputDir, DISCOVERY_REPORT_FILE)),
    removeOwnedDiscoveryManifestArtifact(resolve(resolvedOutputDir, DISCOVERY_MANIFEST_FILE)),
  ]);
}

async function removeOwnedDiscoveryReportArtifact(path: string): Promise<void> {
  await removeOwnedJsonFile(path, isDiscoveryReportArtifact);
}

async function removeOwnedDiscoveryManifestArtifact(path: string): Promise<void> {
  await removeOwnedJsonFile(path, isDiscoveryManifestArtifact);
}

async function removeOwnedJsonFile(
  path: string,
  isOwnedArtifact: (value: unknown) => boolean
): Promise<void> {
  try {
    const stats = await lstat(path);

    if (!stats.isFile()) {
      return;
    }
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return;
    }

    throw error;
  }

  let content: unknown;

  try {
    content = JSON.parse(await readFile(path, 'utf-8')) as unknown;
  } catch {
    return;
  }

  if (!isOwnedArtifact(content)) {
    return;
  }

  await rm(path, { force: true });
}

async function removeJustWrittenDiscoveryReport(path: string): Promise<void> {
  try {
    const stats = await lstat(path);

    if (stats.isDirectory()) {
      return;
    }
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return;
    }

    throw error;
  }

  await rm(path, { force: true });
}

function isDiscoveryReportArtifact(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }

  return (
    value.schemaVersion === DISCOVERY_REPORT_SCHEMA_VERSION &&
    typeof value.mode === 'string' &&
    DISCOVERY_REPORT_MODES.has(value.mode) &&
    Array.isArray(value.candidates) &&
    Array.isArray(value.warnings)
  );
}

function isDiscoveryManifestArtifact(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }

  const discovery = value.discovery;
  const generatedOutputs = value.generatedOutputs;

  if (!isObjectRecord(discovery) || !Array.isArray(generatedOutputs)) {
    return false;
  }

  const firstOutput = generatedOutputs[0];

  return (
    value.schemaVersion === MANIFEST_SCHEMA_VERSION &&
    value.mode === DISCOVERY_REPORT_MODE &&
    typeof discovery.kind === 'string' &&
    DISCOVERY_MANIFEST_KINDS.has(discovery.kind) &&
    typeof discovery.reportPath === 'string' &&
    discovery.reportPath.length > 0 &&
    discovery.reportSchemaVersion === DISCOVERY_REPORT_SCHEMA_VERSION &&
    typeof discovery.reportMode === 'string' &&
    DISCOVERY_REPORT_MODES.has(discovery.reportMode) &&
    isNonNegativeInteger(discovery.candidateCount) &&
    isNonNegativeInteger(discovery.warningCount) &&
    isObjectRecord(firstOutput) &&
    firstOutput.kind === DISCOVERY_REPORT_OUTPUT_KIND &&
    firstOutput.path === discovery.reportPath
  );
}

function isPathNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

const CAPABILITIES_CONTRACT = {
  schemaVersion: CAPABILITIES_SCHEMA_VERSION,
  generator: {
    packageName: GENERATOR_NAME,
    packageVersion: GENERATOR_VERSION,
    cliName: CLI_NAME,
    binary: EXPECTED_BINARY_NAME,
  },
  productBoundary: {
    cliRole: 'deterministic-scriptable-capability-layer',
    agentRole: 'intelligent-planner',
    sourceAuthority: 'agent-owned',
    taskFit: 'agent-owned',
    sourceSelection: 'agent-owned-explicit-decision',
    discoveryReports: 'candidate-evidence-not-source-selection',
    statement:
      'The CLI accepts explicit inputs and reports deterministic facts. The agent owns source authority, task fit, and selected source decisions.',
  },
  implemented: [
    {
      id: 'discover-source',
      command: 'discover',
      mode: 'discover --source',
      status: 'implemented',
      inputBoundary: 'explicit local file or directory',
      outputFiles: ['discovery-report.json', 'manifest.json'],
      summary:
        'bounded local source inspection with deterministic candidate file evidence, descriptive manifest contract metadata, content-free input provenance summary metadata, content-free artifact summary metadata, and a compact content-free candidate evidence manifest index',
      limitations: [
        'candidate evidence for agent review only',
        'input provenance summaries are content-free candidate-evidence metadata only',
        'artifact summaries are content-free manifest metadata only',
        'candidate evidence index is manifest metadata only',
        'no docs generation',
        'no source selection',
        'no trust scoring',
      ],
    },
    {
      id: 'discover-repo',
      command: 'discover',
      mode: 'discover --repo',
      status: 'implemented',
      inputBoundary: 'explicit git URL or explicit local git repository',
      options: ['--scope <path>', '--cache-dir <dir>', '--output-dir <dir>'],
      outputFiles: ['discovery-report.json', 'manifest.json'],
      summary:
        'bounded repository inspection with stable cache reuse, optional repo-relative scope, descriptive manifest contract metadata, content-free input provenance summary metadata, content-free artifact summary metadata, and a compact content-free candidate evidence manifest index',
      limitations: [
        'candidate evidence for agent review only',
        'input provenance summaries are content-free candidate-evidence metadata only',
        'artifact summaries are content-free manifest metadata only',
        'candidate evidence index is manifest metadata only',
        'no repo script execution',
        'no docs generation',
        'no source selection',
        'no trust scoring',
      ],
    },
    {
      id: 'discover-url',
      command: 'discover',
      mode: 'discover --url',
      status: 'implemented',
      inputBoundary: 'explicit http or https URL',
      outputFiles: ['discovery-report.json', 'manifest.json'],
      summary:
        'bounded static website inspection for the explicit URL plus same-origin /llms.txt and /sitemap.xml, recording explicit observed HTTP freshness validators, descriptive manifest contract metadata, content-free input provenance summary metadata, content-free artifact summary metadata, and a compact content-free candidate evidence manifest index',
      limitations: [
        'candidate evidence for agent review only',
        'input provenance summaries are content-free candidate-evidence metadata only',
        'artifact summaries are content-free manifest metadata only',
        'candidate evidence index is manifest metadata only',
        'observed HTTP freshness evidence is not freshness validation or remote refresh',
        'no linked candidate fetching',
        'no JavaScript rendering',
        'no broad crawling',
        'no source selection',
      ],
    },
    {
      id: 'source-truth-inspect',
      command: 'source-truth inspect',
      mode: 'source-truth inspect --source',
      status: 'implemented',
      inputBoundary: 'explicit local file or directory',
      outputFiles: ['stdout JSON evidence report'],
      factFamilies: [
        'export facts',
        'optional direct-declaration AST signatures',
        'package/config facts',
        'path/filename test/example context facts',
        'AST-observed test-case label context facts',
      ],
      summary: 'deterministic local evidence extraction for conservative observed facts',
      limitations: [
        'no behavior inference',
        'no assertion parsing',
        'no test body serialization',
        'test-case labels are not behavior or correctness proof',
        'no test execution',
        'no framework inference',
        'no route inference',
        'no re-export resolution',
        'local explicit sources only',
      ],
    },
    {
      id: 'source-truth-generate',
      command: 'source-truth generate',
      mode: 'source-truth generate --source --output-dir',
      status: 'implemented',
      inputBoundary: 'explicit local file or directory',
      outputFiles: ['source-truth-report.json', 'source-truth.md', 'manifest.json', 'failure.json'],
      factFamilies: [
        'export facts',
        'optional direct-declaration AST signatures',
        'package/config facts',
        'path/filename test/example context facts',
        'AST-observed test-case label context facts',
      ],
      summary:
        'evidence-bound Markdown and provenance files from source-truth inspection, with descriptive manifest contract metadata, content-free input provenance summary metadata, content-free artifact summary metadata, and deterministic content-free source-file line/token metadata in the manifest',
      limitations: [
        'input provenance summaries are content-free manifest metadata only',
        'manifest source-file line/token metadata is content-free text metadata, not behavior verification',
        'artifact summaries are content-free manifest metadata only',
        'no behavior inference',
        'no assertion parsing',
        'no test body serialization',
        'test-case labels are not behavior or correctness proof',
        'no test execution',
        'no framework inference',
        'no route inference',
        'no re-export resolution',
        'local explicit sources only',
      ],
    },
    {
      id: 'source-truth-verify-docs',
      command: 'source-truth verify-docs',
      mode: 'source-truth verify-docs --source --docs --output-dir',
      status: 'implemented',
      inputBoundary:
        'explicit local source file or directory plus explicit local Markdown/MDX docs file or directory',
      options: ['--source <path>', '--docs <path>', '--output-dir <dir>'],
      outputFiles: ['source-verification-report.json', 'manifest.json', 'failure.json'],
      factFamilies: [
        'source export facts from source-truth inspection',
        'docs inline-code identifier references',
        'exact lexical exported-name matches',
        'unmatched docs references',
      ],
      summary:
        'deterministic local evidence comparing explicit docs references with observed source exported names and emitting descriptive manifest contract metadata, content-free input provenance summary metadata, content-free artifact summary metadata, plus compact content-free source/docs file evidence index metadata',
      limitations: [
        'explicit local paths only',
        'Markdown/MDX-style text docs only',
        'input provenance summaries are content-free manifest metadata only',
        'file evidence index metadata is content-free and derived only from the local report',
        'artifact summaries are content-free manifest metadata only',
        'docs evidence limited to inline-code identifiers and empty call identifiers',
        'exact matches are lexical exported-name evidence only',
        'unmatched references are observations, not failures',
        'no behavior inference',
        'no assertion parsing',
        'no test execution',
        'no framework inference',
        'no route inference',
        'no re-export resolution beyond existing source-truth facts',
        'no automatic source selection',
      ],
    },
    {
      id: 'agent-context',
      command: 'agent context',
      mode: 'agent context --json',
      status: 'implemented',
      inputBoundary: 'packaged context and skill files only',
      outputFiles: ['stdout JSON metadata'],
      summary: 'read-only metadata for packaged agent context and skill artifacts',
      limitations: [
        'packaged context and skill metadata only',
        'does not install/register skills',
        'no user config writes',
        'no environment probing',
        'no network',
      ],
    },
    {
      id: 'agent-doctor',
      command: 'agent doctor',
      mode: 'agent doctor --json',
      status: 'implemented',
      inputBoundary: 'packaged artifacts and explicit process environment PATH only',
      options: ['--json'],
      outputFiles: ['stdout diagnostics', 'stdout JSON diagnostics'],
      summary:
        'read-only diagnostics for packaged context/skill artifact readability, expected binary metadata, PATH visibility, and skipped host-install checks',
      limitations: [
        'does not install/register skills',
        'does not write user config',
        'does not mutate host skill directories',
        'does not perform network access',
        'PATH check is informational and may warn in development',
        'host skill installation check is skipped unless a future explicit option is implemented',
        'no source-selection or task-fit inference',
      ],
    },
    {
      id: 'parser-plugin-manifest-validate',
      command: 'plugins validate',
      mode: 'plugins validate --manifest',
      status: 'implemented',
      inputBoundary: 'explicit local JSON parser plugin manifest file',
      options: ['--manifest <path>', '--json'],
      outputFiles: ['stdout validation result', 'stdout JSON validation result'],
      summary:
        'deterministic read-only validation of parser plugin manifest metadata without loading plugin modules',
      limitations: [
        'manifest validation only',
        'does not load, import, or execute plugin modules',
        'does not enable custom parser execution',
        'does not generate custom parsers',
        'does not select plugin manifests or sources',
        'no network',
        'no file writes',
      ],
    },
    {
      id: 'generate-source',
      command: 'generate',
      mode: 'generate --source',
      status: 'implemented',
      inputBoundary: 'explicit local file or directory',
      options: [
        '--source <path>',
        '--format auto|markdown|mdx|openapi|openref|rst|html',
        '--parser-plugin-manifest <path> with explicit custom --format <plugin-format-id>; directory sources require directorySupport: true',
        '--chunks jsonl',
        '--preset swift-book',
      ],
      outputFiles: ['manifest.json', 'llm-docs/*-llms.txt', 'chunks/semantic-chunks.jsonl'],
      summary:
        'deterministic local source parsing through the registered parser or an explicit local parser plugin and universal formatter, with descriptive manifest contract metadata, content-free input provenance summary metadata, content-free artifact summary metadata, opt-in semantic chunk JSONL export for built-in source generation, compact chunk manifest indexes, and a scoped swift-book preset',
      limitations: [
        'local files and directories only',
        'input provenance summaries are content-free manifest metadata only',
        'artifact summaries are content-free manifest metadata only',
        'no URL fetching',
        'no discovery report consumption',
        'no candidate auto-selection',
        'parser plugin generation requires --source <local-file-or-directory>, --parser-plugin-manifest <path>, and a custom explicit --format id',
        'parser plugin directory generation requires directorySupport: true on the selected manifest format',
        'parser plugin code is trusted local code executed for generation and is not sandboxed',
        'no parser plugin discovery, installation, package resolution, or auto-selection',
        'swift-book preset requires explicit --source and adds deterministic output defaults only',
        'no source selection decision',
        'semantic chunk JSONL is emitted only when --chunks jsonl is requested',
        'semantic chunk manifest indexes are source-docs JSONL metadata only',
      ],
    },
    {
      id: 'parser-plugin-execution',
      command: 'generate',
      mode: 'generate --source <local-file-or-directory> --parser-plugin-manifest <path> --format <plugin-format-id>',
      status: 'implemented',
      inputBoundary:
        'one explicit local source file or directory, one explicit local parser plugin manifest, and one explicit custom plugin format id',
      options: [
        '--source <local-file-or-directory>',
        '--parser-plugin-manifest <path>',
        '--format <id>',
      ],
      outputFiles: ['manifest.json', 'llm-docs/*-llms.txt'],
      summary:
        'explicit parser plugin execution through one declared local module, normalized through the universal formatter with descriptive manifest contract metadata, content-free input provenance summary metadata, content-free artifact summary metadata, and parser plugin provenance in the source-docs manifest',
      limitations: [
        'explicit local source files or directories only',
        'input provenance summaries are content-free manifest metadata only',
        'artifact summaries are content-free manifest metadata only',
        'directory sources require directorySupport: true on the selected manifest format',
        'requires a custom plugin format id declared by the manifest',
        'rejects built-in formats and --format auto',
        'no --chunks support with parser plugins',
        'no --preset support with parser plugins',
        'no parser plugin discovery or auto-selection',
        'no plugin installation or package resolution',
        'plugin code is trusted local code and is not sandboxed',
        'verify checks recorded plugin manifest metadata and hashes without importing plugin code',
        'no network added by the CLI',
      ],
    },
    {
      id: 'generate-preset-swift-book',
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
      summary:
        'deterministic Swift Programming Language output defaults over an explicit local source path',
      limitations: [
        'requires explicit --source',
        'local files and directories only',
        'Markdown parser only',
        'no TSPL.docc path inference',
        'no repo clone or cache',
        'preset generation itself does not refresh existing outputs',
        'no source-code verification',
        'no automatic source selection',
        'preset metadata does not select or verify source truth',
      ],
    },
    {
      id: 'generate-sdk',
      command: 'generate',
      mode: 'generate --sdk',
      status: 'implemented',
      inputBoundary: 'configured SDK manifest entry',
      options: ['--sdk <sdk>', '--sdk-version <version>', '--format openref|openref-0.1'],
      outputFiles: [
        'manifest.json',
        'parsed/<sdk>-<resolved-version>-spec.json',
        'llm-docs/*-llms.txt',
      ],
      summary:
        'configured OpenRef SDK generation through the existing compatibility flow with descriptive manifest contract metadata, content-free input provenance summary metadata, and content-free artifact summary metadata',
      limitations: [
        'configured SDKs only',
        'input provenance summaries are content-free manifest metadata only',
        'artifact summaries are content-free manifest metadata only',
        'no preset generation',
        'no discovery report consumption',
      ],
    },
    {
      id: 'verify-discovery-report',
      command: 'verify',
      mode: 'verify --manifest or verify --output-dir',
      status: 'implemented',
      inputBoundary: 'discovery-report manifest.json',
      summary:
        'file integrity, basic schema consistency, required V2 descriptive manifest contract validation, required V2 content-free input provenance summary validation, required V2 content-free artifact summary validation, required V2 content-free candidate evidence index checks, and optional refresh provenance validation for discovery report manifests',
      limitations: [
        'discovery-report manifest mode only',
        'candidate evidence for agent review only',
        'input provenance summaries are content-free and do not score or select candidates',
        'artifact summaries are content-free and do not score candidates',
        'candidate evidence indexes are content-free and do not score candidates',
        'no task fit decision',
        'no source selection',
        'verify itself does not refresh discovery reports',
        'verify does not refresh remote freshness evidence',
        'no source-code verification',
      ],
    },
    {
      id: 'verify-configured-sdk',
      command: 'verify',
      mode: 'verify --manifest or verify --output-dir',
      status: 'implemented',
      inputBoundary: 'configured-sdk manifest.json',
      outputFiles: ['stdout verification result'],
      summary:
        'recorded generator/sdk/parser/formatter metadata, required V2 descriptive manifest contract validation, required V2 content-free input provenance summary validation, required V2 content-free artifact summary validation, source file hash, byte-size, required content-free source line/token metadata, generated output hash, byte-size, required manifest-recorded output line/token verification, and optional refresh provenance validation for configured SDK manifests',
      limitations: [
        'configured-sdk manifest mode only',
        'only verifies existing source and generated output files recorded in the manifest',
        'input provenance summaries are content-free manifest metadata only',
        'artifact summaries are content-free manifest metadata only',
        'source line/token metadata is deterministic content-free text metadata only',
        'verify does not refresh configured SDK outputs',
        'no repo freshness check',
        'no source-code verification',
      ],
    },
    {
      id: 'verify-source-docs',
      command: 'verify',
      mode: 'verify --manifest or verify --output-dir',
      status: 'implemented',
      inputBoundary: 'local-source-docs manifest.json',
      outputFiles: ['stdout verification result'],
      summary:
        'recorded generator/parser/formatter metadata, required V2 descriptive manifest contract validation, required V2 content-free input provenance summary validation, required V2 content-free artifact summary validation, source path, source file hash, byte-size, line-count, estimated-token, generated output hash, byte-size, line-count, estimated-token, optional semantic chunk index verification, and optional refresh provenance validation for local source docs manifests',
      limitations: [
        'local-source-docs manifest mode only',
        'input provenance summaries are content-free manifest metadata only',
        'artifact summaries are content-free manifest metadata only',
        'verify does not refresh outputs',
        'no repo freshness check',
        'no source-code verification',
      ],
    },
    {
      id: 'verify-source-truth-docs',
      command: 'verify',
      mode: 'verify --manifest or verify --output-dir',
      status: 'implemented',
      inputBoundary: 'source-truth-local-docs manifest.json',
      outputFiles: ['stdout verification result'],
      summary:
        'deterministic integrity and schema consistency checks for source-truth docs manifests, including required V2 descriptive manifest contract validation, required V2 content-free input provenance summary validation, required V2 content-free artifact summary validation, required content-free source-file line/token metadata, and optional refresh provenance validation when present',
      limitations: [
        'source-truth-local-docs manifest mode only',
        'input provenance summaries are content-free manifest metadata only',
        'artifact summaries are content-free manifest metadata only',
        'source-file line/token metadata is content-free text metadata only',
        'local generated evidence docs only',
        'verify does not refresh outputs',
        'no repo freshness check',
        'no source-code verification',
        'no behavior inference',
      ],
    },
    {
      id: 'verify-source-verification',
      command: 'verify',
      mode: 'verify --manifest or verify --output-dir',
      status: 'implemented',
      inputBoundary: 'source-verification-local-evidence manifest.json',
      outputFiles: ['stdout verification result'],
      summary:
        'deterministic source-verification report integrity, provenance, report-path, manifest/report summary, report-body count, sourceInspection.source consistency, required V2 descriptive manifest contract validation, required V2 content-free input provenance summary validation, required V2 content-free artifact summary validation, required V2 content-free file evidence index checks, and optional refresh provenance validation',
      limitations: [
        'source-verification-local-evidence manifest mode only',
        'input provenance summaries are content-free manifest metadata only',
        'artifact summaries are content-free manifest metadata only',
        'file evidence indexes are source/docs file metadata only',
        'verify does not refresh outputs or sources',
        'no additional source/docs inspection',
        'no broad official-docs claim checking',
        'no source-code behavior validation',
        'no task-fit, source-truth, or source-selection decision',
        'no proof that docs statements are correct',
      ],
    },
    {
      id: 'refresh-source-docs',
      command: 'refresh',
      mode: 'refresh --manifest or refresh --output-dir for local-source-docs',
      status: 'implemented',
      inputBoundary:
        'existing built-in-parser local-source-docs manifest.json with recorded local source path',
      options: ['--manifest <path>', '--output-dir <dir>'],
      outputFiles: ['manifest.json', 'llm-docs/*-llms.txt', 'chunks/semantic-chunks.jsonl'],
      summary:
        'deterministic regeneration of built-in-parser local source docs from the manifest-recorded explicit local source path, preserving opt-in chunk JSONL and chunk index metadata when the prior manifest recorded that output, writing current content-free input provenance summary metadata and content-free artifact summary metadata, recording verified refresh provenance metadata, followed by manifest integrity verification of regenerated outputs',
      limitations: [
        'built-in-parser local-source-docs manifests only',
        'input provenance summaries are content-free manifest metadata only',
        'parser-plugin local-source-docs manifests are not refreshed; rerun explicit generate --source --parser-plugin-manifest --format',
        'uses only source.resolvedPath, source.formatHint, preset metadata, and prior chunk-output presence from the existing manifest',
        'no URLs',
        'no repo freshness check',
        'no crawling',
        'no source selection',
        'does not consume discovery reports',
        'no source-code verification',
        'no remote network work',
        'no source project script execution',
      ],
    },
    {
      id: 'refresh-source-truth-docs',
      command: 'refresh',
      mode: 'refresh --manifest or refresh --output-dir for source-truth-local-docs',
      status: 'implemented',
      inputBoundary:
        'existing source-truth-local-docs manifest.json with recorded local source path',
      options: ['--manifest <path>', '--output-dir <dir>'],
      outputFiles: ['source-truth-report.json', 'source-truth.md', 'manifest.json'],
      summary:
        'deterministic regeneration of source-truth docs and content-free source-file line/token manifest metadata plus content-free input provenance summary metadata and content-free artifact summary metadata from the manifest-recorded explicit local source path, recording verified refresh provenance metadata, followed by manifest integrity verification of regenerated outputs',
      limitations: [
        'source-truth-local-docs manifests only',
        'input provenance summaries are content-free manifest metadata only',
        'uses only source.resolvedPath from the existing manifest',
        'no URLs',
        'no repo freshness check',
        'no crawling',
        'no source selection',
        'does not consume discovery reports',
        'no source-code verification',
        'no remote network work',
        'no source project script execution',
        'no behavior inference',
      ],
    },
    {
      id: 'refresh-configured-sdk',
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
      summary:
        'deterministic regeneration of configured OpenRef SDK docs and content-free source spec line/token manifest metadata plus content-free input provenance summary metadata and content-free artifact summary metadata from the manifest-recorded absolute local spec path, recording verified refresh provenance metadata, followed by manifest integrity verification of regenerated outputs',
      limitations: [
        'configured-sdk manifests only',
        'input provenance summaries are content-free manifest metadata only',
        'requires source.resolvedSpecPath to be an absolute local non-symlink file outside the output directory',
        'uses only the recorded local spec path, SDK metadata, parser/formatter metadata, and manifest-recorded filename prefix',
        'OpenRef parser and legacy LLM formatter only',
        'no registry lookup',
        'no URL fetching',
        'no repo freshness check',
        'no crawling',
        'no source selection',
        'does not consume discovery reports',
        'no candidate report consumption',
        'no candidate auto-selection',
        'no source-code verification',
        'no remote network work',
        'no source project script execution',
      ],
    },
    {
      id: 'refresh-source-discovery-report',
      command: 'refresh',
      mode: 'refresh --manifest or refresh --output-dir for discovery-report source',
      status: 'implemented',
      inputBoundary:
        'existing discovery-report manifest.json with discovery.kind source and a local-bounded report source.resolvedPath',
      options: ['--manifest <path>', '--output-dir <dir>'],
      outputFiles: ['discovery-report.json', 'manifest.json'],
      summary:
        'deterministic rerun of local source discovery from discovery-report.json report.source.resolvedPath into the same output directory, preserving prior traversal bounds, writing current content-free input provenance summary metadata and content-free artifact summary metadata, recording verified refresh provenance metadata, and followed by manifest integrity verification',
      limitations: [
        'source discovery-report manifests only',
        'input provenance summaries are content-free candidate-evidence metadata only',
        'uses only report.source.resolvedPath and traversal.maxDepth/maxEntries/maxFiles from the existing local report',
        'candidate evidence for agent review only',
        'no docs generation',
        'no source selection',
        'repo discovery-report refresh is not supported',
        'URL discovery-report refresh is not supported',
        'no remote freshness refresh',
        'no repo cache update',
        'no broad crawling',
        'no candidate report consumption',
        'no candidate auto-selection',
        'no source-code verification',
        'no network access',
      ],
    },
    {
      id: 'refresh-source-verification-local-evidence',
      command: 'refresh',
      mode: 'refresh --manifest or refresh --output-dir for source-verification-local-evidence',
      status: 'implemented',
      inputBoundary:
        'existing successful source-verification-local-evidence manifest.json with a local source-verification-report.json',
      options: ['--manifest <path>', '--output-dir <dir>'],
      outputFiles: ['source-verification-report.json', 'manifest.json', 'failure.json'],
      summary:
        'deterministic rerun of explicit local source/docs lexical evidence from source-verification-report.json recorded source/docs paths into the same output directory, preserving prior docs traversal bounds, writing current content-free input provenance summary metadata and content-free artifact summary metadata, recording verified refresh provenance metadata, and followed by manifest integrity verification on success',
      limitations: [
        'source-verification-local-evidence manifests only',
        'input provenance summaries are content-free manifest metadata only',
        'uses only report.source.resolvedPath, report.docs.resolvedPath, and docs.traversal maxDepth/maxEntries/maxFiles/maxFileBytes from the existing local report',
        'explicit local paths only',
        'Markdown/MDX-style text docs only',
        'exact matches are lexical exported-name evidence only',
        'no broad official-docs claim checking',
        'no source-code behavior validation',
        'no freshness validation',
        'no remote refresh',
        'no repo cache update',
        'no crawling',
        'no source selection',
        'no candidate report consumption',
        'no candidate auto-selection',
        'no source-truth decision or proof that docs statements are correct',
        'no network access',
      ],
    },
    {
      id: 'list-sdks',
      command: 'list-sdks',
      mode: 'list-sdks',
      status: 'implemented',
      inputBoundary: 'configured SDK directory',
      outputFiles: ['stdout SDK list'],
      summary: 'list configured SDKs and versions',
      limitations: ['no source discovery', 'no generation'],
    },
    {
      id: 'validate-sdk',
      command: 'validate',
      mode: 'validate --sdk',
      status: 'implemented',
      inputBoundary: 'configured SDK manifest entry',
      outputFiles: ['stdout validation result'],
      summary: 'fetch and parse a configured SDK OpenRef spec',
      limitations: ['configured SDKs only', 'no docs generation'],
    },
  ],
  sourceTruth: {
    status: 'implemented-conservative-local-evidence',
    supportedFactFamilies: [
      'export facts',
      'optional direct-declaration AST signatures',
      'package/config facts',
      'path/filename test/example context facts',
      'AST-observed test-case label context facts',
    ],
    limitations: [
      'no behavior inference',
      'no assertion parsing',
      'no test body serialization',
      'test-case labels are not behavior or correctness proof',
      'no test execution',
      'no framework inference',
      'no route inference',
      'no re-export resolution',
      'local explicit sources only',
    ],
  },
  plannedUnsupported: [
    {
      id: 'generate-preset-additional',
      command: 'generate --preset <name> except swift-book',
      status: 'planned-unsupported',
      reason:
        'only --preset swift-book over an explicit local --source path is implemented; additional presets remain planned',
    },
    {
      id: 'refresh-unsupported-manifests',
      command:
        'refresh for parser-plugin source-docs, repo/URL discovery reports, URL, repo, website, freshness, broad verification, or source-code workflows',
      status: 'planned-unsupported',
      reason:
        'only explicit built-in-parser local-source-docs, source-truth-local-docs, configured-sdk manifests with recorded absolute local spec paths, local source discovery-report manifests, and source-verification-local-evidence manifests can be refreshed; parser-plugin source-docs, repo/URL discovery-report refresh, remote freshness refresh, broad crawling, broad official-docs behavior/API verification refresh, and source-code verification refresh remain planned',
    },
    {
      id: 'source-code-verification',
      command: 'broad source verification for official docs',
      status: 'planned-unsupported',
      reason:
        'broad official-docs behavior/API claim verification remains planned; implemented source-truth verify-docs is explicit-local lexical evidence only',
    },
    {
      id: 'broad-crawling',
      command: 'broad website crawling',
      status: 'planned-unsupported',
      reason:
        'website discovery is bounded to explicit URL plus fixed same-origin well-known resources',
    },
    {
      id: 'automatic-source-selection',
      command: 'automatic source selection',
      status: 'planned-unsupported',
      reason: 'agents review candidate evidence and explicitly choose sources',
    },
    {
      id: 'framework-route-understanding',
      command: 'framework or route understanding',
      status: 'planned-unsupported',
      reason: 'source-truth inspection does not infer framework identity or routes',
    },
    {
      id: 'behavior-level-code-docs',
      command: 'behavior-level generation from source code',
      status: 'planned-unsupported',
      reason:
        'source-truth generation is limited to observed export, signature, package/config, and path context facts',
    },
    {
      id: 'parser-plugin-broader-workflows',
      command:
        'parser plugin discovery, install, package resolution, auto-detection, sandboxing, and broad custom parser workflows',
      status: 'planned-unsupported',
      reason:
        'only explicit local parser plugin generation is implemented for one source file or a directory whose selected manifest format declares directorySupport: true; discovery, install, package resolution, auto-selection, sandboxing, and broad custom parser workflows remain planned/unsupported',
    },
    {
      id: 'agent-install-codex',
      command: 'agent install codex',
      status: 'planned-unsupported',
      reason:
        'no current CLI skill installer; installing/registering skills remains separate from packaged context metadata',
    },
  ],
} as const;

function resolvePackageLocalPath(packageRelativePath: string): string {
  const resolvedPath = resolve(PACKAGE_ROOT, packageRelativePath);
  const relativePath = relative(PACKAGE_ROOT, resolvedPath);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`context artifact path escapes package root: ${packageRelativePath}`);
  }

  return resolvedPath;
}

async function readPackagedAgentArtifact(
  artifact: (typeof AGENT_CONTEXT_ARTIFACTS)[number] | (typeof AGENT_SKILL_ARTIFACTS)[number]
): Promise<AgentContextArtifact> {
  const artifactPath = resolvePackageLocalPath(artifact.path);
  let content: Buffer;

  try {
    content = await readFile(artifactPath);
  } catch (error) {
    const errorCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'unknown';

    throw new Error(`packaged agent artifact unavailable (${errorCode}): ${artifact.path}`);
  }

  return {
    id: artifact.id,
    name: artifact.name,
    path: artifact.path,
    byteSize: content.byteLength,
    sha256: sha256Hex(content),
    intendedUse: artifact.intendedUse,
  };
}

async function buildAgentContextContract(): Promise<AgentContextContract> {
  return {
    schemaVersion: AGENT_CONTEXT_SCHEMA_VERSION,
    mode: 'agent-context-packaged-metadata',
    generator: {
      packageName: GENERATOR_NAME,
      packageVersion: GENERATOR_VERSION,
      cliName: CLI_NAME,
      binary: EXPECTED_BINARY_NAME,
    },
    contextArtifacts: await Promise.all(
      AGENT_CONTEXT_ARTIFACTS.map((artifact) => readPackagedAgentArtifact(artifact))
    ),
    skillArtifacts: await Promise.all(
      AGENT_SKILL_ARTIFACTS.map((artifact) => readPackagedAgentArtifact(artifact))
    ),
    limitations: [
      'Reports packaged context and skill metadata only.',
      'Does not install or register skills.',
      'Does not write user config.',
      'Does not probe environment state.',
      'Does not perform network access.',
    ],
  };
}

function readExpectedPackageBinaryEntry(): string {
  const metadata = packageJson as { bin?: unknown };

  if (!isObjectRecord(metadata.bin)) {
    throw new Error('malformed package metadata: bin map is missing');
  }

  const binaryPath = metadata.bin[EXPECTED_BINARY_NAME];

  if (typeof binaryPath !== 'string' || binaryPath.length === 0) {
    throw new Error(`malformed package metadata: expected ${EXPECTED_BINARY_NAME} bin entry`);
  }

  return binaryPath;
}

function getPathEnvironmentValue(): string {
  return process.env.PATH ?? process.env.Path ?? '';
}

function getExecutableCandidateNames(binary: string): string[] {
  if (process.platform !== 'win32') {
    return [binary];
  }

  const lowerBinary = binary.toLowerCase();
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);

  if (extensions.some((extension) => lowerBinary.endsWith(extension.toLowerCase()))) {
    return [binary];
  }

  return [binary, ...extensions.map((extension) => `${binary}${extension.toLowerCase()}`)];
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const fileStats = await stat(path);

    if (!fileStats.isFile()) {
      return false;
    }

    await access(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch (error) {
    if (isPathNotFoundError(error)) {
      return false;
    }

    return false;
  }
}

async function findExecutableOnPath(binary: string): Promise<{
  pathConfigured: boolean;
  pathEntryCount: number;
  found: boolean;
  matches: string[];
}> {
  const pathValue = getPathEnvironmentValue();
  const pathEntries = pathValue.length === 0 ? [] : pathValue.split(delimiter);
  const candidateNames = getExecutableCandidateNames(binary);
  const matches: string[] = [];
  const seen = new Set<string>();

  for (const pathEntry of pathEntries) {
    const basePath = resolve(pathEntry.length === 0 ? '.' : pathEntry);

    for (const candidateName of candidateNames) {
      const candidatePath = resolve(basePath, candidateName);

      if (seen.has(candidatePath)) {
        continue;
      }

      seen.add(candidatePath);

      if (await isExecutableFile(candidatePath)) {
        matches.push(candidatePath);
      }
    }
  }

  return {
    pathConfigured: pathValue.length > 0,
    pathEntryCount: pathEntries.length,
    found: matches.length > 0,
    matches,
  };
}

function summarizeDoctorChecks(
  checks: AgentDoctorCheck[],
  options: {
    packagedArtifactCount: number;
    contextArtifactCount: number;
    skillArtifactCount: number;
    pathBinaryFound: boolean;
  }
): AgentDoctorContract['summary'] {
  const passed = checks.filter((check) => check.status === 'pass').length;
  const warnings = checks.filter((check) => check.status === 'warning').length;
  const failed = checks.filter((check) => check.status === 'fail').length;
  const skipped = checks.filter((check) => check.status === 'skipped').length;
  const overallStatus: AgentDoctorCheckStatus =
    failed > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass';

  return {
    overallStatus,
    totalChecks: checks.length,
    passed,
    warnings,
    failed,
    skipped,
    hardFailureCount: failed,
    packagedArtifactCount: options.packagedArtifactCount,
    contextArtifactCount: options.contextArtifactCount,
    skillArtifactCount: options.skillArtifactCount,
    pathBinaryFound: options.pathBinaryFound,
  };
}

async function buildAgentDoctorContract(): Promise<AgentDoctorContract> {
  const context = await buildAgentContextContract();
  const packageBinEntry = readExpectedPackageBinaryEntry();
  const pathCheck = await findExecutableOnPath(EXPECTED_BINARY_NAME);
  const contextArtifactCount = context.contextArtifacts.length;
  const skillArtifactCount = context.skillArtifacts.length;
  const packagedArtifactCount = contextArtifactCount + skillArtifactCount;
  const checks: AgentDoctorCheck[] = [
    {
      id: 'packaged-agent-artifacts',
      name: 'Packaged agent artifacts',
      status: 'pass',
      summary: 'Packaged context and skill artifacts are readable and hashable.',
      facts: {
        contextArtifactCount,
        skillArtifactCount,
        artifacts: [...context.contextArtifacts, ...context.skillArtifacts],
      },
    },
    {
      id: 'expected-binary-name',
      name: 'Expected binary name',
      status: 'pass',
      summary: `Expected CLI binary name is ${EXPECTED_BINARY_NAME}.`,
      facts: {
        expectedBinary: EXPECTED_BINARY_NAME,
        packageBinEntry,
      },
    },
    {
      id: 'path-binary',
      name: 'PATH binary visibility',
      status: pathCheck.found ? 'pass' : 'warning',
      summary: pathCheck.found
        ? `${EXPECTED_BINARY_NAME} was found on PATH.`
        : `${EXPECTED_BINARY_NAME} was not found on PATH; this is a warning, not a hard failure.`,
      facts: {
        expectedBinary: EXPECTED_BINARY_NAME,
        pathConfigured: pathCheck.pathConfigured,
        pathEntryCount: pathCheck.pathEntryCount,
        found: pathCheck.found,
        matches: pathCheck.matches,
      },
    },
    {
      id: 'codex-skill-installation',
      name: 'Codex skill installation',
      status: 'skipped',
      summary:
        'No explicit Codex home or skill-installation location was provided; host skill installation was not checked.',
      facts: {
        checked: false,
        reason: 'not-configured',
      },
    },
  ];

  return {
    schemaVersion: AGENT_DOCTOR_SCHEMA_VERSION,
    mode: 'agent-doctor-read-only-diagnostics',
    generator: context.generator,
    summary: summarizeDoctorChecks(checks, {
      packagedArtifactCount,
      contextArtifactCount,
      skillArtifactCount,
      pathBinaryFound: pathCheck.found,
    }),
    checks,
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
  };
}

function resolvePlannedOutputVersion(
  sdkName: string,
  requestedVersion: string,
  config: ConfigLoader
): string {
  return config.resolveSDKVersion(sdkName, requestedVersion);
}

async function removeScopedManifest(outputDir: string): Promise<void> {
  await rm(`${outputDir}/manifest.json`, { force: true });
}

class GenerateRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerateRequestError';
  }
}

function failGenerateRequest(message: string): never {
  throw new GenerateRequestError(message);
}

function printGenerateRequestFailure(message: string): void {
  console.error(chalk.red(`Generate failed: ${message}`));
  console.error(
    chalk.yellow(
      'Supported generation modes: generate --source <local-file-or-directory> [--format auto|markdown|mdx|openapi|openref|rst|html] [--chunks jsonl] [--preset swift-book] --output-dir <dir>; generate --source <local-file-or-directory> --parser-plugin-manifest <path> --format <plugin-format-id> --output-dir <dir> (directories require selected format directorySupport: true); generate --sdk <sdk> [--sdk-version <version>] [--format openref|openref-0.1].'
    )
  );
  console.error(
    chalk.yellow(
      'Preset generation is limited to --preset swift-book with an explicit --source path; presets do not select sources.'
    )
  );
  console.error(
    chalk.yellow(
      'Discovery reports are candidate evidence for agent review; pass an explicit local source path to generate.'
    )
  );
}

function isRefreshManifestVerificationError(
  error: unknown
): error is Error & { checkedFiles: number; failures: string[] } {
  const candidate = error as Error & { checkedFiles?: unknown; failures?: unknown };

  return (
    error instanceof Error &&
    error.name === 'RefreshManifestVerificationError' &&
    typeof candidate.checkedFiles === 'number' &&
    Array.isArray(candidate.failures) &&
    candidate.failures.every((failure) => typeof failure === 'string')
  );
}

type GenerateMode = 'source' | 'configured-sdk';

interface ResolvedSourceGeneratePreset {
  format: string;
  output: {
    filenamePrefix: string;
    title: string;
    systemPrompt: string;
  };
  manifest: SourceDocsPresetMetadata;
}

function validateGenerateOptions(options: {
  sdk?: string;
  source?: string;
  format?: string;
  chunks?: string;
  preset?: string;
  parserPluginManifest?: string;
}): GenerateMode {
  if (
    options.parserPluginManifest !== undefined &&
    options.parserPluginManifest.trim().length === 0
  ) {
    failGenerateRequest('generate --parser-plugin-manifest requires a non-empty path.');
  }

  if (options.parserPluginManifest !== undefined && options.sdk !== undefined) {
    failGenerateRequest(
      'generate --parser-plugin-manifest is supported only with explicit --source and cannot be used with --sdk.'
    );
  }

  if (options.parserPluginManifest !== undefined && options.source === undefined) {
    failGenerateRequest(
      'generate --parser-plugin-manifest requires --source <explicit-local-file-or-directory>.'
    );
  }

  if (options.parserPluginManifest !== undefined && options.preset !== undefined) {
    failGenerateRequest('generate --parser-plugin-manifest cannot be combined with --preset.');
  }

  if (options.parserPluginManifest !== undefined && options.chunks !== undefined) {
    failGenerateRequest(
      'generate --parser-plugin-manifest cannot be combined with --chunks in this release.'
    );
  }

  if (options.parserPluginManifest !== undefined) {
    const normalizedFormat = options.format?.trim().toLowerCase();

    if (normalizedFormat === undefined || normalizedFormat.length === 0) {
      failGenerateRequest(
        'generate --parser-plugin-manifest requires explicit --format <plugin-format-id>.'
      );
    }

    if (BUILT_IN_SOURCE_GENERATE_FORMATS.has(normalizedFormat)) {
      failGenerateRequest(
        `generate --parser-plugin-manifest requires a custom plugin format id; '${normalizedFormat}' is a built-in source format.`
      );
    }
  }

  if (options.preset !== undefined && options.preset.trim().length === 0) {
    failGenerateRequest('generate --preset requires a non-empty preset name.');
  }

  if (options.preset !== undefined && options.sdk !== undefined) {
    failGenerateRequest(
      'generate --preset is supported only with explicit --source and cannot be used with --sdk.'
    );
  }

  if (options.source !== undefined && options.sdk !== undefined) {
    failGenerateRequest('generate --source and --sdk are mutually exclusive.');
  }

  if (options.preset !== undefined && options.source === undefined) {
    failGenerateRequest(
      `generate --preset ${options.preset.trim()} requires --source <explicit-local-docs-path>; presets do not select source paths.`
    );
  }

  if (options.source !== undefined) {
    if (options.format !== undefined && options.parserPluginManifest === undefined) {
      const normalizedFormat = options.format.trim().toLowerCase();

      if (
        !SOURCE_GENERATE_FORMATS.some((supportedFormat) => supportedFormat === normalizedFormat)
      ) {
        failGenerateRequest(
          `--format ${options.format} is not supported for generate --source; supported source formats are ${SOURCE_GENERATE_FORMATS.join(
            ', '
          )}.`
        );
      }
    }

    if (options.chunks !== undefined) {
      const normalizedChunks = options.chunks.trim().toLowerCase();

      if (
        !SOURCE_GENERATE_CHUNK_FORMATS.some(
          (supportedFormat) => supportedFormat === normalizedChunks
        )
      ) {
        failGenerateRequest(
          `--chunks ${options.chunks} is not supported for generate --source; supported chunk export formats are ${SOURCE_GENERATE_CHUNK_FORMATS.join(
            ', '
          )}.`
        );
      }
    }

    return 'source';
  }

  if (options.chunks !== undefined) {
    failGenerateRequest('generate --chunks is supported only for generate --source.');
  }

  if (options.format !== undefined) {
    const normalizedFormat = options.format.trim().toLowerCase();

    if (
      !CONFIGURED_SDK_GENERATE_FORMATS.some(
        (supportedFormat) => supportedFormat === normalizedFormat
      )
    ) {
      failGenerateRequest(
        `--format ${options.format} is not supported for configured generate --sdk; supported formats are ${CONFIGURED_SDK_GENERATE_FORMATS.join(
          ', '
        )}.`
      );
    }
  }

  if (options.sdk === undefined || options.sdk.trim().length === 0) {
    failGenerateRequest('generate requires exactly one of --source or --sdk.');
  }

  return 'configured-sdk';
}

function canonicalizeConfiguredSdkManifestFormat(format: string): string {
  const normalizedFormat = format.trim().toLowerCase();

  if (
    CONFIGURED_SDK_GENERATE_FORMATS.some((supportedFormat) => supportedFormat === normalizedFormat)
  ) {
    return CONFIGURED_SDK_CANONICAL_MANIFEST_FORMAT;
  }

  return format;
}

async function resolveSourceGeneratePreset(options: {
  preset?: string;
  format?: string;
  configDir: string;
}): Promise<ResolvedSourceGeneratePreset | undefined> {
  if (options.preset === undefined) {
    return undefined;
  }

  const presetName = options.preset.trim().toLowerCase();

  if (!SOURCE_GENERATE_PRESETS.some((supportedPreset) => supportedPreset === presetName)) {
    failGenerateRequest(
      `Unknown preset '${options.preset}'. Supported source-generation presets: ${SOURCE_GENERATE_PRESETS.join(
        ', '
      )}.`
    );
  }

  const explicitFormat = options.format?.trim().toLowerCase();

  if (
    explicitFormat !== undefined &&
    !SWIFT_BOOK_PRESET_FORMATS.some((supportedFormat) => supportedFormat === explicitFormat)
  ) {
    failGenerateRequest(
      `--format ${options.format} is not compatible with --preset ${presetName}; supported preset formats are ${SWIFT_BOOK_PRESET_FORMATS.join(
        ', '
      )}.`
    );
  }

  const config = new ConfigLoader(options.configDir);
  let loadedPreset: Awaited<ReturnType<ConfigLoader['loadPreset']>>;

  try {
    loadedPreset = await config.loadPreset(presetName);
  } catch (error) {
    failGenerateRequest(error instanceof Error ? error.message : String(error));
  }

  const presetFormat = loadedPreset.config.format.trim().toLowerCase();

  if (!SWIFT_BOOK_PRESET_FORMATS.some((supportedFormat) => supportedFormat === presetFormat)) {
    failGenerateRequest(
      `Preset '${presetName}' is configured with unsupported format '${loadedPreset.config.format}'; supported preset formats are ${SWIFT_BOOK_PRESET_FORMATS.join(
        ', '
      )}.`
    );
  }

  const presetManifest: SourceDocsPresetMetadata = {
    name: presetName,
    configPath: loadedPreset.configPath,
    displayName: loadedPreset.config.name,
    ...(loadedPreset.config.description === undefined
      ? {}
      : { description: loadedPreset.config.description }),
    defaults: {
      format: presetFormat,
      filenamePrefix: loadedPreset.config.output.filenamePrefix,
      title: loadedPreset.config.output.title,
      systemPrompt: loadedPreset.config.systemPrompt,
      ...(loadedPreset.config.output.formats === undefined
        ? {}
        : { outputFormats: loadedPreset.config.output.formats }),
    },
    ...(loadedPreset.config.manifest === undefined
      ? {}
      : { metadata: loadedPreset.config.manifest }),
    limitations: [...SOURCE_DOCS_SWIFT_BOOK_PRESET_LIMITATIONS],
  };
  const presetContractFailures = validateSourceDocsPresetContract(presetManifest);

  if (presetContractFailures.length > 0) {
    failGenerateRequest(
      `Preset '${presetName}' violates the non-authoritative source contract: ${presetContractFailures.join(
        '; '
      )}.`
    );
  }

  return {
    format: explicitFormat ?? presetFormat,
    output: {
      filenamePrefix: loadedPreset.config.output.filenamePrefix,
      title: loadedPreset.config.output.title,
      systemPrompt: loadedPreset.config.systemPrompt,
    },
    manifest: presetManifest,
  };
}

async function cleanupStaleSourceArtifactsForFailedSourceRequest(options: {
  source?: string;
  outputDir?: string;
  parserPluginManifest?: string;
}): Promise<void> {
  if (options.parserPluginManifest !== undefined) {
    return;
  }

  // A failed request may have no explicit --output-dir; clean the source-mode
  // default (the destination source generation would have used).
  const outputDir = options.outputDir ?? SOURCE_DEFAULT_OUTPUT_DIR;

  try {
    const { cleanupStaleSourceDocsArtifacts } = await import('./core/source-docs.js');

    await cleanupStaleSourceDocsArtifacts(
      outputDir,
      options.source === undefined ? {} : { protectedSourcePath: options.source }
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(
      chalk.yellow(`Warning: failed to clean stale source-mode artifacts: ${errorMsg}`)
    );
  }
}

program
  .name(CLI_NAME)
  .description(
    'Generate LLM-optimized documentation from explicit local sources and configured SDK specs'
  )
  .version(GENERATOR_VERSION)
  .enablePositionalOptions();

// ============================================================================
// CAPABILITIES COMMAND
// ============================================================================

program
  .command('capabilities')
  .description('Report implemented and planned CLI capabilities for agents')
  .option('--json', 'Print the deterministic machine-readable capabilities contract')
  .action((options: { json?: boolean }) => {
    if (options.json === true) {
      console.log(JSON.stringify(CAPABILITIES_CONTRACT, null, 2));
      return;
    }

    console.log(chalk.bold('llm-docs capabilities'));
    console.log(`  Schema: ${CAPABILITIES_SCHEMA_VERSION}`);
    console.log(`  Package: ${GENERATOR_NAME}@${GENERATOR_VERSION}`);
    console.log(`  Implemented modes: ${CAPABILITIES_CONTRACT.implemented.length}`);
    console.log(
      `  Planned or unsupported modes: ${CAPABILITIES_CONTRACT.plannedUnsupported.length}`
    );
    console.log('  Use --json for the stable agent contract.');
  });

// ============================================================================
// AGENT COMMAND
// ============================================================================

const agentCommand = program
  .command('agent')
  .description('Report read-only agent metadata packaged with this CLI');

agentCommand
  .command('context')
  .description('Report packaged read-only agent context metadata')
  .option('--json', 'Print deterministic machine-readable agent context metadata')
  .action(async (options: { json?: boolean }) => {
    try {
      const context = await buildAgentContextContract();

      if (options.json === true) {
        console.log(JSON.stringify(context, null, 2));
        return;
      }

      console.log(chalk.bold('llm-docs agent context'));
      console.log(`  Schema: ${context.schemaVersion}`);
      console.log(
        `  Package: ${context.generator.packageName}@${context.generator.packageVersion}`
      );
      console.log(`  Binary: ${context.generator.binary}`);
      console.log('  Context artifacts:');

      for (const artifact of context.contextArtifacts) {
        console.log(`  - ${artifact.name} (${artifact.id})`);
        console.log(`    Path: ${artifact.path}`);
        console.log(`    Size: ${artifact.byteSize} bytes`);
        console.log(`    SHA-256: ${artifact.sha256}`);
        console.log(`    Intended use: ${artifact.intendedUse}`);
      }

      console.log('  Packaged skills:');

      for (const artifact of context.skillArtifacts) {
        console.log(`  - ${artifact.name} (${artifact.id})`);
        console.log(`    Path: ${artifact.path}`);
        console.log(`    Size: ${artifact.byteSize} bytes`);
        console.log(`    SHA-256: ${artifact.sha256}`);
        console.log(`    Intended use: ${artifact.intendedUse}`);
      }

      console.log('  Limitations:');

      for (const limitation of context.limitations) {
        console.log(`  - ${limitation}`);
      }

      console.log('  Use --json for the stable agent metadata contract.');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Agent context failed: ${errorMsg}`));
      process.exit(1);
    }
  });

agentCommand
  .command('doctor')
  .description('Run read-only agent packaging and PATH diagnostics')
  .option('--json', 'Print deterministic machine-readable agent doctor diagnostics')
  .action(async (options: { json?: boolean }) => {
    try {
      const diagnostics = await buildAgentDoctorContract();
      const doctorFailed = diagnostics.summary.overallStatus === 'fail';

      if (options.json === true) {
        console.log(JSON.stringify(diagnostics, null, 2));
        if (doctorFailed) {
          process.exit(1);
        }
        return;
      }

      console.log(chalk.bold('llm-docs agent doctor'));
      console.log(`  Schema: ${diagnostics.schemaVersion}`);
      console.log(
        `  Package: ${diagnostics.generator.packageName}@${diagnostics.generator.packageVersion}`
      );
      console.log(`  Binary: ${diagnostics.generator.binary}`);
      console.log(`  Overall: ${diagnostics.summary.overallStatus}`);
      console.log(
        `  Checks: ${diagnostics.summary.passed} passed, ${diagnostics.summary.warnings} warning, ${diagnostics.summary.failed} failed, ${diagnostics.summary.skipped} skipped`
      );
      console.log(
        `  Packaged artifacts: ${diagnostics.summary.packagedArtifactCount} readable/hashable`
      );

      const pathCheck = diagnostics.checks.find((check) => check.id === 'path-binary');
      const pathFound = pathCheck?.facts.found === true;
      console.log(
        `  PATH ${EXPECTED_BINARY_NAME}: ${pathFound ? 'found' : 'not found (warning only)'}`
      );
      console.log('  Codex skill installation: skipped (not configured)');
      console.log('  Read-only: no installs, config writes, host mutations, or network access.');
      console.log('  Use --json for the stable diagnostics contract.');

      // Exit non-zero only on a hard failure (a missing PATH binary is a
      // warning and still exits 0). Currently no check reports 'fail', so this
      // is a forward-looking guard, not a behavior change.
      if (doctorFailed) {
        process.exit(1);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Agent doctor failed: ${errorMsg}`));
      process.exit(1);
    }
  });

// ============================================================================
// PLUGINS COMMAND
// ============================================================================

const pluginsCommand = program
  .command('plugins')
  .description('Validate explicit local parser plugin manifests');

pluginsCommand
  .command('validate')
  .description('Validate an explicit local parser plugin manifest without loading plugin code')
  .requiredOption('--manifest <path>', 'Path to a local parser plugin manifest JSON file')
  .option('--json', 'Print deterministic machine-readable validation result')
  .action(async (options: { manifest: string; json?: boolean }) => {
    const result = await validateParserPluginManifestFile({ manifestPath: options.manifest });

    if (options.json === true) {
      console.log(JSON.stringify(result, null, 2));

      if (!result.valid) {
        process.exit(1);
      }

      return;
    }

    console.log(chalk.bold('Parser plugin manifest validation'));
    console.log(`  Manifest: ${result.manifestPath}`);
    console.log(`  Result: ${result.valid ? 'passed' : 'failed'}`);

    if (result.valid && result.manifest !== undefined) {
      console.log(`  Name: ${result.manifest.name}`);
      console.log(`  Version: ${result.manifest.version}`);
      console.log(`  Module: ${result.manifest.module}`);
      console.log(`  Formats: ${result.manifest.formats.length}`);

      for (const format of result.manifest.formats) {
        console.log(
          `  - ${format.id}: ${format.displayName} (${format.extensions
            .map((extension) => `.${extension}`)
            .join(', ')})`
        );
      }

      console.log(
        '  Scope: validation only; plugin execution is available only through explicit generate --source --parser-plugin-manifest --format.'
      );
      return;
    }

    console.error(chalk.red(`  Errors: ${result.errors.length}`));

    for (const error of result.errors) {
      console.error(chalk.red(`  - ${error.path}: ${error.message}`));
    }

    process.exit(1);
  });

// ============================================================================
// SOURCE-TRUTH COMMAND
// ============================================================================

const sourceTruthCommand = program
  .command('source-truth')
  .description('Inspect explicit local source paths and generate bounded source evidence docs');

sourceTruthCommand
  .command('inspect')
  .description('Print deterministic JSON evidence for an explicit local source path')
  .requiredOption('--source <path>', 'Explicit local file or directory to inspect')
  .action(async (options: { source: string }) => {
    try {
      const { inspectSourceTruth } = await import('./core/source-truth.js');
      const report = await inspectSourceTruth({ source: options.source });

      console.log(`${JSON.stringify(report, null, 2)}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Source-truth inspection failed: ${errorMsg}`));
      process.exit(1);
    }
  });

sourceTruthCommand
  .command('generate')
  .description('Generate evidence-bound Markdown docs from an explicit local source path')
  .requiredOption('--source <path>', 'Explicit local file or directory to inspect')
  .requiredOption('--output-dir <dir>', 'Directory for source-truth output files')
  .action(async (options: { source: string; outputDir: string }) => {
    try {
      const { generateSourceTruthDocs } = await import('./core/source-truth-docs.js');
      const result = await generateSourceTruthDocs({
        source: options.source,
        outputDir: options.outputDir,
      });

      console.log(chalk.bold('Source-truth docs generated'));
      console.log(`  Source: ${result.report.source.resolvedPath}`);
      console.log(`  Export facts: ${result.report.facts.length}`);
      console.log(`  Package/config facts: ${result.report.configFacts.length}`);
      console.log(`  Context facts: ${result.report.contextFacts.length}`);
      console.log(`  Output: ${chalk.cyan(result.outputDir)}`);
      console.log(`  Markdown: ${chalk.cyan(result.markdownPath)}`);
      console.log(`  Manifest: ${chalk.cyan(result.manifestPath)}`);
    } catch (error) {
      const { SourceTruthDocsNoFactsError } = await import('./core/source-truth-docs.js');
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (error instanceof SourceTruthDocsNoFactsError) {
        console.error(chalk.red(`Source-truth generation failed: ${errorMsg}`));
        console.error(chalk.yellow(`Failure report: ${error.failurePath}`));
        console.error(chalk.yellow(`Evidence report: ${error.reportPath}`));
      } else {
        console.error(chalk.red(`Source-truth generation failed: ${errorMsg}`));
      }

      process.exit(1);
    }
  });

sourceTruthCommand
  .command('verify-docs')
  .description('Compare explicit local docs references with observed local source export facts')
  .requiredOption('--source <path>', 'Explicit local source file or directory to inspect')
  .requiredOption('--docs <path>', 'Explicit local Markdown/MDX docs file or directory to inspect')
  .requiredOption('--output-dir <dir>', 'Directory for source-verification evidence files')
  .action(async (options: { source: string; docs: string; outputDir: string }) => {
    try {
      const { verifyDocsAgainstSource } = await import('./core/source-verification.js');
      const result = await verifyDocsAgainstSource({
        source: options.source,
        docs: options.docs,
        outputDir: options.outputDir,
        generator: {
          name: GENERATOR_NAME,
          version: GENERATOR_VERSION,
          cliName: CLI_NAME,
        },
      });

      console.log(chalk.bold('Local source/docs evidence generated'));
      console.log(`  Source: ${result.report.source.resolvedPath}`);
      console.log(`  Docs: ${result.report.docs.resolvedPath}`);
      console.log(`  Docs references: ${result.report.summary.docsReferenceCount}`);
      console.log(`  Exact export matches: ${result.report.summary.exactMatchCount}`);
      console.log(`  Unmatched references: ${result.report.summary.unmatchedReferenceCount}`);
      console.log(`  Output: ${chalk.cyan(result.outputDir)}`);
      console.log(`  Report: ${chalk.cyan(result.reportPath)}`);
      console.log(`  Manifest: ${chalk.cyan(result.manifestPath)}`);
    } catch (error) {
      const { SourceVerificationNoDocsEvidenceError } = await import(
        './core/source-verification.js'
      );
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (error instanceof SourceVerificationNoDocsEvidenceError) {
        console.error(chalk.red(`Local source/docs evidence failed: ${errorMsg}`));
        console.error(chalk.yellow(`Failure report: ${error.failurePath}`));
        console.error(chalk.yellow(`Evidence report: ${error.reportPath}`));
      } else {
        console.error(chalk.red(`Local source/docs evidence failed: ${errorMsg}`));
      }

      process.exit(1);
    }
  });

// ============================================================================
// DISCOVER COMMAND
// ============================================================================

program
  .command('discover')
  .description('Write a bounded discovery report for an explicit local source, repo, or URL')
  .option('--source <path>', 'Explicit local file or directory to inspect')
  .option(
    '--repo <git-url-or-local-git-repo>',
    'Explicit git URL or local git repository to inspect'
  )
  .option('--url <http-or-https-url>', 'Explicit HTTP(S) URL to inspect')
  .option('--scope <path>', 'Repo-relative path to inspect in repo mode')
  .option('--cache-dir <dir>', 'Directory for cached repo clones')
  .option('--output-dir <dir>', 'Directory for discovery-report.json and manifest.json')
  .option(
    '--allow-private-hosts',
    'In --url mode, permit private/link-local/metadata IP targets (SSRF guard is on by default)',
    false
  )
  .action(
    async (options: {
      source?: string;
      repo?: string;
      url?: string;
      scope?: string;
      cacheDir?: string;
      outputDir?: string;
      allowPrivateHosts?: boolean;
    }) => {
      try {
        const inputCount =
          (options.source === undefined ? 0 : 1) +
          (options.repo === undefined ? 0 : 1) +
          (options.url === undefined ? 0 : 1);

        if (inputCount !== 1) {
          throw new Error('discover requires exactly one of --source, --repo, or --url.');
        }

        if (options.source !== undefined) {
          if (options.scope !== undefined || options.cacheDir !== undefined) {
            throw new Error('discover --scope and --cache-dir are only supported with --repo.');
          }

          if (options.outputDir !== undefined) {
            await removeKnownDiscoveryArtifacts(options.outputDir);
          }

          const report = await discoverLocalSource(
            options.outputDir === undefined
              ? { source: options.source }
              : { source: options.source, outputDir: options.outputDir }
          );
          const manifestPath = await writeCliDiscoveryReportManifest({
            discoveryKind: 'source',
            reportPath: report.output.reportPath,
            report,
          });

          console.log(chalk.bold('Local source discovery'));
          console.log(`  Source: ${report.source.resolvedPath}`);
          console.log(`  Type: ${report.source.type}`);
          console.log(`  Candidate files: ${report.candidates.length}`);
          console.log(`  Warnings: ${report.warnings.length}`);
          console.log(`  Report: ${chalk.cyan(report.output.reportPath)}`);
          console.log(`  Manifest: ${chalk.cyan(manifestPath)}`);

          return;
        }

        if (options.url !== undefined) {
          if (options.scope !== undefined || options.cacheDir !== undefined) {
            throw new Error('discover --scope and --cache-dir are only supported with --repo.');
          }

          if (options.outputDir !== undefined) {
            await removeKnownDiscoveryArtifacts(options.outputDir);
          }

          const websiteOptions: Parameters<typeof discoverWebsite>[0] = { url: options.url };
          if (options.outputDir !== undefined) {
            websiteOptions.outputDir = options.outputDir;
          }
          if (options.allowPrivateHosts === true) {
            websiteOptions.allowPrivateHosts = true;
          }

          const { report } = await discoverWebsite(websiteOptions);
          const manifestPath = await writeCliDiscoveryReportManifest({
            discoveryKind: 'url',
            reportPath: report.output.reportPath,
            report,
          });

          console.log(chalk.bold('Website discovery'));
          console.log(`  URL: ${report.website.normalizedUrl}`);
          console.log(`  Resources inspected: ${report.inspectedResources.length}`);
          console.log(`  Candidate URLs: ${report.candidates.length}`);
          console.log(`  Warnings: ${report.warnings.length}`);
          console.log(`  Report: ${chalk.cyan(report.output.reportPath)}`);
          console.log(`  Manifest: ${chalk.cyan(manifestPath)}`);

          for (const warning of report.warnings) {
            console.error(chalk.yellow(`Warning: ${warning}`));
          }

          return;
        }

        const repoInput = options.repo;

        if (repoInput === undefined) {
          throw new Error('discover requires --repo.');
        }

        const repoOptions: Parameters<typeof discoverRepo>[0] = { repo: repoInput };

        if (options.scope !== undefined) {
          repoOptions.scope = options.scope;
        }

        if (options.cacheDir !== undefined) {
          repoOptions.cacheDir = options.cacheDir;
        }

        if (options.outputDir !== undefined) {
          await removeKnownDiscoveryArtifacts(options.outputDir);
          repoOptions.outputDir = options.outputDir;
        }

        const { report } = await discoverRepo(repoOptions);
        const manifestPath = await writeCliDiscoveryReportManifest({
          discoveryKind: 'repo',
          reportPath: report.output.reportPath,
          report,
        });

        console.log(chalk.bold('Repo discovery'));
        console.log(`  Repo: ${report.repo.normalizedInput}`);
        console.log(`  Cache: ${report.repo.cachePath}`);
        console.log(`  Scope: ${report.scope.path}`);
        console.log(`  Commit: ${report.repo.git.commit ?? 'unknown'}`);
        console.log(
          `  Dirty: ${report.repo.git.dirty === null ? 'unknown' : String(report.repo.git.dirty)}`
        );
        console.log(`  Candidate files: ${report.candidates.length}`);
        console.log(`  Warnings: ${report.warnings.length}`);
        console.log(`  Report: ${chalk.cyan(report.output.reportPath)}`);
        console.log(`  Manifest: ${chalk.cyan(manifestPath)}`);

        for (const warning of report.warnings) {
          console.error(chalk.yellow(`Warning: ${warning}`));
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Discovery failed: ${errorMsg}`));
        process.exit(1);
      }
    }
  );

// ============================================================================
// GENERATE COMMAND
// ============================================================================

program
  .command('generate')
  .description('Generate LLM documentation from an explicit local source or configured SDK')
  .option('--sdk <sdk>', 'SDK to generate (or "all" for all SDKs)')
  .option('--source <path>', 'Explicit local file or directory to parse and format')
  .option(
    '--format <format>',
    'Source parser hint: auto, markdown, mdx, openapi, openref, rst, html; explicit parser plugin format id; SDK guard: openref or openref-0.1'
  )
  .option('--chunks <format>', 'Source-only semantic chunk export: jsonl')
  .option(
    '--parser-plugin-manifest <path>',
    'Explicit local parser plugin manifest for file or opted-in directory source generation'
  )
  .option('--preset <name>', 'Source-only deterministic preset: swift-book')
  .option('--sdk-version <version>', 'Version to generate (or "all" for all versions)', 'latest')
  .option('--config-dir <dir>', 'Configuration directory', 'config')
  .option(
    '--output-dir <dir>',
    'Output directory (defaults to ./llm-docs for --source, ../../public/llms-openref for --sdk)'
  )
  .option('-v, --verbose', 'Enable verbose logging', false)
  .option('--force', 'Force re-download specs (ignore cache)', false)
  .action(
    async (options: {
      sdk?: string;
      source?: string;
      format?: string;
      chunks?: string;
      parserPluginManifest?: string;
      preset?: string;
      sdkVersion: string;
      configDir: string;
      outputDir?: string;
      verbose: boolean;
      force: boolean;
    }) => {
      let generateMode: GenerateMode;

      try {
        generateMode = validateGenerateOptions(options);
      } catch (error) {
        if (error instanceof GenerateRequestError) {
          await cleanupStaleSourceArtifactsForFailedSourceRequest(options);
          printGenerateRequestFailure(error.message);
          process.exit(1);
        }

        throw error;
      }

      // Apply a mode-aware default so generic `generate --source` no longer
      // inherits the Supabase-monorepo default (../../public/llms-openref), which
      // resolves two directories ABOVE the CWD and is then mkdir'd + cleared.
      const resolvedOutputDir =
        options.outputDir ??
        (generateMode === 'source' ? SOURCE_DEFAULT_OUTPUT_DIR : SDK_DEFAULT_OUTPUT_DIR);

      if (generateMode === 'source') {
        try {
          const sourcePreset = await resolveSourceGeneratePreset(options);
          const { generateSourceDocs } = await import('./core/source-docs.js');
          const sourceDocsOptions: Parameters<typeof generateSourceDocs>[0] = {
            source: options.source ?? '',
            outputDir: resolvedOutputDir,
            generator: {
              name: GENERATOR_NAME,
              version: GENERATOR_VERSION,
              cliName: CLI_NAME,
            },
          };

          if (sourcePreset !== undefined) {
            sourceDocsOptions.format = sourcePreset.format;
            sourceDocsOptions.output = sourcePreset.output;
            sourceDocsOptions.preset = sourcePreset.manifest;
          } else if (options.format !== undefined) {
            sourceDocsOptions.format = options.format;
          }
          if (options.chunks !== undefined) {
            sourceDocsOptions.chunks = options.chunks;
          }
          if (options.parserPluginManifest !== undefined) {
            sourceDocsOptions.parserPluginManifest = options.parserPluginManifest;
          }

          const result = await generateSourceDocs(sourceDocsOptions);
          const chunkOutput = result.manifest.generatedOutputs.find(
            (output) => output.kind === 'semantic-chunks-jsonl'
          );
          const parserPlugin = result.manifest.parser.plugin;

          console.log(chalk.bold('Local source docs generated'));
          console.log(`  Source: ${result.manifest.source.resolvedPath}`);
          console.log(`  Type: ${result.manifest.source.type}`);
          console.log(`  Format: ${result.manifest.source.resolvedFormat}`);
          if (parserPlugin !== undefined) {
            console.log(`  Parser plugin: ${parserPlugin.name} ${parserPlugin.version}`);
          }
          if (result.manifest.preset !== undefined) {
            console.log(`  Preset: ${result.manifest.preset.name}`);
          }
          console.log(`  Source files: ${result.manifest.sourceFiles.length}`);
          console.log(`  Generated files: ${result.manifest.generatedOutputs.length}`);
          if (chunkOutput !== undefined) {
            console.log(`  Chunk export: ${chalk.cyan(chunkOutput.path)}`);
          }
          console.log(`  Output: ${chalk.cyan(result.outputDir)}`);
          console.log(`  Manifest: ${chalk.cyan(result.manifestPath)}`);
        } catch (error) {
          if (error instanceof GenerateRequestError) {
            await cleanupStaleSourceArtifactsForFailedSourceRequest(options);
            printGenerateRequestFailure(error.message);
            process.exit(1);
          }

          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(chalk.red(`Generate failed: ${errorMsg}`));
          process.exit(1);
        }

        return;
      }

      // Set log level
      Logger.setLevel(options.verbose ? LogLevel.DEBUG : LogLevel.INFO);

      console.log(chalk.bold.blue('\nLLM Documentation Generator\n'));

      try {
        // Load configuration
        const config = new ConfigLoader(options.configDir);
        await config.load();

        // Determine which SDKs to process
        const availableSDKs = config.getAllSDKs();
        const requestedSdk = options.sdk ?? '';
        const sdksToProcess = requestedSdk === 'all' ? availableSDKs : [requestedSdk];

        // Validate SDK names
        for (const sdkName of sdksToProcess) {
          if (!config.hasSDK(sdkName)) {
            console.error(chalk.red(`\nError: SDK '${sdkName}' not found`));
            console.log(`Available SDKs: ${availableSDKs.join(', ')}`);
            process.exit(1);
          }
        }

        // Build list of (sdk, version) pairs to process
        const tasks: Array<[string, string]> = [];

        for (const sdkName of sdksToProcess) {
          if (options.sdkVersion === 'all') {
            const versions = config.getSDKVersions(sdkName);
            for (const ver of versions) {
              tasks.push([sdkName, ver]);
            }
          } else {
            tasks.push([sdkName, options.sdkVersion]);
          }
        }

        console.log(chalk.cyan(`Processing ${tasks.length} SDK/version pair(s)...\n`));

        // Process each SDK/version combination
        let successCount = 0;
        let failureCount = 0;

        for (const [sdkName, ver] of tasks) {
          const spinner = ora(`Processing ${sdkName} ${ver}...`).start();

          try {
            const plannedVersion = resolvePlannedOutputVersion(sdkName, ver, config);
            const plannedOutputDir = `${resolvedOutputDir}/${sdkName}/${plannedVersion}`;
            await removeScopedManifest(plannedOutputDir);

            // Fetch spec (uses cache by default) - returns [specPath, resolvedVersion]
            const [specPath, resolvedVersion] = await fetchSpec(
              sdkName,
              ver,
              config,
              options.force
            );
            const resolvedSpecPath = resolve(specPath);
            const versionConfig = config.getSDKVersionConfig(sdkName, resolvedVersion);
            const manifestSpecFormat = canonicalizeConfiguredSdkManifestFormat(
              versionConfig.spec.format
            );

            // Parse spec
            const parser = new OpenRefParser(specPath);
            const parsedData = await parser.parse();

            // Save parsed JSON using resolved version
            const outputDir = `${resolvedOutputDir}/${sdkName}/${resolvedVersion}`;
            const parsedSpecPath = `${outputDir}/parsed/${sdkName}-${resolvedVersion}-spec.json`;
            await parser.saveJSON(parsedData, parsedSpecPath);

            // Format for LLM using resolved version
            const formatter = new LLMFormatter(
              parsedData,
              config,
              sdkName,
              resolvedVersion,
              specPath
            );
            const llmOutputPaths = await formatter.generateAll(outputDir);

            await writeGenerationManifest({
              manifestPath: `${outputDir}/manifest.json`,
              generatedAt: new Date(),
              generator: {
                name: GENERATOR_NAME,
                version: GENERATOR_VERSION,
                cliName: CLI_NAME,
              },
              sdk: {
                name: sdkName,
                resolvedVersion,
                displayName: versionConfig.displayName,
              },
              source: {
                configuredUrl: versionConfig.spec.url,
                configuredLocalPath: versionConfig.spec.localPath,
                resolvedSpecPath,
                format: manifestSpecFormat,
              },
              parser: {
                name: 'OpenRefParser',
                version: GENERATOR_VERSION,
                format: manifestSpecFormat,
              },
              formatter: {
                name: 'LLMFormatter',
                version: GENERATOR_VERSION,
                format: LEGACY_FORMATTER_FORMAT,
              },
              generatedOutputs: [
                { path: parsedSpecPath, kind: 'parsed-spec-json' },
                ...llmOutputPaths.map((path) => ({ path, kind: 'llm-docs' as const })),
              ],
              warnings: [],
            });

            spinner.succeed(chalk.green(`Completed ${sdkName} ${resolvedVersion}`));
            successCount++;
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            spinner.fail(chalk.red(`Failed ${sdkName} ${ver}: ${errorMsg}`));
            failureCount++;

            if (options.verbose && error instanceof Error && error.stack !== undefined) {
              console.error(chalk.gray(error.stack));
            }
          }
        }

        // Summary
        console.log(chalk.bold.green("\nGeneration complete!"));
        console.log(`  Successful: ${successCount}`);
        if (failureCount > 0) {
          console.log(chalk.red(`  Failed: ${failureCount}`));
        }
        console.log(`\nOutput location: ${chalk.cyan(resolvedOutputDir)}`);

        process.exit(failureCount > 0 ? 1 : 0);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(chalk.bold.red(`\nFatal error: ${errorMsg}`));

        if (options.verbose && error instanceof Error && error.stack !== undefined) {
          console.error(chalk.gray(error.stack));
        }

        process.exit(1);
      }
    }
  );

// ============================================================================
// REFRESH COMMAND
// ============================================================================

program
  .command('refresh')
  .description(
    'Refresh supported explicit local manifests, including local source discovery and source/docs evidence reports'
  )
  .option('--manifest <path>', 'Path to manifest.json')
  .option('--output-dir <dir>', 'Output directory containing manifest.json')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (options: { manifest?: string; outputDir?: string; verbose: boolean }) => {
    const manifestOptionCount =
      (options.manifest === undefined ? 0 : 1) + (options.outputDir === undefined ? 0 : 1);

    if (manifestOptionCount !== 1) {
      console.error(chalk.red('Error: provide exactly one of --manifest or --output-dir'));
      process.exit(1);
    }

    const manifestPath =
      options.manifest === undefined ? `${options.outputDir}/manifest.json` : options.manifest;

    try {
      const { refreshGenerationManifest } = await import('./core/refresh.js');
      const result = await refreshGenerationManifest({
        manifestPath,
        generator: {
          name: GENERATOR_NAME,
          version: GENERATOR_VERSION,
          cliName: CLI_NAME,
        },
      });

      console.log(chalk.bold('Manifest refresh'));
      console.log(`  Mode: ${result.mode}`);
      console.log(`  Source: ${result.sourcePath}`);
      if (result.presetName !== undefined) {
        console.log(`  Preset: ${result.presetName}`);
      }
      if (result.mode === DISCOVERY_REPORT_MODE) {
        console.log("  Candidate evidence report: refreshed");
        console.log(`  Candidate files: ${result.candidateCount ?? 0}`);
        if (result.reportPath !== undefined) {
          console.log(`  Report: ${chalk.cyan(result.reportPath)}`);
        }
        console.log('  Scope: candidate evidence only; no source selection or generation');
      } else if (result.mode === SOURCE_VERIFICATION_MODE) {
        if (result.docsPath !== undefined) {
          console.log(`  Docs: ${result.docsPath}`);
        }
        console.log("  Local source/docs evidence: refreshed");
        console.log(`  Source files: ${result.sourceFiles}`);
        console.log(`  Evidence files: ${result.generatedOutputs}`);
        console.log(`  Docs references: ${result.docsReferences ?? 0}`);
        console.log(`  Exact export matches: ${result.exactMatches ?? 0}`);
        console.log(`  Unmatched references: ${result.unmatchedReferences ?? 0}`);
        if (result.reportPath !== undefined) {
          console.log(`  Report: ${chalk.cyan(result.reportPath)}`);
        }
        console.log(
          '  Scope: explicit local lexical evidence only; no broad claim verification or source-truth proof'
        );
      } else {
        console.log(`  Source files: ${result.sourceFiles}`);
        console.log(`  Generated files: ${result.generatedOutputs}`);
      }
      if (result.chunkOutputPath !== undefined) {
        console.log(`  Chunk export: ${chalk.cyan(result.chunkOutputPath)}`);
      }
      console.log(`  Output: ${chalk.cyan(result.outputDir)}`);
      console.log(`  Manifest: ${chalk.cyan(result.manifestPath)}`);
      console.log('  Refresh provenance: recorded');
      console.log(`  Post-refresh verification: ${result.postRefreshVerification.status}`);
      console.log(`  Checked files: ${result.postRefreshVerification.checkedFiles}`);
      console.log(chalk.green('Refresh complete'));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Refresh failed: ${errorMsg}`));

      if (isRefreshManifestVerificationError(error)) {
        console.error(chalk.red(`  Checked files: ${error.checkedFiles}`));
        for (const failure of error.failures) {
          console.error(chalk.red(`  - ${failure}`));
        }
      }

      if (options.verbose && error instanceof Error && error.stack !== undefined) {
        console.error(chalk.gray(error.stack));
      }

      process.exit(1);
    }
  });

// ============================================================================
// VERIFY COMMAND
// ============================================================================

program
  .command('verify')
  .description(
    'Verify an existing configured SDK, local source docs, source-truth docs, discovery report, or source-verification manifest by recorded metadata'
  )
  .option('--manifest <path>', 'Path to manifest.json')
  .option('--output-dir <dir>', 'Output directory containing manifest.json')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (options: { manifest?: string; outputDir?: string; verbose: boolean }) => {
    const manifestOptionCount =
      (options.manifest === undefined ? 0 : 1) + (options.outputDir === undefined ? 0 : 1);

    if (manifestOptionCount !== 1) {
      console.error(chalk.red('Error: provide exactly one of --manifest or --output-dir'));
      process.exit(1);
    }

    const manifestPath =
      options.manifest === undefined ? `${options.outputDir}/manifest.json` : options.manifest;

    try {
      const result = await verifyGenerationManifest({ manifestPath });

      console.log(chalk.bold('Manifest verification'));
      console.log(`  Manifest: ${result.manifestPath}`);
      console.log(`  Checked files: ${result.checkedFiles}`);
      console.log(`  Failures: ${result.failures.length}`);

      if (result.failures.length > 0) {
        for (const failure of result.failures) {
          console.error(chalk.red(`  - ${failure}`));
        }

        process.exit(1);
      }

      console.log(chalk.green('Verification passed'));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Verification failed: ${errorMsg}`));

      if (options.verbose && error instanceof Error && error.stack !== undefined) {
        console.error(chalk.gray(error.stack));
      }

      process.exit(1);
    }
  });

// ============================================================================
// LIST-SDKS COMMAND
// ============================================================================

program
  .command('list-sdks')
  .description('List all configured SDKs and their versions')
  .option('--config-dir <dir>', 'Configuration directory', 'config')
  .action(async (options: { configDir: string }) => {
    try {
      const config = new ConfigLoader(options.configDir);
      await config.load();

      console.log(chalk.bold('\nConfigured SDKs:\n'));

      const sdks = config.getAllSDKs();

      for (const sdkName of sdks) {
        const sdk = config.getSDK(sdkName);
        const versions = Object.keys(sdk.versions);

        console.log(chalk.cyan(`  ${sdkName}`));
        console.log(`    Name: ${sdk.name}`);
        console.log(`    Language: ${sdk.language}`);
        console.log(`    Versions: ${versions.join(', ')}`);

        // Show details for each version
        for (const ver of versions) {
          const verConfig = sdk.versions[ver];
          if (verConfig !== undefined) {
            console.log(chalk.gray(`      ${ver}:`));
            console.log(chalk.gray(`        Display: ${verConfig.displayName}`));
            console.log(chalk.gray(`        Spec: ${verConfig.spec.url}`));
          }
        }

        console.log();
      }

      console.log(chalk.gray(`Total SDKs: ${sdks.length}`));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Error: ${errorMsg}`));
      process.exit(1);
    }
  });

// ============================================================================
// VALIDATE COMMAND
// ============================================================================

program
  .command('validate')
  .description('Validate SDK specification')
  .requiredOption('--sdk <sdk>', 'SDK name')
  .option('--version <version>', 'Version to validate', 'latest')
  .option('--config-dir <dir>', 'Configuration directory', 'config')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(
    async (options: { sdk: string; version: string; configDir: string; verbose: boolean }) => {
      Logger.setLevel(options.verbose ? LogLevel.DEBUG : LogLevel.INFO);

      console.log(chalk.yellow(`\nValidating ${options.sdk} ${options.version}...\n`));

      try {
        const config = new ConfigLoader(options.configDir);
        await config.load();

        // Fetch and parse spec - returns [specPath, resolvedVersion]
        const [specPath, resolvedVersion] = await fetchSpec(options.sdk, options.version, config);
        const parser = new OpenRefParser(specPath);
        const parsedData = await parser.parse();

        console.log(chalk.green('Validation successful!\n'));
        console.log(`  SDK: ${chalk.cyan(options.sdk)}`);
        console.log(`  Version: ${chalk.cyan(resolvedVersion)}`);
        console.log(`  Operations: ${parsedData.operations.length}`);
        console.log(
          `  Examples: ${parsedData.operations.reduce(
            (sum: number, op) => sum + op.examples.length,
            0
          )}`
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`\nValidation failed: ${errorMsg}`));

        if (options.verbose && error instanceof Error && error.stack !== undefined) {
          console.error(chalk.gray(error.stack));
        }

        process.exit(1);
      }
    }
  );

// ============================================================================
// PARSE AND RUN
// ============================================================================

// The program uses the synchronous program.parse(), so a rejected action
// promise surfaces as an unhandled rejection. Convert it into an honest,
// non-zero-exit failure instead of a raw stack trace / inconsistent exit code.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(chalk.red(`Error: ${message}`));
  process.exit(1);
});

program.parse();
