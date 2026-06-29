/**
 * Artifact summary types, builders, content-free hashers, and validators.
 */

import { createHash } from 'node:crypto';

import { errorMessage, isNonEmptyString, isNonNegativeInteger, isObjectRecord } from '../../utils/guards.js';
import { HASH_PREFIX, isSha256Hash } from '../../utils/hash.js';
import { compareStringsByCodeUnit } from '../../utils/sort.js';
import {
  ARTIFACT_SUMMARY_FILE_SECTION_KEYS,
  ARTIFACT_SUMMARY_INDEX_KEYS,
  ARTIFACT_SUMMARY_KEYS,
  ARTIFACT_SUMMARY_SCHEMA,
  ARTIFACT_SUMMARY_SOURCE_FILE_SECTION_KEYS,
  ARTIFACT_SUMMARY_WARNINGS_KEYS,
  CONFIGURED_SDK_MODE,
  DISCOVERY_REPORT_MODE,
  SOURCE_DOCS_MODE,
  SOURCE_TRUTH_DOCS_MODE,
  SOURCE_VERIFICATION_MODE,
} from './constants.js';
import type { ManifestContractMode } from './constants.js';
import {
  optionalNonNegativeIntegerField,
  optionalStringArraysEqual,
  requiredArrayField,
  requiredNonNegativeIntegerField,
  requiredObjectField,
  requiredStringField,
  stringArraysEqual,
  validateAllowedKeys,
} from './field-validators.js';
import { isManifestContractMode, isStringArray } from './predicates.js';

const ARTIFACT_SUMMARY_HASH_SEED = 'llm-docs-generator:artifact-summary:v1\n';

export interface ArtifactFileSummary {
  count: number;
  kinds: string[];
  totalByteSize: number;
  totalLineCount?: number;
  totalEstimatedTokenCount?: number;
  aggregateHash: string;
}

export interface ArtifactSourceFileSummary {
  count: number;
  formats?: string[];
  totalByteSize: number;
  totalLineCount?: number;
  totalEstimatedTokenCount?: number;
  aggregateHash: string;
}

export interface ArtifactIndexSummary {
  semanticChunkIndexCount?: number;
  semanticChunkCount?: number;
  candidateEvidenceCandidateCount?: number;
  sourceVerificationSourceFileCount?: number;
  sourceVerificationDocsFileCount?: number;
}

export interface ArtifactSummary {
  schema: typeof ARTIFACT_SUMMARY_SCHEMA;
  manifestMode: ManifestContractMode;
  generatedOutputs: ArtifactFileSummary;
  sourceFiles?: ArtifactSourceFileSummary;
  warnings: {
    count: number;
  };
  indexes?: ArtifactIndexSummary;
}

export function buildArtifactSummaryForManifest(
  manifest: Record<string, unknown>
): ArtifactSummary {
  const mode = manifest.mode;

  if (!isNonEmptyString(mode) || !isManifestContractMode(mode)) {
    throw new Error('manifest mode must be supported before writing artifact summary');
  }

  const generatedOutputs = requiredArrayField(
    manifest,
    'generatedOutputs',
    'artifact summary manifest'
  );
  const sourceFiles = artifactSummarySourceFiles(mode, manifest);
  const indexes = artifactSummaryIndexes(mode, manifest);
  const summary: ArtifactSummary = {
    schema: ARTIFACT_SUMMARY_SCHEMA,
    manifestMode: mode,
    generatedOutputs: summarizeGeneratedArtifactFiles(generatedOutputs),
    warnings: {
      count: artifactSummaryWarningCount(mode, manifest),
    },
  };

  if (sourceFiles !== undefined) {
    summary.sourceFiles = summarizeSourceArtifactFiles(sourceFiles);
  }

  if (indexes !== undefined) {
    summary.indexes = indexes;
  }

  return summary;
}

