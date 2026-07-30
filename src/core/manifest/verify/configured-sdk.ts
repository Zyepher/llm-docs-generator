/**
 * Verifier and validators for configured-sdk manifests.
 */

import { dirname } from 'node:path';

import { isNonEmptyString, isNonNegativeInteger, isObjectRecord } from '../../../utils/guards.js';
import { isSha256Hash } from '../../../utils/hash.js';
import {
  CONFIGURED_SDK_FORMATTER_FORMAT,
  CONFIGURED_SDK_FORMATTER_NAME,
  CONFIGURED_SDK_GENERATED_OUTPUT_KINDS,
  CONFIGURED_SDK_MODE,
  CONFIGURED_SDK_PARSER_FORMAT,
  CONFIGURED_SDK_PARSER_NAME,
} from '../constants.js';
import { pathExists, resolveManifestSourcePath, verifyFile } from '../fs-verify.js';
import type { FileCheck } from '../fs-verify.js';
import type { VerifyGenerationManifestResult, VerifyTierResult } from '../types.js';
import { validateRequiredManifestContract } from '../contract.js';
import { validateRequiredInputProvenance } from '../provenance.js';
import { validateRequiredArtifactSummary } from '../artifact-summary.js';
import { validateRefreshProvenance } from '../refresh-provenance.js';
import { validateGeneratedOutputs, validateGeneratorMetadata } from './shared.js';

export async function verifyConfiguredSdkManifest(
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

  validateRefreshProvenance(manifest.refresh, CONFIGURED_SDK_MODE, failures);

  if (failures.length > 0) {
    return {
      manifestPath,
      checkedFiles: 0,
      failures,
    };
  }

  const manifestDir = dirname(manifestPath);
  // Two integrity tiers checked separately: `outputChecks` are the
  // self-contained generated pack (always verified), `sourceChecks` are the
  // external recorded spec (verified only when the spec is available).
  const outputChecks: FileCheck[] = [];
  const sourceChecks: FileCheck[] = [];
  const sourceRecord = source as Record<string, unknown>;
  const outputRecords = generatedOutputs as unknown[];
  const sourcePath = sourceRecord.resolvedSpecPath;
  const sourceByteSize = sourceRecord.byteSize;
  const sourceHash = sourceRecord.contentHash;
  const sourceLineCount = sourceRecord.lineCount;
  const sourceEstimatedTokenCount = sourceRecord.estimatedTokenCount;

  if (!isNonEmptyString(sourcePath)) {
    failures.push('malformed manifest: source.resolvedSpecPath must be a non-empty string');
  }

  if (!isNonNegativeInteger(sourceByteSize)) {
    failures.push('malformed manifest: source.byteSize must be a non-negative integer');
  }

  if (!isSha256Hash(sourceHash)) {
    failures.push('malformed manifest: source.contentHash must be a sha256 hash');
  }

  if (!isNonNegativeInteger(sourceLineCount)) {
    failures.push('malformed manifest: source.lineCount must be a non-negative integer');
  }

  if (!isNonNegativeInteger(sourceEstimatedTokenCount)) {
    failures.push('malformed manifest: source.estimatedTokenCount must be a non-negative integer');
  }

  if (
    isNonEmptyString(sourcePath) &&
    isNonNegativeInteger(sourceByteSize) &&
    isSha256Hash(sourceHash)
  ) {
    const hasValidSourceLineCount = isNonNegativeInteger(sourceLineCount);
    const hasValidSourceEstimatedTokenCount = isNonNegativeInteger(sourceEstimatedTokenCount);

    sourceChecks.push({
      label: 'source',
      path: resolveManifestSourcePath(sourcePath, manifestDir),
      expectedByteSize: sourceByteSize,
      expectedHash: sourceHash,
      ...(hasValidSourceLineCount ? { expectedLineCount: sourceLineCount as number } : {}),
      ...(hasValidSourceEstimatedTokenCount
        ? { expectedEstimatedTokenCount: sourceEstimatedTokenCount as number }
        : {}),
    });
  }

  validateGeneratedOutputs({
    generatedOutputs: outputRecords,
    manifestDir,
    failures,
    fileChecks: outputChecks,
    requireTextMetadata: true,
    // Intentionally lenient (unlike the source-* modes): the legacy
    // configured-SDK path may have its generated outputs symlinked into a
    // published docs tree, and verify must follow those symlinks. This is a
    // deliberate compatibility affordance, exercised by the "continues to follow
    // configured SDK generated output symlinks during verification" test — do
    // not tighten to true without changing that contract. The byte-size + SHA-256
    // check still detects tampered content through the symlink.
    rejectSymlinks: false,
    allowedKinds: CONFIGURED_SDK_GENERATED_OUTPUT_KINDS,
  });

  validateRequiredManifestContract(manifest.manifestContract, CONFIGURED_SDK_MODE, failures);
  validateRequiredInputProvenance(
    manifest.inputProvenance,
    CONFIGURED_SDK_MODE,
    manifest,
    failures
  );
  validateRequiredArtifactSummary(
    manifest.artifactSummary,
    CONFIGURED_SDK_MODE,
    manifest,
    failures
  );

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
  // when the recorded spec is missing or fails, so a verifier can attest the
  // outputs it holds.
  const outputFailures: string[] = [];

  for (const check of outputChecks) {
    await verifyFile(check, outputFailures);
  }

  // Source tier: the recorded spec file. A missing spec is reported as
  // `unavailable` (expected for a relocated pack); a present spec that fails
  // its hash check is a real failure.
  const sourceFailures: string[] = [];
  let sourceCheckedFiles = 0;
  let sourceStatus: VerifyTierResult['status'];
  const sourceCheck = sourceChecks.at(0);

  if (sourceCheck === undefined || !(await pathExists(sourceCheck.path))) {
    sourceStatus = 'unavailable';
    sourceFailures.push(
      `source: recorded source path is unavailable at ${sourceCheck?.path ?? '(unknown)'}`
    );
  } else {
    await verifyFile(sourceCheck, sourceFailures);
    sourceCheckedFiles = 1;
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
  };
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
