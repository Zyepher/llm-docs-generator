/**
 * Generation manifest writer for the configured SDK compatibility flow.
 */

import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, parse, relative, resolve, sep, win32 } from 'node:path';

import { describeGeneratedTextOutput } from './generated-output-metadata.js';
import {
  buildSemanticChunkJsonlManifestIndex,
  hashSemanticChunkManifestIndex,
  semanticChunkManifestIndexesEqual,
  type SemanticChunkManifestIndex,
  type SemanticChunkManifestIndexChunk,
} from './semantic-chunk-index.js';
import {
  validateParserPluginManifestFile,
  type ParserPluginFormatMetadata,
  type ParserPluginManifestMetadata,
} from './parser-plugin-manifest.js';
import { writeTextFileSafely } from '../utils/safe-write.js';

const HASH_PREFIX = 'sha256:';

export const MANIFEST_SCHEMA_VERSION = '0.1.0';
export const CONFIGURED_SDK_MODE = 'configured-sdk';
export const DISCOVERY_REPORT_MODE = 'discovery-report';
const SOURCE_DOCS_MODE = 'local-source-docs';
const SOURCE_TRUTH_DOCS_MODE = 'source-truth-local-docs';
const CONFIGURED_SDK_GENERATED_OUTPUT_KINDS = new Set<GeneratedOutputKind>([
  'parsed-spec-json',
  'llm-docs',
]);
const DISCOVERY_REPORT_SCHEMA_VERSION = '0.2.0';
const DISCOVERY_REPORT_OUTPUT_KIND = 'discovery-report';
const DISCOVERY_REPORT_GENERATED_OUTPUT_KINDS = new Set([DISCOVERY_REPORT_OUTPUT_KIND]);
const DISCOVERY_CANDIDATE_EVIDENCE_INDEX_HASH_SEED =
  'llm-docs-generator:discovery-candidate-evidence-index:v1\n';
const DISCOVERY_CANDIDATE_EVIDENCE_INDEX_KEYS = new Set([
  'candidateCount',
  'aggregateHash',
  'context',
  'candidates',
]);
const DISCOVERY_CANDIDATE_EVIDENCE_CONTEXT_KEYS_BY_KIND: Record<
  DiscoveryReportKind,
  ReadonlySet<string>
> = {
  source: new Set(['source']),
  repo: new Set(['repo', 'scope']),
  url: new Set(['website', 'crawlPolicy', 'resourceFreshness']),
};
const DISCOVERY_SOURCE_CONTEXT_KEYS = new Set(['input', 'resolvedPath', 'type']);
const DISCOVERY_REPO_CONTEXT_KEYS = new Set(['input', 'normalizedInput', 'commit', 'dirty']);
const DISCOVERY_REPO_SCOPE_CONTEXT_KEYS = new Set(['input', 'path', 'resolvedPath', 'type']);
const DISCOVERY_WEBSITE_CONTEXT_KEYS = new Set(['input', 'normalizedUrl', 'origin']);
const DISCOVERY_WEBSITE_CRAWL_POLICY_CONTEXT_KEYS = new Set([
  'linkedCandidateFetches',
  'renderedJavaScript',
  'inspectedResourceCount',
  'sameOriginWellKnownResourceCount',
]);
const DISCOVERY_WEBSITE_RESOURCE_FRESHNESS_KEYS = new Set([
  'url',
  'sourceRole',
  'observedAt',
  'etag',
  'lastModified',
]);
const DISCOVERY_PATH_CANDIDATE_EVIDENCE_INDEX_CANDIDATE_KEYS = new Set([
  'path',
  'order',
  'kind',
  'format',
  'hints',
  'formatHints',
  'evidence',
  'byteSize',
  'sha256',
]);
const DISCOVERY_URL_CANDIDATE_EVIDENCE_INDEX_CANDIDATE_KEYS = new Set([
  'url',
  'order',
  'evidence',
  'sameOrigin',
  'external',
  'sourceResources',
]);
const DISCOVERY_CANDIDATE_EVIDENCE_KEYS = new Set(['category', 'signals', 'relations', 'flags']);
const DISCOVERY_CANDIDATE_SOURCE_RESOURCE_KEYS = new Set(['url', 'sourceRole', 'evidence']);
const SOURCE_TRUTH_REPORT_SCHEMA_VERSION = '0.1.0';
const SOURCE_TRUTH_INSPECTION_MODE = 'source-truth-local-evidence';
const SOURCE_TRUTH_REPORT_OUTPUT_KIND = 'source-truth-report-json';
const SOURCE_TRUTH_MARKDOWN_OUTPUT_KIND = 'source-truth-markdown';
const SOURCE_TRUTH_GENERATED_OUTPUT_KINDS = new Set([
  SOURCE_TRUTH_REPORT_OUTPUT_KIND,
  SOURCE_TRUTH_MARKDOWN_OUTPUT_KIND,
]);
const SOURCE_VERIFICATION_MODE = 'source-verification-local-evidence';
const SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION = '0.1.0';
const SOURCE_VERIFICATION_REPORT_OUTPUT_KIND = 'source-verification-report-json';
const SOURCE_VERIFICATION_GENERATED_OUTPUT_KINDS = new Set([
  SOURCE_VERIFICATION_REPORT_OUTPUT_KIND,
]);
const SOURCE_VERIFICATION_SUMMARY_FIELDS = [
  'sourceFileCount',
  'sourceExportFactCount',
  'observedExportedNameCount',
  'docsFileCount',
  'docsReferenceCount',
  'exactMatchCount',
  'unmatchedReferenceCount',
  'warningCount',
] as const;
const DISCOVERY_REPORT_MODE_BY_KIND = {
  source: 'local-bounded-inspection',
  repo: 'repo-bounded-inspection',
  url: 'website-bounded-inspection',
} as const;
const SOURCE_DOCS_GENERATED_OUTPUT_KINDS = new Set(['llm-docs', 'semantic-chunks-jsonl']);
const SOURCE_DOCS_SEMANTIC_CHUNK_JSONL_KIND = 'semantic-chunks-jsonl';
const CONFIGURED_SDK_PARSER_NAME = 'OpenRefParser';
const CONFIGURED_SDK_PARSER_FORMAT = 'openref-0.1';
const CONFIGURED_SDK_FORMATTER_NAME = 'LLMFormatter';
const CONFIGURED_SDK_FORMATTER_FORMAT = 'legacy-llm-docs';
const SOURCE_DOCS_FORMATTER_NAME = 'UniversalFormatter';
const SOURCE_DOCS_FORMATTER_FORMAT = 'universal-llm-docs';
const SOURCE_DOCS_SOURCE_TYPES = new Set(['file', 'directory']);
const SOURCE_DOCS_FORMAT_HINTS = new Set([
  'auto',
  'markdown',
  'mdx',
  'openapi',
  'openref',
  'rst',
  'html',
]);
const SOURCE_DOCS_RESOLVED_FORMATS = new Set(['markdown', 'openapi', 'openref', 'rst', 'html']);
const SOURCE_DOCS_PLUGIN_FORMAT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const SOURCE_DOCS_SEMANTIC_CHUNK_INDEX_KEYS = new Set([
  'path',
  'format',
  'chunkCount',
  'aggregateHash',
  'warningCount',
  'chunks',
]);
const SOURCE_DOCS_SEMANTIC_CHUNK_INDEX_CHUNK_KEYS = new Set([
  'id',
  'order',
  'title',
  'path',
  'nodePath',
  'contentHash',
  'characterCount',
  'estimatedTokenCount',
  'sourceFormat',
  'sourcePath',
  'warningCount',
]);
export const SOURCE_DOCS_SWIFT_BOOK_PRESET_NAME = 'swift-book';
export const SOURCE_DOCS_SWIFT_BOOK_PRESET_METADATA = {
  sourceSelection: 'explicit-local-source-required',
  sourceVerification: 'not-performed',
  sourceTruthClaim: 'not-claimed',
} as const;
export const SOURCE_DOCS_SWIFT_BOOK_PRESET_LIMITATIONS = [
  'Requires an explicit local --source path.',
  'Does not select or infer source paths.',
  'Does not clone repositories or refresh caches.',
  'Does not perform source-code verification.',
  'Does not claim source truth.',
] as const;

export type GeneratedOutputKind = 'parsed-spec-json' | 'llm-docs';
export type DiscoveryReportKind = keyof typeof DISCOVERY_REPORT_MODE_BY_KIND;

export interface GeneratorMetadata {
  name: string;
  version: string;
  cliName?: string;
}

export interface SourceManifestInput {
  configuredUrl: string;
  configuredLocalPath: string | null;
  resolvedSpecPath: string;
  format: string;
}

export interface ParserManifestMetadata {
  name: string;
  version: string;
  format: string;
}

export interface FormatterManifestMetadata {
  name: string;
  version: string;
  format: string;
}

export interface GeneratedOutputInput {
  path: string;
  kind: GeneratedOutputKind;
}

export interface GeneratedOutputManifestEntry extends GeneratedOutputInput {
  byteSize: number;
  hash: string;
  lineCount: number;
  estimatedTokenCount: number;
}

export interface WriteGenerationManifestOptions {
  manifestPath: string;
  generatedAt: Date;
  generator: GeneratorMetadata;
  sdk: {
    name: string;
    resolvedVersion: string;
    displayName: string;
  };
  source: SourceManifestInput;
  parser: ParserManifestMetadata;
  formatter: FormatterManifestMetadata;
  generatedOutputs: GeneratedOutputInput[];
  warnings?: string[];
}

export interface VerifyGenerationManifestOptions {
  manifestPath: string;
}

export interface VerifyGenerationManifestResult {
  manifestPath: string;
  checkedFiles: number;
  failures: string[];
}

export interface WriteDiscoveryReportManifestOptions {
  manifestPath: string;
  generator: GeneratorMetadata;
  discoveryKind: DiscoveryReportKind;
  reportPath: string;
  report: unknown;
}

interface DiscoveryCandidateEvidenceIndex {
  candidateCount: number;
  aggregateHash: string;
  context: DiscoveryCandidateEvidenceContext;
  candidates: DiscoveryCandidateEvidenceIndexCandidate[];
}

type DiscoveryCandidateEvidenceContext =
  | {
      source: {
        input: string;
        resolvedPath: string;
        type: string;
      };
    }
  | {
      repo: {
        input: string;
        normalizedInput: string;
        commit: string | null;
        dirty: boolean | null;
      };
      scope: {
        input: string;
        path: string;
        resolvedPath: string;
        type: string;
      };
    }
  | {
      website: {
        input: string;
        normalizedUrl: string;
        origin: string;
      };
      crawlPolicy: {
        linkedCandidateFetches: false;
        renderedJavaScript: false;
        inspectedResourceCount: number;
        sameOriginWellKnownResourceCount: number;
      };
      resourceFreshness: WebsiteResourceFreshnessIndexEntry[];
    };

interface DiscoveryCandidateEvidenceIndexCandidate {
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
}

type DiscoveryCandidateEvidenceIndexHashData = Omit<
  DiscoveryCandidateEvidenceIndex,
  'aggregateHash'
>;

interface WebsiteResourceFreshnessIndexEntry {
  url: string;
  sourceRole: string;
  observedAt: string;
  etag: string | null;
  lastModified: string | null;
}

export async function writeGenerationManifest(
  options: WriteGenerationManifestOptions
): Promise<void> {
  const manifestDir = dirname(options.manifestPath);
  const sourceFile = await describeFile(options.source.resolvedSpecPath);

  const generatedOutputs: GeneratedOutputManifestEntry[] = (
    await Promise.all(
      options.generatedOutputs
        .filter((output) => output.path !== options.manifestPath)
        .map(async (output) => {
          const file = await describeGeneratedTextOutput(output.path);

          return {
            path: toManifestRelativePath(manifestDir, output.path),
            kind: output.kind,
            byteSize: file.byteSize,
            hash: file.hash,
            lineCount: file.lineCount,
            estimatedTokenCount: file.estimatedTokenCount,
          };
        })
    )
  ).sort((a, b) => compareStringsByCodeUnit(a.path, b.path));

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: options.generatedAt.toISOString(),
    generator: options.generator,
    mode: CONFIGURED_SDK_MODE,
    sdk: options.sdk,
    source: {
      ...options.source,
      byteSize: sourceFile.byteSize,
      contentHash: sourceFile.hash,
    },
    parser: options.parser,
    formatter: options.formatter,
    generatedOutputs,
    warnings: options.warnings ?? [],
  };

  await mkdir(manifestDir, { recursive: true });
  await writeFile(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

export async function writeDiscoveryReportManifest(
  options: WriteDiscoveryReportManifestOptions
): Promise<void> {
  const manifestDir = dirname(options.manifestPath);
  const report = await readDiscoveryReportJson(options.reportPath);
  const reportSummary = summarizeDiscoveryReport(options.discoveryKind, report);
  const candidateEvidenceIndex = buildDiscoveryCandidateEvidenceIndex(
    options.discoveryKind,
    report
  );
  const reportFile = await describeGeneratedTextOutput(options.reportPath);
  const reportPath = toManifestRelativePath(manifestDir, options.reportPath);
  const discovery = {
    kind: options.discoveryKind,
    reportPath,
    reportSchemaVersion: reportSummary.schemaVersion,
    reportMode: reportSummary.mode,
    candidateCount: reportSummary.candidateCount,
    warningCount: reportSummary.warningCount,
    ...(reportSummary.urlResourceCount === undefined
      ? {}
      : { urlResourceCount: reportSummary.urlResourceCount }),
  };
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generator: options.generator,
    mode: DISCOVERY_REPORT_MODE,
    discovery,
    candidateEvidenceIndex,
    generatedOutputs: [
      {
        path: reportPath,
        kind: DISCOVERY_REPORT_OUTPUT_KIND,
        byteSize: reportFile.byteSize,
        hash: reportFile.hash,
        lineCount: reportFile.lineCount,
        estimatedTokenCount: reportFile.estimatedTokenCount,
      },
    ],
  };

  await mkdir(manifestDir, { recursive: true });
  await writeTextFileSafely(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function verifyGenerationManifest(
  options: VerifyGenerationManifestOptions
): Promise<VerifyGenerationManifestResult> {
  return verifyManifestFile(options.manifestPath);
}

export async function verifyManifestFile(
  manifestPathInput: string
): Promise<VerifyGenerationManifestResult> {
  const manifestPath = resolve(manifestPathInput);
  let manifest: unknown;

  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as unknown;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {
        manifestPath,
        checkedFiles: 0,
        failures: [`manifest not found: ${manifestPath}`],
      };
    }

    return {
      manifestPath,
      checkedFiles: 0,
      failures: [`malformed manifest JSON: ${errorMessage(error)}`],
    };
  }

  if (!isObjectRecord(manifest)) {
    return {
      manifestPath,
      checkedFiles: 0,
      failures: ['malformed manifest: root must be an object'],
    };
  }

  const schemaVersion = manifest.schemaVersion;
  const mode = manifest.mode;

  if (schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return {
      manifestPath,
      checkedFiles: 0,
      failures: [`unsupported manifest schemaVersion: ${String(schemaVersion)}`],
    };
  }

  if (mode === CONFIGURED_SDK_MODE) {
    return verifyConfiguredSdkManifest(manifestPath, manifest);
  }

  if (mode === SOURCE_DOCS_MODE) {
    return verifySourceDocsManifest(manifestPath, manifest);
  }

  if (mode === SOURCE_TRUTH_DOCS_MODE) {
    return verifySourceTruthDocsManifest(manifestPath, manifest);
  }

  if (mode === SOURCE_VERIFICATION_MODE) {
    return verifySourceVerificationManifest(manifestPath, manifest);
  }

  if (mode === DISCOVERY_REPORT_MODE) {
    return verifyDiscoveryReportManifest(manifestPath, manifest);
  }

  return {
    manifestPath,
    checkedFiles: 0,
    failures: [`unsupported manifest mode: ${String(mode)}`],
  };
}

async function verifyDiscoveryReportManifest(
  manifestPath: string,
  manifest: Record<string, unknown>
): Promise<VerifyGenerationManifestResult> {
  const failures: string[] = [];
  const manifestDir = dirname(manifestPath);
  const generator = manifest.generator;
  const discovery = manifest.discovery;
  const candidateEvidenceIndex = manifest.candidateEvidenceIndex;
  const generatedOutputs = manifest.generatedOutputs;

  if (!isObjectRecord(generator)) {
    failures.push('malformed manifest: missing generator object');
  } else {
    validateGeneratorMetadata(generator, failures);
  }

  if (!isObjectRecord(discovery)) {
    failures.push('malformed manifest: missing discovery object');
  }

  if (!Array.isArray(generatedOutputs)) {
    failures.push('malformed manifest: missing generatedOutputs array');
  }

  if (failures.length > 0) {
    return {
      manifestPath,
      checkedFiles: 0,
      failures,
    };
  }

  const fileChecks: FileCheck[] = [];
  const discoveryRecord = discovery as Record<string, unknown>;
  const outputRecords = generatedOutputs as unknown[];
  const discoveryKind = discoveryRecord.kind;
  const reportPath = discoveryRecord.reportPath;
  const reportSchemaVersion = discoveryRecord.reportSchemaVersion;
  const reportMode = discoveryRecord.reportMode;
  const candidateCount = discoveryRecord.candidateCount;
  const warningCount = discoveryRecord.warningCount;
  const urlResourceCount = discoveryRecord.urlResourceCount;
  const candidateEvidenceIndexEntry =
    candidateEvidenceIndex === undefined || !isDiscoveryReportKind(discoveryKind)
      ? undefined
      : validateDiscoveryCandidateEvidenceIndex({
          index: candidateEvidenceIndex,
          discoveryKind,
          failures,
        });

  if (!isDiscoveryReportKind(discoveryKind)) {
    failures.push('malformed manifest: discovery.kind must be source, repo, or url');
  }

  if (!isNonEmptyString(reportPath)) {
    failures.push('malformed manifest: discovery.reportPath must be a non-empty string');
  } else if (isAbsolute(reportPath)) {
    failures.push(`malformed manifest: discovery.reportPath must be relative: ${reportPath}`);
  } else if (!isInsideDirectory(manifestDir, resolve(manifestDir, reportPath))) {
    failures.push(
      `malformed manifest: discovery.reportPath escapes manifest directory: ${reportPath}`
    );
  }

  if (reportSchemaVersion !== DISCOVERY_REPORT_SCHEMA_VERSION) {
    failures.push(
      `malformed manifest: discovery.reportSchemaVersion must be ${DISCOVERY_REPORT_SCHEMA_VERSION}`
    );
  }

  if (
    isDiscoveryReportKind(discoveryKind) &&
    reportMode !== DISCOVERY_REPORT_MODE_BY_KIND[discoveryKind]
  ) {
    failures.push(
      `malformed manifest: discovery.reportMode must be ${DISCOVERY_REPORT_MODE_BY_KIND[discoveryKind]}`
    );
  }

  if (!isNonNegativeInteger(candidateCount)) {
    failures.push('malformed manifest: discovery.candidateCount must be a non-negative integer');
  }

  if (!isNonNegativeInteger(warningCount)) {
    failures.push('malformed manifest: discovery.warningCount must be a non-negative integer');
  }

  if (discoveryKind === 'url') {
    if (!isNonNegativeInteger(urlResourceCount)) {
      failures.push(
        'malformed manifest: discovery.urlResourceCount must be a non-negative integer'
      );
    }
  } else if ('urlResourceCount' in discoveryRecord) {
    failures.push('malformed manifest: discovery.urlResourceCount is only valid for url discovery');
  }

  if (outputRecords.length !== 1) {
    failures.push('malformed manifest: discovery manifests must contain exactly one output');
  }

  const outputRecord = outputRecords[0];
  if (isObjectRecord(outputRecord)) {
    if (
      isNonEmptyString(reportPath) &&
      !isAbsolute(reportPath) &&
      outputRecord.path !== reportPath
    ) {
      failures.push('malformed manifest: generatedOutputs[0].path must match discovery.reportPath');
    }

    if (outputRecord.kind !== DISCOVERY_REPORT_OUTPUT_KIND) {
      failures.push(
        `malformed manifest: generatedOutputs[0].kind must be ${DISCOVERY_REPORT_OUTPUT_KIND}`
      );
    }
  }

  validateGeneratedOutputs({
    generatedOutputs: outputRecords,
    manifestDir,
    failures,
    fileChecks,
    requireTextMetadata: true,
    rejectSymlinks: true,
    allowedKinds: DISCOVERY_REPORT_GENERATED_OUTPUT_KINDS,
  });

  const checkedFiles = failures.length === 0 ? fileChecks.length : 0;

  if (failures.length === 0) {
    for (const check of fileChecks) {
      await verifyFile(check, failures);
    }
  }

  if (
    failures.length === 0 &&
    isDiscoveryReportKind(discoveryKind) &&
    isNonEmptyString(reportPath) &&
    !isAbsolute(reportPath)
  ) {
    const expectedReport = {
      kind: discoveryKind,
      schemaVersion: DISCOVERY_REPORT_SCHEMA_VERSION,
      mode: DISCOVERY_REPORT_MODE_BY_KIND[discoveryKind],
      candidateCount: candidateCount as number,
      warningCount: warningCount as number,
      ...(discoveryKind === 'url' ? { urlResourceCount: urlResourceCount as number } : {}),
    };

    await verifyDiscoveryReportFile({
      manifestDir,
      reportPath: resolve(manifestDir, reportPath),
      expected: expectedReport,
      candidateEvidenceIndex: candidateEvidenceIndexEntry,
      failures,
    });
  }

  return {
    manifestPath,
    checkedFiles,
    failures,
  };
}

