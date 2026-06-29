import { createHash } from 'node:crypto';
import { isObjectRecord, isNonEmptyString, isNonNegativeInteger } from '../utils/guards.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';

const HASH_SEED = 'llm-docs-generator:source-verification-file-evidence-index:v1\n';
const HASH_PREFIX = 'sha256:';
const INDEX_KEYS = new Set([
  'sourceFileCount',
  'docsFileCount',
  'aggregateHash',
  'sourceFiles',
  'docsFiles',
]);
const SOURCE_FILE_KEYS = new Set([
  'path',
  'status',
  'byteSize',
  'sha256',
  'supported',
  'facts',
  'configFacts',
  'contextFacts',
  'parseDiagnostics',
  'skipReason',
]);
const DOCS_FILE_KEYS = new Set([
  'path',
  'status',
  'byteSize',
  'sha256',
  'supported',
  'references',
  'skipReason',
]);
const FILE_STATUSES = new Set(['inspected', 'skipped']);
const SKIP_REASONS = new Set(['unsupported-extension', 'oversized', 'unreadable']);

export interface SourceVerificationFileEvidenceIndex {
  sourceFileCount: number;
  docsFileCount: number;
  aggregateHash: string;
  sourceFiles: SourceVerificationSourceFileEvidenceIndexEntry[];
  docsFiles: SourceVerificationDocsFileEvidenceIndexEntry[];
}

export interface SourceVerificationSourceFileEvidenceIndexEntry {
  path: string;
  status: string;
  byteSize: number;
  sha256?: string;
  supported: boolean;
  facts: number;
  configFacts: number;
  contextFacts: number;
  parseDiagnostics?: number;
  skipReason?: string;
}

export interface SourceVerificationDocsFileEvidenceIndexEntry {
  path: string;
  status: string;
  byteSize: number;
  sha256?: string;
  supported: boolean;
  references: number;
  skipReason?: string;
}

export type SourceVerificationFileEvidenceIndexHashData = Omit<
  SourceVerificationFileEvidenceIndex,
  'aggregateHash'
>;

interface SourceVerificationFileEvidenceReportInput {
  sourceInspection: {
    files: readonly SourceVerificationSourceFileEvidenceReportEntry[];
  };
  docs: {
    files: readonly SourceVerificationDocsFileEvidenceReportEntry[];
  };
}

interface SourceVerificationSourceFileEvidenceReportEntry {
  path: string;
  status: string;
  byteSize: number;
  sha256?: string;
  supported: boolean;
  facts: readonly unknown[];
  configFacts: readonly unknown[];
  contextFacts: readonly unknown[];
  parseDiagnostics?: readonly unknown[];
  skipReason?: string;
}

interface SourceVerificationDocsFileEvidenceReportEntry {
  path: string;
  status: string;
  byteSize: number;
  sha256?: string;
  supported: boolean;
  references: readonly unknown[];
  referenceCount: number;
  skipReason?: string;
}

export function buildSourceVerificationFileEvidenceIndex(
  report: SourceVerificationFileEvidenceReportInput
): SourceVerificationFileEvidenceIndex {
  const sourceFiles = report.sourceInspection.files
    .map(projectSourceReportFile)
    .sort(compareSourceFileEntries);
  const docsFiles = report.docs.files.map(projectDocsReportFile).sort(compareDocsFileEntries);
  const hashData: SourceVerificationFileEvidenceIndexHashData = {
    sourceFileCount: sourceFiles.length,
    docsFileCount: docsFiles.length,
    sourceFiles,
    docsFiles,
  };

  return {
    sourceFileCount: hashData.sourceFileCount,
    docsFileCount: hashData.docsFileCount,
    aggregateHash: hashSourceVerificationFileEvidenceIndex(hashData),
    sourceFiles,
    docsFiles,
  };
}

