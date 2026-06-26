/**
 * Generation manifest writer for the configured SDK compatibility flow.
 */

import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

import { describeGeneratedTextOutput } from './generated-output-metadata.js';
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
const SOURCE_TRUTH_REPORT_SCHEMA_VERSION = '0.1.0';
const SOURCE_TRUTH_INSPECTION_MODE = 'source-truth-local-evidence';
const SOURCE_TRUTH_REPORT_OUTPUT_KIND = 'source-truth-report-json';
const SOURCE_TRUTH_MARKDOWN_OUTPUT_KIND = 'source-truth-markdown';
const SOURCE_TRUTH_GENERATED_OUTPUT_KINDS = new Set([
  SOURCE_TRUTH_REPORT_OUTPUT_KIND,
  SOURCE_TRUTH_MARKDOWN_OUTPUT_KIND,
]);
const DISCOVERY_REPORT_MODE_BY_KIND = {
  source: 'local-bounded-inspection',
  repo: 'repo-bounded-inspection',
  url: 'website-bounded-inspection',
} as const;
const SOURCE_DOCS_GENERATED_OUTPUT_KINDS = new Set(['llm-docs', 'semantic-chunks-jsonl']);
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
  const reportSummary = summarizeDiscoveryReport(options.discoveryKind, options.report);
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
      failures.push(`malformed manifest: generatedOutputs[0].kind must be ${DISCOVERY_REPORT_OUTPUT_KIND}`);
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
  const source = manifest.source;
  const generatedOutputs = manifest.generatedOutputs;

  if (!isObjectRecord(source)) {
    failures.push('malformed manifest: missing source object');
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
  const source = manifest.source;
  const sourceFiles = manifest.sourceFiles;
  const generatedOutputs = manifest.generatedOutputs;
  const preset = manifest.preset;

  if (!isObjectRecord(source)) {
    failures.push('malformed manifest: missing source object');
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
  const sourceFileRecords = sourceFiles as unknown[];
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

  if (!isNonEmptyString(sourceInput)) {
    failures.push('malformed manifest: source.input must be a non-empty string');
  }

  if (!isNonEmptyString(sourceType) || !SOURCE_DOCS_SOURCE_TYPES.has(sourceType)) {
    failures.push('malformed manifest: source.type must be file or directory');
  }

  if (!isNonEmptyString(sourceFormatHint) || !SOURCE_DOCS_FORMAT_HINTS.has(sourceFormatHint)) {
    failures.push('malformed manifest: source.formatHint must be a supported source format hint');
  }

  if (
    !isNonEmptyString(sourceResolvedFormat) ||
    !SOURCE_DOCS_RESOLVED_FORMATS.has(sourceResolvedFormat)
  ) {
    failures.push('malformed manifest: source.resolvedFormat must be a supported source format');
  }

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
  validateSourceDocsPresetMetadata(preset, failures);

  if (failures.length === 0) {
    for (const check of pathTypeChecks) {
      await verifyPathType(check, failures);
    }
  }

  return runFileChecks(manifestPath, failures, fileChecks);
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

interface DiscoveryReportSummary {
  schemaVersion: string;
  mode: string;
  candidateCount: number;
  warningCount: number;
  urlResourceCount?: number;
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
  failures: string[];
}): Promise<void> {
  const { manifestDir, reportPath, expected, failures } = options;
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

    if (
      isNonEmptyString(outputPath) &&
      !isAbsolute(outputPath) &&
      isInsideDirectory(manifestDir, resolve(manifestDir, outputPath)) &&
      isAllowedOutputKind(outputKind, allowedKinds) &&
      isNonNegativeInteger(outputByteSize) &&
      isSha256Hash(outputHash) &&
      (!requireTextMetadata ||
        (isNonNegativeInteger(outputLineCount) && isNonNegativeInteger(outputEstimatedTokenCount)))
    ) {
      const expectedLineCount = requireTextMetadata ? (outputLineCount as number) : undefined;
      const expectedEstimatedTokenCount = requireTextMetadata
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

    if (!isNonEmptyString(sourceFileFormat)) {
      failures.push(`malformed manifest: ${label}.format must be a non-empty string`);
    } else if (
      isNonEmptyString(sourceResolvedFormat) &&
      SOURCE_DOCS_RESOLVED_FORMATS.has(sourceResolvedFormat) &&
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

    if (
      signatureFactCount !== undefined &&
      !isNonNegativeInteger(signatureFactCount)
    ) {
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
    validateSourceTruthTraversal(
      reportTraversal,
      'source-truth report: traversal',
      failures
    );

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

    if (
      parseDiagnostics !== undefined &&
      !Array.isArray(parseDiagnostics)
    ) {
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

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
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

  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isFileNotFoundError(error: unknown): boolean {
  return isObjectRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