async function verifyConfiguredSdkManifest(
  manifestPath: string,
  manifest: Record<string, unknown>
): Promise<VerifyGenerationManifestResult> {
  const failures: string[] = [];
  const generator = manifest.generator;
  const sdk = manifest.sdk;
  const source = manifest.source;
  const parser = manifest.parser;
  const formatter = manifest.formatter;
  const generatedOutputs = manifest.generatedOutputs;

  if (!isObjectRecord(generator)) {
    failures.push('malformed manifest: missing generator object');
  } else {
    validateGeneratorMetadata(generator, failures);
  }

  if (!isObjectRecord(sdk)) {
    failures.push('malformed manifest: missing sdk object');
  } else {
    validateConfiguredSdkMetadata(sdk, failures);
  }

  if (!isObjectRecord(source)) {
    failures.push('malformed manifest: missing source object');
  }

  if (!isObjectRecord(parser)) {
    failures.push('malformed manifest: missing parser object');
  } else {
    validateConfiguredSdkParserMetadata(parser, failures);
  }

  if (!isObjectRecord(formatter)) {
    failures.push('malformed manifest: missing formatter object');
  } else {
    validateConfiguredSdkFormatterMetadata(formatter, failures);
  }

  if (!Array.isArray(generatedOutputs)) {
    failures.push('malformed manifest: missing generatedOutputs array');
  }

  if (failures.length > 0) {
    return {
      manifestPath,
      checkedFiles: 0,
      failures,
    };
  }

  const manifestDir = dirname(manifestPath);
  const fileChecks: FileCheck[] = [];
  const sourceRecord = source as Record<string, unknown>;
  const outputRecords = generatedOutputs as unknown[];
  const sourcePath = sourceRecord.resolvedSpecPath;
  const sourceByteSize = sourceRecord.byteSize;
  const sourceHash = sourceRecord.contentHash;

  if (!isNonEmptyString(sourcePath)) {
    failures.push('malformed manifest: source.resolvedSpecPath must be a non-empty string');
  }

  if (!isNonNegativeInteger(sourceByteSize)) {
    failures.push('malformed manifest: source.byteSize must be a non-negative integer');
  }

  if (!isSha256Hash(sourceHash)) {
    failures.push('malformed manifest: source.contentHash must be a sha256 hash');
  }

  if (
    isNonEmptyString(sourcePath) &&
    isNonNegativeInteger(sourceByteSize) &&
    isSha256Hash(sourceHash)
  ) {
    fileChecks.push({
      label: 'source',
      path: resolveManifestSourcePath(sourcePath, manifestDir),
      expectedByteSize: sourceByteSize,
      expectedHash: sourceHash,
    });
  }

  validateGeneratedOutputs({
    generatedOutputs: outputRecords,
    manifestDir,
    failures,
    fileChecks,
    requireTextMetadata: false,
    rejectSymlinks: false,
    allowedKinds: CONFIGURED_SDK_GENERATED_OUTPUT_KINDS,
  });

  return runFileChecks(manifestPath, failures, fileChecks);
}

async function verifySourceDocsManifest(
  manifestPath: string,
  manifest: Record<string, unknown>
): Promise<VerifyGenerationManifestResult> {
  const failures: string[] = [];
  const manifestDir = dirname(manifestPath);
  const generator = manifest.generator;
  const source = manifest.source;
  const sourceFiles = manifest.sourceFiles;
  const parser = manifest.parser;
  const formatter = manifest.formatter;
  const generatedOutputs = manifest.generatedOutputs;
  const semanticChunkIndexes = manifest.semanticChunkIndexes;
  const preset = manifest.preset;

  if (!isObjectRecord(generator)) {
    failures.push('malformed manifest: missing generator object');
  } else {
    validateGeneratorMetadata(generator, failures);
  }

  if (!isObjectRecord(source)) {
    failures.push('malformed manifest: missing source object');
  }

  if (!Array.isArray(sourceFiles)) {
    failures.push('malformed manifest: missing sourceFiles array');
  }

  if (!isObjectRecord(parser)) {
    failures.push('malformed manifest: missing parser object');
  }

  if (!isObjectRecord(formatter)) {
    failures.push('malformed manifest: missing formatter object');
  }

  if (!Array.isArray(generatedOutputs)) {
    failures.push('malformed manifest: missing generatedOutputs array');
  }

  if (failures.length > 0) {
    return {
      manifestPath,
      checkedFiles: 0,
      failures,
    };
  }

  const fileChecks: FileCheck[] = [];
  const pathTypeChecks: PathTypeCheck[] = [];
  const sourceRecord = source as Record<string, unknown>;
  const sourceFileRecords = sourceFiles as unknown[];
  const parserRecord = parser as Record<string, unknown>;
  const formatterRecord = formatter as Record<string, unknown>;
  const outputRecords = generatedOutputs as unknown[];
  const sourceInput = sourceRecord.input;
  const sourcePath = sourceRecord.resolvedPath;
  const sourceType = sourceRecord.type;
  const sourceFormatHint = sourceRecord.formatHint;
  const sourceResolvedFormat = sourceRecord.resolvedFormat;
  const sourceByteSize = sourceRecord.byteSize;
  const sourceHash = sourceRecord.hash;
  const sourceFileCount = sourceRecord.fileCount;
  const sourceAggregateHash = sourceRecord.aggregateHash;
  const parserPluginMetadata = validateSourceDocsParserPluginMetadata(
    parserRecord.plugin,
    failures,
    fileChecks
  );
  const parserPluginFormatId = parserPluginMetadata?.format.id;
  const hasParserPluginMetadata = parserRecord.plugin !== undefined;

  if (!isNonEmptyString(sourceInput)) {
    failures.push('malformed manifest: source.input must be a non-empty string');
  }

  if (!isNonEmptyString(sourceType) || !SOURCE_DOCS_SOURCE_TYPES.has(sourceType)) {
    failures.push('malformed manifest: source.type must be file or directory');
  }

  if (hasParserPluginMetadata && sourceType === 'directory') {
    failures.push(
      'malformed manifest: parser.plugin source manifests must record source.type file'
    );
  }

  if (hasParserPluginMetadata && preset !== undefined) {
    failures.push('malformed manifest: parser.plugin source manifests must not include preset');
  }

  if (hasParserPluginMetadata && semanticChunkIndexes !== undefined) {
    failures.push(
      'malformed manifest: parser.plugin source manifests must not include semanticChunkIndexes'
    );
  }

  if (!isNonEmptyString(sourceFormatHint)) {
    failures.push('malformed manifest: source.formatHint must be a supported source format hint');
  } else if (hasParserPluginMetadata) {
    if (parserPluginFormatId !== undefined && sourceFormatHint !== parserPluginFormatId) {
      failures.push('malformed manifest: source.formatHint must match parser.plugin.format.id');
    }
  } else if (!SOURCE_DOCS_FORMAT_HINTS.has(sourceFormatHint)) {
    failures.push('malformed manifest: source.formatHint must be a supported source format hint');
  }

  if (!isNonEmptyString(sourceResolvedFormat)) {
    failures.push('malformed manifest: source.resolvedFormat must be a supported source format');
  } else if (hasParserPluginMetadata) {
    if (parserPluginFormatId !== undefined && sourceResolvedFormat !== parserPluginFormatId) {
      failures.push('malformed manifest: source.resolvedFormat must match parser.plugin.format.id');
    }
  } else if (!SOURCE_DOCS_RESOLVED_FORMATS.has(sourceResolvedFormat)) {
    failures.push('malformed manifest: source.resolvedFormat must be a supported source format');
  }

  validateSourceDocsParserMetadata(
    parserRecord,
    sourceResolvedFormat,
    parserPluginFormatId,
    failures
  );
  validateSourceDocsFormatterMetadata(formatterRecord, failures);

  if (!isNonEmptyString(sourcePath)) {
    failures.push('malformed manifest: source.resolvedPath must be a non-empty string');
  } else if (!isAbsolute(sourcePath)) {
    failures.push('malformed manifest: source.resolvedPath must be absolute');
  }

  if (sourceType === 'file') {
    if (!isNonNegativeInteger(sourceByteSize)) {
      failures.push('malformed manifest: source.byteSize must be a non-negative integer');
    }

    if (!isSha256Hash(sourceHash)) {
      failures.push('malformed manifest: source.hash must be a sha256 hash');
    }
  }

  if (sourceType === 'directory') {
    if (!isNonNegativeInteger(sourceFileCount)) {
      failures.push('malformed manifest: source.fileCount must be a non-negative integer');
    }

    if (!isSha256Hash(sourceAggregateHash)) {
      failures.push('malformed manifest: source.aggregateHash must be a sha256 hash');
    }
  }

  if (
    isNonEmptyString(sourcePath) &&
    isAbsolute(sourcePath) &&
    isSourceDocsSourceType(sourceType)
  ) {
    pathTypeChecks.push({
      label: 'source',
      path: sourcePath,
      expectedType: sourceType,
    });
  }

  const sourceFileEntries = validateSourceFiles({
    sourceFiles: sourceFileRecords,
    sourcePath,
    sourceType,
    sourceResolvedFormat,
    failures,
    fileChecks,
  });

  if (sourceType === 'file' && sourceFileEntries.length !== 1) {
    failures.push(
      'malformed manifest: file source manifests must contain exactly one sourceFiles entry'
    );
  }

  if (
    sourceType === 'file' &&
    sourceFileEntries.length === 1 &&
    isNonNegativeInteger(sourceByteSize) &&
    isSha256Hash(sourceHash)
  ) {
    const sourceFile = sourceFileEntries[0];

    if (sourceFile !== undefined && sourceFile.byteSize !== sourceByteSize) {
      failures.push('malformed manifest: source.byteSize must match sourceFiles[0].byteSize');
    }

    if (sourceFile !== undefined && sourceFile.hash !== sourceHash) {
      failures.push('malformed manifest: source.hash must match sourceFiles[0].hash');
    }
  }

  if (
    sourceType === 'directory' &&
    isNonNegativeInteger(sourceFileCount) &&
    sourceFileCount !== sourceFileEntries.length
  ) {
    failures.push('malformed manifest: source.fileCount must match sourceFiles length');
  }

  if (
    sourceType === 'directory' &&
    isSha256Hash(sourceAggregateHash) &&
    sourceFileEntries.length === sourceFileRecords.length
  ) {
    const actualAggregateHash = aggregateSourceFilesHash(sourceFileEntries);

    if (sourceAggregateHash !== actualAggregateHash) {
      failures.push('malformed manifest: source.aggregateHash must match sourceFiles metadata');
    }
  }

  validateGeneratedOutputs({
    generatedOutputs: outputRecords,
    manifestDir,
    failures,
    fileChecks,
    requireTextMetadata: true,
    rejectSymlinks: true,
    allowedKinds: SOURCE_DOCS_GENERATED_OUTPUT_KINDS,
  });
  if (hasParserPluginMetadata) {
    validateSourceDocsParserPluginGeneratedOutputs(outputRecords, failures);
  }
  const semanticChunkIndexEntries = validateSourceDocsSemanticChunkIndexes({
    semanticChunkIndexes,
    generatedOutputs: outputRecords,
    manifestDir,
    failures,
  });
  validateSourceDocsPresetMetadata(preset, failures);

  if (failures.length === 0 && parserPluginMetadata !== undefined) {
    await verifySourceDocsParserPluginManifestMetadata(parserPluginMetadata, failures);
  }

  if (failures.length === 0) {
    for (const check of pathTypeChecks) {
      await verifyPathType(check, failures);
    }
  }

  const checkedFiles = failures.length === 0 ? fileChecks.length : 0;

  if (failures.length === 0) {
    for (const check of fileChecks) {
      await verifyFile(check, failures);
    }
  }

  if (failures.length === 0) {
    await verifySourceDocsSemanticChunkIndexes({
      manifestDir,
      semanticChunkIndexes: semanticChunkIndexEntries,
      failures,
    });
  }

  return {
    manifestPath,
    checkedFiles,
    failures,
  };
}

async function verifySourceTruthDocsManifest(
  manifestPath: string,
  manifest: Record<string, unknown>
): Promise<VerifyGenerationManifestResult> {
  const failures: string[] = [];
  const manifestDir = dirname(manifestPath);
  const source = manifest.source;
  const inspection = manifest.inspection;
  const sourceFiles = manifest.sourceFiles;
  const generatedOutputs = manifest.generatedOutputs;

  if (!isObjectRecord(source)) {
    failures.push('malformed manifest: missing source object');
  }

  if (!isObjectRecord(inspection)) {
    failures.push('malformed manifest: missing inspection object');
  }

  if (!Array.isArray(sourceFiles)) {
    failures.push('malformed manifest: missing sourceFiles array');
  }

  if (!Array.isArray(generatedOutputs)) {
    failures.push('malformed manifest: missing generatedOutputs array');
  }

  if (failures.length > 0) {
    return {
      manifestPath,
      checkedFiles: 0,
      failures,
    };
  }

  const fileChecks: FileCheck[] = [];
  const pathTypeChecks: PathTypeCheck[] = [];
  const sourceRecord = source as Record<string, unknown>;
  const inspectionRecord = inspection as Record<string, unknown>;
  const sourceFileRecords = sourceFiles as unknown[];
  const outputRecords = generatedOutputs as unknown[];
  const sourceInput = sourceRecord.input;
  const sourcePath = sourceRecord.resolvedPath;
  const sourceType = sourceRecord.type;

  if (!isNonEmptyString(sourceInput)) {
    failures.push('malformed manifest: source.input must be a non-empty string');
  }

  if (!isNonEmptyString(sourceType) || !isSourceTruthSourceType(sourceType)) {
    failures.push('malformed manifest: source.type must be file or directory');
  }

  if (!isNonEmptyString(sourcePath)) {
    failures.push('malformed manifest: source.resolvedPath must be a non-empty string');
  } else if (!isAbsolute(sourcePath)) {
    failures.push('malformed manifest: source.resolvedPath must be absolute');
  }

  if (
    isNonEmptyString(sourcePath) &&
    isAbsolute(sourcePath) &&
    isSourceTruthSourceType(sourceType)
  ) {
    pathTypeChecks.push({
      label: 'source',
      path: sourcePath,
      expectedType: sourceType,
      rejectSymlinkAncestors: true,
    });
  }

  validateSourceTruthInspection(inspectionRecord, failures);

  const sourceFileEntries = validateSourceTruthSourceFiles({
    sourceFiles: sourceFileRecords,
    sourcePath,
    sourceType,
    failures,
    fileChecks,
  });

  if (sourceType === 'file' && sourceFileEntries.length !== 1) {
    failures.push(
      'malformed manifest: file source-truth manifests must contain exactly one sourceFiles entry'
    );
  }

  validateGeneratedOutputs({
    generatedOutputs: outputRecords,
    manifestDir,
    failures,
    fileChecks,
    requireTextMetadata: true,
    rejectSymlinks: true,
    rejectSymlinkAncestors: true,
    allowedKinds: SOURCE_TRUTH_GENERATED_OUTPUT_KINDS,
  });

  validateSourceTruthGeneratedOutputSet(outputRecords, failures);

  if (failures.length === 0) {
    for (const check of pathTypeChecks) {
      await verifyPathType(check, failures);
    }
  }

  const checkedFiles = failures.length === 0 ? fileChecks.length : 0;

  if (failures.length === 0) {
    for (const check of fileChecks) {
      await verifyFile(check, failures);
    }
  }

  if (failures.length === 0) {
    const reportOutputPath = sourceTruthReportOutputPath(outputRecords);

    if (reportOutputPath === undefined) {
      failures.push(
        `malformed manifest: source-truth manifests must include a ${SOURCE_TRUTH_REPORT_OUTPUT_KIND} output`
      );
    } else {
      await verifySourceTruthReportFile({
        reportPath: resolve(manifestDir, reportOutputPath),
        expected: {
          source: sourceRecord,
          inspection: inspectionRecord,
          sourceFiles: sourceFileEntries,
        },
        failures,
      });
    }
  }

  return {
    manifestPath,
    checkedFiles,
    failures,
  };
}