export function summarizeGeneratedArtifactFiles(files: unknown[]): ArtifactFileSummary {
  const entries = files.map((file, index) =>
    artifactSummaryFileMetadata(file, `artifact summary generatedOutputs[${index}]`, 'kind')
  );
  const kinds = uniqueSortedStrings(entries.map((entry) => entry.kind).filter(isNonEmptyString));

  return {
    count: entries.length,
    kinds,
    ...summarizeArtifactFileTotals(entries, 'generatedOutputs'),
  };
}

export function summarizeSourceArtifactFiles(files: unknown[]): ArtifactSourceFileSummary {
  const entries = files.map((file, index) =>
    artifactSummaryFileMetadata(file, `artifact summary sourceFiles[${index}]`, 'format')
  );
  const formats = uniqueSortedStrings(
    entries.map((entry) => entry.format).filter(isNonEmptyString)
  );
  const summary: ArtifactSourceFileSummary = {
    count: entries.length,
    ...summarizeArtifactFileTotals(entries, 'sourceFiles'),
  };

  if (formats.length > 0) {
    summary.formats = formats;
  }

  return summary;
}

export interface ArtifactSummaryFileMetadata {
  path?: string;
  resolvedPath?: string;
  kind?: string;
  format?: string;
  byteSize: number;
  hash: string;
  lineCount?: number;
  estimatedTokenCount?: number;
}

export function artifactSummaryFileMetadata(
  file: unknown,
  label: string,
  classificationField: 'kind' | 'format'
): ArtifactSummaryFileMetadata {
  if (!isObjectRecord(file)) {
    throw new Error(`${label} must be an object`);
  }

  const byteSize = requiredNonNegativeIntegerField(file, 'byteSize', label);
  const hashField =
    typeof file.hash === 'string'
      ? 'hash'
      : typeof file.contentHash === 'string'
        ? 'contentHash'
        : 'hash';
  const hash = requiredStringField(file, hashField, label);

  if (!isSha256Hash(hash)) {
    throw new Error(`${label}.${hashField} must be a sha256 hash`);
  }

  const metadata: ArtifactSummaryFileMetadata = {
    byteSize,
    hash,
  };
  const path = file.path;
  const resolvedPath = file.resolvedPath;
  const classification = file[classificationField];
  const lineCount = optionalNonNegativeIntegerField(file, 'lineCount', label);
  const estimatedTokenCount = optionalNonNegativeIntegerField(file, 'estimatedTokenCount', label);

  if (typeof path === 'string') {
    metadata.path = path;
  }

  if (typeof resolvedPath === 'string') {
    metadata.resolvedPath = resolvedPath;
  }

  if (typeof classification === 'string') {
    metadata[classificationField] = classification;
  }

  if (lineCount !== undefined) {
    metadata.lineCount = lineCount;
  }

  if (estimatedTokenCount !== undefined) {
    metadata.estimatedTokenCount = estimatedTokenCount;
  }

  return metadata;
}

export function summarizeArtifactFileTotals(
  entries: ArtifactSummaryFileMetadata[],
  section: 'generatedOutputs' | 'sourceFiles'
): Omit<ArtifactFileSummary, 'count' | 'kinds'> {
  const totalLineCount = entries.every((entry) => entry.lineCount !== undefined)
    ? entries.reduce((total, entry) => total + (entry.lineCount ?? 0), 0)
    : undefined;
  const totalEstimatedTokenCount = entries.every((entry) => entry.estimatedTokenCount !== undefined)
    ? entries.reduce((total, entry) => total + (entry.estimatedTokenCount ?? 0), 0)
    : undefined;

  return {
    totalByteSize: entries.reduce((total, entry) => total + entry.byteSize, 0),
    ...(totalLineCount === undefined ? {} : { totalLineCount }),
    ...(totalEstimatedTokenCount === undefined ? {} : { totalEstimatedTokenCount }),
    aggregateHash: hashArtifactSummaryFileMetadata(section, entries),
  };
}

