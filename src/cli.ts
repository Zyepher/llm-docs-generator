#!/usr/bin/env node

/**
 * CLI Entry Point for Supabase LLM Docs Generator
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
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigLoader } from './config/loader.js';
import { discoverLocalSource } from './core/discovery.js';
import { discoverRepo } from './core/repo-discovery.js';
import { discoverWebsite } from './core/website-discovery.js';
import { OpenRefParser } from './parsers/openref/parser.js';
import { LLMFormatter } from './core/formatter.js';
import { verifyGenerationManifest, writeGenerationManifest } from './core/manifest.js';
import { fetchSpec } from './utils/fetcher.js';
import { Logger, LogLevel } from './utils/logger.js';

// ============================================================================
// CLI PROGRAM
// ============================================================================

const program = new Command();
const CLI_NAME = 'supabase-llm-docs';
const GENERATOR_NAME = packageJson.name;
const GENERATOR_VERSION = packageJson.version;
const LEGACY_FORMATTER_FORMAT = 'legacy-llm-docs';
const CAPABILITIES_SCHEMA_VERSION = '0.1.0';
const AGENT_CONTEXT_SCHEMA_VERSION = '0.2.0';
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIGURED_SDK_GENERATE_FORMATS = ['openref', 'openref-0.1'] as const;
const SOURCE_GENERATE_FORMATS = [
  'auto',
  'markdown',
  'mdx',
  'openapi',
  'openref',
  'rst',
  'html',
] as const;
const SOURCE_GENERATE_CHUNK_FORMATS = ['jsonl'] as const;

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

const CAPABILITIES_CONTRACT = {
  schemaVersion: CAPABILITIES_SCHEMA_VERSION,
  generator: {
    packageName: GENERATOR_NAME,
    packageVersion: GENERATOR_VERSION,
    cliName: CLI_NAME,
    binary: 'llm-docs',
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
      outputFiles: ['discovery-report.json'],
      summary: 'bounded local source inspection with deterministic candidate file evidence',
      limitations: [
        'candidate evidence for agent review only',
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
      outputFiles: ['discovery-report.json'],
      summary:
        'bounded repository inspection with stable cache reuse and optional repo-relative scope',
      limitations: [
        'candidate evidence for agent review only',
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
      outputFiles: ['discovery-report.json'],
      summary:
        'bounded static website inspection for the explicit URL plus same-origin /llms.txt and /sitemap.xml',
      limitations: [
        'candidate evidence for agent review only',
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
      ],
      summary: 'deterministic local evidence extraction for conservative observed facts',
      limitations: [
        'no behavior inference',
        'no assertion parsing',
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
      ],
      summary: 'evidence-bound Markdown and provenance files from source-truth inspection',
      limitations: [
        'no behavior inference',
        'no assertion parsing',
        'no test execution',
        'no framework inference',
        'no route inference',
        'no re-export resolution',
        'local explicit sources only',
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
      id: 'generate-source',
      command: 'generate',
      mode: 'generate --source',
      status: 'implemented',
      inputBoundary: 'explicit local file or directory',
      options: [
        '--source <path>',
        '--format auto|markdown|mdx|openapi|openref|rst|html',
        '--chunks jsonl',
      ],
      outputFiles: ['manifest.json', 'llm-docs/*-llms.txt', 'chunks/semantic-chunks.jsonl'],
      summary:
        'deterministic local source parsing through the registered parser and universal formatter, with opt-in semantic chunk JSONL export',
      limitations: [
        'local files and directories only',
        'no URL fetching',
        'no discovery report consumption',
        'no candidate auto-selection',
        'no preset generation',
        'no source selection decision',
        'semantic chunk JSONL is emitted only when --chunks jsonl is requested',
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
      summary: 'configured OpenRef SDK generation through the existing compatibility flow',
      limitations: [
        'configured SDKs only',
        'no preset generation',
        'no discovery report consumption',
      ],
    },
    {
      id: 'verify-configured-sdk',
      command: 'verify',
      mode: 'verify --manifest or verify --output-dir',
      status: 'implemented',
      inputBoundary: 'configured-sdk manifest.json',
      outputFiles: ['stdout verification result'],
      summary: 'hash and byte-size verification for configured SDK manifests',
      limitations: [
        'configured-sdk manifest mode only',
        'does not recompute optional generated output line or token metadata',
        'no refresh',
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
        'source path, source file, generated output hash, byte-size, line-count, and estimated-token verification for local source docs manifests',
      limitations: [
        'local-source-docs manifest mode only',
        'no refresh',
        'no repo freshness check',
        'no source-code verification',
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
    ],
    limitations: [
      'no behavior inference',
      'no assertion parsing',
      'no test execution',
      'no framework inference',
      'no route inference',
      'no re-export resolution',
      'local explicit sources only',
    ],
  },
  plannedUnsupported: [
    {
      id: 'generate-preset',
      command: 'generate --preset',
      status: 'planned-unsupported',
      reason:
        'preset generation is not implemented; the current generate command supports explicit local source generation and configured OpenRef SDK generation only',
    },
    {
      id: 'refresh',
      command: 'refresh',
      status: 'planned-unsupported',
      reason: 'no current CLI refresh workflow',
    },
    {
      id: 'source-code-verification',
      command: 'source verification for official docs',
      status: 'planned-unsupported',
      reason: 'no current claim verification workflow against implementation source files',
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
      id: 'agent-install-codex',
      command: 'agent install codex',
      status: 'planned-unsupported',
      reason:
        'no current CLI skill installer; installing/registering skills remains separate from packaged context metadata',
    },
    {
      id: 'agent-doctor',
      command: 'agent doctor',
      status: 'planned-unsupported',
      reason:
        'no current CLI host diagnostics; the CLI does not probe PATH, host config, or skill installation state',
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
    sha256: createHash('sha256').update(content).digest('hex'),
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
      binary: 'llm-docs',
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
      'Supported generation modes: generate --source <local-file-or-directory> [--format auto|markdown|mdx|openapi|openref|rst|html] [--chunks jsonl] --output-dir <dir>; generate --sdk <sdk> [--sdk-version <version>] [--format openref|openref-0.1].'
    )
  );
  console.error(chalk.yellow('Preset generation remains planned/unsupported in the current CLI.'));
  console.error(
    chalk.yellow(
      'Discovery reports are candidate evidence for agent review; pass an explicit local source path to generate.'
    )
  );
}

type GenerateMode = 'source' | 'configured-sdk';

function validateGenerateOptions(options: {
  sdk?: string;
  source?: string;
  format?: string;
  chunks?: string;
  preset?: string;
}): GenerateMode {
  if (options.preset !== undefined) {
    failGenerateRequest('generate --preset is not implemented.');
  }

  if (options.source !== undefined && options.sdk !== undefined) {
    failGenerateRequest('generate --source and --sdk are mutually exclusive.');
  }

  if (options.source !== undefined) {
    if (options.format !== undefined) {
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

async function cleanupStaleSourceArtifactsForFailedSourceRequest(options: {
  source?: string;
  outputDir: string;
}): Promise<void> {
  if (options.source === undefined) {
    return;
  }

  try {
    const { cleanupStaleSourceDocsArtifacts } = await import('./core/source-docs.js');

    await cleanupStaleSourceDocsArtifacts(options.outputDir, {
      protectedSourcePath: options.source,
    });
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
  .option('--output-dir <dir>', 'Directory for discovery-report.json')
  .action(
    async (options: {
      source?: string;
      repo?: string;
      url?: string;
      scope?: string;
      cacheDir?: string;
      outputDir?: string;
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

          const report = await discoverLocalSource(
            options.outputDir === undefined
              ? { source: options.source }
              : { source: options.source, outputDir: options.outputDir }
          );

          console.log(chalk.bold('Local source discovery'));
          console.log(`  Source: ${report.source.resolvedPath}`);
          console.log(`  Type: ${report.source.type}`);
          console.log(`  Candidate files: ${report.candidates.length}`);
          console.log(`  Warnings: ${report.warnings.length}`);
          console.log(`  Report: ${chalk.cyan(report.output.reportPath)}`);

          return;
        }

        if (options.url !== undefined) {
          if (options.scope !== undefined || options.cacheDir !== undefined) {
            throw new Error('discover --scope and --cache-dir are only supported with --repo.');
          }

          const { report } = await discoverWebsite(
            options.outputDir === undefined
              ? { url: options.url }
              : { url: options.url, outputDir: options.outputDir }
          );

          console.log(chalk.bold('Website discovery'));
          console.log(`  URL: ${report.website.normalizedUrl}`);
          console.log(`  Resources inspected: ${report.inspectedResources.length}`);
          console.log(`  Candidate URLs: ${report.candidates.length}`);
          console.log(`  Warnings: ${report.warnings.length}`);
          console.log(`  Report: ${chalk.cyan(report.output.reportPath)}`);

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
          repoOptions.outputDir = options.outputDir;
        }

        const { report } = await discoverRepo(repoOptions);

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
    'Source parser hint: auto, markdown, mdx, openapi, openref, rst, html; SDK guard: openref or openref-0.1'
  )
  .option('--chunks <format>', 'Source-only semantic chunk export: jsonl')
  .option('--preset <name>', 'Planned preset generation input (unsupported)')
  .option('--sdk-version <version>', 'Version to generate (or "all" for all versions)', 'latest')
  .option('--config-dir <dir>', 'Configuration directory', 'config')
  .option('--output-dir <dir>', 'Output directory', '../../public/llms-openref')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .option('--force', 'Force re-download specs (ignore cache)', false)
  .action(
    async (options: {
      sdk?: string;
      source?: string;
      format?: string;
      chunks?: string;
      preset?: string;
      sdkVersion: string;
      configDir: string;
      outputDir: string;
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

      if (generateMode === 'source') {
        try {
          const { generateSourceDocs } = await import('./core/source-docs.js');
          const sourceDocsOptions: Parameters<typeof generateSourceDocs>[0] = {
            source: options.source ?? '',
            outputDir: options.outputDir,
            generator: {
              name: GENERATOR_NAME,
              version: GENERATOR_VERSION,
              cliName: CLI_NAME,
            },
          };

          if (options.format !== undefined) {
            sourceDocsOptions.format = options.format;
          }
          if (options.chunks !== undefined) {
            sourceDocsOptions.chunks = options.chunks;
          }

          const result = await generateSourceDocs(sourceDocsOptions);
          const chunkOutput = result.manifest.generatedOutputs.find(
            (output) => output.kind === 'semantic-chunks-jsonl'
          );

          console.log(chalk.bold('Local source docs generated'));
          console.log(`  Source: ${result.manifest.source.resolvedPath}`);
          console.log(`  Type: ${result.manifest.source.type}`);
          console.log(`  Format: ${result.manifest.source.resolvedFormat}`);
          console.log(`  Source files: ${result.manifest.sourceFiles.length}`);
          console.log(`  Generated files: ${result.manifest.generatedOutputs.length}`);
          if (chunkOutput !== undefined) {
            console.log(`  Chunk export: ${chalk.cyan(chunkOutput.path)}`);
          }
          console.log(`  Output: ${chalk.cyan(result.outputDir)}`);
          console.log(`  Manifest: ${chalk.cyan(result.manifestPath)}`);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.error(chalk.red(`Generate failed: ${errorMsg}`));
          process.exit(1);
        }

        return;
      }

      // Set log level
      Logger.setLevel(options.verbose ? LogLevel.DEBUG : LogLevel.INFO);

      console.log(chalk.bold.blue('\nSupabase LLM Documentation Generator\n'));

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
            const plannedOutputDir = `${options.outputDir}/${sdkName}/${plannedVersion}`;
            await removeScopedManifest(plannedOutputDir);

            // Fetch spec (uses cache by default) - returns [specPath, resolvedVersion]
            const [specPath, resolvedVersion] = await fetchSpec(
              sdkName,
              ver,
              config,
              options.force
            );
            const versionConfig = config.getSDKVersionConfig(sdkName, resolvedVersion);

            // Parse spec
            const parser = new OpenRefParser(specPath);
            const parsedData = await parser.parse();

            // Save parsed JSON using resolved version
            const outputDir = `${options.outputDir}/${sdkName}/${resolvedVersion}`;
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
                resolvedSpecPath: specPath,
                format: versionConfig.spec.format,
              },
              parser: {
                name: 'OpenRefParser',
                version: GENERATOR_VERSION,
                format: versionConfig.spec.format,
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

            // Continue with other SDKs even if one fails
            continue;
          }
        }

        // Summary
        console.log(chalk.bold.green(`\nGeneration complete!`));
        console.log(`  Successful: ${successCount}`);
        if (failureCount > 0) {
          console.log(chalk.red(`  Failed: ${failureCount}`));
        }
        console.log(`\nOutput location: ${chalk.cyan(options.outputDir)}`);

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
// VERIFY COMMAND
// ============================================================================

program
  .command('verify')
  .description(
    'Verify an existing configured SDK or local source docs manifest by recorded file metadata'
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

program.parse();