export function buildSourceVerificationFileEvidenceIndexFromUnknownReport(
  report: unknown,
  failures: string[]
): SourceVerificationFileEvidenceIndex | undefined {
  if (!isObjectRecord(report)) {
    failures.push('source-verification report: root must be an object');
    return undefined;
  }

  const sourceInspection = report.sourceInspection;
  const docs = report.docs;

  if (!isObjectRecord(sourceInspection)) {
    failures.push('source-verification report: sourceInspection must be an object');
    return undefined;
  }

  if (!isObjectRecord(docs)) {
    failures.push('source-verification report: docs must be an object');
    return undefined;
  }

  if (!Array.isArray(sourceInspection.files)) {
    failures.push('source-verification report: sourceInspection.files must be an array');
    return undefined;
  }

  if (!Array.isArray(docs.files)) {
    failures.push('source-verification report: docs.files must be an array');
    return undefined;
  }

  const sourceFiles: SourceVerificationSourceFileEvidenceReportEntry[] = [];
  const docsFiles: SourceVerificationDocsFileEvidenceReportEntry[] = [];
  const initialFailureCount = failures.length;

  for (const [index, file] of sourceInspection.files.entries()) {
    const entry = normalizeSourceReportFile(
      file,
      `source-verification report: sourceInspection.files[${index}]`,
      failures
    );

    if (entry !== undefined) {
      sourceFiles.push(entry);
    }
  }

  for (const [index, file] of docs.files.entries()) {
    const entry = normalizeDocsReportFile(
      file,
      `source-verification report: docs.files[${index}]`,
      failures
    );

    if (entry !== undefined) {
      docsFiles.push(entry);
    }
  }

  if (failures.length !== initialFailureCount) {
    return undefined;
  }

  return buildSourceVerificationFileEvidenceIndex({
    sourceInspection: { files: sourceFiles },
    docs: { files: docsFiles },
  });
}

export function validateSourceVerificationFileEvidenceIndex(
  index: unknown,
  failures: string[]
): SourceVerificationFileEvidenceIndex | undefined {
  const initialFailureCount = failures.length;

  if (!isObjectRecord(index)) {
    failures.push(
      'malformed manifest: sourceVerification.fileEvidenceIndex must be an object when present'
    );
    return undefined;
  }

  validateAllowedKeys(index, INDEX_KEYS, 'sourceVerification.fileEvidenceIndex', failures);

  const sourceFileCount = index.sourceFileCount;
  const docsFileCount = index.docsFileCount;
  const aggregateHash = index.aggregateHash;
  const sourceFiles: SourceVerificationSourceFileEvidenceIndexEntry[] = [];
  const docsFiles: SourceVerificationDocsFileEvidenceIndexEntry[] = [];

  if (!isNonNegativeInteger(sourceFileCount)) {
    failures.push(
      'malformed manifest: sourceVerification.fileEvidenceIndex.sourceFileCount must be a non-negative integer'
    );
  }

  if (!isNonNegativeInteger(docsFileCount)) {
    failures.push(
      'malformed manifest: sourceVerification.fileEvidenceIndex.docsFileCount must be a non-negative integer'
    );
  }

  if (!isSha256Hash(aggregateHash)) {
    failures.push(
      'malformed manifest: sourceVerification.fileEvidenceIndex.aggregateHash must be a sha256 hash'
    );
  }

  if (!Array.isArray(index.sourceFiles)) {
    failures.push(
      'malformed manifest: sourceVerification.fileEvidenceIndex.sourceFiles must be an array'
    );
  } else {
    for (const [fileIndex, file] of index.sourceFiles.entries()) {
      const entry = validateSourceFileEvidenceIndexEntry({
        file,
        label: `sourceVerification.fileEvidenceIndex.sourceFiles[${fileIndex}]`,
        failures,
      });

      if (entry !== undefined) {
        sourceFiles.push(entry);
      }
    }

    if (isNonNegativeInteger(sourceFileCount) && sourceFileCount !== index.sourceFiles.length) {
      failures.push(
        'malformed manifest: sourceVerification.fileEvidenceIndex.sourceFileCount must match sourceFiles length'
      );
    }
  }

  if (!Array.isArray(index.docsFiles)) {
    failures.push(
      'malformed manifest: sourceVerification.fileEvidenceIndex.docsFiles must be an array'
    );
  } else {
    for (const [fileIndex, file] of index.docsFiles.entries()) {
      const entry = validateDocsFileEvidenceIndexEntry({
        file,
        label: `sourceVerification.fileEvidenceIndex.docsFiles[${fileIndex}]`,
        failures,
      });

      if (entry !== undefined) {
        docsFiles.push(entry);
      }
    }

    if (isNonNegativeInteger(docsFileCount) && docsFileCount !== index.docsFiles.length) {
      failures.push(
        'malformed manifest: sourceVerification.fileEvidenceIndex.docsFileCount must match docsFiles length'
      );
    }
  }

  if (
    isNonNegativeInteger(sourceFileCount) &&
    isNonNegativeInteger(docsFileCount) &&
    isSha256Hash(aggregateHash) &&
    Array.isArray(index.sourceFiles) &&
    Array.isArray(index.docsFiles) &&
    sourceFiles.length === index.sourceFiles.length &&
    docsFiles.length === index.docsFiles.length
  ) {
    const hashData: SourceVerificationFileEvidenceIndexHashData = {
      sourceFileCount,
      docsFileCount,
      sourceFiles,
      docsFiles,
    };
    const actualAggregateHash = hashSourceVerificationFileEvidenceIndex(hashData);

    if (aggregateHash !== actualAggregateHash) {
      failures.push(
        'malformed manifest: sourceVerification.fileEvidenceIndex.aggregateHash must match file evidence index metadata'
      );
    }
  }

  if (failures.length !== initialFailureCount) {
    return undefined;
  }

  return {
    sourceFileCount: sourceFileCount as number,
    docsFileCount: docsFileCount as number,
    aggregateHash: aggregateHash as string,
    sourceFiles,
    docsFiles,
  };
}

