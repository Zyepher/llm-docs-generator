/**
 * Validators shared across multiple manifest verifiers.
 */

import { isAbsolute, resolve } from 'node:path';

import { isNonEmptyString, isNonNegativeInteger, isObjectRecord } from '../../../utils/guards.js';
import { isSha256Hash } from '../../../utils/hash.js';
import { formatAllowedOutputKinds, isAllowedOutputKind, isInsideDirectory } from '../predicates.js';
import type { FileCheck } from '../fs-verify.js';

export function validateGeneratorMetadata(generator: Record<string, unknown>, failures: string[]): void {
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

export function validateGeneratedOutputs(options: {
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

  // Duplicate-path guard: two generatedOutputs entries for one path mask a lost
  // artifact from the hash checks (both entries point at, and clean-hash, the
  // surviving file). Keyed by resolved path so spelling variants of one target
  // are caught too. Reported once per repeated path.
  const seenOutputPaths = new Set<string>();

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
    } else {
      const pathKey = resolve(manifestDir, outputPath);
      if (seenOutputPaths.has(pathKey)) {
        failures.push(
          `malformed manifest: ${label}.path duplicates an earlier generatedOutputs path: ${outputPath}`
        );
      } else {
        seenOutputPaths.add(pathKey);
      }
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
