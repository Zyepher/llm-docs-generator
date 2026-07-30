/**
 * Verifier for source-truth-docs manifests and its report consistency checks.
 */

import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  errorMessage,
  isNonEmptyString,
  isNonNegativeInteger,
  isObjectRecord,
} from '../../../utils/guards.js';
import { HASH_PREFIX, isSha256Hash, isUnprefixedSha256Hash } from '../../../utils/hash.js';
import { readJsonFile } from '../../../utils/json.js';
import {
  SOURCE_TRUTH_DOCS_MODE,
  SOURCE_TRUTH_GENERATED_OUTPUT_KINDS,
  SOURCE_TRUTH_INSPECTION_MODE,
  SOURCE_TRUTH_MARKDOWN_OUTPUT_KIND,
  SOURCE_TRUTH_REPORT_OUTPUT_KIND,
  SOURCE_TRUTH_REPORT_SCHEMA_VERSION,
} from '../constants.js';
import { isInsideDirectory, isSourceTruthSourceType } from '../predicates.js';
import {
  pathExists,
  scanManifestDirectoryForUnlistedFiles,
  verifyFile,
  verifyPathType,
} from '../fs-verify.js';
import type { FileCheck, PathTypeCheck } from '../fs-verify.js';
import type { VerifyGenerationManifestResult, VerifyTierResult } from '../types.js';
import { validateRequiredManifestContract } from '../contract.js';
import { validateRequiredInputProvenance } from '../provenance.js';
import { validateRequiredArtifactSummary } from '../artifact-summary.js';
import { validateRefreshProvenance } from '../refresh-provenance.js';
import { validateGeneratedOutputs } from './shared.js';

export async function verifySourceTruthDocsManifest(
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

  // Two integrity tiers checked separately: `outputChecks` are the
  // self-contained generated pack (always verified), `sourceChecks` are the
  // external recorded source (verified only when the source is available).
  const outputChecks: FileCheck[] = [];
  const sourceChecks: FileCheck[] = [];
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
    fileChecks: sourceChecks,
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
    fileChecks: outputChecks,
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

  const reportOutputPath = sourceTruthReportOutputPath(outputRecords);

  if (reportOutputPath === undefined) {
    failures.push(
      `malformed manifest: source-truth manifests must include a ${SOURCE_TRUTH_REPORT_OUTPUT_KIND} output`
    );
  }

  // A malformed manifest cannot be integrity-checked: structural failures block
  // every filesystem check and no tier is reported.
  if (failures.length > 0) {
    return {
      manifestPath,
      checkedFiles: 0,
      failures,
    };
  }

  // Outputs tier: ALWAYS hash-check the self-contained generated pack, even
  // when the recorded source is missing or fails, so a verifier can attest the
  // outputs it holds.
  const outputFailures: string[] = [];

  for (const check of outputChecks) {
    await verifyFile(check, outputFailures);
  }

  // The report consistency check binds the report output to the manifest's own
  // metadata; it reads only pack contents, so it belongs to the outputs tier
  // and is skipped when a hash check already failed (a tampered report proves
  // nothing beyond the failure already surfaced).
  if (outputFailures.length === 0 && reportOutputPath !== undefined) {
    await verifySourceTruthReportFile({
      reportPath: resolve(manifestDir, reportOutputPath),
      expected: {
        source: sourceRecord,
        inspection: inspectionRecord,
        sourceFiles: sourceFileEntries,
      },
      failures: outputFailures,
    });
  }

  const scan = await scanManifestDirectoryForUnlistedFiles({
    manifestPath,
    listedPaths: [...sourceChecks, ...outputChecks].map((check) => check.path),
  });
  outputFailures.push(...scan.failures);

  // Source tier: the external recorded source. A missing source root is
  // reported as `unavailable` (expected for a relocated pack) instead of a
  // wall of missing-file failures.
  const sourceFailures: string[] = [];
  let sourceCheckedFiles = 0;
  let sourceStatus: VerifyTierResult['status'];
  const sourceAvailable =
    isNonEmptyString(sourcePath) && isAbsolute(sourcePath) ? await pathExists(sourcePath) : false;

  if (!sourceAvailable) {
    sourceStatus = 'unavailable';
    sourceFailures.push(
      `source: recorded source path is unavailable at ${
        isNonEmptyString(sourcePath) ? sourcePath : '(unknown)'
      }`
    );
  } else {
    for (const check of pathTypeChecks) {
      await verifyPathType(check, sourceFailures);
    }

    if (isNonEmptyString(sourcePath) && isAbsolute(sourcePath)) {
      await verifyCanonicalSourcePath(sourcePath, sourceFailures);
    }

    for (const check of sourceChecks) {
      await verifyFile(check, sourceFailures);
    }

    sourceCheckedFiles = sourceChecks.length;
    sourceStatus = sourceFailures.length === 0 ? 'passed' : 'failed';
  }

  const outputs: VerifyTierResult = {
    status: outputFailures.length === 0 ? 'passed' : 'failed',
    checkedFiles: outputChecks.length,
    failures: outputFailures,
  };
  const sourceTier: VerifyTierResult = {
    status: sourceStatus,
    checkedFiles: sourceCheckedFiles,
    failures: sourceFailures,
  };

  return {
    manifestPath,
    checkedFiles: outputs.checkedFiles + sourceTier.checkedFiles,
    failures: [...outputFailures, ...sourceFailures],
    outputs,
    source: sourceTier,
    ...(scan.unmanagedFiles.length > 0 ? { unmanagedFiles: scan.unmanagedFiles } : {}),
  };
}

async function verifyCanonicalSourcePath(sourcePath: string, failures: string[]): Promise<void> {
  try {
    const canonicalSourcePath = await realpath(sourcePath);

    if (canonicalSourcePath !== sourcePath) {
      failures.push(`source: symbolic links are not allowed in path at ${sourcePath}`);
    }
  } catch (error) {
    failures.push(`source: cannot inspect ${sourcePath}: ${errorMessage(error)}`);
  }
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
  signatureFactCount: number;
  configFactCount: number;
  contextFactCount: number;
  parseDiagnosticCount: number;
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

    if (!isNonNegativeInteger(signatureFactCount)) {
      failures.push(
        `malformed manifest: ${label}.signatureFactCount must be a non-negative integer`
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
      isNonNegativeInteger(signatureFactCount) &&
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
        signatureFactCount,
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
    'signatureFactCount',
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