export function sourceVerificationFileEvidenceIndexesEqual(
  left: SourceVerificationFileEvidenceIndex,
  right: SourceVerificationFileEvidenceIndex
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function hashSourceVerificationFileEvidenceIndex(
  index: SourceVerificationFileEvidenceIndexHashData
): string {
  const hash = createHash('sha256');
  hash.update(HASH_SEED);
  hash.update(JSON.stringify(index));
  hash.update('\n');

  return `${HASH_PREFIX}${hash.digest('hex')}`;
}

function projectSourceReportFile(
  file: SourceVerificationSourceFileEvidenceReportEntry
): SourceVerificationSourceFileEvidenceIndexEntry {
  return {
    path: file.path,
    status: file.status,
    byteSize: file.byteSize,
    ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }),
    supported: file.supported,
    facts: file.facts.length,
    configFacts: file.configFacts.length,
    contextFacts: file.contextFacts.length,
    ...(file.parseDiagnostics === undefined || file.parseDiagnostics.length === 0
      ? {}
      : { parseDiagnostics: file.parseDiagnostics.length }),
    ...(file.skipReason === undefined ? {} : { skipReason: file.skipReason }),
  };
}

function projectDocsReportFile(
  file: SourceVerificationDocsFileEvidenceReportEntry
): SourceVerificationDocsFileEvidenceIndexEntry {
  return {
    path: file.path,
    status: file.status,
    byteSize: file.byteSize,
    ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }),
    supported: file.supported,
    references: file.referenceCount,
    ...(file.skipReason === undefined ? {} : { skipReason: file.skipReason }),
  };
}

function normalizeSourceReportFile(
  file: unknown,
  label: string,
  failures: string[]
): SourceVerificationSourceFileEvidenceReportEntry | undefined {
  if (!isObjectRecord(file)) {
    failures.push(`${label} must be an object`);
    return undefined;
  }

  const sha256 = normalizeOptionalSha256(file.sha256, `${label}.sha256`, failures);
  const parseDiagnostics = normalizeOptionalArray(
    file.parseDiagnostics,
    `${label}.parseDiagnostics`,
    failures
  );
  const skipReason = normalizeOptionalSkipReason(file.skipReason, `${label}.skipReason`, failures);

  if (!isNonEmptyString(file.path)) {
    failures.push(`${label}.path must be a non-empty string`);
  }

  if (!isFileStatus(file.status)) {
    failures.push(`${label}.status must be inspected or skipped`);
  }

  if (!isNonNegativeInteger(file.byteSize)) {
    failures.push(`${label}.byteSize must be a non-negative integer`);
  }

  if (typeof file.supported !== 'boolean') {
    failures.push(`${label}.supported must be a boolean`);
  }

  if (!Array.isArray(file.facts)) {
    failures.push(`${label}.facts must be an array`);
  }

  if (!Array.isArray(file.configFacts)) {
    failures.push(`${label}.configFacts must be an array`);
  }

  if (!Array.isArray(file.contextFacts)) {
    failures.push(`${label}.contextFacts must be an array`);
  }

  if (
    !isNonEmptyString(file.path) ||
    !isFileStatus(file.status) ||
    !isNonNegativeInteger(file.byteSize) ||
    sha256 === undefined ||
    typeof file.supported !== 'boolean' ||
    !Array.isArray(file.facts) ||
    !Array.isArray(file.configFacts) ||
    !Array.isArray(file.contextFacts) ||
    parseDiagnostics === undefined ||
    skipReason === undefined
  ) {
    return undefined;
  }

  return {
    path: file.path,
    status: file.status,
    byteSize: file.byteSize,
    ...(sha256 === null ? {} : { sha256 }),
    supported: file.supported,
    facts: file.facts,
    configFacts: file.configFacts,
    contextFacts: file.contextFacts,
    ...(parseDiagnostics === null ? {} : { parseDiagnostics }),
    ...(skipReason === null ? {} : { skipReason }),
  };
}