async function verifySourceVerificationManifest(
  manifestPath: string,
  manifest: Record<string, unknown>
): Promise<VerifyGenerationManifestResult> {
  const failures: string[] = [];
  const manifestDir = dirname(manifestPath);
  const generator = manifest.generator;
  const sourceVerification = manifest.sourceVerification;
  const generatedOutputs = manifest.generatedOutputs;

  if (!isObjectRecord(generator)) {
    failures.push('malformed manifest: missing generator object');
  } else {
    validateGeneratorMetadata(generator, failures);
  }

  if (!isObjectRecord(sourceVerification)) {
    failures.push('malformed manifest: missing sourceVerification object');
  }

  if (!Array.isArray(generatedOutputs)) {
    failures.push('malformed manifest: missing generatedOutputs array');
  }

  if (failures.length > 0) {
    return {
      manifestPath,
      checkedFiles: 0,
      failures,
    };
  }

  const fileChecks: FileCheck[] = [];
  const sourceVerificationRecord = sourceVerification as Record<string, unknown>;
  const outputRecords = generatedOutputs as unknown[];
  const reportPath = sourceVerificationRecord.reportPath;
  const reportSchemaVersion = sourceVerificationRecord.reportSchemaVersion;
  const reportMode = sourceVerificationRecord.reportMode;
  const source = sourceVerificationRecord.source;
  const docs = sourceVerificationRecord.docs;
  const summary = sourceVerificationRecord.summary;

  if (!isNonEmptyString(reportPath)) {
    failures.push('malformed manifest: sourceVerification.reportPath must be a non-empty string');
  } else if (isAbsolute(reportPath)) {
    failures.push(
      `malformed manifest: sourceVerification.reportPath must be relative: ${reportPath}`
    );
  } else if (!isInsideDirectory(manifestDir, resolve(manifestDir, reportPath))) {
    failures.push(
      `malformed manifest: sourceVerification.reportPath escapes manifest directory: ${reportPath}`
    );
  }

  if (reportSchemaVersion !== SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION) {
    failures.push(
      `malformed manifest: sourceVerification.reportSchemaVersion must be ${SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION}`
    );
  }

  if (reportMode !== SOURCE_VERIFICATION_MODE) {
    failures.push(
      `malformed manifest: sourceVerification.reportMode must be ${SOURCE_VERIFICATION_MODE}`
    );
  }

  validateSourceVerificationEndpoint(source, 'sourceVerification.source', failures);
  validateSourceVerificationEndpoint(docs, 'sourceVerification.docs', failures);
  validateSourceVerificationSummary(summary, 'sourceVerification.summary', failures);

  if (outputRecords.length !== 1) {
    failures.push(
      'malformed manifest: source-verification manifests must contain exactly one output'
    );
  }

  const outputRecord = outputRecords[0];
  if (isObjectRecord(outputRecord)) {
    if (
      isNonEmptyString(reportPath) &&
      !isAbsolute(reportPath) &&
      outputRecord.path !== reportPath
    ) {
      failures.push(
        'malformed manifest: generatedOutputs[0].path must match sourceVerification.reportPath'
      );
    }

    if (outputRecord.kind !== SOURCE_VERIFICATION_REPORT_OUTPUT_KIND) {
      failures.push(
        `malformed manifest: generatedOutputs[0].kind must be ${SOURCE_VERIFICATION_REPORT_OUTPUT_KIND}`
      );
    }
  }

  validateGeneratedOutputs({
    generatedOutputs: outputRecords,
    manifestDir,
    failures,
    fileChecks,
    requireTextMetadata: true,
    rejectSymlinks: true,
    rejectSymlinkAncestors: true,
    allowedKinds: SOURCE_VERIFICATION_GENERATED_OUTPUT_KINDS,
  });

  const checkedFiles = failures.length === 0 ? fileChecks.length : 0;

  if (failures.length === 0) {
    for (const check of fileChecks) {
      await verifyFile(check, failures);
    }
  }

  if (failures.length === 0 && isNonEmptyString(reportPath) && !isAbsolute(reportPath)) {
    await verifySourceVerificationReportFile({
      manifestDir,
      reportPath: resolve(manifestDir, reportPath),
      expected: {
        reportPath,
        source: source as Record<string, unknown>,
        docs: docs as Record<string, unknown>,
        summary: summary as Record<string, unknown>,
      },
      failures,
    });
  }

  return {
    manifestPath,
    checkedFiles,
    failures,
  };
}

interface DiscoveryReportSummary {
  schemaVersion: string;
  mode: string;
  candidateCount: number;
  warningCount: number;
  urlResourceCount?: number;
}

async function readDiscoveryReportJson(reportPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(reportPath, 'utf-8')) as unknown;
  } catch (error) {
    throw new Error(
      `discovery report must be readable JSON before writing manifest: ${errorMessage(error)}`
    );
  }
}

function summarizeDiscoveryReport(
  discoveryKind: DiscoveryReportKind,
  report: unknown
): DiscoveryReportSummary {
  if (!isObjectRecord(report)) {
    throw new Error('discovery report must be an object before writing manifest');
  }

  const expectedMode = DISCOVERY_REPORT_MODE_BY_KIND[discoveryKind];
  const candidates = report.candidates;
  const warnings = report.warnings;

  if (report.schemaVersion !== DISCOVERY_REPORT_SCHEMA_VERSION) {
    throw new Error(
      `discovery report schemaVersion must be ${DISCOVERY_REPORT_SCHEMA_VERSION} before writing manifest`
    );
  }

  if (report.mode !== expectedMode) {
    throw new Error(`discovery report mode must be ${expectedMode} before writing manifest`);
  }

  if (!Array.isArray(candidates)) {
    throw new Error('discovery report candidates must be an array before writing manifest');
  }

  if (!Array.isArray(warnings)) {
    throw new Error('discovery report warnings must be an array before writing manifest');
  }

  if (discoveryKind === 'url') {
    const inspectedResources = report.inspectedResources;

    if (!Array.isArray(inspectedResources)) {
      throw new Error(
        'website discovery report inspectedResources must be an array before writing manifest'
      );
    }

    return {
      schemaVersion: DISCOVERY_REPORT_SCHEMA_VERSION,
      mode: expectedMode,
      candidateCount: candidates.length,
      warningCount: warnings.length,
      urlResourceCount: inspectedResources.length,
    };
  }

  return {
    schemaVersion: DISCOVERY_REPORT_SCHEMA_VERSION,
    mode: expectedMode,
    candidateCount: candidates.length,
    warningCount: warnings.length,
  };
}

function buildDiscoveryCandidateEvidenceIndex(
  discoveryKind: DiscoveryReportKind,
  report: unknown
): DiscoveryCandidateEvidenceIndex {
  if (!isObjectRecord(report)) {
    throw new Error('discovery report must be an object before writing candidate evidence index');
  }

  const candidates = report.candidates;

  if (!Array.isArray(candidates)) {
    throw new Error(
      'discovery report candidates must be an array before writing candidate evidence index'
    );
  }

  const context = buildDiscoveryCandidateEvidenceContext(discoveryKind, report);
  const candidateEntries = candidates.map((candidate, index) =>
    buildDiscoveryCandidateEvidenceIndexCandidate(discoveryKind, candidate, index)
  );
  const hashData: DiscoveryCandidateEvidenceIndexHashData = {
    candidateCount: candidateEntries.length,
    context,
    candidates: candidateEntries,
  };

  return {
    candidateCount: hashData.candidateCount,
    aggregateHash: hashDiscoveryCandidateEvidenceIndex(hashData),
    context: hashData.context,
    candidates: hashData.candidates,
  };
}

function buildDiscoveryCandidateEvidenceContext(
  discoveryKind: DiscoveryReportKind,
  report: Record<string, unknown>
): DiscoveryCandidateEvidenceContext {
  if (discoveryKind === 'source') {
    const source = requiredObjectField(report, 'source', 'discovery report source');

    return {
      source: {
        input: requiredStringField(source, 'input', 'discovery report source'),
        resolvedPath: requiredStringField(source, 'resolvedPath', 'discovery report source'),
        type: requiredStringField(source, 'type', 'discovery report source'),
      },
    };
  }

  if (discoveryKind === 'repo') {
    const repo = requiredObjectField(report, 'repo', 'discovery report repo');
    const repoGit = requiredObjectField(repo, 'git', 'discovery report repo.git');
    const scope = requiredObjectField(report, 'scope', 'discovery report scope');

    return {
      repo: {
        input: requiredStringField(repo, 'input', 'discovery report repo'),
        normalizedInput: requiredStringField(repo, 'normalizedInput', 'discovery report repo'),
        commit: optionalStringOrNullField(repoGit, 'commit', 'discovery report repo.git'),
        dirty: optionalBooleanOrNullField(repoGit, 'dirty', 'discovery report repo.git'),
      },
      scope: {
        input: requiredStringField(scope, 'input', 'discovery report scope'),
        path: requiredStringField(scope, 'path', 'discovery report scope'),
        resolvedPath: requiredStringField(scope, 'resolvedPath', 'discovery report scope'),
        type: requiredStringField(scope, 'type', 'discovery report scope'),
      },
    };
  }

  const website = requiredObjectField(report, 'website', 'discovery report website');
  const crawlPolicy = requiredObjectField(report, 'crawlPolicy', 'discovery report crawlPolicy');
  const inspectedResources = report.inspectedResources;
  const sameOriginWellKnownResources = crawlPolicy.sameOriginWellKnownResources;

  if (!Array.isArray(inspectedResources)) {
    throw new Error(
      'discovery report inspectedResources must be an array before writing candidate evidence index'
    );
  }

  if (!Array.isArray(sameOriginWellKnownResources)) {
    throw new Error(
      'discovery report crawlPolicy.sameOriginWellKnownResources must be an array before writing candidate evidence index'
    );
  }

  const resourceFreshness = inspectedResources.map((resource, index) =>
    buildDiscoveryWebsiteResourceFreshnessIndexEntry(resource, index)
  );

  return {
    website: {
      input: requiredStringField(website, 'input', 'discovery report website'),
      normalizedUrl: requiredStringField(website, 'normalizedUrl', 'discovery report website'),
      origin: requiredStringField(website, 'origin', 'discovery report website'),
    },
    crawlPolicy: {
      linkedCandidateFetches: requiredFalseField(
        crawlPolicy,
        'linkedCandidateFetches',
        'discovery report crawlPolicy'
      ),
      renderedJavaScript: requiredFalseField(
        crawlPolicy,
        'renderedJavaScript',
        'discovery report crawlPolicy'
      ),
      inspectedResourceCount: inspectedResources.length,
      sameOriginWellKnownResourceCount: sameOriginWellKnownResources.length,
    },
    resourceFreshness,
  };
}

function buildDiscoveryWebsiteResourceFreshnessIndexEntry(
  resource: unknown,
  resourceIndex: number
): WebsiteResourceFreshnessIndexEntry {
  if (!isObjectRecord(resource)) {
    throw new Error(
      `discovery report inspectedResources[${resourceIndex}] must be an object before writing candidate evidence index`
    );
  }

  const resourceLabel = `discovery report inspectedResources[${resourceIndex}]`;
  const freshness = requiredObjectField(resource, 'freshness', resourceLabel);
  const freshnessLabel = `${resourceLabel}.freshness`;

  return {
    url: requiredStringField(resource, 'url', resourceLabel),
    sourceRole: requiredStringField(resource, 'sourceRole', resourceLabel),
    observedAt: requiredStringField(freshness, 'observedAt', freshnessLabel),
    etag: optionalStringOrNullField(freshness, 'etag', freshnessLabel),
    lastModified: optionalStringOrNullField(freshness, 'lastModified', freshnessLabel),
  };
}

function buildDiscoveryCandidateEvidenceIndexCandidate(
  discoveryKind: DiscoveryReportKind,
  candidate: unknown,
  index: number
): DiscoveryCandidateEvidenceIndexCandidate {
  if (!isObjectRecord(candidate)) {
    throw new Error(
      `discovery report candidates[${index}] must be an object before writing candidate evidence index`
    );
  }

  const order = requiredPositiveIntegerField(
    candidate,
    'order',
    `discovery report candidates[${index}]`
  );
  const evidence = buildDiscoveryCandidateEvidence(candidate.evidence, index);

  if (discoveryKind === 'url') {
    const entry: DiscoveryCandidateEvidenceIndexCandidate = {
      url: requiredStringField(candidate, 'url', `discovery report candidates[${index}]`),
      order,
      evidence,
      sameOrigin: requiredBooleanField(
        candidate,
        'sameOrigin',
        `discovery report candidates[${index}]`
      ),
      external: requiredBooleanField(
        candidate,
        'external',
        `discovery report candidates[${index}]`
      ),
    };

    if (Array.isArray(candidate.sourceResources) && candidate.sourceResources.length > 0) {
      entry.sourceResources = candidate.sourceResources.map((sourceResource, sourceIndex) =>
        buildDiscoveryCandidateSourceResource(sourceResource, index, sourceIndex)
      );
    }

    return entry;
  }

  const hints = optionalStringArrayField(
    candidate,
    'hints',
    `discovery report candidates[${index}]`
  );
  const formatHints = optionalStringArrayField(
    candidate,
    'formatHints',
    `discovery report candidates[${index}]`
  );
  const entry: DiscoveryCandidateEvidenceIndexCandidate = {
    path: requiredStringField(candidate, 'path', `discovery report candidates[${index}]`),
    order,
    kind: requiredStringField(candidate, 'kind', `discovery report candidates[${index}]`),
    format: requiredStringField(candidate, 'format', `discovery report candidates[${index}]`),
    evidence,
    byteSize: requiredNonNegativeIntegerField(
      candidate,
      'byteSize',
      `discovery report candidates[${index}]`
    ),
    sha256: requiredUnprefixedSha256Field(
      candidate,
      'sha256',
      `discovery report candidates[${index}]`
    ),
  };

  if (hints.length > 0) {
    entry.hints = hints;
  }

  if (formatHints.length > 0) {
    entry.formatHints = formatHints;
  }

  return entry;
}

function buildDiscoveryCandidateEvidence(
  evidence: unknown,
  candidateIndex: number
): DiscoveryCandidateEvidenceIndexCandidate['evidence'] {
  if (!isObjectRecord(evidence)) {
    throw new Error(
      `discovery report candidates[${candidateIndex}].evidence must be an object before writing candidate evidence index`
    );
  }

  const entry: DiscoveryCandidateEvidenceIndexCandidate['evidence'] = {};
  const category = evidence.category;
  const signals = evidence.signals;
  const relations = evidence.relations;
  const flags = evidence.flags;

  if (typeof category === 'string') {
    entry.category = category;
  }

  if (Array.isArray(signals)) {
    entry.signals = requireStringArray(
      signals,
      `discovery report candidates[${candidateIndex}].evidence.signals`
    );
  }

  if (Array.isArray(relations)) {
    entry.relations = requireStringArray(
      relations,
      `discovery report candidates[${candidateIndex}].evidence.relations`
    );
  }

  if (Array.isArray(flags)) {
    entry.flags = requireStringArray(
      flags,
      `discovery report candidates[${candidateIndex}].evidence.flags`
    );
  }

  return entry;
}

function buildDiscoveryCandidateSourceResource(
  sourceResource: unknown,
  candidateIndex: number,
  sourceIndex: number
): NonNullable<DiscoveryCandidateEvidenceIndexCandidate['sourceResources']>[number] {
  if (!isObjectRecord(sourceResource)) {
    throw new Error(
      `discovery report candidates[${candidateIndex}].sourceResources[${sourceIndex}] must be an object before writing candidate evidence index`
    );
  }

  const label = `discovery report candidates[${candidateIndex}].sourceResources[${sourceIndex}]`;

  return {
    url: requiredStringField(sourceResource, 'url', label),
    sourceRole: requiredStringField(sourceResource, 'sourceRole', label),
    evidence: requiredStringField(sourceResource, 'evidence', label),
  };
}

function hashDiscoveryCandidateEvidenceIndex(
  index: DiscoveryCandidateEvidenceIndexHashData
): string {
  const hash = createHash('sha256');

  hash.update(DISCOVERY_CANDIDATE_EVIDENCE_INDEX_HASH_SEED);
  hash.update(JSON.stringify(index));
  hash.update('\n');

  return `${HASH_PREFIX}${hash.digest('hex')}`;
}

function discoveryCandidateEvidenceIndexesEqual(
  expected: DiscoveryCandidateEvidenceIndex,
  actual: DiscoveryCandidateEvidenceIndex
): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function requiredObjectField(
  value: Record<string, unknown>,
  field: string,
  label: string
): Record<string, unknown> {
  const fieldValue = value[field];

  if (!isObjectRecord(fieldValue)) {
    throw new Error(`${label}.${field} must be an object`);
  }

  return fieldValue;
}

function requiredStringField(value: Record<string, unknown>, field: string, label: string): string {
  const fieldValue = value[field];

  if (!isNonEmptyString(fieldValue)) {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }

  return fieldValue;
}

function optionalStringOrNullField(
  value: Record<string, unknown>,
  field: string,
  label: string
): string | null {
  const fieldValue = value[field];

  if (fieldValue === undefined || fieldValue === null) {
    return null;
  }

  if (!isNonEmptyString(fieldValue)) {
    throw new Error(`${label}.${field} must be a non-empty string or null`);
  }

  return fieldValue;
}

function requiredBooleanField(
  value: Record<string, unknown>,
  field: string,
  label: string
): boolean {
  const fieldValue = value[field];

  if (typeof fieldValue !== 'boolean') {
    throw new Error(`${label}.${field} must be a boolean`);
  }

  return fieldValue;
}

function optionalBooleanOrNullField(
  value: Record<string, unknown>,
  field: string,
  label: string
): boolean | null {
  const fieldValue = value[field];

  if (fieldValue === undefined || fieldValue === null) {
    return null;
  }

  if (typeof fieldValue !== 'boolean') {
    throw new Error(`${label}.${field} must be a boolean or null`);
  }

  return fieldValue;
}

function requiredFalseField(value: Record<string, unknown>, field: string, label: string): false {
  const fieldValue = value[field];

  if (fieldValue !== false) {
    throw new Error(`${label}.${field} must be false`);
  }

  return false;
}

function requiredPositiveIntegerField(
  value: Record<string, unknown>,
  field: string,
  label: string
): number {
  const fieldValue = value[field];

  if (!isPositiveInteger(fieldValue)) {
    throw new Error(`${label}.${field} must be a positive integer`);
  }

  return fieldValue;
}

function requiredNonNegativeIntegerField(
  value: Record<string, unknown>,
  field: string,
  label: string
): number {
  const fieldValue = value[field];

  if (!isNonNegativeInteger(fieldValue)) {
    throw new Error(`${label}.${field} must be a non-negative integer`);
  }

  return fieldValue;
}

function requiredUnprefixedSha256Field(
  value: Record<string, unknown>,
  field: string,
  label: string
): string {
  const fieldValue = value[field];

  if (!isUnprefixedSha256Hash(fieldValue)) {
    throw new Error(`${label}.${field} must be a sha256 hex digest`);
  }

  return fieldValue;
}

function optionalStringArrayField(
  value: Record<string, unknown>,
  field: string,
  label: string
): string[] {
  const fieldValue = value[field];

  if (fieldValue === undefined) {
    return [];
  }

  if (!Array.isArray(fieldValue)) {
    throw new Error(`${label}.${field} must be a string array`);
  }

  return requireStringArray(fieldValue, `${label}.${field}`);
}

function requireStringArray(values: unknown[], label: string): string[] {
  if (!values.every((value) => typeof value === 'string')) {
    throw new Error(`${label} must contain only strings`);
  }

  return values;
}

function validateGeneratorMetadata(generator: Record<string, unknown>, failures: string[]): void {
  if (!isNonEmptyString(generator.name)) {
    failures.push('malformed manifest: generator.name must be a non-empty string');
  }

  if (!isNonEmptyString(generator.version)) {
    failures.push('malformed manifest: generator.version must be a non-empty string');
  }

  if ('cliName' in generator && !isNonEmptyString(generator.cliName)) {
    failures.push('malformed manifest: generator.cliName must be a non-empty string when present');
  }
}

function validateConfiguredSdkMetadata(sdk: Record<string, unknown>, failures: string[]): void {
  if (!isNonEmptyString(sdk.name)) {
    failures.push('malformed manifest: sdk.name must be a non-empty string');
  }

  if (!isNonEmptyString(sdk.resolvedVersion)) {
    failures.push('malformed manifest: sdk.resolvedVersion must be a non-empty string');
  }

  if (!isNonEmptyString(sdk.displayName)) {
    failures.push('malformed manifest: sdk.displayName must be a non-empty string');
  }
}

function validateConfiguredSdkParserMetadata(
  parser: Record<string, unknown>,
  failures: string[]
): void {
  if (!isNonEmptyString(parser.name)) {
    failures.push('malformed manifest: parser.name must be a non-empty string');
  } else if (parser.name !== CONFIGURED_SDK_PARSER_NAME) {
    failures.push(`malformed manifest: parser.name must be ${CONFIGURED_SDK_PARSER_NAME}`);
  }

  if (!isNonEmptyString(parser.version)) {
    failures.push('malformed manifest: parser.version must be a non-empty string');
  }

  if (parser.format !== CONFIGURED_SDK_PARSER_FORMAT) {
    failures.push(`malformed manifest: parser.format must be ${CONFIGURED_SDK_PARSER_FORMAT}`);
  }
}