export function hashArtifactSummaryFileMetadata(
  section: 'generatedOutputs' | 'sourceFiles',
  entries: ArtifactSummaryFileMetadata[]
): string {
  const hash = createHash('sha256');

  hash.update(ARTIFACT_SUMMARY_HASH_SEED);
  hash.update(section);
  hash.update('\n');
  hash.update(JSON.stringify(entries));
  hash.update('\n');

  return `${HASH_PREFIX}${hash.digest('hex')}`;
}

export function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values)].sort(compareStringsByCodeUnit);
}

export function artifactSummarySourceFiles(
  mode: ManifestContractMode,
  manifest: Record<string, unknown>
): unknown[] | undefined {
  if (mode === CONFIGURED_SDK_MODE) {
    const source = requiredObjectField(manifest, 'source', 'artifact summary manifest');

    return [
      {
        path: source.resolvedSpecPath,
        resolvedPath: source.resolvedSpecPath,
        format: source.format,
        byteSize: source.byteSize,
        hash: source.contentHash,
        ...('lineCount' in source ? { lineCount: source.lineCount } : {}),
        ...('estimatedTokenCount' in source
          ? { estimatedTokenCount: source.estimatedTokenCount }
          : {}),
      },
    ];
  }

  if (mode === SOURCE_DOCS_MODE || mode === SOURCE_TRUTH_DOCS_MODE) {
    return requiredArrayField(manifest, 'sourceFiles', 'artifact summary manifest');
  }

  return undefined;
}

export function artifactSummaryWarningCount(
  mode: ManifestContractMode,
  manifest: Record<string, unknown>
): number {
  if (mode === CONFIGURED_SDK_MODE || mode === SOURCE_DOCS_MODE) {
    const warnings = requiredArrayField(manifest, 'warnings', 'artifact summary manifest');

    return warnings.length;
  }

  if (mode === SOURCE_TRUTH_DOCS_MODE) {
    const inspection = requiredObjectField(manifest, 'inspection', 'artifact summary manifest');
    const warnings = requiredArrayField(inspection, 'warnings', 'artifact summary inspection');

    return warnings.length;
  }

  if (mode === DISCOVERY_REPORT_MODE) {
    const discovery = requiredObjectField(manifest, 'discovery', 'artifact summary manifest');

    return requiredNonNegativeIntegerField(discovery, 'warningCount', 'artifact summary discovery');
  }

  const sourceVerification = requiredObjectField(
    manifest,
    'sourceVerification',
    'artifact summary manifest'
  );
  const summary = requiredObjectField(
    sourceVerification,
    'summary',
    'artifact summary sourceVerification'
  );

  return requiredNonNegativeIntegerField(summary, 'warningCount', 'artifact summary summary');
}

export function artifactSummaryIndexes(
  mode: ManifestContractMode,
  manifest: Record<string, unknown>
): ArtifactIndexSummary | undefined {
  if (mode === SOURCE_DOCS_MODE) {
    const semanticChunkIndexes = manifest.semanticChunkIndexes;

    if (semanticChunkIndexes === undefined) {
      return undefined;
    }

    if (!Array.isArray(semanticChunkIndexes)) {
      throw new Error('artifact summary semanticChunkIndexes must be an array when present');
    }

    return {
      semanticChunkIndexCount: semanticChunkIndexes.length,
      semanticChunkCount: semanticChunkIndexes.reduce((total, index, entryIndex) => {
        if (!isObjectRecord(index)) {
          throw new Error(`artifact summary semanticChunkIndexes[${entryIndex}] must be an object`);
        }

        return (
          total +
          requiredNonNegativeIntegerField(
            index,
            'chunkCount',
            `artifact summary semanticChunkIndexes[${entryIndex}]`
          )
        );
      }, 0),
    };
  }

  if (mode === DISCOVERY_REPORT_MODE) {
    const candidateEvidenceIndex = manifest.candidateEvidenceIndex;

    if (candidateEvidenceIndex === undefined) {
      return undefined;
    }

    if (!isObjectRecord(candidateEvidenceIndex)) {
      throw new Error('artifact summary candidateEvidenceIndex must be an object when present');
    }

    return {
      candidateEvidenceCandidateCount: requiredNonNegativeIntegerField(
        candidateEvidenceIndex,
        'candidateCount',
        'artifact summary candidateEvidenceIndex'
      ),
    };
  }

  if (mode === SOURCE_VERIFICATION_MODE) {
    const sourceVerification = requiredObjectField(
      manifest,
      'sourceVerification',
      'artifact summary manifest'
    );
    const fileEvidenceIndex = sourceVerification.fileEvidenceIndex;

    if (fileEvidenceIndex === undefined) {
      return undefined;
    }

    if (!isObjectRecord(fileEvidenceIndex)) {
      throw new Error(
        'artifact summary sourceVerification.fileEvidenceIndex must be an object when present'
      );
    }

    return {
      sourceVerificationSourceFileCount: requiredNonNegativeIntegerField(
        fileEvidenceIndex,
        'sourceFileCount',
        'artifact summary sourceVerification.fileEvidenceIndex'
      ),
      sourceVerificationDocsFileCount: requiredNonNegativeIntegerField(
        fileEvidenceIndex,
        'docsFileCount',
        'artifact summary sourceVerification.fileEvidenceIndex'
      ),
    };
  }

  return undefined;
}