function normalizeDocsReportFile(
  file: unknown,
  label: string,
  failures: string[]
): SourceVerificationDocsFileEvidenceReportEntry | undefined {
  if (!isObjectRecord(file)) {
    failures.push(`${label} must be an object`);
    return undefined;
  }

  const sha256 = normalizeOptionalSha256(file.sha256, `${label}.sha256`, failures);
  const skipReason = normalizeOptionalSkipReason(file.skipReason, `${label}.skipReason`, failures);

  if (!isNonEmptyString(file.path)) {
    failures.push(`${label}.path must be a non-empty string`);
  }

  if (!isFileStatus(file.status)) {
    failures.push(`${label}.status must be inspected or skipped`);
  }

  if (!isNonNegativeInteger(file.byteSize)) {
    failures.push(`${label}.byteSize must be a non-negative integer`);
  }

  if (typeof file.supported !== 'boolean') {
    failures.push(`${label}.supported must be a boolean`);
  }

  if (!Array.isArray(file.references)) {
    failures.push(`${label}.references must be an array`);
  }

  if (!isNonNegativeInteger(file.referenceCount)) {
    failures.push(`${label}.referenceCount must be a non-negative integer`);
  }

  if (
    !isNonEmptyString(file.path) ||
    !isFileStatus(file.status) ||
    !isNonNegativeInteger(file.byteSize) ||
    sha256 === undefined ||
    typeof file.supported !== 'boolean' ||
    !Array.isArray(file.references) ||
    !isNonNegativeInteger(file.referenceCount) ||
    skipReason === undefined
  ) {
    return undefined;
  }

  return {
    path: file.path,
    status: file.status,
    byteSize: file.byteSize,
    ...(sha256 === null ? {} : { sha256 }),
    supported: file.supported,
    references: file.references,
    referenceCount: file.referenceCount,
    ...(skipReason === null ? {} : { skipReason }),
  };
}

function validateSourceFileEvidenceIndexEntry(options: {
  file: unknown;
  label: string;
  failures: string[];
}): SourceVerificationSourceFileEvidenceIndexEntry | undefined {
  const { file, label, failures } = options;

  if (!isObjectRecord(file)) {
    failures.push(`malformed manifest: ${label} must be an object`);
    return undefined;
  }

  validateAllowedKeys(file, SOURCE_FILE_KEYS, label, failures);

  const sha256 = normalizeOptionalSha256(file.sha256, `${label}.sha256`, failures);
  const parseDiagnostics = normalizeOptionalCount(
    file.parseDiagnostics,
    `${label}.parseDiagnostics`,
    failures
  );
  const skipReason = normalizeOptionalSkipReason(file.skipReason, `${label}.skipReason`, failures);

  if (!isNonEmptyString(file.path)) {
    failures.push(`malformed manifest: ${label}.path must be a non-empty string`);
  }

  if (!isFileStatus(file.status)) {
    failures.push(`malformed manifest: ${label}.status must be inspected or skipped`);
  }

  if (!isNonNegativeInteger(file.byteSize)) {
    failures.push(`malformed manifest: ${label}.byteSize must be a non-negative integer`);
  }

  if (typeof file.supported !== 'boolean') {
    failures.push(`malformed manifest: ${label}.supported must be a boolean`);
  }

  if (!isNonNegativeInteger(file.facts)) {
    failures.push(`malformed manifest: ${label}.facts must be a non-negative integer`);
  }

  if (!isNonNegativeInteger(file.configFacts)) {
    failures.push(`malformed manifest: ${label}.configFacts must be a non-negative integer`);
  }

  if (!isNonNegativeInteger(file.contextFacts)) {
    failures.push(`malformed manifest: ${label}.contextFacts must be a non-negative integer`);
  }

  if (
    !isNonEmptyString(file.path) ||
    !isFileStatus(file.status) ||
    !isNonNegativeInteger(file.byteSize) ||
    sha256 === undefined ||
    typeof file.supported !== 'boolean' ||
    !isNonNegativeInteger(file.facts) ||
    !isNonNegativeInteger(file.configFacts) ||
    !isNonNegativeInteger(file.contextFacts) ||
    parseDiagnostics === undefined ||
    skipReason === undefined
  ) {
    return undefined;
  }

  return {
    path: file.path,
    status: file.status,
    byteSize: file.byteSize,
    ...(sha256 === null ? {} : { sha256 }),
    supported: file.supported,
    facts: file.facts,
    configFacts: file.configFacts,
    contextFacts: file.contextFacts,
    ...(parseDiagnostics === null ? {} : { parseDiagnostics }),
    ...(skipReason === null ? {} : { skipReason }),
  };
}