function validateConfiguredSdkFormatterMetadata(
  formatter: Record<string, unknown>,
  failures: string[]
): void {
  if (formatter.name !== CONFIGURED_SDK_FORMATTER_NAME) {
    failures.push(`malformed manifest: formatter.name must be ${CONFIGURED_SDK_FORMATTER_NAME}`);
  }

  if (!isNonEmptyString(formatter.version)) {
    failures.push('malformed manifest: formatter.version must be a non-empty string');
  }

  if (formatter.format !== CONFIGURED_SDK_FORMATTER_FORMAT) {
    failures.push(
      `malformed manifest: formatter.format must be ${CONFIGURED_SDK_FORMATTER_FORMAT}`
    );
  }
}

interface SourceDocsParserPluginRecord {
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
  format: ParserPluginFormatMetadata;
}

function validateSourceDocsParserMetadata(
  parser: Record<string, unknown>,
  sourceResolvedFormat: unknown,
  parserPluginFormatId: string | undefined,
  failures: string[]
): void {
  const parserFormat = parser.format;

  if (!isNonEmptyString(parser.name)) {
    failures.push('malformed manifest: parser.name must be a non-empty string');
  }

  if (!isNonEmptyString(parser.version)) {
    failures.push('malformed manifest: parser.version must be a non-empty string');
  }

  if (!isNonEmptyString(parserFormat)) {
    failures.push('malformed manifest: parser.format must be a supported source format');
    return;
  }

  if (parserPluginFormatId === undefined && !SOURCE_DOCS_RESOLVED_FORMATS.has(parserFormat)) {
    failures.push('malformed manifest: parser.format must be a supported source format');
    return;
  }

  if (parserPluginFormatId !== undefined && parserFormat !== parserPluginFormatId) {
    failures.push('malformed manifest: parser.format must match parser.plugin.format.id');
  }

  if (isNonEmptyString(sourceResolvedFormat) && parserFormat !== sourceResolvedFormat) {
    failures.push('malformed manifest: parser.format must match source.resolvedFormat');
  }
}

function validateSourceDocsParserPluginMetadata(
  plugin: unknown,
  failures: string[],
  fileChecks: FileCheck[]
): SourceDocsParserPluginRecord | undefined {
  if (plugin === undefined) {
    return undefined;
  }

  if (!isObjectRecord(plugin)) {
    failures.push('malformed manifest: parser.plugin must be an object when present');
    return undefined;
  }

  const manifestPath = plugin.manifestPath;
  const resolvedManifestPath = plugin.resolvedManifestPath;
  const manifestByteSize = plugin.manifestByteSize;
  const manifestHash = plugin.manifestHash;
  const moduleMetadata = plugin.module;
  const formatMetadata = plugin.format;
  const execution = plugin.execution;

  if (!isNonEmptyString(manifestPath)) {
    failures.push('malformed manifest: parser.plugin.manifestPath must be a non-empty string');
  }

  if (!isNonEmptyString(resolvedManifestPath)) {
    failures.push(
      'malformed manifest: parser.plugin.resolvedManifestPath must be a non-empty string'
    );
  } else if (!isAbsolute(resolvedManifestPath)) {
    failures.push('malformed manifest: parser.plugin.resolvedManifestPath must be absolute');
  }

  if (!isNonNegativeInteger(manifestByteSize)) {
    failures.push(
      'malformed manifest: parser.plugin.manifestByteSize must be a non-negative integer'
    );
  }

  if (!isSha256Hash(manifestHash)) {
    failures.push('malformed manifest: parser.plugin.manifestHash must be a sha256 hash');
  }

  if (!isNonEmptyString(plugin.name)) {
    failures.push('malformed manifest: parser.plugin.name must be a non-empty string');
  }

  if (!isNonEmptyString(plugin.version)) {
    failures.push('malformed manifest: parser.plugin.version must be a non-empty string');
  }

  const moduleRecord = validateSourceDocsParserPluginModuleMetadata(moduleMetadata, failures);
  const formatRecord = validateSourceDocsParserPluginFormatMetadata(formatMetadata, failures);
  validateSourceDocsParserPluginExecutionMetadata(execution, failures);

  if (
    isNonEmptyString(resolvedManifestPath) &&
    isAbsolute(resolvedManifestPath) &&
    isNonNegativeInteger(manifestByteSize) &&
    isSha256Hash(manifestHash)
  ) {
    fileChecks.push({
      label: 'parser.plugin.manifest',
      path: resolvedManifestPath,
      expectedByteSize: manifestByteSize,
      expectedHash: manifestHash,
    });
  }

  if (
    !isNonEmptyString(manifestPath) ||
    !isNonEmptyString(resolvedManifestPath) ||
    !isAbsolute(resolvedManifestPath) ||
    !isNonNegativeInteger(manifestByteSize) ||
    !isSha256Hash(manifestHash) ||
    !isNonEmptyString(plugin.name) ||
    !isNonEmptyString(plugin.version) ||
    moduleRecord === undefined ||
    formatRecord === undefined
  ) {
    return undefined;
  }

  return {
    manifestPath,
    resolvedManifestPath,
    manifestByteSize,
    manifestHash,
    name: plugin.name,
    version: plugin.version,
    module: moduleRecord,
    format: formatRecord,
  };
}

function validateSourceDocsParserPluginModuleMetadata(
  moduleMetadata: unknown,
  failures: string[]
): SourceDocsParserPluginRecord['module'] | undefined {
  if (!isObjectRecord(moduleMetadata)) {
    failures.push('malformed manifest: parser.plugin.module must be an object');
    return undefined;
  }

  const modulePath = moduleMetadata.path;
  const moduleResolvedPath = moduleMetadata.resolvedPath;
  let valid = true;

  if (!isNonEmptyString(modulePath)) {
    failures.push('malformed manifest: parser.plugin.module.path must be a non-empty string');
    valid = false;
  } else if (
    isUrlLikePath(modulePath) ||
    isAbsolute(modulePath) ||
    win32.isAbsolute(modulePath) ||
    hasEmptyOrParentPathSegment(modulePath)
  ) {
    failures.push('malformed manifest: parser.plugin.module.path must be relative');
    valid = false;
  }

  if (!isNonEmptyString(moduleResolvedPath)) {
    failures.push(
      'malformed manifest: parser.plugin.module.resolvedPath must be a non-empty string'
    );
    valid = false;
  } else if (!isAbsolute(moduleResolvedPath)) {
    failures.push('malformed manifest: parser.plugin.module.resolvedPath must be absolute');
    valid = false;
  }

  return valid && isNonEmptyString(modulePath) && isNonEmptyString(moduleResolvedPath)
    ? {
        path: modulePath,
        resolvedPath: moduleResolvedPath,
      }
    : undefined;
}

function validateSourceDocsParserPluginFormatMetadata(
  formatMetadata: unknown,
  failures: string[]
): ParserPluginFormatMetadata | undefined {
  if (!isObjectRecord(formatMetadata)) {
    failures.push('malformed manifest: parser.plugin.format must be an object');
    return undefined;
  }

  const formatId = formatMetadata.id;
  const extensions = formatMetadata.extensions;
  const mediaTypes = formatMetadata.mediaTypes;
  const directorySupport = formatMetadata.directorySupport;
  let valid = true;

  if (!isNonEmptyString(formatId) || !SOURCE_DOCS_PLUGIN_FORMAT_ID_PATTERN.test(formatId)) {
    failures.push("malformed manifest: parser.plugin.format.id must match '^[a-z][a-z0-9-]*$'");
    valid = false;
  }

  if (!isNonEmptyString(formatMetadata.displayName)) {
    failures.push(
      'malformed manifest: parser.plugin.format.displayName must be a non-empty string'
    );
    valid = false;
  }

  if (!Array.isArray(extensions) || extensions.length === 0) {
    failures.push('malformed manifest: parser.plugin.format.extensions must be a non-empty array');
    valid = false;
  } else if (!extensions.every((extension) => isNonEmptyString(extension))) {
    failures.push('malformed manifest: parser.plugin.format.extensions must contain only strings');
    valid = false;
  }

  let parsedMediaTypes: string[] | undefined;
  if (mediaTypes !== undefined) {
    parsedMediaTypes = validateOptionalStringArray(
      mediaTypes,
      'parser.plugin.format.mediaTypes',
      failures
    );

    if (parsedMediaTypes === undefined) {
      valid = false;
    }

    if (
      parsedMediaTypes !== undefined &&
      parsedMediaTypes.some((mediaType) => mediaType.length === 0)
    ) {
      failures.push(
        'malformed manifest: parser.plugin.format.mediaTypes must contain only non-empty strings'
      );
      valid = false;
    }
  }

  if (directorySupport !== undefined && typeof directorySupport !== 'boolean') {
    failures.push('malformed manifest: parser.plugin.format.directorySupport must be a boolean');
    valid = false;
  }

  return valid &&
    isNonEmptyString(formatId) &&
    SOURCE_DOCS_PLUGIN_FORMAT_ID_PATTERN.test(formatId) &&
    isNonEmptyString(formatMetadata.displayName) &&
    Array.isArray(extensions) &&
    extensions.length > 0 &&
    extensions.every((extension) => isNonEmptyString(extension))
    ? {
        id: formatId,
        displayName: formatMetadata.displayName,
        extensions,
        ...(parsedMediaTypes === undefined ? {} : { mediaTypes: parsedMediaTypes }),
        ...(typeof directorySupport === 'boolean' ? { directorySupport } : {}),
      }
    : undefined;
}

function validateSourceDocsParserPluginExecutionMetadata(
  execution: unknown,
  failures: string[]
): void {
  if (!isObjectRecord(execution)) {
    failures.push('malformed manifest: parser.plugin.execution must be an object');
    return;
  }

  if (execution.codeExecuted !== true) {
    failures.push('malformed manifest: parser.plugin.execution.codeExecuted must be true');
  }

  if (execution.trust !== 'trusted-local-code') {
    failures.push("malformed manifest: parser.plugin.execution.trust must be 'trusted-local-code'");
  }

  if (execution.sandboxed !== false) {
    failures.push('malformed manifest: parser.plugin.execution.sandboxed must be false');
  }

  if (!isNonEmptyString(execution.statement)) {
    failures.push(
      'malformed manifest: parser.plugin.execution.statement must be a non-empty string'
    );
  }
}

function validateSourceDocsParserPluginGeneratedOutputs(
  generatedOutputs: unknown[],
  failures: string[]
): void {
  for (const [index, output] of generatedOutputs.entries()) {
    if (!isObjectRecord(output)) {
      continue;
    }

    if (output.kind === SOURCE_DOCS_SEMANTIC_CHUNK_JSONL_KIND) {
      failures.push(
        `malformed manifest: generatedOutputs[${index}].kind must not be semantic-chunks-jsonl for parser.plugin source manifests`
      );
    }
  }
}

async function verifySourceDocsParserPluginManifestMetadata(
  recorded: SourceDocsParserPluginRecord,
  failures: string[]
): Promise<void> {
  try {
    const actualManifestFile = await describeFile(recorded.resolvedManifestPath);

    if (actualManifestFile.byteSize !== recorded.manifestByteSize) {
      failures.push(
        'parser.plugin.manifest: byte size does not match parser.plugin.manifestByteSize'
      );
    }

    if (actualManifestFile.hash !== recorded.manifestHash) {
      failures.push('parser.plugin.manifest: hash does not match parser.plugin.manifestHash');
    }
  } catch (error) {
    if (isFileNotFoundError(error)) {
      failures.push(`parser.plugin.manifest: missing file at ${recorded.resolvedManifestPath}`);
      return;
    }

    failures.push(
      `parser.plugin.manifest: cannot read ${recorded.resolvedManifestPath}: ${errorMessage(error)}`
    );
    return;
  }

  const validation = await validateParserPluginManifestFile({
    manifestPath: recorded.resolvedManifestPath,
  });

  if (!validation.valid || validation.manifest === undefined) {
    const details = validation.errors.map((error) => `${error.path}: ${error.message}`).join('; ');

    failures.push(`parser.plugin.manifest: recorded plugin manifest is invalid: ${details}`);
    return;
  }

  compareParserPluginManifestMetadata(recorded, validation.manifest, failures);
}

function compareParserPluginManifestMetadata(
  recorded: SourceDocsParserPluginRecord,
  manifest: ParserPluginManifestMetadata,
  failures: string[]
): void {
  if (recorded.name !== manifest.name) {
    failures.push('parser.plugin.name must match parser plugin manifest name');
  }

  if (recorded.version !== manifest.version) {
    failures.push('parser.plugin.version must match parser plugin manifest version');
  }

  if (recorded.module.path !== manifest.module) {
    failures.push('parser.plugin.module.path must match parser plugin manifest module');
  }

  const selectedFormat = manifest.formats.find((format) => format.id === recorded.format.id);

  if (selectedFormat === undefined) {
    failures.push('parser.plugin.format.id must match a format declared by the plugin manifest');
    return;
  }

  compareParserPluginFormatMetadata(recorded.format, selectedFormat, failures);
}

function compareParserPluginFormatMetadata(
  recorded: ParserPluginFormatMetadata,
  selectedFormat: ParserPluginFormatMetadata,
  failures: string[]
): void {
  if (recorded.displayName !== selectedFormat.displayName) {
    failures.push(
      'parser.plugin.format.displayName must match parser plugin manifest selected format'
    );
  }

  if (!sameStringArray(recorded.extensions, selectedFormat.extensions)) {
    failures.push(
      'parser.plugin.format.extensions must match parser plugin manifest selected format'
    );
  }

  if (!sameOptionalStringArray(recorded.mediaTypes, selectedFormat.mediaTypes)) {
    failures.push(
      'parser.plugin.format.mediaTypes must match parser plugin manifest selected format'
    );
  }

  if (recorded.directorySupport !== selectedFormat.directorySupport) {
    failures.push(
      'parser.plugin.format.directorySupport must match parser plugin manifest selected format'
    );
  }
}

function validateSourceDocsFormatterMetadata(
  formatter: Record<string, unknown>,
  failures: string[]
): void {
  if (formatter.name !== SOURCE_DOCS_FORMATTER_NAME) {
    failures.push(`malformed manifest: formatter.name must be ${SOURCE_DOCS_FORMATTER_NAME}`);
  }

  if (!isNonEmptyString(formatter.version)) {
    failures.push('malformed manifest: formatter.version must be a non-empty string');
  }

  if (formatter.format !== SOURCE_DOCS_FORMATTER_FORMAT) {
    failures.push(`malformed manifest: formatter.format must be ${SOURCE_DOCS_FORMATTER_FORMAT}`);
  }
}

async function verifyDiscoveryReportFile(options: {
  manifestDir: string;
  reportPath: string;
  expected: {
    kind: DiscoveryReportKind;
    schemaVersion: string;
    mode: string;
    candidateCount: number;
    warningCount: number;
    urlResourceCount?: number;
  };
  candidateEvidenceIndex: DiscoveryCandidateEvidenceIndex | undefined;
  failures: string[];
}): Promise<void> {
  const { manifestDir, reportPath, expected, candidateEvidenceIndex, failures } = options;
  let report: unknown;

  try {
    report = JSON.parse(await readFile(reportPath, 'utf-8')) as unknown;
  } catch (error) {
    failures.push(`discovery report: malformed JSON: ${errorMessage(error)}`);
    return;
  }

  if (!isObjectRecord(report)) {
    failures.push('discovery report: root must be an object');
    return;
  }

  if (report.schemaVersion !== expected.schemaVersion) {
    failures.push(
      `discovery report: schemaVersion mismatch (expected ${expected.schemaVersion}, actual ${String(
        report.schemaVersion
      )})`
    );
  }

  if (report.mode !== expected.mode) {
    failures.push(
      `discovery report: mode mismatch (expected ${expected.mode}, actual ${String(report.mode)})`
    );
  }

  const output = report.output;
  if (!isObjectRecord(output)) {
    failures.push('discovery report: missing output object');
  } else if (!isNonEmptyString(output.reportPath)) {
    failures.push('discovery report: output.reportPath must be a non-empty string');
  } else if (resolveManifestSourcePath(output.reportPath, manifestDir) !== reportPath) {
    failures.push('discovery report: output.reportPath must match manifest discovery.reportPath');
  }

  validateDiscoveryReportKindShape(report, expected.kind, failures);
  validateDiscoveryReportCounts(report, expected, failures);

  if (candidateEvidenceIndex !== undefined) {
    verifyDiscoveryCandidateEvidenceIndexAgainstReport({
      discoveryKind: expected.kind,
      report,
      manifestIndex: candidateEvidenceIndex,
      failures,
    });
  }
}

function validateDiscoveryReportKindShape(
  report: Record<string, unknown>,
  kind: DiscoveryReportKind,
  failures: string[]
): void {
  if (kind === 'source') {
    if (!isObjectRecord(report.source)) {
      failures.push('discovery report: source discovery must include source object');
    }

    return;
  }

  if (kind === 'repo') {
    if (!isObjectRecord(report.repo)) {
      failures.push('discovery report: repo discovery must include repo object');
    }

    if (!isObjectRecord(report.scope)) {
      failures.push('discovery report: repo discovery must include scope object');
    }

    return;
  }

  if (!isObjectRecord(report.website)) {
    failures.push('discovery report: url discovery must include website object');
  }

  if (!isObjectRecord(report.crawlPolicy)) {
    failures.push('discovery report: url discovery must include crawlPolicy object');
  }
}

function validateDiscoveryReportCounts(
  report: Record<string, unknown>,
  expected: {
    kind: DiscoveryReportKind;
    candidateCount: number;
    warningCount: number;
    urlResourceCount?: number;
  },
  failures: string[]
): void {
  const candidates = report.candidates;
  const warnings = report.warnings;

  if (!Array.isArray(candidates)) {
    failures.push('discovery report: candidates must be an array');
  } else if (candidates.length !== expected.candidateCount) {
    failures.push(
      `discovery report: candidate count mismatch (expected ${expected.candidateCount}, actual ${candidates.length})`
    );
  }

  if (!Array.isArray(warnings)) {
    failures.push('discovery report: warnings must be an array');
  } else if (warnings.length !== expected.warningCount) {
    failures.push(
      `discovery report: warning count mismatch (expected ${expected.warningCount}, actual ${warnings.length})`
    );
  }

  if (expected.kind !== 'url') {
    return;
  }

  const inspectedResources = report.inspectedResources;

  if (!Array.isArray(inspectedResources)) {
    failures.push('discovery report: inspectedResources must be an array for url discovery');
  } else if (inspectedResources.length !== expected.urlResourceCount) {
    failures.push(
      `discovery report: URL resource count mismatch (expected ${String(
        expected.urlResourceCount
      )}, actual ${inspectedResources.length})`
    );
  }
}

