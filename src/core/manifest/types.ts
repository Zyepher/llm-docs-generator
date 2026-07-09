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
  // Two-tier integrity result populated by the local-source-docs verifier:
  // `outputs` covers the self-contained generated pack (always hash-checked),
  // `source` covers the external recorded source (may be unavailable for a
  // relocated pack). Other manifest modes leave these undefined.
  outputs?: VerifyTierResult;
  source?: VerifyTierResult;
}

export interface WriteDiscoveryReportManifestOptions {
  manifestPath: string;
  generator: GeneratorMetadata;
  discoveryKind: DiscoveryReportKind;
  reportPath: string;
}
