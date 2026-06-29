/**
 * Generation manifest writer for the configured SDK compatibility flow.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, win32 } from 'node:path';

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
import {
  isObjectRecord,
  isNonEmptyString,
  isNonNegativeInteger,
  errorMessage,
  isFileNotFoundError,
} from '../utils/guards.js';
import { writeTextFileSafely } from '../utils/safe-write.js';
import { aggregateSourceFilesHash } from '../utils/source-files-hash.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import { readJsonFile } from '../utils/json.js';
import {
  HASH_PREFIX,
  isSha256Hash,
  isUnprefixedSha256Hash,
} from '../utils/hash.js';
import {
  CONFIGURED_SDK_MODE,
  DISCOVERY_REPORT_MODE,
  DISCOVERY_REPORT_OUTPUT_KIND,
  MANIFEST_SCHEMA_VERSION,
  SOURCE_DOCS_FORMATTER_FORMAT,
  SOURCE_DOCS_FORMATTER_NAME,
  SOURCE_DOCS_FORMAT_HINTS,
  SOURCE_DOCS_GENERATED_OUTPUT_KINDS,
  SOURCE_DOCS_MODE,
  SOURCE_DOCS_PLUGIN_FORMAT_ID_PATTERN,
  SOURCE_DOCS_RESOLVED_FORMATS,
  SOURCE_DOCS_SEMANTIC_CHUNK_INDEX_CHUNK_KEYS,
  SOURCE_DOCS_SEMANTIC_CHUNK_INDEX_KEYS,
  SOURCE_DOCS_SEMANTIC_CHUNK_JSONL_KIND,
  SOURCE_DOCS_SOURCE_TYPES,
  SOURCE_DOCS_SWIFT_BOOK_PRESET_LIMITATIONS,
  SOURCE_DOCS_SWIFT_BOOK_PRESET_METADATA,
  SOURCE_DOCS_SWIFT_BOOK_PRESET_NAME,
  SOURCE_TRUTH_DOCS_MODE,
  SOURCE_TRUTH_GENERATED_OUTPUT_KINDS,
  SOURCE_TRUTH_INSPECTION_MODE,
  SOURCE_TRUTH_MARKDOWN_OUTPUT_KIND,
  SOURCE_TRUTH_REPORT_OUTPUT_KIND,
  SOURCE_TRUTH_REPORT_SCHEMA_VERSION,
  SOURCE_VERIFICATION_MODE,
} from './manifest/constants.js';
import type { RefreshSourceManifestMode } from './manifest/constants.js';
import {
  isInsideDirectory,
  isPositiveInteger,
  isSourceDocsSourceType,
  isSourceTruthSourceType,
  isStringArray,
} from './manifest/predicates.js';
import { validateAllowedKeys, validateOptionalStringArray } from './manifest/field-validators.js';
import type {
  GeneratedOutputManifestEntry,
  VerifyGenerationManifestOptions,
  VerifyGenerationManifestResult,
  WriteDiscoveryReportManifestOptions,
  WriteGenerationManifestOptions,
} from './manifest/types.js';
import {
  describeFile,
  hasEmptyOrParentPathSegment,
  isUrlLikePath,
  sameOptionalStringArray,
  sameStringArray,
  toManifestRelativePath,
  verifyFile,
  verifyPathType,
} from './manifest/fs-verify.js';
import type { FileCheck, PathTypeCheck } from './manifest/fs-verify.js';
import { buildManifestContract, validateRequiredManifestContract } from './manifest/contract.js';
import {
  buildRefreshProvenance,
  validateRefreshProvenance,
} from './manifest/refresh-provenance.js';
import type { RefreshProvenance } from './manifest/refresh-provenance.js';
import {
  buildInputProvenanceForManifest,
  validateRequiredInputProvenance,
} from './manifest/provenance.js';
import {
  buildArtifactSummaryForManifest,
  validateRequiredArtifactSummary,
} from './manifest/artifact-summary.js';
import {
  buildDiscoveryCandidateEvidenceIndex,
  readDiscoveryReportJson,
  summarizeDiscoveryReport,
} from './manifest/discovery-evidence.js';
import {
  validateGeneratedOutputs,
  validateGeneratorMetadata,
} from './manifest/verify/shared.js';
import { verifyConfiguredSdkManifest } from './manifest/verify/configured-sdk.js';
import { verifySourceVerificationManifest } from './manifest/verify/source-verification.js';
import { verifyDiscoveryReportManifest } from './manifest/verify/discovery-report.js';

export { buildManifestContract } from './manifest/contract.js';
export type { ManifestContract } from './manifest/contract.js';
export type { RefreshProvenance } from './manifest/refresh-provenance.js';
export { buildInputProvenanceForManifest } from './manifest/provenance.js';
export type {
  InputProvenance,
  InputProvenanceEndpoint,
  InputProvenanceParser,
  InputProvenanceParserPlugin,
  InputProvenanceReport,
} from './manifest/provenance.js';
export { buildArtifactSummaryForManifest } from './manifest/artifact-summary.js';
export type {
  ArtifactFileSummary,
  ArtifactIndexSummary,
  ArtifactSourceFileSummary,
  ArtifactSummary,
} from './manifest/artifact-summary.js';

export {
  CONFIGURED_SDK_MODE,
  DISCOVERY_REPORT_MODE,
  MANIFEST_SCHEMA_VERSION,
  SOURCE_DOCS_SWIFT_BOOK_PRESET_LIMITATIONS,
  SOURCE_DOCS_SWIFT_BOOK_PRESET_METADATA,
  SOURCE_DOCS_SWIFT_BOOK_PRESET_NAME,
} from './manifest/constants.js';
export type {
  DiscoveryReportKind,
  GeneratedOutputKind,
  ManifestContractMode,
  RefreshSourceManifestMode,
} from './manifest/constants.js';
export type {
  FormatterManifestMetadata,
  GeneratedOutputInput,
  GeneratedOutputManifestEntry,
  GeneratorMetadata,
  ParserManifestMetadata,
  SourceManifestInput,
  VerifyGenerationManifestOptions,
  VerifyGenerationManifestResult,
  WriteDiscoveryReportManifestOptions,
  WriteGenerationManifestOptions,
} from './manifest/types.js';

export async function writeGenerationManifest(
  options: WriteGenerationManifestOptions
): Promise<void> {
  const manifestDir = dirname(options.manifestPath);
  const sourceFile = await describeGeneratedTextOutput(options.source.resolvedSpecPath);

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
    manifestContract: buildManifestContract(CONFIGURED_SDK_MODE),
    sdk: options.sdk,
    source: {
      ...options.source,
      byteSize: sourceFile.byteSize,
      contentHash: sourceFile.hash,
      lineCount: sourceFile.lineCount,
      estimatedTokenCount: sourceFile.estimatedTokenCount,
    },
    parser: options.parser,
    formatter: options.formatter,
    generatedOutputs,
    warnings: options.warnings ?? [],
  };
  const manifestWithProvenance = {
    ...manifest,
    inputProvenance: buildInputProvenanceForManifest(manifest),
  };
  const manifestWithSummary = {
    ...manifestWithProvenance,
    artifactSummary: buildArtifactSummaryForManifest(manifestWithProvenance),
  };

  await mkdir(manifestDir, { recursive: true });
  // Atomic, symlink-refusing write (parity with the sibling manifest writers),
  // so a crash mid-write can't leave a truncated manifest and a pre-existing
  // symlink at the path can't redirect the write.
  await writeTextFileSafely(
    options.manifestPath,
    `${JSON.stringify(manifestWithSummary, null, 2)}\n`
  );
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
    manifestContract: buildManifestContract(DISCOVERY_REPORT_MODE),
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
  const manifestWithProvenance = {
    ...manifest,
    inputProvenance: buildInputProvenanceForManifest(manifest),
  };
  const manifestWithSummary = {
    ...manifestWithProvenance,
    artifactSummary: buildArtifactSummaryForManifest(manifestWithProvenance),
  };

  await mkdir(manifestDir, { recursive: true });
  await writeTextFileSafely(
    options.manifestPath,
    `${JSON.stringify(manifestWithSummary, null, 2)}\n`
  );
}

export async function recordRefreshProvenanceInManifest(options: {
  manifestPath: string;
  mode: RefreshSourceManifestMode;
  refreshedAt?: Date;
}): Promise<RefreshProvenance> {
  const manifest = await readJsonFile(options.manifestPath);

  if (!isObjectRecord(manifest)) {
    throw new Error('refreshed manifest must be an object before recording refresh provenance');
  }

  if (manifest.mode !== options.mode) {
    throw new Error(
      `refreshed manifest mode ${String(manifest.mode)} does not match refresh mode ${options.mode}`
    );
  }

  const refresh = buildRefreshProvenance(options.mode, options.refreshedAt ?? new Date());
  manifest.inputProvenance = buildInputProvenanceForManifest(manifest);
  manifest.artifactSummary = buildArtifactSummaryForManifest(manifest);
  manifest.refresh = refresh;
  await writeTextFileSafely(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return refresh;
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
    manifest = await readJsonFile(manifestPath);
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

  const hasParserPluginMetadata =
    isObjectRecord(parser) && (parser as Record<string, unknown>).plugin !== undefined;

  if (manifest.refresh !== undefined) {
    if (hasParserPluginMetadata) {
      failures.push(
        'malformed manifest: refresh is supported for local-source-docs manifests only when generated by the built-in parser'
      );
    } else {
      validateRefreshProvenance(manifest.refresh, SOURCE_DOCS_MODE, failures);
    }
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

  if (!isNonEmptyString(sourceInput)) {
    failures.push('malformed manifest: source.input must be a non-empty string');
  }

  if (!isNonEmptyString(sourceType) || !SOURCE_DOCS_SOURCE_TYPES.has(sourceType)) {
    failures.push('malformed manifest: source.type must be file or directory');
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

  if (
    hasParserPluginMetadata &&
    sourceType === 'directory' &&
    parserPluginMetadata !== undefined &&
    parserPluginMetadata.format.directorySupport !== true
  ) {
    failures.push(
      'malformed manifest: parser.plugin directory source manifests require parser.plugin.format.directorySupport true'
    );
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

  validateRequiredManifestContract(manifest.manifestContract, SOURCE_DOCS_MODE, failures);
  validateRequiredInputProvenance(manifest.inputProvenance, SOURCE_DOCS_MODE, manifest, failures);
  validateRequiredArtifactSummary(manifest.artifactSummary, SOURCE_DOCS_MODE, manifest, failures);

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

  validateRefreshProvenance(manifest.refresh, SOURCE_TRUTH_DOCS_MODE, failures);

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

  validateRequiredManifestContract(manifest.manifestContract, SOURCE_TRUTH_DOCS_MODE, failures);
  validateRequiredInputProvenance(
    manifest.inputProvenance,
    SOURCE_TRUTH_DOCS_MODE,
    manifest,
    failures
  );
  validateRequiredArtifactSummary(
    manifest.artifactSummary,
    SOURCE_TRUTH_DOCS_MODE,
    manifest,
    failures
  );

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
      parsedMediaTypes?.some((mediaType) => mediaType.length === 0)
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

function validateSourceDocsSemanticChunkIndexes(options: {
  semanticChunkIndexes: unknown;
  generatedOutputs: unknown[];
  manifestDir: string;
  failures: string[];
}): SemanticChunkManifestIndex[] {
  const { semanticChunkIndexes, generatedOutputs, manifestDir, failures } = options;

  if (semanticChunkIndexes === undefined) {
    // A semantic-chunks-jsonl output with no index would leave its chunk
    // metadata (ordinals, per-chunk hashes, warning counts) unverified, so an
    // omitted index must fail rather than silently pass when such an output
    // exists.
    if (sourceDocsSemanticChunkOutputPaths(generatedOutputs, manifestDir).size > 0) {
      failures.push(
        'malformed manifest: semanticChunkIndexes is required when a semantic-chunks-jsonl output is present'
      );
    }
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
  lineCount?: number;
  estimatedTokenCount?: number;
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
    const sourceFileLineCount = sourceFile.lineCount;
    const sourceFileEstimatedTokenCount = sourceFile.estimatedTokenCount;
    const factCount = sourceFile.factCount;
    const exportFactCount = sourceFile.exportFactCount;
    const signatureFactCount = sourceFile.signatureFactCount;
    const configFactCount = sourceFile.configFactCount;
    const contextFactCount = sourceFile.contextFactCount;
    const parseDiagnosticCount = sourceFile.parseDiagnosticCount;
    const hasValidLineCount = isNonNegativeInteger(sourceFileLineCount);
    const hasValidEstimatedTokenCount = isNonNegativeInteger(sourceFileEstimatedTokenCount);

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

    if (!hasValidLineCount) {
      failures.push(`malformed manifest: ${label}.lineCount must be a non-negative integer`);
    }

    if (!hasValidEstimatedTokenCount) {
      failures.push(
        `malformed manifest: ${label}.estimatedTokenCount must be a non-negative integer`
      );
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
      hasValidLineCount &&
      hasValidEstimatedTokenCount &&
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
        lineCount: sourceFileLineCount,
        estimatedTokenCount: sourceFileEstimatedTokenCount,
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

      fileCheck.expectedLineCount = sourceFileLineCount;
      fileCheck.expectedEstimatedTokenCount = sourceFileEstimatedTokenCount;

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
    report = await readJsonFile(reportPath);
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


