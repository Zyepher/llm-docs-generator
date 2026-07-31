/**
 * Verifier for source-verification-local-evidence manifests and its report
 * consistency checks.
 */

import { dirname, isAbsolute, resolve } from 'node:path';

import {
  errorMessage,
  isNonEmptyString,
  isNonNegativeInteger,
  isObjectRecord,
} from '../../../utils/guards.js';
import { readJsonFile } from '../../../utils/json.js';
import {
  buildSourceVerificationFileEvidenceIndexFromUnknownReport,
  sourceVerificationFileEvidenceIndexesEqual,
  validateSourceVerificationFileEvidenceIndex,
  type SourceVerificationFileEvidenceIndex,
} from '../../source-verification-file-evidence-index.js';
import {
  SOURCE_VERIFICATION_GENERATED_OUTPUT_KINDS,
  SOURCE_VERIFICATION_MODE,
  SOURCE_VERIFICATION_REPORT_OUTPUT_KIND,
  SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION,
  SOURCE_VERIFICATION_SUMMARY_FIELDS,
} from '../constants.js';
import { isInsideDirectory, isSourceTruthSourceType } from '../predicates.js';
import {
  resolveManifestSourcePath,
  scanManifestDirectoryForUnlistedFiles,
  verifyFile,
} from '../fs-verify.js';
import type { FileCheck } from '../fs-verify.js';
import type { VerifyGenerationManifestResult, VerifyTierResult } from '../types.js';
import { validateRequiredManifestContract } from '../contract.js';
import { validateRequiredInputProvenance } from '../provenance.js';
import { validateRequiredArtifactSummary } from '../artifact-summary.js';
import { validateRefreshProvenance } from '../refresh-provenance.js';
import { validateGeneratedOutputs, validateGeneratorMetadata } from './shared.js';

export async function verifySourceVerificationManifest(
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

  validateRequiredManifestContract(manifest.manifestContract, SOURCE_VERIFICATION_MODE, failures);
  validateRequiredInputProvenance(
    manifest.inputProvenance,
    SOURCE_VERIFICATION_MODE,
    manifest,
    failures
  );
  validateRequiredArtifactSummary(
    manifest.artifactSummary,
    SOURCE_VERIFICATION_MODE,
    manifest,
    failures
  );
  validateRefreshProvenance(manifest.refresh, SOURCE_VERIFICATION_MODE, failures);

  if (isObjectRecord(sourceVerification) && sourceVerification.fileEvidenceIndex === undefined) {
    failures.push(
      'malformed manifest: sourceVerification.fileEvidenceIndex is required for V2 source-verification-local-evidence manifests; unsupported pre-V2 manifest; regenerate with V2'
    );
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
  let fileEvidenceIndex: SourceVerificationFileEvidenceIndex | undefined;

  if (sourceVerificationRecord.fileEvidenceIndex !== undefined) {
    fileEvidenceIndex = validateSourceVerificationFileEvidenceIndex(
      sourceVerificationRecord.fileEvidenceIndex,
      failures
    );
  }

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

  // A malformed manifest cannot be integrity-checked: structural failures block
  // every filesystem check and no tier is reported.
  if (failures.length > 0) {
    return {
      manifestPath,
      checkedFiles: 0,
      failures,
    };
  }

  // Outputs tier only: this mode records no source-side hash checks (the
  // recorded source and docs paths are inputs to the report, not verified
  // artifacts), so the evidence report IS the entire verification.
  const outputFailures: string[] = [];

  for (const check of fileChecks) {
    await verifyFile(check, outputFailures);
  }

  if (outputFailures.length === 0 && isNonEmptyString(reportPath) && !isAbsolute(reportPath)) {
    await verifySourceVerificationReportFile({
      manifestDir,
      reportPath: resolve(manifestDir, reportPath),
      expected: {
        reportPath,
        source: source as Record<string, unknown>,
        docs: docs as Record<string, unknown>,
        summary: summary as Record<string, unknown>,
        fileEvidenceIndex,
      },
      failures: outputFailures,
    });
  }

  const scan = await scanManifestDirectoryForUnlistedFiles({
    manifestPath,
    listedPaths: fileChecks.map((check) => check.path),
  });
  outputFailures.push(...scan.failures);

  const outputs: VerifyTierResult = {
    status: outputFailures.length === 0 ? 'passed' : 'failed',
    checkedFiles: fileChecks.length,
    failures: outputFailures,
  };

  return {
    manifestPath,
    checkedFiles: outputs.checkedFiles,
    failures: outputFailures,
    outputs,
    ...(scan.unmanagedFiles.length > 0 ? { unmanagedFiles: scan.unmanagedFiles } : {}),
  };
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
async function verifySourceVerificationReportFile(options: {
  manifestDir: string;
  reportPath: string;
  expected: {
    reportPath: string;
    source: Record<string, unknown>;
    docs: Record<string, unknown>;
    summary: Record<string, unknown>;
    fileEvidenceIndex: SourceVerificationFileEvidenceIndex | undefined;
  };
  failures: string[];
}): Promise<void> {
  const { manifestDir, reportPath, expected, failures } = options;
  let report: unknown;

  try {
    report = await readJsonFile(reportPath);
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

  if (expected.fileEvidenceIndex !== undefined) {
    const rebuiltFileEvidenceIndex = buildSourceVerificationFileEvidenceIndexFromUnknownReport(
      report,
      failures
    );

    if (
      rebuiltFileEvidenceIndex !== undefined &&
      !sourceVerificationFileEvidenceIndexesEqual(
        expected.fileEvidenceIndex,
        rebuiltFileEvidenceIndex
      )
    ) {
      failures.push(
        'source-verification file evidence index: manifest metadata does not match source-verification-report.json'
      );
    }
  }

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
