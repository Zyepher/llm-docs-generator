/**
 * Generation manifest writer for the configured SDK compatibility flow.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { describeGeneratedTextOutput } from './generated-output-metadata.js';
import {
  isObjectRecord,
  errorMessage,
  isFileNotFoundError,
} from '../utils/guards.js';
import { writeTextFileSafely } from '../utils/safe-write.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import { readJsonFile } from '../utils/json.js';
import {
  CONFIGURED_SDK_MODE,
  DISCOVERY_REPORT_MODE,
  DISCOVERY_REPORT_OUTPUT_KIND,
  MANIFEST_SCHEMA_VERSION,
  SOURCE_DOCS_MODE,
  SOURCE_TRUTH_DOCS_MODE,
  SOURCE_VERIFICATION_MODE,
} from './manifest/constants.js';
import type { RefreshSourceManifestMode } from './manifest/constants.js';
import type {
  GeneratedOutputManifestEntry,
  VerifyGenerationManifestOptions,
  VerifyGenerationManifestResult,
  WriteDiscoveryReportManifestOptions,
  WriteGenerationManifestOptions,
} from './manifest/types.js';
import { toManifestRelativePath } from './manifest/fs-verify.js';
import { buildManifestContract } from './manifest/contract.js';
import { buildRefreshProvenance } from './manifest/refresh-provenance.js';
import type { RefreshProvenance } from './manifest/refresh-provenance.js';
import { buildInputProvenanceForManifest } from './manifest/provenance.js';
import { buildArtifactSummaryForManifest } from './manifest/artifact-summary.js';
import {
  buildDiscoveryCandidateEvidenceIndex,
  readDiscoveryReportJson,
  summarizeDiscoveryReport,
} from './manifest/discovery-evidence.js';
import { verifyConfiguredSdkManifest } from './manifest/verify/configured-sdk.js';
import { verifySourceVerificationManifest } from './manifest/verify/source-verification.js';
import { verifyDiscoveryReportManifest } from './manifest/verify/discovery-report.js';
import { verifySourceTruthDocsManifest } from './manifest/verify/source-truth-docs.js';
import { verifySourceDocsManifest } from './manifest/verify/source-docs.js';

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
export { validateSourceDocsPresetContract } from './manifest/verify/source-docs.js';

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