function validateDiscoveryCandidateEvidenceIndex(options: {
  index: unknown;
  discoveryKind: DiscoveryReportKind;
  failures: string[];
}): DiscoveryCandidateEvidenceIndex | undefined {
  const { index, discoveryKind, failures } = options;
  const initialFailureCount = failures.length;

  if (!isObjectRecord(index)) {
    failures.push('malformed manifest: candidateEvidenceIndex must be an object when present');
    return undefined;
  }

  validateAllowedKeys(
    index,
    DISCOVERY_CANDIDATE_EVIDENCE_INDEX_KEYS,
    'candidateEvidenceIndex',
    failures
  );

  const candidateCount = index.candidateCount;
  const aggregateHash = index.aggregateHash;
  const context = validateDiscoveryCandidateEvidenceIndexContext({
    context: index.context,
    discoveryKind,
    failures,
  });
  const candidateEntries: DiscoveryCandidateEvidenceIndexCandidate[] = [];

  if (!isNonNegativeInteger(candidateCount)) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.candidateCount must be a non-negative integer'
    );
  }

  if (!isSha256Hash(aggregateHash)) {
    failures.push('malformed manifest: candidateEvidenceIndex.aggregateHash must be a sha256 hash');
  }

  if (!Array.isArray(index.candidates)) {
    failures.push('malformed manifest: candidateEvidenceIndex.candidates must be an array');
  } else {
    for (const [candidateIndex, candidate] of index.candidates.entries()) {
      const entry = validateDiscoveryCandidateEvidenceIndexCandidate({
        candidate,
        candidateIndex,
        discoveryKind,
        failures,
      });

      if (entry !== undefined) {
        candidateEntries.push(entry);
      }
    }

    if (isNonNegativeInteger(candidateCount) && candidateCount !== index.candidates.length) {
      failures.push(
        'malformed manifest: candidateEvidenceIndex.candidateCount must match candidates length'
      );
    }
  }

  if (
    context !== undefined &&
    isNonNegativeInteger(candidateCount) &&
    isSha256Hash(aggregateHash) &&
    Array.isArray(index.candidates) &&
    candidateEntries.length === index.candidates.length
  ) {
    const hashData: DiscoveryCandidateEvidenceIndexHashData = {
      candidateCount,
      context,
      candidates: candidateEntries,
    };
    const actualAggregateHash = hashDiscoveryCandidateEvidenceIndex(hashData);

    if (aggregateHash !== actualAggregateHash) {
      failures.push(
        'malformed manifest: candidateEvidenceIndex.aggregateHash must match candidate evidence index metadata'
      );
    }
  }

  if (failures.length !== initialFailureCount) {
    return undefined;
  }

  return {
    candidateCount: candidateCount as number,
    aggregateHash: aggregateHash as string,
    context: context as DiscoveryCandidateEvidenceContext,
    candidates: candidateEntries,
  };
}

function validateDiscoveryCandidateEvidenceIndexContext(options: {
  context: unknown;
  discoveryKind: DiscoveryReportKind;
  failures: string[];
}): DiscoveryCandidateEvidenceContext | undefined {
  const { context, discoveryKind, failures } = options;

  if (!isObjectRecord(context)) {
    failures.push('malformed manifest: candidateEvidenceIndex.context must be an object');
    return undefined;
  }

  validateAllowedKeys(
    context,
    DISCOVERY_CANDIDATE_EVIDENCE_CONTEXT_KEYS_BY_KIND[discoveryKind],
    'candidateEvidenceIndex.context',
    failures
  );

  if (discoveryKind === 'source') {
    return validateDiscoverySourceCandidateEvidenceContext(context, failures);
  }

  if (discoveryKind === 'repo') {
    return validateDiscoveryRepoCandidateEvidenceContext(context, failures);
  }

  return validateDiscoveryWebsiteCandidateEvidenceContext(context, failures);
}

function validateDiscoverySourceCandidateEvidenceContext(
  context: Record<string, unknown>,
  failures: string[]
): DiscoveryCandidateEvidenceContext | undefined {
  const source = context.source;

  if (!isObjectRecord(source)) {
    failures.push('malformed manifest: candidateEvidenceIndex.context.source must be an object');
    return undefined;
  }

  validateAllowedKeys(
    source,
    DISCOVERY_SOURCE_CONTEXT_KEYS,
    'candidateEvidenceIndex.context.source',
    failures
  );

  if (
    !isNonEmptyString(source.input) ||
    !isNonEmptyString(source.resolvedPath) ||
    !isNonEmptyString(source.type)
  ) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.source must include input, resolvedPath, and type strings'
    );
    return undefined;
  }

  return {
    source: {
      input: source.input,
      resolvedPath: source.resolvedPath,
      type: source.type,
    },
  };
}

function validateDiscoveryRepoCandidateEvidenceContext(
  context: Record<string, unknown>,
  failures: string[]
): DiscoveryCandidateEvidenceContext | undefined {
  const repo = context.repo;
  const scope = context.scope;

  if (!isObjectRecord(repo)) {
    failures.push('malformed manifest: candidateEvidenceIndex.context.repo must be an object');
    return undefined;
  }

  if (!isObjectRecord(scope)) {
    failures.push('malformed manifest: candidateEvidenceIndex.context.scope must be an object');
    return undefined;
  }

  validateAllowedKeys(
    repo,
    DISCOVERY_REPO_CONTEXT_KEYS,
    'candidateEvidenceIndex.context.repo',
    failures
  );
  validateAllowedKeys(
    scope,
    DISCOVERY_REPO_SCOPE_CONTEXT_KEYS,
    'candidateEvidenceIndex.context.scope',
    failures
  );

  if (!isNonEmptyString(repo.input) || !isNonEmptyString(repo.normalizedInput)) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.repo must include input and normalizedInput strings'
    );
    return undefined;
  }

  if (repo.commit !== null && !isNonEmptyString(repo.commit)) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.repo.commit must be a string or null'
    );
    return undefined;
  }

  if (repo.dirty !== null && typeof repo.dirty !== 'boolean') {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.repo.dirty must be a boolean or null'
    );
    return undefined;
  }

  if (
    !isNonEmptyString(scope.input) ||
    !isNonEmptyString(scope.path) ||
    !isNonEmptyString(scope.resolvedPath) ||
    !isNonEmptyString(scope.type)
  ) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.scope must include input, path, resolvedPath, and type strings'
    );
    return undefined;
  }

  return {
    repo: {
      input: repo.input,
      normalizedInput: repo.normalizedInput,
      commit: repo.commit,
      dirty: repo.dirty,
    },
    scope: {
      input: scope.input,
      path: scope.path,
      resolvedPath: scope.resolvedPath,
      type: scope.type,
    },
  };
}

function validateDiscoveryWebsiteCandidateEvidenceContext(
  context: Record<string, unknown>,
  failures: string[]
): DiscoveryCandidateEvidenceContext | undefined {
  const website = context.website;
  const crawlPolicy = context.crawlPolicy;
  const resourceFreshness = context.resourceFreshness;

  if (!isObjectRecord(website)) {
    failures.push('malformed manifest: candidateEvidenceIndex.context.website must be an object');
    return undefined;
  }

  if (!isObjectRecord(crawlPolicy)) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.crawlPolicy must be an object'
    );
    return undefined;
  }

  validateAllowedKeys(
    website,
    DISCOVERY_WEBSITE_CONTEXT_KEYS,
    'candidateEvidenceIndex.context.website',
    failures
  );
  validateAllowedKeys(
    crawlPolicy,
    DISCOVERY_WEBSITE_CRAWL_POLICY_CONTEXT_KEYS,
    'candidateEvidenceIndex.context.crawlPolicy',
    failures
  );
  const resourceFreshnessEntries = validateDiscoveryWebsiteResourceFreshnessIndex(
    resourceFreshness,
    'candidateEvidenceIndex.context.resourceFreshness',
    failures
  );

  if (
    !isNonEmptyString(website.input) ||
    !isNonEmptyString(website.normalizedUrl) ||
    !isNonEmptyString(website.origin)
  ) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.website must include input, normalizedUrl, and origin strings'
    );
    return undefined;
  }

  if (crawlPolicy.linkedCandidateFetches !== false) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.crawlPolicy.linkedCandidateFetches must be false'
    );
    return undefined;
  }

  if (crawlPolicy.renderedJavaScript !== false) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.crawlPolicy.renderedJavaScript must be false'
    );
    return undefined;
  }

  if (
    !isNonNegativeInteger(crawlPolicy.inspectedResourceCount) ||
    !isNonNegativeInteger(crawlPolicy.sameOriginWellKnownResourceCount)
  ) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.crawlPolicy resource counts must be non-negative integers'
    );
    return undefined;
  }

  if (resourceFreshnessEntries === undefined) {
    return undefined;
  }

  return {
    website: {
      input: website.input,
      normalizedUrl: website.normalizedUrl,
      origin: website.origin,
    },
    crawlPolicy: {
      linkedCandidateFetches: false,
      renderedJavaScript: false,
      inspectedResourceCount: crawlPolicy.inspectedResourceCount,
      sameOriginWellKnownResourceCount: crawlPolicy.sameOriginWellKnownResourceCount,
    },
    resourceFreshness: resourceFreshnessEntries,
  };
}

function validateDiscoveryWebsiteResourceFreshnessIndex(
  value: unknown,
  label: string,
  failures: string[]
): WebsiteResourceFreshnessIndexEntry[] | undefined {
  if (!Array.isArray(value)) {
    failures.push(`malformed manifest: ${label} must be an array`);
    return undefined;
  }

  const entries: WebsiteResourceFreshnessIndexEntry[] = [];

  for (const [index, entry] of value.entries()) {
    const entryLabel = `${label}[${index}]`;

    if (!isObjectRecord(entry)) {
      failures.push(`malformed manifest: ${entryLabel} must be an object`);
      return undefined;
    }

    validateAllowedKeys(entry, DISCOVERY_WEBSITE_RESOURCE_FRESHNESS_KEYS, entryLabel, failures);
    const etag = entry.etag;
    const lastModified = entry.lastModified;
    const normalizedEtag =
      etag === undefined || etag === null ? null : isNonEmptyString(etag) ? etag : undefined;
    const normalizedLastModified =
      lastModified === undefined || lastModified === null
        ? null
        : isNonEmptyString(lastModified)
          ? lastModified
          : undefined;

    if (!isNonEmptyString(entry.url)) {
      failures.push(`malformed manifest: ${entryLabel}.url must be a non-empty string`);
    }

    if (!isNonEmptyString(entry.sourceRole)) {
      failures.push(`malformed manifest: ${entryLabel}.sourceRole must be a non-empty string`);
    }

    if (!isIsoTimestampString(entry.observedAt)) {
      failures.push(`malformed manifest: ${entryLabel}.observedAt must be an ISO timestamp`);
    }

    if (normalizedEtag === undefined) {
      failures.push(`malformed manifest: ${entryLabel}.etag must be a non-empty string or null`);
    }

    if (normalizedLastModified === undefined) {
      failures.push(
        `malformed manifest: ${entryLabel}.lastModified must be a non-empty string or null`
      );
    }

    if (
      !isNonEmptyString(entry.url) ||
      !isNonEmptyString(entry.sourceRole) ||
      !isIsoTimestampString(entry.observedAt) ||
      normalizedEtag === undefined ||
      normalizedLastModified === undefined
    ) {
      return undefined;
    }

    entries.push({
      url: entry.url,
      sourceRole: entry.sourceRole,
      observedAt: entry.observedAt,
      etag: normalizedEtag,
      lastModified: normalizedLastModified,
    });
  }

  return entries;
}

function validateDiscoveryCandidateEvidenceIndexCandidate(options: {
  candidate: unknown;
  candidateIndex: number;
  discoveryKind: DiscoveryReportKind;
  failures: string[];
}): DiscoveryCandidateEvidenceIndexCandidate | undefined {
  const { candidate, candidateIndex, discoveryKind, failures } = options;
  const label = `candidateEvidenceIndex.candidates[${candidateIndex}]`;

  if (!isObjectRecord(candidate)) {
    failures.push(`malformed manifest: ${label} must be an object`);
    return undefined;
  }

  const allowedKeys =
    discoveryKind === 'url'
      ? DISCOVERY_URL_CANDIDATE_EVIDENCE_INDEX_CANDIDATE_KEYS
      : DISCOVERY_PATH_CANDIDATE_EVIDENCE_INDEX_CANDIDATE_KEYS;

  validateAllowedKeys(candidate, allowedKeys, label, failures);

  const order = candidate.order;
  const evidence = validateDiscoveryCandidateEvidenceIndexEvidence(
    candidate.evidence,
    label,
    failures
  );

  if (!isPositiveInteger(order)) {
    failures.push(`malformed manifest: ${label}.order must be a positive integer`);
  } else if (order !== candidateIndex + 1) {
    failures.push(`malformed manifest: ${label}.order must match candidate index order`);
  }

  if (discoveryKind === 'url') {
    return validateDiscoveryUrlCandidateEvidenceIndexCandidate({
      candidate,
      label,
      order,
      evidence,
      failures,
    });
  }

  return validateDiscoveryPathCandidateEvidenceIndexCandidate({
    candidate,
    label,
    order,
    evidence,
    failures,
  });
}

function validateDiscoveryPathCandidateEvidenceIndexCandidate(options: {
  candidate: Record<string, unknown>;
  label: string;
  order: unknown;
  evidence: DiscoveryCandidateEvidenceIndexCandidate['evidence'] | undefined;
  failures: string[];
}): DiscoveryCandidateEvidenceIndexCandidate | undefined {
  const { candidate, label, order, evidence, failures } = options;
  const hints = validateOptionalStringArray(candidate.hints, `${label}.hints`, failures);
  const formatHints = validateOptionalStringArray(
    candidate.formatHints,
    `${label}.formatHints`,
    failures
  );

  if (!isNonEmptyString(candidate.path)) {
    failures.push(`malformed manifest: ${label}.path must be a non-empty string`);
  }

  if (!isNonEmptyString(candidate.kind)) {
    failures.push(`malformed manifest: ${label}.kind must be a non-empty string`);
  }

  if (!isNonEmptyString(candidate.format)) {
    failures.push(`malformed manifest: ${label}.format must be a non-empty string`);
  }

  if (!isNonNegativeInteger(candidate.byteSize)) {
    failures.push(`malformed manifest: ${label}.byteSize must be a non-negative integer`);
  }

  if (!isUnprefixedSha256Hash(candidate.sha256)) {
    failures.push(`malformed manifest: ${label}.sha256 must be a sha256 hex digest`);
  }

  if (
    !isPositiveInteger(order) ||
    !isNonEmptyString(candidate.path) ||
    !isNonEmptyString(candidate.kind) ||
    !isNonEmptyString(candidate.format) ||
    !isNonNegativeInteger(candidate.byteSize) ||
    !isUnprefixedSha256Hash(candidate.sha256) ||
    evidence === undefined ||
    hints === undefined ||
    formatHints === undefined
  ) {
    return undefined;
  }

  const entry: DiscoveryCandidateEvidenceIndexCandidate = {
    path: candidate.path,
    order,
    kind: candidate.kind,
    format: candidate.format,
    evidence,
    byteSize: candidate.byteSize,
    sha256: candidate.sha256,
  };

  if (hints.length > 0) {
    entry.hints = hints;
  }

  if (formatHints.length > 0) {
    entry.formatHints = formatHints;
  }

  return entry;
}

function validateDiscoveryUrlCandidateEvidenceIndexCandidate(options: {
  candidate: Record<string, unknown>;
  label: string;
  order: unknown;
  evidence: DiscoveryCandidateEvidenceIndexCandidate['evidence'] | undefined;
  failures: string[];
}): DiscoveryCandidateEvidenceIndexCandidate | undefined {
  const { candidate, label, order, evidence, failures } = options;
  const sourceResources = validateOptionalCandidateSourceResources(
    candidate.sourceResources,
    `${label}.sourceResources`,
    failures
  );

  if (!isNonEmptyString(candidate.url)) {
    failures.push(`malformed manifest: ${label}.url must be a non-empty string`);
  }

  if (typeof candidate.sameOrigin !== 'boolean') {
    failures.push(`malformed manifest: ${label}.sameOrigin must be a boolean`);
  }

  if (typeof candidate.external !== 'boolean') {
    failures.push(`malformed manifest: ${label}.external must be a boolean`);
  }

  if (
    !isPositiveInteger(order) ||
    !isNonEmptyString(candidate.url) ||
    typeof candidate.sameOrigin !== 'boolean' ||
    typeof candidate.external !== 'boolean' ||
    evidence === undefined ||
    sourceResources === undefined
  ) {
    return undefined;
  }

  const entry: DiscoveryCandidateEvidenceIndexCandidate = {
    url: candidate.url,
    order,
    evidence,
    sameOrigin: candidate.sameOrigin,
    external: candidate.external,
  };

  if (sourceResources.length > 0) {
    entry.sourceResources = sourceResources;
  }

  return entry;
}

function validateDiscoveryCandidateEvidenceIndexEvidence(
  evidence: unknown,
  label: string,
  failures: string[]
): DiscoveryCandidateEvidenceIndexCandidate['evidence'] | undefined {
  if (!isObjectRecord(evidence)) {
    failures.push(`malformed manifest: ${label}.evidence must be an object`);
    return undefined;
  }

  validateAllowedKeys(evidence, DISCOVERY_CANDIDATE_EVIDENCE_KEYS, `${label}.evidence`, failures);

  const category = evidence.category;
  const signals = validateOptionalStringArray(
    evidence.signals,
    `${label}.evidence.signals`,
    failures
  );
  const relations = validateOptionalStringArray(
    evidence.relations,
    `${label}.evidence.relations`,
    failures
  );
  const flags = validateOptionalStringArray(evidence.flags, `${label}.evidence.flags`, failures);

  if ('category' in evidence && !isNonEmptyString(category)) {
    failures.push(`malformed manifest: ${label}.evidence.category must be a non-empty string`);
  }

  if (signals === undefined || relations === undefined || flags === undefined) {
    return undefined;
  }

  const entry: DiscoveryCandidateEvidenceIndexCandidate['evidence'] = {};

  if (isNonEmptyString(category)) {
    entry.category = category;
  }

  if ('signals' in evidence) {
    entry.signals = signals;
  }

  if ('relations' in evidence) {
    entry.relations = relations;
  }

  if ('flags' in evidence) {
    entry.flags = flags;
  }

  return entry;
}

function validateOptionalCandidateSourceResources(
  value: unknown,
  label: string,
  failures: string[]
): NonNullable<DiscoveryCandidateEvidenceIndexCandidate['sourceResources']> | undefined {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    failures.push(`malformed manifest: ${label} must be an array when present`);
    return undefined;
  }

  const resources: NonNullable<DiscoveryCandidateEvidenceIndexCandidate['sourceResources']> = [];

  for (const [index, resource] of value.entries()) {
    const resourceLabel = `${label}[${index}]`;

    if (!isObjectRecord(resource)) {
      failures.push(`malformed manifest: ${resourceLabel} must be an object`);
      return undefined;
    }

    validateAllowedKeys(
      resource,
      DISCOVERY_CANDIDATE_SOURCE_RESOURCE_KEYS,
      resourceLabel,
      failures
    );

    if (
      !isNonEmptyString(resource.url) ||
      !isNonEmptyString(resource.sourceRole) ||
      !isNonEmptyString(resource.evidence)
    ) {
      failures.push(
        `malformed manifest: ${resourceLabel} must include url, sourceRole, and evidence strings`
      );
      return undefined;
    }

    resources.push({
      url: resource.url,
      sourceRole: resource.sourceRole,
      evidence: resource.evidence,
    });
  }

  return resources;
}

function validateOptionalStringArray(
  value: unknown,
  label: string,
  failures: string[]
): string[] | undefined {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    failures.push(`malformed manifest: ${label} must be a string array when present`);
    return undefined;
  }

  if (!value.every((entry) => typeof entry === 'string')) {
    failures.push(`malformed manifest: ${label} must contain only strings`);
    return undefined;
  }

  return value;
}