export function validateRequiredArtifactSummary(
  summary: unknown,
  expectedMode: ManifestContractMode,
  manifest: Record<string, unknown>,
  failures: string[]
): void {
  if (summary === undefined) {
    failures.push(
      'malformed manifest: artifactSummary is required for V2 manifests; unsupported pre-V2 manifest; regenerate with V2'
    );
    return;
  }

  validateArtifactSummary(summary, expectedMode, manifest, failures);
}

export function validateArtifactSummary(
  summary: unknown,
  expectedMode: ManifestContractMode,
  manifest: Record<string, unknown>,
  failures: string[]
): void {
  if (summary === undefined) {
    return;
  }

  if (!isObjectRecord(summary)) {
    failures.push('malformed manifest: artifactSummary must be an object');
    return;
  }

  validateAllowedKeys(summary, ARTIFACT_SUMMARY_KEYS, 'artifactSummary', failures);

  let expected: ArtifactSummary | undefined;

  try {
    expected = buildArtifactSummaryForManifest(manifest);
  } catch (error) {
    failures.push(
      `malformed manifest: artifactSummary could not be rebuilt from manifest metadata: ${errorMessage(
        error
      )}`
    );
  }

  if (summary.schema !== ARTIFACT_SUMMARY_SCHEMA) {
    failures.push(`malformed manifest: artifactSummary.schema must be ${ARTIFACT_SUMMARY_SCHEMA}`);
  }

  if (!isNonEmptyString(summary.manifestMode) || !isManifestContractMode(summary.manifestMode)) {
    failures.push('malformed manifest: artifactSummary.manifestMode must be a supported mode');
  } else if (summary.manifestMode !== expectedMode) {
    failures.push(
      `malformed manifest: artifactSummary.manifestMode must match manifest mode ${expectedMode}`
    );
  }

  if (expected === undefined) {
    return;
  }

  validateGeneratedArtifactSummarySection(
    summary.generatedOutputs,
    expected.generatedOutputs,
    failures
  );
  validateWarningArtifactSummarySection(summary.warnings, expected.warnings, failures);

  if (expected.sourceFiles === undefined) {
    if ('sourceFiles' in summary) {
      failures.push(
        `malformed manifest: artifactSummary.sourceFiles is not supported for ${expectedMode}`
      );
    }
  } else {
    validateSourceArtifactSummarySection(summary.sourceFiles, expected.sourceFiles, failures);
  }

  if (expected.indexes === undefined) {
    if ('indexes' in summary) {
      failures.push(
        `malformed manifest: artifactSummary.indexes is not supported for ${expectedMode}`
      );
    }
  } else {
    validateArtifactSummaryIndexes(summary.indexes, expected.indexes, failures);
  }
}