function validateDocsFileEvidenceIndexEntry(options: {
  file: unknown;
  label: string;
  failures: string[];
}): SourceVerificationDocsFileEvidenceIndexEntry | undefined {
  const { file, label, failures } = options;

  if (!isObjectRecord(file)) {
    failures.push(`malformed manifest: ${label} must be an object`);
    return undefined;
  }

  validateAllowedKeys(file, DOCS_FILE_KEYS, label, failures);

  const sha256 = normalizeOptionalSha256(file.sha256, `${label}.sha256`, failures);
  const skipReason = normalizeOptionalSkipReason(file.skipReason, `${label}.skipReason`, failures);

  if (!isNonEmptyString(file.path)) {
    failures.push(`malformed manifest: ${label}.path must be a non-empty string`);
  }

  if (!isFileStatus(file.status)) {
    failures.push(`malformed manifest: ${label}.status must be inspected or skipped`);
  }

  if (!isNonNegativeInteger(file.byteSize)) {
    failures.push(`malformed manifest: ${label}.byteSize must be a non-negative integer`);
  }

  if (typeof file.supported !== 'boolean') {
    failures.push(`malformed manifest: ${label}.supported must be a boolean`);
  }

  if (!isNonNegativeInteger(file.references)) {
    failures.push(`malformed manifest: ${label}.references must be a non-negative integer`);
  }

  if (
    !isNonEmptyString(file.path) ||
    !isFileStatus(file.status) ||
    !isNonNegativeInteger(file.byteSize) ||
    sha256 === undefined ||
    typeof file.supported !== 'boolean' ||
    !isNonNegativeInteger(file.references) ||
    skipReason === undefined
  ) {
    return undefined;
  }

  return {
    path: file.path,
    status: file.status,
    byteSize: file.byteSize,
    ...(sha256 === null ? {} : { sha256 }),
    supported: file.supported,
    references: file.references,
    ...(skipReason === null ? {} : { skipReason }),
  };
}

function normalizeOptionalSha256(
  value: unknown,
  label: string,
  failures: string[]
): string | null | undefined {
  if (value === undefined) {
    return null;
  }

  if (!isUnprefixedSha256Hash(value)) {
    failures.push(`${label} must be a sha256 hex digest when present`);
    return undefined;
  }

  return value;
}

function normalizeOptionalCount(
  value: unknown,
  label: string,
  failures: string[]
): number | null | undefined {
  if (value === undefined) {
    return null;
  }

  if (!isNonNegativeInteger(value)) {
    failures.push(`malformed manifest: ${label} must be a non-negative integer when present`);
    return undefined;
  }

  return value;
}

function normalizeOptionalArray(
  value: unknown,
  label: string,
  failures: string[]
): readonly unknown[] | null | undefined {
  if (value === undefined) {
    return null;
  }

  if (!Array.isArray(value)) {
    failures.push(`${label} must be an array when present`);
    return undefined;
  }

  return value;
}

function normalizeOptionalSkipReason(
  value: unknown,
  label: string,
  failures: string[]
): string | null | undefined {
  if (value === undefined) {
    return null;
  }

  if (typeof value !== 'string' || !SKIP_REASONS.has(value)) {
    failures.push(`${label} must be unsupported-extension, oversized, or unreadable when present`);
    return undefined;
  }

  return value;
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

function compareSourceFileEntries(
  left: SourceVerificationSourceFileEvidenceIndexEntry,
  right: SourceVerificationSourceFileEvidenceIndexEntry
): number {
  return (
    compareStringsByCodeUnit(left.path, right.path) ||
    compareStringsByCodeUnit(left.status, right.status)
  );
}

function compareDocsFileEntries(
  left: SourceVerificationDocsFileEvidenceIndexEntry,
  right: SourceVerificationDocsFileEvidenceIndexEntry
): number {
  return (
    compareStringsByCodeUnit(left.path, right.path) ||
    compareStringsByCodeUnit(left.status, right.status)
  );
}

function isFileStatus(value: unknown): value is string {
  return typeof value === 'string' && FILE_STATUSES.has(value);
}

function isSha256Hash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isUnprefixedSha256Hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