function verifyDiscoveryCandidateEvidenceIndexAgainstReport(options: {
  discoveryKind: DiscoveryReportKind;
  report: Record<string, unknown>;
  manifestIndex: DiscoveryCandidateEvidenceIndex;
  failures: string[];
}): void {
  let reportIndex: DiscoveryCandidateEvidenceIndex;

  try {
    reportIndex = buildDiscoveryCandidateEvidenceIndex(options.discoveryKind, options.report);
  } catch (error) {
    options.failures.push(
      `discovery candidate evidence index: could not rebuild from discovery-report.json: ${errorMessage(error)}`
    );
    return;
  }

  if (!discoveryCandidateEvidenceIndexesEqual(options.manifestIndex, reportIndex)) {
    options.failures.push(
      'discovery candidate evidence index: manifest metadata does not match discovery-report.json'
    );
  }
}

function validateGeneratedOutputs(options: {
  generatedOutputs: unknown[];
  manifestDir: string;
  failures: string[];
  fileChecks: FileCheck[];
  requireTextMetadata: boolean;
  rejectSymlinks: boolean;
  rejectSymlinkAncestors?: boolean;
  allowedKinds: ReadonlySet<string>;
}): void {
  const {
    generatedOutputs,
    manifestDir,
    failures,
    fileChecks,
    requireTextMetadata,
    rejectSymlinks,
    rejectSymlinkAncestors,
    allowedKinds,
  } = options;

  for (const [index, output] of generatedOutputs.entries()) {
    if (!isObjectRecord(output)) {
      failures.push(`malformed manifest: generatedOutputs[${index}] must be an object`);
      continue;
    }

    const outputPath = output.path;
    const outputKind = output.kind;
    const outputByteSize = output.byteSize;
    const outputHash = output.hash;
    const outputLineCount = output.lineCount;
    const outputEstimatedTokenCount = output.estimatedTokenCount;
    const label = `output[${index}]`;

    if (!isNonEmptyString(outputPath)) {
      failures.push(`malformed manifest: ${label}.path must be a non-empty string`);
    } else if (isAbsolute(outputPath)) {
      failures.push(`malformed manifest: ${label}.path must be relative: ${outputPath}`);
    } else if (!isInsideDirectory(manifestDir, resolve(manifestDir, outputPath))) {
      failures.push(`malformed manifest: ${label}.path escapes manifest directory: ${outputPath}`);
    }

    if (!isAllowedOutputKind(outputKind, allowedKinds)) {
      failures.push(
        `malformed manifest: ${label}.kind must be ${formatAllowedOutputKinds(allowedKinds)}`
      );
    }

    if (!isNonNegativeInteger(outputByteSize)) {
      failures.push(`malformed manifest: ${label}.byteSize must be a non-negative integer`);
    }

    if (!isSha256Hash(outputHash)) {
      failures.push(`malformed manifest: ${label}.hash must be a sha256 hash`);
    }

    if (requireTextMetadata && !('lineCount' in output)) {
      failures.push(`malformed manifest: ${label}.lineCount must be a non-negative integer`);
    } else if ('lineCount' in output && !isNonNegativeInteger(outputLineCount)) {
      failures.push(
        `malformed manifest: ${label}.lineCount must be a non-negative integer${
          requireTextMetadata ? '' : ' when present'
        }`
      );
    }

    if (requireTextMetadata && !('estimatedTokenCount' in output)) {
      failures.push(
        `malformed manifest: ${label}.estimatedTokenCount must be a non-negative integer`
      );
    } else if (
      'estimatedTokenCount' in output &&
      !isNonNegativeInteger(outputEstimatedTokenCount)
    ) {
      failures.push(
        `malformed manifest: ${label}.estimatedTokenCount must be a non-negative integer${
          requireTextMetadata ? '' : ' when present'
        }`
      );
    }

    const hasValidLineCount = isNonNegativeInteger(outputLineCount);
    const hasValidEstimatedTokenCount = isNonNegativeInteger(outputEstimatedTokenCount);

    if (
      isNonEmptyString(outputPath) &&
      !isAbsolute(outputPath) &&
      isInsideDirectory(manifestDir, resolve(manifestDir, outputPath)) &&
      isAllowedOutputKind(outputKind, allowedKinds) &&
      isNonNegativeInteger(outputByteSize) &&
      isSha256Hash(outputHash) &&
      (!requireTextMetadata || (hasValidLineCount && hasValidEstimatedTokenCount))
    ) {
      const expectedLineCount = hasValidLineCount ? (outputLineCount as number) : undefined;
      const expectedEstimatedTokenCount = hasValidEstimatedTokenCount
        ? (outputEstimatedTokenCount as number)
        : undefined;

      const fileCheck: FileCheck = {
        label: `output ${outputPath}`,
        path: resolve(manifestDir, outputPath),
        expectedByteSize: outputByteSize,
        expectedHash: outputHash,
      };

      if (rejectSymlinks) {
        fileCheck.rejectSymlink = true;
        fileCheck.trustedRoot = manifestDir;
        fileCheck.rejectSymlinkAncestors = rejectSymlinkAncestors === true;
      }

      if (expectedLineCount !== undefined) {
        fileCheck.expectedLineCount = expectedLineCount;
      }

      if (expectedEstimatedTokenCount !== undefined) {
        fileCheck.expectedEstimatedTokenCount = expectedEstimatedTokenCount;
      }

      fileChecks.push(fileCheck);
    }
  }
}

function validateSourceDocsSemanticChunkIndexes(options: {
  semanticChunkIndexes: unknown;
  generatedOutputs: unknown[];
  manifestDir: string;
  failures: string[];
}): SemanticChunkManifestIndex[] {
  const { semanticChunkIndexes, generatedOutputs, manifestDir, failures } = options;

  if (semanticChunkIndexes === undefined) {
    return [];
  }

  if (!Array.isArray(semanticChunkIndexes)) {
    failures.push('malformed manifest: semanticChunkIndexes must be an array when present');
    return [];
  }

  const expectedChunkOutputPaths = sourceDocsSemanticChunkOutputPaths(
    generatedOutputs,
    manifestDir
  );
  const entries: SemanticChunkManifestIndex[] = [];
  const seenPaths = new Set<string>();

  for (const [index, chunkIndex] of semanticChunkIndexes.entries()) {
    const label = `semanticChunkIndexes[${index}]`;

    if (!isObjectRecord(chunkIndex)) {
      failures.push(`malformed manifest: ${label} must be an object`);
      continue;
    }

    validateAllowedKeys(chunkIndex, SOURCE_DOCS_SEMANTIC_CHUNK_INDEX_KEYS, label, failures);

    const outputPath = chunkIndex.path;
    const format = chunkIndex.format;
    const chunkCount = chunkIndex.chunkCount;
    const aggregateHash = chunkIndex.aggregateHash;
    const warningCount = chunkIndex.warningCount;
    const chunks = chunkIndex.chunks;
    const chunkEntries: SemanticChunkManifestIndexChunk[] = [];

    if (!isNonEmptyString(outputPath)) {
      failures.push(`malformed manifest: ${label}.path must be a non-empty string`);
    } else if (isAbsolute(outputPath)) {
      failures.push(`malformed manifest: ${label}.path must be relative: ${outputPath}`);
    } else if (!isInsideDirectory(manifestDir, resolve(manifestDir, outputPath))) {
      failures.push(`malformed manifest: ${label}.path escapes manifest directory: ${outputPath}`);
    } else if (!expectedChunkOutputPaths.has(outputPath)) {
      failures.push(
        `malformed manifest: ${label}.path must reference a semantic-chunks-jsonl generated output`
      );
    } else if (seenPaths.has(outputPath)) {
      failures.push(`malformed manifest: duplicate semantic chunk index path: ${outputPath}`);
    } else {
      seenPaths.add(outputPath);
    }

    if (format !== 'jsonl') {
      failures.push(`malformed manifest: ${label}.format must be jsonl`);
    }

    if (!isNonNegativeInteger(chunkCount)) {
      failures.push(`malformed manifest: ${label}.chunkCount must be a non-negative integer`);
    }

    if (!isSha256Hash(aggregateHash)) {
      failures.push(`malformed manifest: ${label}.aggregateHash must be a sha256 hash`);
    }

    if (!isNonNegativeInteger(warningCount)) {
      failures.push(`malformed manifest: ${label}.warningCount must be a non-negative integer`);
    }

    if (!Array.isArray(chunks)) {
      failures.push(`malformed manifest: ${label}.chunks must be an array`);
    } else {
      for (const [chunkEntryIndex, chunkEntry] of chunks.entries()) {
        const chunkLabel = `${label}.chunks[${chunkEntryIndex}]`;
        const normalizedChunk = validateSourceDocsSemanticChunkIndexChunk({
          chunkEntry,
          label: chunkLabel,
          expectedOrder: chunkEntryIndex + 1,
          failures,
        });

        if (normalizedChunk !== undefined) {
          chunkEntries.push(normalizedChunk);
        }
      }
    }

    if (Array.isArray(chunks) && isNonNegativeInteger(chunkCount) && chunks.length !== chunkCount) {
      failures.push(`malformed manifest: ${label}.chunkCount must match chunks length`);
    }

    if (
      isNonNegativeInteger(warningCount) &&
      Array.isArray(chunks) &&
      chunkEntries.length === chunks.length
    ) {
      const actualWarningCount = chunkEntries.reduce(
        (total, chunk) => total + chunk.warningCount,
        0
      );

      if (warningCount !== actualWarningCount) {
        failures.push(`malformed manifest: ${label}.warningCount must match chunk warning counts`);
      }
    }

    if (
      isNonEmptyString(outputPath) &&
      !isAbsolute(outputPath) &&
      isInsideDirectory(manifestDir, resolve(manifestDir, outputPath)) &&
      format === 'jsonl' &&
      isNonNegativeInteger(chunkCount) &&
      isSha256Hash(aggregateHash) &&
      isNonNegativeInteger(warningCount) &&
      Array.isArray(chunks) &&
      chunkEntries.length === chunks.length
    ) {
      const normalizedIndex: SemanticChunkManifestIndex = {
        path: outputPath,
        format,
        chunkCount,
        aggregateHash,
        warningCount,
        chunks: chunkEntries,
      };
      const actualAggregateHash = hashSemanticChunkManifestIndex({
        path: normalizedIndex.path,
        format: normalizedIndex.format,
        chunkCount: normalizedIndex.chunkCount,
        warningCount: normalizedIndex.warningCount,
        chunks: normalizedIndex.chunks,
      });

      if (normalizedIndex.aggregateHash !== actualAggregateHash) {
        failures.push(
          `malformed manifest: ${label}.aggregateHash must match semantic chunk index metadata`
        );
      }

      entries.push(normalizedIndex);
    }
  }

  if (
    semanticChunkIndexes.length === entries.length &&
    expectedChunkOutputPaths.size !== entries.length
  ) {
    failures.push(
      'malformed manifest: semanticChunkIndexes must contain one entry per semantic-chunks-jsonl generated output'
    );
  }

  return entries;
}

function validateSourceDocsSemanticChunkIndexChunk(options: {
  chunkEntry: unknown;
  label: string;
  expectedOrder: number;
  failures: string[];
}): SemanticChunkManifestIndexChunk | undefined {
  const { chunkEntry, label, expectedOrder, failures } = options;

  if (!isObjectRecord(chunkEntry)) {
    failures.push(`malformed manifest: ${label} must be an object`);
    return undefined;
  }

  validateAllowedKeys(chunkEntry, SOURCE_DOCS_SEMANTIC_CHUNK_INDEX_CHUNK_KEYS, label, failures);

  const id = chunkEntry.id;
  const order = chunkEntry.order;
  const title = chunkEntry.title;
  const path = chunkEntry.path;
  const nodePath = chunkEntry.nodePath;
  const contentHash = chunkEntry.contentHash;
  const characterCount = chunkEntry.characterCount;
  const estimatedTokenCount = chunkEntry.estimatedTokenCount;
  const sourceFormat = chunkEntry.sourceFormat;
  const sourcePath = chunkEntry.sourcePath;
  const warningCount = chunkEntry.warningCount;

  if (!isNonEmptyString(id)) {
    failures.push(`malformed manifest: ${label}.id must be a non-empty string`);
  }

  if (!isPositiveInteger(order)) {
    failures.push(`malformed manifest: ${label}.order must be a positive integer`);
  } else if (order !== expectedOrder) {
    failures.push(`malformed manifest: ${label}.order must match chunk index order`);
  }

  if (!isNonEmptyString(title)) {
    failures.push(`malformed manifest: ${label}.title must be a non-empty string`);
  }

  if (!isStringArray(path)) {
    failures.push(`malformed manifest: ${label}.path must be a string array`);
  }

  if (!isStringArray(nodePath)) {
    failures.push(`malformed manifest: ${label}.nodePath must be a string array`);
  }

  if (!isUnprefixedSha256Hash(contentHash)) {
    failures.push(`malformed manifest: ${label}.contentHash must be a sha256 hex digest`);
  }

  if (!isNonNegativeInteger(characterCount)) {
    failures.push(`malformed manifest: ${label}.characterCount must be a non-negative integer`);
  }

  if (!isNonNegativeInteger(estimatedTokenCount)) {
    failures.push(
      `malformed manifest: ${label}.estimatedTokenCount must be a non-negative integer`
    );
  }

  if ('sourceFormat' in chunkEntry && !isNonEmptyString(sourceFormat)) {
    failures.push(`malformed manifest: ${label}.sourceFormat must be a non-empty string`);
  }

  if ('sourcePath' in chunkEntry && !isNonEmptyString(sourcePath)) {
    failures.push(`malformed manifest: ${label}.sourcePath must be a non-empty string`);
  }

  if (!isNonNegativeInteger(warningCount)) {
    failures.push(`malformed manifest: ${label}.warningCount must be a non-negative integer`);
  }

  if (
    !isNonEmptyString(id) ||
    !isPositiveInteger(order) ||
    !isNonEmptyString(title) ||
    !isStringArray(path) ||
    !isStringArray(nodePath) ||
    !isUnprefixedSha256Hash(contentHash) ||
    !isNonNegativeInteger(characterCount) ||
    !isNonNegativeInteger(estimatedTokenCount) ||
    ('sourceFormat' in chunkEntry && !isNonEmptyString(sourceFormat)) ||
    ('sourcePath' in chunkEntry && !isNonEmptyString(sourcePath)) ||
    !isNonNegativeInteger(warningCount)
  ) {
    return undefined;
  }

  const normalizedChunk: SemanticChunkManifestIndexChunk = {
    id,
    order,
    title,
    path,
    nodePath,
    contentHash,
    characterCount,
    estimatedTokenCount,
    warningCount,
  };

  if (typeof sourceFormat === 'string') {
    normalizedChunk.sourceFormat = sourceFormat;
  }

  if (typeof sourcePath === 'string') {
    normalizedChunk.sourcePath = sourcePath;
  }

  return normalizedChunk;
}

async function verifySourceDocsSemanticChunkIndexes(options: {
  manifestDir: string;
  semanticChunkIndexes: SemanticChunkManifestIndex[];
  failures: string[];
}): Promise<void> {
  for (const semanticChunkIndex of options.semanticChunkIndexes) {
    let actualIndex: SemanticChunkManifestIndex;

    try {
      actualIndex = await buildSemanticChunkJsonlManifestIndex({
        manifestDir: options.manifestDir,
        outputPath: semanticChunkIndex.path,
      });
    } catch (error) {
      options.failures.push(
        `semantic chunk index ${semanticChunkIndex.path}: ${errorMessage(error)}`
      );
      continue;
    }

    if (!semanticChunkManifestIndexesEqual(semanticChunkIndex, actualIndex)) {
      options.failures.push(
        `semantic chunk index ${semanticChunkIndex.path}: manifest metadata does not match JSONL records`
      );
    }
  }
}

function sourceDocsSemanticChunkOutputPaths(
  generatedOutputs: unknown[],
  manifestDir: string
): Set<string> {
  const paths = new Set<string>();

  for (const output of generatedOutputs) {
    if (!isObjectRecord(output) || output.kind !== SOURCE_DOCS_SEMANTIC_CHUNK_JSONL_KIND) {
      continue;
    }

    const outputPath = output.path;

    if (
      isNonEmptyString(outputPath) &&
      !isAbsolute(outputPath) &&
      isInsideDirectory(manifestDir, resolve(manifestDir, outputPath))
    ) {
      paths.add(outputPath);
    }
  }

  return paths;
}

function validateAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string,
  failures: string[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      failures.push(`malformed manifest: ${label}.${key} is not supported`);
    }
  }
}

function validateSourceDocsPresetMetadata(preset: unknown, failures: string[]): void {
  for (const failure of validateSourceDocsPresetContract(preset)) {
    failures.push(`malformed manifest: ${failure}`);
  }
}

export function validateSourceDocsPresetContract(preset: unknown): string[] {
  const failures: string[] = [];

  if (preset === undefined) {
    return failures;
  }

  if (!isObjectRecord(preset)) {
    failures.push('preset must be an object when present');
    return failures;
  }

  if (preset.name !== SOURCE_DOCS_SWIFT_BOOK_PRESET_NAME) {
    failures.push(`preset.name must be ${SOURCE_DOCS_SWIFT_BOOK_PRESET_NAME}`);
  }

  if (!isNonEmptyString(preset.configPath)) {
    failures.push('preset.configPath must be a non-empty string');
  }

  if (!isNonEmptyString(preset.displayName)) {
    failures.push('preset.displayName must be a non-empty string');
  }

  const defaults = preset.defaults;
  if (!isObjectRecord(defaults)) {
    failures.push('preset.defaults must be an object');
  } else {
    if (defaults.format !== 'markdown') {
      failures.push('preset.defaults.format must be markdown');
    }

    if (!isNonEmptyString(defaults.filenamePrefix)) {
      failures.push('preset.defaults.filenamePrefix must be a non-empty string');
    }

    if (!isNonEmptyString(defaults.title)) {
      failures.push('preset.defaults.title must be a non-empty string');
    }

    if (!isNonEmptyString(defaults.systemPrompt)) {
      failures.push('preset.defaults.systemPrompt must be a non-empty string');
    } else {
      const unsupportedPromptClaims = findUnsupportedPresetPromptClaims(defaults.systemPrompt);

      if (unsupportedPromptClaims.length > 0) {
        failures.push(
          `preset.defaults.systemPrompt must not claim ${formatList(unsupportedPromptClaims)}`
        );
      }
    }

    if (
      'outputFormats' in defaults &&
      (!Array.isArray(defaults.outputFormats) ||
        !defaults.outputFormats.every((format) => isNonEmptyString(format)))
    ) {
      failures.push(
        'preset.defaults.outputFormats must be an array of non-empty strings when present'
      );
    }
  }

  const metadata = preset.metadata;
  if (!isObjectRecord(metadata)) {
    failures.push('preset.metadata must be an object');
  } else {
    for (const [field, expectedValue] of Object.entries(SOURCE_DOCS_SWIFT_BOOK_PRESET_METADATA)) {
      if (metadata[field] !== expectedValue) {
        failures.push(`preset.metadata.${field} must be ${expectedValue}`);
      }
    }
  }

  if (!Array.isArray(preset.limitations)) {
    failures.push('preset.limitations must be an array');
    return failures;
  }

  if (!preset.limitations.every((limitation) => isNonEmptyString(limitation))) {
    failures.push('preset.limitations must contain only non-empty strings');
    return failures;
  }

  for (const limitation of SOURCE_DOCS_SWIFT_BOOK_PRESET_LIMITATIONS) {
    if (!preset.limitations.includes(limitation)) {
      failures.push(`preset.limitations must include "${limitation}"`);
    }
  }

  return failures;
}