export function validateGeneratedArtifactSummarySection(
  value: unknown,
  expected: ArtifactFileSummary,
  failures: string[]
): void {
  const label = 'artifactSummary.generatedOutputs';

  if (!isObjectRecord(value)) {
    failures.push(`malformed manifest: ${label} must be an object`);
    return;
  }

  validateAllowedKeys(value, ARTIFACT_SUMMARY_FILE_SECTION_KEYS, label, failures);
  validateArtifactSummaryNonNegativeInteger(value.count, `${label}.count`, failures);
  validateArtifactSummaryStringArray(value.kinds, `${label}.kinds`, failures);
  validateArtifactSummaryNonNegativeInteger(
    value.totalByteSize,
    `${label}.totalByteSize`,
    failures
  );
  validateArtifactSummaryOptionalNonNegativeInteger(
    value,
    'totalLineCount',
    `${label}.totalLineCount`,
    failures
  );
  validateArtifactSummaryOptionalNonNegativeInteger(
    value,
    'totalEstimatedTokenCount',
    `${label}.totalEstimatedTokenCount`,
    failures
  );

  if (!isSha256Hash(value.aggregateHash)) {
    failures.push(`malformed manifest: ${label}.aggregateHash must be a sha256 hash`);
  }

  if (value.count !== expected.count) {
    failures.push(
      'malformed manifest: artifactSummary.generatedOutputs.count must match generatedOutputs length'
    );
  }

  if (Array.isArray(value.kinds) && !stringArraysEqual(value.kinds as string[], expected.kinds)) {
    failures.push(
      'malformed manifest: artifactSummary.generatedOutputs.kinds must match generatedOutputs kinds'
    );
  }

  if (value.totalByteSize !== expected.totalByteSize) {
    failures.push(
      'malformed manifest: artifactSummary.generatedOutputs.totalByteSize must match generatedOutputs byte sizes'
    );
  }

  if (value.totalLineCount !== expected.totalLineCount) {
    failures.push(
      'malformed manifest: artifactSummary.generatedOutputs.totalLineCount must match generatedOutputs line counts'
    );
  }

  if (value.totalEstimatedTokenCount !== expected.totalEstimatedTokenCount) {
    failures.push(
      'malformed manifest: artifactSummary.generatedOutputs.totalEstimatedTokenCount must match generatedOutputs estimated token counts'
    );
  }

  if (value.aggregateHash !== expected.aggregateHash) {
    failures.push(
      'malformed manifest: artifactSummary.generatedOutputs.aggregateHash must match generated output metadata'
    );
  }
}

export function validateSourceArtifactSummarySection(
  value: unknown,
  expected: ArtifactSourceFileSummary,
  failures: string[]
): void {
  const label = 'artifactSummary.sourceFiles';

  if (!isObjectRecord(value)) {
    failures.push(`malformed manifest: ${label} must be an object`);
    return;
  }

  validateAllowedKeys(value, ARTIFACT_SUMMARY_SOURCE_FILE_SECTION_KEYS, label, failures);
  validateArtifactSummaryNonNegativeInteger(value.count, `${label}.count`, failures);
  validateArtifactSummaryOptionalStringArray(value, 'formats', `${label}.formats`, failures);
  validateArtifactSummaryNonNegativeInteger(
    value.totalByteSize,
    `${label}.totalByteSize`,
    failures
  );
  validateArtifactSummaryOptionalNonNegativeInteger(
    value,
    'totalLineCount',
    `${label}.totalLineCount`,
    failures
  );
  validateArtifactSummaryOptionalNonNegativeInteger(
    value,
    'totalEstimatedTokenCount',
    `${label}.totalEstimatedTokenCount`,
    failures
  );

  if (!isSha256Hash(value.aggregateHash)) {
    failures.push(`malformed manifest: ${label}.aggregateHash must be a sha256 hash`);
  }

  if (value.count !== expected.count) {
    failures.push(
      'malformed manifest: artifactSummary.sourceFiles.count must match source file metadata length'
    );
  }

  if (!optionalStringArraysEqual(value.formats, expected.formats)) {
    failures.push(
      'malformed manifest: artifactSummary.sourceFiles.formats must match source file formats'
    );
  }

  if (value.totalByteSize !== expected.totalByteSize) {
    failures.push(
      'malformed manifest: artifactSummary.sourceFiles.totalByteSize must match source file byte sizes'
    );
  }

  if (value.totalLineCount !== expected.totalLineCount) {
    failures.push(
      'malformed manifest: artifactSummary.sourceFiles.totalLineCount must match source file line counts'
    );
  }

  if (value.totalEstimatedTokenCount !== expected.totalEstimatedTokenCount) {
    failures.push(
      'malformed manifest: artifactSummary.sourceFiles.totalEstimatedTokenCount must match source file estimated token counts'
    );
  }

  if (value.aggregateHash !== expected.aggregateHash) {
    failures.push(
      'malformed manifest: artifactSummary.sourceFiles.aggregateHash must match source file metadata'
    );
  }
}

