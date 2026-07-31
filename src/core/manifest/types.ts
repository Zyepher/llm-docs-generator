/**
 * Public input/output type definitions for the manifest writers and verifier.
 */

import type { DiscoveryReportKind, GeneratedOutputKind } from './constants.js';

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

export interface VerifyTierResult {
  status: 'passed' | 'failed' | 'unavailable';
  checkedFiles: number;
  failures: string[];
}

export interface VerifyGenerationManifestResult {
  manifestPath: string;
  checkedFiles: number;
  failures: string[];
  // Two-tier integrity result: `outputs` covers the self-contained generated
  // pack (always hash-checked, even when the recorded source is missing or
  // fails), `source` covers the external recorded source (may be unavailable
  // for a relocated pack). `outputs` is undefined only when the manifest is
  // too malformed to integrity-check; `source` additionally stays undefined
  // for modes that record no source-side checks (discovery-report,
  // source-verification-local-evidence).
  outputs?: VerifyTierResult;
  source?: VerifyTierResult;
  // Files found in the pack directory that the manifest does not cover and
  // that do not match the tool's own output naming (for example an agent's
  // own llm-docs/index.md nav aid, or .DS_Store). Informational only: never a
  // failure, never hashed. Sorted by code unit and bounded to 20 entries plus
  // a trailing "+N more" marker.
  unmanagedFiles?: string[];
  // Non-fatal verifier notes (e.g. a provenance cross-check skipped because the
  // output header predates provenance stamping). Never affect the exit code.
  notes?: string[];
}

export interface WriteDiscoveryReportManifestOptions {
  manifestPath: string;
  generator: GeneratorMetadata;
  discoveryKind: DiscoveryReportKind;
  reportPath: string;
}