function findUnsupportedPresetPromptClaims(prompt: string): string[] {
  const normalizedPrompt = prompt.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const claims: string[] = [];

  if (/\b(complete|completeness|comprehensive)\b/.test(normalizedPrompt)) {
    claims.push('completeness');
  }

  if (/\bsource truth\b/.test(normalizedPrompt)) {
    claims.push('source truth');
  }

  if (/\b(verified|verification|validated|validation)\b/.test(normalizedPrompt)) {
    claims.push('source verification');
  }

  if (/\b(authoritative|authority|official)\b/.test(normalizedPrompt)) {
    claims.push('authority or official status');
  }

  return claims;
}

function formatList(values: string[]): string {
  if (values.length <= 1) {
    return values[0] ?? '';
  }

  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}

interface SourceFileEntry {
  path: string;
  resolvedPath: string;
  byteSize: number;
  hash: string;
  format: string;
}

interface SourceTruthSourceFileEntry {
  path: string;
  resolvedPath: string;
  byteSize: number;
  hash: string;
  factCount: number;
  exportFactCount: number;
  signatureFactCount?: number;
  configFactCount: number;
  contextFactCount: number;
  parseDiagnosticCount: number;
}

function validateSourceVerificationEndpoint(
  value: unknown,
  label: string,
  failures: string[]
): void {
  if (!isObjectRecord(value)) {
    failures.push(`malformed manifest: ${label} must be an object`);
    return;
  }

  if (!isNonEmptyString(value.input)) {
    failures.push(`malformed manifest: ${label}.input must be a non-empty string`);
  }

  if (!isNonEmptyString(value.resolvedPath)) {
    failures.push(`malformed manifest: ${label}.resolvedPath must be a non-empty string`);
  } else if (!isAbsolute(value.resolvedPath)) {
    failures.push(`malformed manifest: ${label}.resolvedPath must be absolute`);
  }

  if (!isNonEmptyString(value.type) || !isSourceTruthSourceType(value.type)) {
    failures.push(`malformed manifest: ${label}.type must be file or directory`);
  }
}

function validateSourceVerificationSummary(
  value: unknown,
  label: string,
  failures: string[]
): void {
  if (!isObjectRecord(value)) {
    failures.push(`malformed manifest: ${label} must be an object`);
    return;
  }

  for (const field of SOURCE_VERIFICATION_SUMMARY_FIELDS) {
    if (!isNonNegativeInteger(value[field])) {
      failures.push(`malformed manifest: ${label}.${field} must be a non-negative integer`);
    }
  }
}

function validateSourceFiles(options: {
  sourceFiles: unknown[];
  sourcePath: unknown;
  sourceType: unknown;
  sourceResolvedFormat: unknown;
  failures: string[];
  fileChecks: FileCheck[];
}): SourceFileEntry[] {
  const { sourceFiles, sourcePath, sourceType, sourceResolvedFormat, failures, fileChecks } =
    options;
  const sourceFileEntries: SourceFileEntry[] = [];
  const sourceRoot =
    isNonEmptyString(sourcePath) && isAbsolute(sourcePath) ? sourcePath : undefined;
  const trustedRoot =
    sourceRoot === undefined
      ? undefined
      : sourceType === 'directory'
        ? sourceRoot
        : dirname(sourceRoot);

  for (const [index, sourceFile] of sourceFiles.entries()) {
    const label = `sourceFiles[${index}]`;

    if (!isObjectRecord(sourceFile)) {
      failures.push(`malformed manifest: ${label} must be an object`);
      continue;
    }

    const sourceFilePath = sourceFile.path;
    const sourceFileResolvedPath = sourceFile.resolvedPath;
    const sourceFileByteSize = sourceFile.byteSize;
    const sourceFileHash = sourceFile.hash;
    const sourceFileLineCount = sourceFile.lineCount;
    const sourceFileEstimatedTokenCount = sourceFile.estimatedTokenCount;
    const sourceFileFormat = sourceFile.format;

    if (!isNonEmptyString(sourceFilePath)) {
      failures.push(`malformed manifest: ${label}.path must be a non-empty string`);
    } else if (isAbsolute(sourceFilePath)) {
      failures.push(`malformed manifest: ${label}.path must be relative: ${sourceFilePath}`);
    } else if (
      sourceRoot !== undefined &&
      sourceType === 'directory' &&
      !isInsideDirectory(sourceRoot, resolve(sourceRoot, sourceFilePath))
    ) {
      failures.push(`malformed manifest: ${label}.path escapes source root: ${sourceFilePath}`);
    }

    if (!isNonEmptyString(sourceFileResolvedPath)) {
      failures.push(`malformed manifest: ${label}.resolvedPath must be a non-empty string`);
    } else if (!isAbsolute(sourceFileResolvedPath)) {
      failures.push(`malformed manifest: ${label}.resolvedPath must be absolute`);
    } else if (
      sourceRoot !== undefined &&
      sourceType === 'directory' &&
      !isInsideDirectory(sourceRoot, sourceFileResolvedPath)
    ) {
      failures.push(
        `malformed manifest: ${label}.resolvedPath escapes source root: ${sourceFileResolvedPath}`
      );
    }

    if (
      sourceRoot !== undefined &&
      isNonEmptyString(sourceFilePath) &&
      !isAbsolute(sourceFilePath) &&
      isNonEmptyString(sourceFileResolvedPath) &&
      isAbsolute(sourceFileResolvedPath) &&
      isSourceDocsSourceType(sourceType)
    ) {
      const expectedResolvedPath =
        sourceType === 'directory'
          ? resolve(sourceRoot, sourceFilePath)
          : resolve(dirname(sourceRoot), sourceFilePath);

      if (expectedResolvedPath !== sourceFileResolvedPath) {
        failures.push(
          `malformed manifest: ${label}.resolvedPath must match ${label}.path under source.resolvedPath`
        );
      }

      if (sourceType === 'file' && sourceFileResolvedPath !== sourceRoot) {
        failures.push(
          `malformed manifest: ${label}.resolvedPath must match source.resolvedPath for file sources`
        );
      }
    }

    if (!isNonNegativeInteger(sourceFileByteSize)) {
      failures.push(`malformed manifest: ${label}.byteSize must be a non-negative integer`);
    }

    if (!isSha256Hash(sourceFileHash)) {
      failures.push(`malformed manifest: ${label}.hash must be a sha256 hash`);
    }

    if (!isNonNegativeInteger(sourceFileLineCount)) {
      failures.push(`malformed manifest: ${label}.lineCount must be a non-negative integer`);
    }

    if (!isNonNegativeInteger(sourceFileEstimatedTokenCount)) {
      failures.push(
        `malformed manifest: ${label}.estimatedTokenCount must be a non-negative integer`
      );
    }

    if (!isNonEmptyString(sourceFileFormat)) {
      failures.push(`malformed manifest: ${label}.format must be a non-empty string`);
    } else if (
      isNonEmptyString(sourceResolvedFormat) &&
      sourceFileFormat !== sourceResolvedFormat
    ) {
      failures.push(`malformed manifest: ${label}.format must match source.resolvedFormat`);
    }

    if (
      isNonEmptyString(sourceFilePath) &&
      !isAbsolute(sourceFilePath) &&
      isNonEmptyString(sourceFileResolvedPath) &&
      isAbsolute(sourceFileResolvedPath) &&
      isNonNegativeInteger(sourceFileByteSize) &&
      isSha256Hash(sourceFileHash) &&
      isNonEmptyString(sourceFileFormat)
    ) {
      sourceFileEntries.push({
        path: sourceFilePath,
        resolvedPath: sourceFileResolvedPath,
        byteSize: sourceFileByteSize,
        hash: sourceFileHash,
        format: sourceFileFormat,
      });
      const fileCheck: FileCheck = {
        label,
        path: sourceFileResolvedPath,
        expectedByteSize: sourceFileByteSize,
        expectedHash: sourceFileHash,
        rejectSymlink: true,
      };

      if (
        isNonNegativeInteger(sourceFileLineCount) &&
        isNonNegativeInteger(sourceFileEstimatedTokenCount)
      ) {
        fileCheck.expectedLineCount = sourceFileLineCount;
        fileCheck.expectedEstimatedTokenCount = sourceFileEstimatedTokenCount;
      }

      if (trustedRoot !== undefined) {
        fileCheck.trustedRoot = trustedRoot;
      }

      fileChecks.push(fileCheck);
    }
  }

  return sourceFileEntries;
}

function validateSourceTruthInspection(
  inspection: Record<string, unknown>,
  failures: string[]
): void {
  if (inspection.schemaVersion !== SOURCE_TRUTH_REPORT_SCHEMA_VERSION) {
    failures.push(
      `malformed manifest: inspection.schemaVersion must be ${SOURCE_TRUTH_REPORT_SCHEMA_VERSION}`
    );
  }

  if (inspection.mode !== SOURCE_TRUTH_INSPECTION_MODE) {
    failures.push(`malformed manifest: inspection.mode must be ${SOURCE_TRUTH_INSPECTION_MODE}`);
  }

  const traversal = inspection.traversal;
  if (!isObjectRecord(traversal)) {
    failures.push('malformed manifest: inspection.traversal must be an object');
  } else {
    validateSourceTruthTraversal(traversal, 'malformed manifest: inspection.traversal', failures);
  }

  const warnings = inspection.warnings;
  if (!Array.isArray(warnings) || !warnings.every((warning) => typeof warning === 'string')) {
    failures.push('malformed manifest: inspection.warnings must be an array of strings');
  }
}

function validateSourceTruthTraversal(
  traversal: Record<string, unknown>,
  label: string,
  failures: string[]
): void {
  if (traversal.followSymlinks !== false) {
    failures.push(`${label}.followSymlinks must be false`);
  }

  for (const field of [
    'maxDepth',
    'maxEntries',
    'maxFiles',
    'maxFileBytes',
    'visitedEntries',
    'visitedFiles',
    'inspectedFiles',
    'skippedFiles',
  ]) {
    if (!isNonNegativeInteger(traversal[field])) {
      failures.push(`${label}.${field} must be a non-negative integer`);
    }
  }

  if (
    !Array.isArray(traversal.skippedDirectoryNames) ||
    !traversal.skippedDirectoryNames.every((entry) => typeof entry === 'string')
  ) {
    failures.push(`${label}.skippedDirectoryNames must be an array of strings`);
  }

  if (typeof traversal.truncated !== 'boolean') {
    failures.push(`${label}.truncated must be a boolean`);
  }
}

function validateSourceTruthSourceFiles(options: {
  sourceFiles: unknown[];
  sourcePath: unknown;
  sourceType: unknown;
  failures: string[];
  fileChecks: FileCheck[];
}): SourceTruthSourceFileEntry[] {
  const { sourceFiles, sourcePath, sourceType, failures, fileChecks } = options;
  const sourceFileEntries: SourceTruthSourceFileEntry[] = [];
  const sourceRoot =
    isNonEmptyString(sourcePath) && isAbsolute(sourcePath) ? sourcePath : undefined;
  const trustedRoot =
    sourceRoot === undefined
      ? undefined
      : sourceType === 'directory'
        ? sourceRoot
        : dirname(sourceRoot);

  for (const [index, sourceFile] of sourceFiles.entries()) {
    const label = `sourceFiles[${index}]`;

    if (!isObjectRecord(sourceFile)) {
      failures.push(`malformed manifest: ${label} must be an object`);
      continue;
    }

    const sourceFilePath = sourceFile.path;
    const sourceFileResolvedPath = sourceFile.resolvedPath;
    const sourceFileByteSize = sourceFile.byteSize;
    const sourceFileHash = sourceFile.hash;
    const factCount = sourceFile.factCount;
    const exportFactCount = sourceFile.exportFactCount;
    const signatureFactCount = sourceFile.signatureFactCount;
    const configFactCount = sourceFile.configFactCount;
    const contextFactCount = sourceFile.contextFactCount;
    const parseDiagnosticCount = sourceFile.parseDiagnosticCount;

    if (!isNonEmptyString(sourceFilePath)) {
      failures.push(`malformed manifest: ${label}.path must be a non-empty string`);
    } else if (isAbsolute(sourceFilePath)) {
      failures.push(`malformed manifest: ${label}.path must be relative: ${sourceFilePath}`);
    } else if (
      sourceRoot !== undefined &&
      sourceType === 'directory' &&
      !isInsideDirectory(sourceRoot, resolve(sourceRoot, sourceFilePath))
    ) {
      failures.push(`malformed manifest: ${label}.path escapes source root: ${sourceFilePath}`);
    }

    if (!isNonEmptyString(sourceFileResolvedPath)) {
      failures.push(`malformed manifest: ${label}.resolvedPath must be a non-empty string`);
    } else if (!isAbsolute(sourceFileResolvedPath)) {
      failures.push(`malformed manifest: ${label}.resolvedPath must be absolute`);
    } else if (
      sourceRoot !== undefined &&
      sourceType === 'directory' &&
      !isInsideDirectory(sourceRoot, sourceFileResolvedPath)
    ) {
      failures.push(
        `malformed manifest: ${label}.resolvedPath escapes source root: ${sourceFileResolvedPath}`
      );
    }

    if (
      sourceRoot !== undefined &&
      isNonEmptyString(sourceFilePath) &&
      !isAbsolute(sourceFilePath) &&
      isNonEmptyString(sourceFileResolvedPath) &&
      isAbsolute(sourceFileResolvedPath) &&
      isSourceTruthSourceType(sourceType)
    ) {
      const expectedResolvedPath =
        sourceType === 'directory'
          ? resolve(sourceRoot, sourceFilePath)
          : resolve(dirname(sourceRoot), sourceFilePath);

      if (expectedResolvedPath !== sourceFileResolvedPath) {
        failures.push(
          `malformed manifest: ${label}.resolvedPath must match ${label}.path under source.resolvedPath`
        );
      }

      if (sourceType === 'file' && sourceFileResolvedPath !== sourceRoot) {
        failures.push(
          `malformed manifest: ${label}.resolvedPath must match source.resolvedPath for file sources`
        );
      }
    }

    if (!isNonNegativeInteger(sourceFileByteSize)) {
      failures.push(`malformed manifest: ${label}.byteSize must be a non-negative integer`);
    }

    if (!isSha256Hash(sourceFileHash)) {
      failures.push(`malformed manifest: ${label}.hash must be a sha256 hash`);
    }

    if (!isNonNegativeInteger(factCount)) {
      failures.push(`malformed manifest: ${label}.factCount must be a non-negative integer`);
    }

    if (!isNonNegativeInteger(exportFactCount)) {
      failures.push(`malformed manifest: ${label}.exportFactCount must be a non-negative integer`);
    }

    if (signatureFactCount !== undefined && !isNonNegativeInteger(signatureFactCount)) {
      failures.push(
        `malformed manifest: ${label}.signatureFactCount must be a non-negative integer when present`
      );
    }

    if (!isNonNegativeInteger(configFactCount)) {
      failures.push(`malformed manifest: ${label}.configFactCount must be a non-negative integer`);
    }

    if (!isNonNegativeInteger(contextFactCount)) {
      failures.push(`malformed manifest: ${label}.contextFactCount must be a non-negative integer`);
    }

    if (!isNonNegativeInteger(parseDiagnosticCount)) {
      failures.push(
        `malformed manifest: ${label}.parseDiagnosticCount must be a non-negative integer`
      );
    }

    if (
      isNonNegativeInteger(factCount) &&
      isNonNegativeInteger(exportFactCount) &&
      isNonNegativeInteger(configFactCount) &&
      isNonNegativeInteger(contextFactCount) &&
      factCount !== exportFactCount + configFactCount + contextFactCount
    ) {
      failures.push(
        `malformed manifest: ${label}.factCount must match export/config/context fact counts`
      );
    }

    if (
      isNonNegativeInteger(signatureFactCount) &&
      isNonNegativeInteger(exportFactCount) &&
      signatureFactCount > exportFactCount
    ) {
      failures.push(
        `malformed manifest: ${label}.signatureFactCount must be less than or equal to exportFactCount`
      );
    }

    if (
      isNonEmptyString(sourceFilePath) &&
      !isAbsolute(sourceFilePath) &&
      isNonEmptyString(sourceFileResolvedPath) &&
      isAbsolute(sourceFileResolvedPath) &&
      isNonNegativeInteger(sourceFileByteSize) &&
      isSha256Hash(sourceFileHash) &&
      isNonNegativeInteger(factCount) &&
      isNonNegativeInteger(exportFactCount) &&
      (signatureFactCount === undefined || isNonNegativeInteger(signatureFactCount)) &&
      isNonNegativeInteger(configFactCount) &&
      isNonNegativeInteger(contextFactCount) &&
      isNonNegativeInteger(parseDiagnosticCount)
    ) {
      sourceFileEntries.push({
        path: sourceFilePath,
        resolvedPath: sourceFileResolvedPath,
        byteSize: sourceFileByteSize,
        hash: sourceFileHash,
        factCount,
        exportFactCount,
        ...(signatureFactCount === undefined ? {} : { signatureFactCount }),
        configFactCount,
        contextFactCount,
        parseDiagnosticCount,
      });
      const fileCheck: FileCheck = {
        label,
        path: sourceFileResolvedPath,
        expectedByteSize: sourceFileByteSize,
        expectedHash: sourceFileHash,
        rejectSymlink: true,
        rejectSymlinkAncestors: true,
      };

      if (trustedRoot !== undefined) {
        fileCheck.trustedRoot = trustedRoot;
      }

      fileChecks.push(fileCheck);
    }
  }

  return sourceFileEntries;
}

function validateSourceTruthGeneratedOutputSet(
  generatedOutputs: unknown[],
  failures: string[]
): void {
  let reportOutputCount = 0;
  let markdownOutputCount = 0;

  for (const output of generatedOutputs) {
    if (!isObjectRecord(output)) {
      continue;
    }

    if (output.kind === SOURCE_TRUTH_REPORT_OUTPUT_KIND) {
      reportOutputCount++;
    }

    if (output.kind === SOURCE_TRUTH_MARKDOWN_OUTPUT_KIND) {
      markdownOutputCount++;
    }
  }

  if (generatedOutputs.length !== 2 || reportOutputCount !== 1 || markdownOutputCount !== 1) {
    failures.push(
      `malformed manifest: source-truth manifests must contain exactly one ${SOURCE_TRUTH_REPORT_OUTPUT_KIND} output and one ${SOURCE_TRUTH_MARKDOWN_OUTPUT_KIND} output`
    );
  }
}

function sourceTruthReportOutputPath(generatedOutputs: unknown[]): string | undefined {
  for (const output of generatedOutputs) {
    if (
      isObjectRecord(output) &&
      output.kind === SOURCE_TRUTH_REPORT_OUTPUT_KIND &&
      isNonEmptyString(output.path) &&
      !isAbsolute(output.path)
    ) {
      return output.path;
    }
  }

  return undefined;
}