export function validateWarningArtifactSummarySection(
  value: unknown,
  expected: ArtifactSummary['warnings'],
  failures: string[]
): void {
  const label = 'artifactSummary.warnings';

  if (!isObjectRecord(value)) {
    failures.push(`malformed manifest: ${label} must be an object`);
    return;
  }

  validateAllowedKeys(value, ARTIFACT_SUMMARY_WARNINGS_KEYS, label, failures);
  validateArtifactSummaryNonNegativeInteger(value.count, `${label}.count`, failures);

  if (value.count !== expected.count) {
    failures.push(
      'malformed manifest: artifactSummary.warnings.count must match manifest warnings'
    );
  }
}

export function validateArtifactSummaryIndexes(
  value: unknown,
  expected: ArtifactIndexSummary,
  failures: string[]
): void {
  const label = 'artifactSummary.indexes';

  if (!isObjectRecord(value)) {
    failures.push(`malformed manifest: ${label} must be an object`);
    return;
  }

  validateAllowedKeys(value, ARTIFACT_SUMMARY_INDEX_KEYS, label, failures);

  for (const key of ARTIFACT_SUMMARY_INDEX_KEYS) {
    validateArtifactSummaryOptionalNonNegativeInteger(value, key, `${label}.${key}`, failures);
  }

  if (!artifactIndexSummariesEqual(value, expected)) {
    failures.push('malformed manifest: artifactSummary.indexes must match manifest index counters');
  }
}

export function validateArtifactSummaryNonNegativeInteger(
  value: unknown,
  label: string,
  failures: string[]
): void {
  if (!isNonNegativeInteger(value)) {
    failures.push(`malformed manifest: ${label} must be a non-negative integer`);
  }
}

export function validateArtifactSummaryOptionalNonNegativeInteger(
  value: Record<string, unknown>,
  key: string,
  label: string,
  failures: string[]
): void {
  if (key in value && !isNonNegativeInteger(value[key])) {
    failures.push(`malformed manifest: ${label} must be a non-negative integer when present`);
  }
}

export function validateArtifactSummaryStringArray(
  value: unknown,
  label: string,
  failures: string[]
): void {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    failures.push(`malformed manifest: ${label} must be a string array`);
  }
}

export function validateArtifactSummaryOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
  label: string,
  failures: string[]
): void {
  if (key in value && !isStringArray(value[key])) {
    failures.push(`malformed manifest: ${label} must be a string array when present`);
  }
}

export function artifactIndexSummariesEqual(
  actual: Record<string, unknown>,
  expected: ArtifactIndexSummary
): boolean {
  const keys: Array<keyof ArtifactIndexSummary> = [
    'semanticChunkIndexCount',
    'semanticChunkCount',
    'candidateEvidenceCandidateCount',
    'sourceVerificationSourceFileCount',
    'sourceVerificationDocsFileCount',
  ];

  for (const key of keys) {
    if (actual[key] !== expected[key]) {
      return false;
    }
  }

  return true;
}