async function verifySourceVerificationReportFile(options: {
  manifestDir: string;
  reportPath: string;
  expected: {
    reportPath: string;
    source: Record<string, unknown>;
    docs: Record<string, unknown>;
    summary: Record<string, unknown>;
  };
  failures: string[];
}): Promise<void> {
  const { manifestDir, reportPath, expected, failures } = options;
  let report: unknown;

  try {
    report = JSON.parse(await readFile(reportPath, 'utf-8')) as unknown;
  } catch (error) {
    failures.push(`source-verification report: malformed JSON: ${errorMessage(error)}`);
    return;
  }

  if (!isObjectRecord(report)) {
    failures.push('source-verification report: root must be an object');
    return;
  }

  if (report.schemaVersion !== SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION) {
    failures.push(
      `source-verification report: schemaVersion mismatch (expected ${SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION}, actual ${String(
        report.schemaVersion
      )})`
    );
  }

  if (report.mode !== SOURCE_VERIFICATION_MODE) {
    failures.push(
      `source-verification report: mode mismatch (expected ${SOURCE_VERIFICATION_MODE}, actual ${String(
        report.mode
      )})`
    );
  }

  const output = report.output;
  if (!isObjectRecord(output)) {
    failures.push('source-verification report: missing output object');
  } else if (!isNonEmptyString(output.reportPath)) {
    failures.push('source-verification report: output.reportPath must be a non-empty string');
  } else if (resolveManifestSourcePath(output.reportPath, manifestDir) !== reportPath) {
    failures.push(
      'source-verification report: output.reportPath must match manifest sourceVerification.reportPath'
    );
  }

  compareSourceVerificationReportEndpoint({
    actual: report.source,
    expected: expected.source,
    label: 'source',
    failures,
  });
  compareSourceVerificationReportEndpoint({
    actual: report.docs,
    expected: expected.docs,
    label: 'docs',
    failures,
  });

  const summary = report.summary;
  if (!isObjectRecord(summary)) {
    failures.push('source-verification report: missing summary object');
    return;
  }

  for (const field of SOURCE_VERIFICATION_SUMMARY_FIELDS) {
    if (summary[field] !== expected.summary[field]) {
      failures.push(
        `source-verification report: summary.${field} mismatch (expected ${String(
          expected.summary[field]
        )}, actual ${String(summary[field])})`
      );
    }
  }

  validateSourceVerificationReportSummaryConsistency(report, summary, failures);

  if (isObjectRecord(report.source) && isObjectRecord(report.sourceInspection)) {
    compareSourceVerificationReportEndpoint({
      actual: report.sourceInspection.source,
      expected: report.source,
      label: 'sourceInspection.source',
      failures,
    });
  }

  if (isObjectRecord(output) && expected.reportPath !== output.reportPath) {
    failures.push('source-verification report: report path mismatch');
  }
}

function compareSourceVerificationReportEndpoint(options: {
  actual: unknown;
  expected: Record<string, unknown>;
  label: string;
  failures: string[];
}): void {
  const { actual, expected, label, failures } = options;

  if (!isObjectRecord(actual)) {
    failures.push(`source-verification report: missing ${label} object`);
    return;
  }

  for (const field of ['input', 'resolvedPath', 'type']) {
    if (actual[field] !== expected[field]) {
      failures.push(
        `source-verification report: ${label}.${field} mismatch (expected ${String(
          expected[field]
        )}, actual ${String(actual[field])})`
      );
    }
  }
}

function validateSourceVerificationReportSummaryConsistency(
  report: Record<string, unknown>,
  summary: Record<string, unknown>,
  failures: string[]
): void {
  const computedSummary = summarizeSourceVerificationReportBody(report, failures);

  if (computedSummary === undefined) {
    return;
  }

  for (const field of SOURCE_VERIFICATION_SUMMARY_FIELDS) {
    if (summary[field] !== computedSummary[field]) {
      failures.push(
        `source-verification report: summary.${field} inconsistent with report body (expected ${String(
          computedSummary[field]
        )}, actual ${String(summary[field])})`
      );
    }
  }
}

function summarizeSourceVerificationReportBody(
  report: Record<string, unknown>,
  failures: string[]
): Record<(typeof SOURCE_VERIFICATION_SUMMARY_FIELDS)[number], number> | undefined {
  const docs = report.docs;
  const sourceInspection = report.sourceInspection;
  const comparison = report.comparison;
  const warnings = report.warnings;

  if (!isObjectRecord(docs)) {
    return undefined;
  }

  if (!isObjectRecord(sourceInspection)) {
    failures.push('source-verification report: sourceInspection must be an object');
    return undefined;
  }

  if (!isObjectRecord(comparison)) {
    failures.push('source-verification report: comparison must be an object');
    return undefined;
  }

  const docsFiles = docs.files;
  const docsReferences = docs.references;
  const sourceFiles = sourceInspection.files;
  const sourceFacts = sourceInspection.facts;
  const observedExports = comparison.observedExports;
  const matches = comparison.matches;
  const unmatchedReferences = comparison.unmatchedReferences;

  if (!Array.isArray(docsFiles)) {
    failures.push('source-verification report: docs.files must be an array');
    return undefined;
  }

  if (!Array.isArray(docsReferences)) {
    failures.push('source-verification report: docs.references must be an array');
    return undefined;
  }

  if (!Array.isArray(sourceFiles)) {
    failures.push('source-verification report: sourceInspection.files must be an array');
    return undefined;
  }

  if (!Array.isArray(sourceFacts)) {
    failures.push('source-verification report: sourceInspection.facts must be an array');
    return undefined;
  }

  if (!Array.isArray(observedExports)) {
    failures.push('source-verification report: comparison.observedExports must be an array');
    return undefined;
  }

  if (!Array.isArray(matches)) {
    failures.push('source-verification report: comparison.matches must be an array');
    return undefined;
  }

  if (!Array.isArray(unmatchedReferences)) {
    failures.push('source-verification report: comparison.unmatchedReferences must be an array');
    return undefined;
  }

  if (!Array.isArray(warnings)) {
    failures.push('source-verification report: warnings must be an array');
    return undefined;
  }

  return {
    sourceFileCount: sourceFiles.length,
    sourceExportFactCount: sourceFacts.length,
    observedExportedNameCount: observedExports.length,
    docsFileCount: docsFiles.filter(
      (file): file is Record<string, unknown> => isObjectRecord(file) && file.status === 'inspected'
    ).length,
    docsReferenceCount: docsReferences.length,
    exactMatchCount: matches.length,
    unmatchedReferenceCount: unmatchedReferences.length,
    warningCount: warnings.length,
  };
}

async function verifySourceTruthReportFile(options: {
  reportPath: string;
  expected: {
    source: Record<string, unknown>;
    inspection: Record<string, unknown>;
    sourceFiles: SourceTruthSourceFileEntry[];
  };
  failures: string[];
}): Promise<void> {
  const { reportPath, expected, failures } = options;
  let report: unknown;

  try {
    report = JSON.parse(await readFile(reportPath, 'utf-8')) as unknown;
  } catch (error) {
    failures.push(`source-truth report: malformed JSON: ${errorMessage(error)}`);
    return;
  }

  if (!isObjectRecord(report)) {
    failures.push('source-truth report: root must be an object');
    return;
  }

  if (report.schemaVersion !== SOURCE_TRUTH_REPORT_SCHEMA_VERSION) {
    failures.push(
      `source-truth report: schemaVersion mismatch (expected ${SOURCE_TRUTH_REPORT_SCHEMA_VERSION}, actual ${String(
        report.schemaVersion
      )})`
    );
  }

  if (report.mode !== SOURCE_TRUTH_INSPECTION_MODE) {
    failures.push(
      `source-truth report: mode mismatch (expected ${SOURCE_TRUTH_INSPECTION_MODE}, actual ${String(
        report.mode
      )})`
    );
  }

  validateSourceTruthReportSource(report.source, expected.source, failures);
  validateSourceTruthReportInspection(report, expected.inspection, failures);
  validateSourceTruthReportCounts(report, expected.sourceFiles, failures);
}

function validateSourceTruthReportSource(
  reportSource: unknown,
  expectedSource: Record<string, unknown>,
  failures: string[]
): void {
  if (!isObjectRecord(reportSource)) {
    failures.push('source-truth report: missing source object');
    return;
  }

  for (const field of ['input', 'resolvedPath', 'type']) {
    if (reportSource[field] !== expectedSource[field]) {
      failures.push(
        `source-truth report: source.${field} mismatch (expected ${String(
          expectedSource[field]
        )}, actual ${String(reportSource[field])})`
      );
    }
  }
}

function validateSourceTruthReportInspection(
  report: Record<string, unknown>,
  expectedInspection: Record<string, unknown>,
  failures: string[]
): void {
  const reportTraversal = report.traversal;
  const expectedTraversal = expectedInspection.traversal;

  if (!isObjectRecord(reportTraversal)) {
    failures.push('source-truth report: traversal must be an object');
  } else {
    validateSourceTruthTraversal(reportTraversal, 'source-truth report: traversal', failures);

    if (isObjectRecord(expectedTraversal)) {
      compareSourceTruthTraversal(reportTraversal, expectedTraversal, failures);
    }
  }

  const reportWarnings = report.warnings;
  const expectedWarnings = expectedInspection.warnings;

  if (!Array.isArray(reportWarnings)) {
    failures.push('source-truth report: warnings must be an array');
  } else if (Array.isArray(expectedWarnings) && reportWarnings.length !== expectedWarnings.length) {
    failures.push(
      `source-truth report: warning count mismatch (expected ${expectedWarnings.length}, actual ${reportWarnings.length})`
    );
  }
}

function compareSourceTruthTraversal(
  reportTraversal: Record<string, unknown>,
  expectedTraversal: Record<string, unknown>,
  failures: string[]
): void {
  for (const field of [
    'followSymlinks',
    'maxDepth',
    'maxEntries',
    'maxFiles',
    'maxFileBytes',
    'visitedEntries',
    'visitedFiles',
    'inspectedFiles',
    'skippedFiles',
    'truncated',
  ]) {
    if (reportTraversal[field] !== expectedTraversal[field]) {
      failures.push(
        `source-truth report: traversal.${field} mismatch (expected ${String(
          expectedTraversal[field]
        )}, actual ${String(reportTraversal[field])})`
      );
    }
  }

  const reportSkippedDirectories = reportTraversal.skippedDirectoryNames;
  const expectedSkippedDirectories = expectedTraversal.skippedDirectoryNames;

  if (Array.isArray(reportSkippedDirectories) && Array.isArray(expectedSkippedDirectories)) {
    if (reportSkippedDirectories.length !== expectedSkippedDirectories.length) {
      failures.push(
        `source-truth report: traversal.skippedDirectoryNames count mismatch (expected ${expectedSkippedDirectories.length}, actual ${reportSkippedDirectories.length})`
      );
    }
  }
}

function validateSourceTruthReportCounts(
  report: Record<string, unknown>,
  expectedSourceFiles: SourceTruthSourceFileEntry[],
  failures: string[]
): void {
  const reportFiles = report.files;
  const reportFacts = report.facts;
  const reportConfigFacts = report.configFacts;
  const reportContextFacts = report.contextFacts;

  if (!Array.isArray(reportFacts)) {
    failures.push('source-truth report: facts must be an array');
  }

  if (!Array.isArray(reportConfigFacts)) {
    failures.push('source-truth report: configFacts must be an array');
  }

  if (!Array.isArray(reportContextFacts)) {
    failures.push('source-truth report: contextFacts must be an array');
  }

  if (!Array.isArray(reportFiles)) {
    failures.push('source-truth report: files must be an array');
    return;
  }

  const reportSourceFiles = summarizeSourceTruthReportFiles(reportFiles, failures);
  const expectedExportFactCount = sumSourceTruthCount(
    expectedSourceFiles,
    (file) => file.exportFactCount
  );
  const expectedConfigFactCount = sumSourceTruthCount(
    expectedSourceFiles,
    (file) => file.configFactCount
  );
  const expectedContextFactCount = sumSourceTruthCount(
    expectedSourceFiles,
    (file) => file.contextFactCount
  );

  if (Array.isArray(reportFacts) && reportFacts.length !== expectedExportFactCount) {
    failures.push(
      `source-truth report: export fact count mismatch (expected ${expectedExportFactCount}, actual ${reportFacts.length})`
    );
  }

  if (Array.isArray(reportConfigFacts) && reportConfigFacts.length !== expectedConfigFactCount) {
    failures.push(
      `source-truth report: config fact count mismatch (expected ${expectedConfigFactCount}, actual ${reportConfigFacts.length})`
    );
  }

  if (Array.isArray(reportContextFacts) && reportContextFacts.length !== expectedContextFactCount) {
    failures.push(
      `source-truth report: context fact count mismatch (expected ${expectedContextFactCount}, actual ${reportContextFacts.length})`
    );
  }

  if (reportSourceFiles.length !== expectedSourceFiles.length) {
    failures.push(
      `source-truth report: source file count mismatch (expected ${expectedSourceFiles.length}, actual ${reportSourceFiles.length})`
    );
  }

  const reportFilesByPath = new Map(reportSourceFiles.map((file) => [file.path, file]));

  for (const [index, expectedFile] of expectedSourceFiles.entries()) {
    const reportFile = reportFilesByPath.get(expectedFile.path);
    const label = `source-truth report: sourceFiles[${index}]`;

    if (reportFile === undefined) {
      failures.push(`${label} missing from report files: ${expectedFile.path}`);
      continue;
    }

    compareSourceTruthReportFile(expectedFile, reportFile, label, failures);
  }
}

function summarizeSourceTruthReportFiles(
  reportFiles: unknown[],
  failures: string[]
): SourceTruthSourceFileEntry[] {
  const sourceFiles: SourceTruthSourceFileEntry[] = [];

  for (const [index, reportFile] of reportFiles.entries()) {
    const label = `source-truth report: files[${index}]`;

    if (!isObjectRecord(reportFile)) {
      failures.push(`${label} must be an object`);
      continue;
    }

    const facts = reportFile.facts;
    const configFacts = reportFile.configFacts;
    const contextFacts = reportFile.contextFacts;
    const parseDiagnostics = reportFile.parseDiagnostics;

    if (!Array.isArray(facts)) {
      failures.push(`${label}.facts must be an array`);
      continue;
    }

    if (!Array.isArray(configFacts)) {
      failures.push(`${label}.configFacts must be an array`);
      continue;
    }

    if (!Array.isArray(contextFacts)) {
      failures.push(`${label}.contextFacts must be an array`);
      continue;
    }

    if (parseDiagnostics !== undefined && !Array.isArray(parseDiagnostics)) {
      failures.push(`${label}.parseDiagnostics must be an array when present`);
      continue;
    }

    if (facts.length === 0 && configFacts.length === 0 && contextFacts.length === 0) {
      continue;
    }

    if (!isNonEmptyString(reportFile.path)) {
      failures.push(`${label}.path must be a non-empty string`);
      continue;
    }

    if (!isNonEmptyString(reportFile.resolvedPath)) {
      failures.push(`${label}.resolvedPath must be a non-empty string`);
      continue;
    }

    if (!isNonNegativeInteger(reportFile.byteSize)) {
      failures.push(`${label}.byteSize must be a non-negative integer`);
      continue;
    }

    if (!isUnprefixedSha256Hash(reportFile.sha256)) {
      failures.push(`${label}.sha256 must be a sha256 hash`);
      continue;
    }

    sourceFiles.push({
      path: reportFile.path,
      resolvedPath: reportFile.resolvedPath,
      byteSize: reportFile.byteSize,
      hash: `${HASH_PREFIX}${reportFile.sha256}`,
      factCount: facts.length + configFacts.length + contextFacts.length,
      exportFactCount: facts.length,
      signatureFactCount: facts.filter(hasSourceTruthSignature).length,
      configFactCount: configFacts.length,
      contextFactCount: contextFacts.length,
      parseDiagnosticCount: parseDiagnostics?.length ?? 0,
    });
  }

  return sourceFiles;
}

function compareSourceTruthReportFile(
  expectedFile: SourceTruthSourceFileEntry,
  reportFile: SourceTruthSourceFileEntry,
  label: string,
  failures: string[]
): void {
  const fields: Array<keyof SourceTruthSourceFileEntry> = [
    'resolvedPath',
    'byteSize',
    'hash',
    'factCount',
    'exportFactCount',
    'configFactCount',
    'contextFactCount',
    'parseDiagnosticCount',
  ];

  for (const field of fields) {
    if (reportFile[field] !== expectedFile[field]) {
      failures.push(
        `${label}.${field} mismatch (expected ${String(expectedFile[field])}, actual ${String(
          reportFile[field]
        )})`
      );
    }
  }

  if (
    expectedFile.signatureFactCount !== undefined &&
    reportFile.signatureFactCount !== expectedFile.signatureFactCount
  ) {
    failures.push(
      `${label}.signatureFactCount mismatch (expected ${expectedFile.signatureFactCount}, actual ${String(
        reportFile.signatureFactCount
      )})`
    );
  }
}

function sumSourceTruthCount(
  files: SourceTruthSourceFileEntry[],
  select: (file: SourceTruthSourceFileEntry) => number
): number {
  return files.reduce((total, file) => total + select(file), 0);
}

function hasSourceTruthSignature(value: unknown): boolean {
  return isObjectRecord(value) && value.signature !== undefined;
}

async function runFileChecks(
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

async function describeFile(path: string): Promise<{ byteSize: number; hash: string }> {
  const [fileStats, hash] = await Promise.all([stat(path), sha256File(path)]);

  return {
    byteSize: fileStats.size,
    hash,
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  return `${HASH_PREFIX}${hash.digest('hex')}`;
}

function toManifestRelativePath(manifestDir: string, outputPath: string): string {
  return relative(manifestDir, outputPath).split(sep).join('/');
}

function resolveManifestSourcePath(sourcePath: string, manifestDir: string): string {
  if (isAbsolute(sourcePath)) {
    return sourcePath;
  }

  return resolve(manifestDir, sourcePath);
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

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameOptionalStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return sameStringArray(left, right);
}

function isUrlLikePath(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('\\\\');
}

function hasEmptyOrParentPathSegment(value: string): boolean {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .some((segment) => segment.length === 0 || segment === '..');
}

interface FileCheck {
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

interface PathTypeCheck {
  label: string;
  path: string;
  expectedType: 'file' | 'directory';
  rejectSymlinkAncestors?: boolean;
}

async function verifyFile(check: FileCheck, failures: string[]): Promise<void> {
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

async function verifyNoSymlinkPathComponent(options: {
  label: string;
  path: string;
  targetPath: string;
  isLeaf: boolean;
  leafType?: 'file' | 'directory';
  failures: string[];
}): Promise<boolean> {
  const { label, path, targetPath, isLeaf, leafType = 'file', failures } = options;
  let stats;

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

async function verifyPathType(check: PathTypeCheck, failures: string[]): Promise<void> {
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

  let stats;

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

function aggregateSourceFilesHash(files: SourceFileEntry[]): string {
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

  return `${HASH_PREFIX}${hash.digest('hex')}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIsoTimestampString(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const date = new Date(value);

  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isSha256Hash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isUnprefixedSha256Hash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isAllowedOutputKind(value: unknown, allowedKinds: ReadonlySet<string>): value is string {
  return typeof value === 'string' && allowedKinds.has(value);
}

function isDiscoveryReportKind(value: unknown): value is DiscoveryReportKind {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(DISCOVERY_REPORT_MODE_BY_KIND, value)
  );
}

function formatAllowedOutputKinds(allowedKinds: ReadonlySet<string>): string {
  const kinds = [...allowedKinds];

  if (kinds.length <= 1) {
    return kinds[0] ?? 'a supported output kind';
  }

  return `${kinds.slice(0, -1).join(', ')} or ${kinds[kinds.length - 1]}`;
}

function isSourceDocsSourceType(value: unknown): value is 'file' | 'directory' {
  return typeof value === 'string' && SOURCE_DOCS_SOURCE_TYPES.has(value);
}

function isSourceTruthSourceType(value: unknown): value is 'file' | 'directory' {
  return typeof value === 'string' && SOURCE_DOCS_SOURCE_TYPES.has(value);
}

function isInsideDirectory(parentDir: string, childPath: string): boolean {
  const relativePath = relative(parentDir, childPath);

  return relativePath === '' || (!isParentRelativePath(relativePath) && !isAbsolute(relativePath));
}

function isParentRelativePath(path: string): boolean {
  return path === '..' || path.startsWith(`..${sep}`);
}

function isFileNotFoundError(error: unknown): boolean {
  return isObjectRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
