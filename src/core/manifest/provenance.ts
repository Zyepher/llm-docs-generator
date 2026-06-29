/**
 * Input provenance types, builder, and validators.
 */

import { errorMessage, isNonEmptyString, isObjectRecord } from '../../utils/guards.js';
import {
  CONFIGURED_SDK_MODE,
  DISCOVERY_REPORT_MODE,
  DISCOVERY_REPORT_OUTPUT_KIND,
  INPUT_PROVENANCE_INPUT_KINDS,
  INPUT_PROVENANCE_SCHEMA,
  MANIFEST_CONTRACT_ARTIFACT_ROLES,
  MANIFEST_CONTRACT_BY_MODE,
  SOURCE_DOCS_MODE,
  SOURCE_TRUTH_DOCS_MODE,
  SOURCE_TRUTH_REPORT_OUTPUT_KIND,
  SOURCE_VERIFICATION_REPORT_OUTPUT_KIND,
} from './constants.js';
import type { DiscoveryReportKind, ManifestContractMode } from './constants.js';
import type { ManifestContract } from './contract.js';
import {
  optionalBooleanOrNullField,
  optionalStringArrayField,
  optionalStringOrNullField,
  requireStringArray,
  requiredArrayField,
  requiredFalseField,
  requiredNonNegativeIntegerField,
  requiredObjectField,
  requiredStringField,
  validateAllowedKeys,
} from './field-validators.js';
import { isDiscoveryReportKind, isManifestContractMode } from './predicates.js';

export interface InputProvenanceEndpoint {
  input?: string;
  configuredUrl?: string;
  configuredLocalPath?: string | null;
  resolvedPath?: string;
  resolvedSpecPath?: string;
  type?: string;
  format?: string;
  formatHint?: string;
  resolvedFormat?: string;
}

export interface InputProvenanceParserPlugin {
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
  format: {
    id: string;
    displayName: string;
    extensions: string[];
    mediaTypes?: string[];
    directorySupport?: boolean;
  };
}

export interface InputProvenanceParser {
  name: string;
  version: string;
  format: string;
  plugin?: InputProvenanceParserPlugin;
}

export interface InputProvenanceReport {
  path: string;
  kind: string;
  schemaVersion: string;
  mode: string;
  discoveryKind?: DiscoveryReportKind;
  candidateCount?: number;
  warningCount?: number;
  urlResourceCount?: number;
}

export interface InputProvenance {
  schema: typeof INPUT_PROVENANCE_SCHEMA;
  manifestMode: ManifestContractMode;
  artifactRole: ManifestContract['artifactRole'];
  inputKind: string;
  source?: InputProvenanceEndpoint;
  docs?: InputProvenanceEndpoint;
  repo?: {
    input: string;
    normalizedInput: string;
    commit: string | null;
    dirty: boolean | null;
  };
  scope?: {
    input: string;
    path: string;
    resolvedPath: string;
    type: string;
  };
  website?: {
    input: string;
    normalizedUrl: string;
    origin: string;
  };
  crawlPolicy?: {
    linkedCandidateFetches: false;
    renderedJavaScript: false;
    inspectedResourceCount: number;
    sameOriginWellKnownResourceCount: number;
  };
  report?: InputProvenanceReport;
  sdk?: {
    name: string;
    resolvedVersion: string;
    displayName: string;
  };
  parser?: InputProvenanceParser;
  formatter?: {
    name: string;
    version: string;
    format: string;
  };
}

export function buildInputProvenanceForManifest(
  manifest: Record<string, unknown>
): InputProvenance {
  const mode = manifest.mode;

  if (!isNonEmptyString(mode) || !isManifestContractMode(mode)) {
    throw new Error('manifest mode must be supported before writing input provenance');
  }

  const base = inputProvenanceBase(mode);

  if (mode === CONFIGURED_SDK_MODE) {
    const source = requiredObjectField(manifest, 'source', 'input provenance manifest');
    const sdk = requiredObjectField(manifest, 'sdk', 'input provenance manifest');
    const parser = requiredObjectField(manifest, 'parser', 'input provenance manifest');
    const formatter = requiredObjectField(manifest, 'formatter', 'input provenance manifest');

    return {
      ...base,
      inputKind: 'configured-sdk',
      source: {
        configuredUrl: requiredStringField(source, 'configuredUrl', 'input provenance source'),
        configuredLocalPath: optionalStringOrNullField(
          source,
          'configuredLocalPath',
          'input provenance source'
        ),
        resolvedSpecPath: requiredStringField(
          source,
          'resolvedSpecPath',
          'input provenance source'
        ),
        format: requiredStringField(source, 'format', 'input provenance source'),
      },
      sdk: inputProvenanceSdk(sdk),
      parser: inputProvenanceParser(parser),
      formatter: inputProvenanceFormatter(formatter),
    };
  }

  if (mode === SOURCE_DOCS_MODE) {
    const source = requiredObjectField(manifest, 'source', 'input provenance manifest');
    const parser = requiredObjectField(manifest, 'parser', 'input provenance manifest');
    const formatter = requiredObjectField(manifest, 'formatter', 'input provenance manifest');
    const plugin = isObjectRecord(parser.plugin)
      ? inputProvenanceParserPlugin(parser.plugin)
      : undefined;

    return {
      ...base,
      inputKind:
        plugin === undefined ? 'built-in-local-source-docs' : 'parser-plugin-local-source-docs',
      source: {
        input: requiredStringField(source, 'input', 'input provenance source'),
        resolvedPath: requiredStringField(source, 'resolvedPath', 'input provenance source'),
        type: requiredStringField(source, 'type', 'input provenance source'),
        formatHint: requiredStringField(source, 'formatHint', 'input provenance source'),
        resolvedFormat: requiredStringField(source, 'resolvedFormat', 'input provenance source'),
      },
      parser: inputProvenanceParser(parser, plugin),
      formatter: inputProvenanceFormatter(formatter),
    };
  }

  if (mode === SOURCE_TRUTH_DOCS_MODE) {
    const source = requiredObjectField(manifest, 'source', 'input provenance manifest');
    const inspection = requiredObjectField(manifest, 'inspection', 'input provenance manifest');
    const reportOutput = inputProvenanceGeneratedOutput(
      manifest,
      SOURCE_TRUTH_REPORT_OUTPUT_KIND,
      'input provenance source-truth report output'
    );

    return {
      ...base,
      inputKind: 'source-truth-local-source',
      source: {
        input: requiredStringField(source, 'input', 'input provenance source'),
        resolvedPath: requiredStringField(source, 'resolvedPath', 'input provenance source'),
        type: requiredStringField(source, 'type', 'input provenance source'),
      },
      report: {
        path: reportOutput.path,
        kind: SOURCE_TRUTH_REPORT_OUTPUT_KIND,
        schemaVersion: requiredStringField(
          inspection,
          'schemaVersion',
          'input provenance inspection'
        ),
        mode: requiredStringField(inspection, 'mode', 'input provenance inspection'),
      },
    };
  }

  if (mode === DISCOVERY_REPORT_MODE) {
    return buildDiscoveryInputProvenance(manifest, base);
  }

  const sourceVerification = requiredObjectField(
    manifest,
    'sourceVerification',
    'input provenance manifest'
  );
  const source = requiredObjectField(
    sourceVerification,
    'source',
    'input provenance sourceVerification'
  );
  const docs = requiredObjectField(
    sourceVerification,
    'docs',
    'input provenance sourceVerification'
  );
  const reportOutput = inputProvenanceGeneratedOutput(
    manifest,
    SOURCE_VERIFICATION_REPORT_OUTPUT_KIND,
    'input provenance source-verification report output'
  );
  const reportPath = requiredStringField(
    sourceVerification,
    'reportPath',
    'input provenance sourceVerification'
  );

  if (reportOutput.path !== reportPath) {
    throw new Error(
      'input provenance source-verification report output path must match sourceVerification.reportPath'
    );
  }

  return {
    ...base,
    inputKind: 'source-verification-local-evidence',
    source: {
      input: requiredStringField(source, 'input', 'input provenance sourceVerification.source'),
      resolvedPath: requiredStringField(
        source,
        'resolvedPath',
        'input provenance sourceVerification.source'
      ),
      type: requiredStringField(source, 'type', 'input provenance sourceVerification.source'),
    },
    docs: {
      input: requiredStringField(docs, 'input', 'input provenance sourceVerification.docs'),
      resolvedPath: requiredStringField(
        docs,
        'resolvedPath',
        'input provenance sourceVerification.docs'
      ),
      type: requiredStringField(docs, 'type', 'input provenance sourceVerification.docs'),
    },
    report: {
      path: reportPath,
      kind: SOURCE_VERIFICATION_REPORT_OUTPUT_KIND,
      schemaVersion: requiredStringField(
        sourceVerification,
        'reportSchemaVersion',
        'input provenance sourceVerification'
      ),
      mode: requiredStringField(
        sourceVerification,
        'reportMode',
        'input provenance sourceVerification'
      ),
    },
  };
}

export function inputProvenanceBase(mode: ManifestContractMode): Omit<InputProvenance, 'inputKind'> {
  return {
    schema: INPUT_PROVENANCE_SCHEMA,
    manifestMode: mode,
    artifactRole: MANIFEST_CONTRACT_BY_MODE[mode].artifactRole,
  };
}

export function inputProvenanceSdk(sdk: Record<string, unknown>): NonNullable<InputProvenance['sdk']> {
  return {
    name: requiredStringField(sdk, 'name', 'input provenance sdk'),
    resolvedVersion: requiredStringField(sdk, 'resolvedVersion', 'input provenance sdk'),
    displayName: requiredStringField(sdk, 'displayName', 'input provenance sdk'),
  };
}

export function inputProvenanceParser(
  parser: Record<string, unknown>,
  plugin?: InputProvenanceParserPlugin
): InputProvenanceParser {
  return {
    name: requiredStringField(parser, 'name', 'input provenance parser'),
    version: requiredStringField(parser, 'version', 'input provenance parser'),
    format: requiredStringField(parser, 'format', 'input provenance parser'),
    ...(plugin === undefined ? {} : { plugin }),
  };
}

export function inputProvenanceParserPlugin(plugin: Record<string, unknown>): InputProvenanceParserPlugin {
  const module = requiredObjectField(plugin, 'module', 'input provenance parser.plugin');
  const format = requiredObjectField(plugin, 'format', 'input provenance parser.plugin');
  const mediaTypes = optionalStringArrayField(
    format,
    'mediaTypes',
    'input provenance parser.plugin.format'
  );
  const directorySupport = format.directorySupport;

  if (directorySupport !== undefined && typeof directorySupport !== 'boolean') {
    throw new Error('input provenance parser.plugin.format.directorySupport must be a boolean');
  }

  return {
    manifestPath: requiredStringField(plugin, 'manifestPath', 'input provenance parser.plugin'),
    resolvedManifestPath: requiredStringField(
      plugin,
      'resolvedManifestPath',
      'input provenance parser.plugin'
    ),
    manifestByteSize: requiredNonNegativeIntegerField(
      plugin,
      'manifestByteSize',
      'input provenance parser.plugin'
    ),
    manifestHash: requiredStringField(plugin, 'manifestHash', 'input provenance parser.plugin'),
    name: requiredStringField(plugin, 'name', 'input provenance parser.plugin'),
    version: requiredStringField(plugin, 'version', 'input provenance parser.plugin'),
    module: {
      path: requiredStringField(module, 'path', 'input provenance parser.plugin.module'),
      resolvedPath: requiredStringField(
        module,
        'resolvedPath',
        'input provenance parser.plugin.module'
      ),
    },
    format: {
      id: requiredStringField(format, 'id', 'input provenance parser.plugin.format'),
      displayName: requiredStringField(
        format,
        'displayName',
        'input provenance parser.plugin.format'
      ),
      extensions: requireStringArray(
        requiredArrayField(format, 'extensions', 'input provenance parser.plugin.format'),
        'input provenance parser.plugin.format.extensions'
      ),
      ...(mediaTypes.length === 0 ? {} : { mediaTypes }),
      ...(directorySupport === undefined ? {} : { directorySupport }),
    },
  };
}

export function inputProvenanceFormatter(
  formatter: Record<string, unknown>
): NonNullable<InputProvenance['formatter']> {
  return {
    name: requiredStringField(formatter, 'name', 'input provenance formatter'),
    version: requiredStringField(formatter, 'version', 'input provenance formatter'),
    format: requiredStringField(formatter, 'format', 'input provenance formatter'),
  };
}

export function inputProvenanceGeneratedOutput(
  manifest: Record<string, unknown>,
  kind: string,
  label: string
): { path: string } {
  const generatedOutputs = requiredArrayField(manifest, 'generatedOutputs', label);
  const reportOutput = generatedOutputs.find(
    (output) => isObjectRecord(output) && output.kind === kind
  );

  if (!isObjectRecord(reportOutput)) {
    throw new Error(`${label} must exist in generatedOutputs`);
  }

  return {
    path: requiredStringField(reportOutput, 'path', label),
  };
}

export function buildDiscoveryInputProvenance(
  manifest: Record<string, unknown>,
  base: Omit<InputProvenance, 'inputKind'>
): InputProvenance {
  const discovery = requiredObjectField(manifest, 'discovery', 'input provenance manifest');
  const discoveryKind = requiredStringField(discovery, 'kind', 'input provenance discovery');
  const candidateEvidenceIndex = requiredObjectField(
    manifest,
    'candidateEvidenceIndex',
    'input provenance manifest'
  );
  const context = requiredObjectField(
    candidateEvidenceIndex,
    'context',
    'input provenance candidateEvidenceIndex'
  );
  const report = inputProvenanceDiscoveryReport(discovery);

  if (discoveryKind === 'source') {
    const source = requiredObjectField(context, 'source', 'input provenance discovery context');

    return {
      ...base,
      inputKind: 'discovery-source-report',
      source: {
        input: requiredStringField(source, 'input', 'input provenance discovery source'),
        resolvedPath: requiredStringField(
          source,
          'resolvedPath',
          'input provenance discovery source'
        ),
        type: requiredStringField(source, 'type', 'input provenance discovery source'),
      },
      report,
    };
  }

  if (discoveryKind === 'repo') {
    const repo = requiredObjectField(context, 'repo', 'input provenance discovery context');
    const scope = requiredObjectField(context, 'scope', 'input provenance discovery context');

    return {
      ...base,
      inputKind: 'discovery-repo-report',
      repo: {
        input: requiredStringField(repo, 'input', 'input provenance discovery repo'),
        normalizedInput: requiredStringField(
          repo,
          'normalizedInput',
          'input provenance discovery repo'
        ),
        commit: optionalStringOrNullField(repo, 'commit', 'input provenance discovery repo'),
        dirty: optionalBooleanOrNullField(repo, 'dirty', 'input provenance discovery repo'),
      },
      scope: {
        input: requiredStringField(scope, 'input', 'input provenance discovery scope'),
        path: requiredStringField(scope, 'path', 'input provenance discovery scope'),
        resolvedPath: requiredStringField(
          scope,
          'resolvedPath',
          'input provenance discovery scope'
        ),
        type: requiredStringField(scope, 'type', 'input provenance discovery scope'),
      },
      report,
    };
  }

  if (discoveryKind === 'url') {
    const website = requiredObjectField(context, 'website', 'input provenance discovery context');
    const crawlPolicy = requiredObjectField(
      context,
      'crawlPolicy',
      'input provenance discovery context'
    );

    return {
      ...base,
      inputKind: 'discovery-url-report',
      website: {
        input: requiredStringField(website, 'input', 'input provenance discovery website'),
        normalizedUrl: requiredStringField(
          website,
          'normalizedUrl',
          'input provenance discovery website'
        ),
        origin: requiredStringField(website, 'origin', 'input provenance discovery website'),
      },
      crawlPolicy: {
        linkedCandidateFetches: requiredFalseField(
          crawlPolicy,
          'linkedCandidateFetches',
          'input provenance discovery crawlPolicy'
        ),
        renderedJavaScript: requiredFalseField(
          crawlPolicy,
          'renderedJavaScript',
          'input provenance discovery crawlPolicy'
        ),
        inspectedResourceCount: requiredNonNegativeIntegerField(
          crawlPolicy,
          'inspectedResourceCount',
          'input provenance discovery crawlPolicy'
        ),
        sameOriginWellKnownResourceCount: requiredNonNegativeIntegerField(
          crawlPolicy,
          'sameOriginWellKnownResourceCount',
          'input provenance discovery crawlPolicy'
        ),
      },
      report,
    };
  }

  throw new Error('input provenance discovery.kind must be source, repo, or url');
}

export function inputProvenanceDiscoveryReport(discovery: Record<string, unknown>): InputProvenanceReport {
  const discoveryKind = requiredStringField(discovery, 'kind', 'input provenance discovery');

  if (!isDiscoveryReportKind(discoveryKind)) {
    throw new Error('input provenance discovery.kind must be source, repo, or url');
  }

  const report: InputProvenanceReport = {
    path: requiredStringField(discovery, 'reportPath', 'input provenance discovery'),
    kind: DISCOVERY_REPORT_OUTPUT_KIND,
    schemaVersion: requiredStringField(
      discovery,
      'reportSchemaVersion',
      'input provenance discovery'
    ),
    mode: requiredStringField(discovery, 'reportMode', 'input provenance discovery'),
    discoveryKind,
    candidateCount: requiredNonNegativeIntegerField(
      discovery,
      'candidateCount',
      'input provenance discovery'
    ),
    warningCount: requiredNonNegativeIntegerField(
      discovery,
      'warningCount',
      'input provenance discovery'
    ),
  };

  if (discoveryKind === 'url') {
    report.urlResourceCount = requiredNonNegativeIntegerField(
      discovery,
      'urlResourceCount',
      'input provenance discovery'
    );
  }

  return report;
}

export function validateRequiredInputProvenance(
  provenance: unknown,
  expectedMode: ManifestContractMode,
  manifest: Record<string, unknown>,
  failures: string[]
): void {
  if (provenance === undefined) {
    failures.push(
      'malformed manifest: inputProvenance is required for V2 manifests; unsupported pre-V2 manifest; regenerate with V2'
    );
    return;
  }

  validateInputProvenance(provenance, expectedMode, manifest, failures);
}

export function validateInputProvenance(
  provenance: unknown,
  expectedMode: ManifestContractMode,
  manifest: Record<string, unknown>,
  failures: string[]
): void {
  if (provenance === undefined) {
    return;
  }

  if (!isObjectRecord(provenance)) {
    failures.push('malformed manifest: inputProvenance must be an object');
    return;
  }

  let expected: InputProvenance | undefined;

  try {
    expected = buildInputProvenanceForManifest(manifest);
  } catch (error) {
    failures.push(
      `malformed manifest: inputProvenance could not be rebuilt from manifest metadata: ${errorMessage(
        error
      )}`
    );
  }

  if (provenance.schema !== INPUT_PROVENANCE_SCHEMA) {
    failures.push(`malformed manifest: inputProvenance.schema must be ${INPUT_PROVENANCE_SCHEMA}`);
  }

  if (
    !isNonEmptyString(provenance.manifestMode) ||
    !isManifestContractMode(provenance.manifestMode)
  ) {
    failures.push('malformed manifest: inputProvenance.manifestMode must be a supported mode');
  } else if (provenance.manifestMode !== expectedMode) {
    failures.push(
      `malformed manifest: inputProvenance.manifestMode must match manifest mode ${expectedMode}`
    );
  }

  if (
    !isNonEmptyString(provenance.artifactRole) ||
    !MANIFEST_CONTRACT_ARTIFACT_ROLES.has(provenance.artifactRole)
  ) {
    failures.push(
      'malformed manifest: inputProvenance.artifactRole must be generated-docs, candidate-evidence-report, or local-source-evidence-report'
    );
  }

  if (
    !isNonEmptyString(provenance.inputKind) ||
    !INPUT_PROVENANCE_INPUT_KINDS.has(provenance.inputKind)
  ) {
    failures.push('malformed manifest: inputProvenance.inputKind must be a supported input kind');
  }

  if (expected === undefined) {
    return;
  }

  validateInputProvenanceAllowedShape(provenance, expected, 'inputProvenance', failures);

  if (provenance.artifactRole !== expected.artifactRole) {
    failures.push(
      `malformed manifest: inputProvenance.artifactRole must be ${expected.artifactRole} for ${expectedMode}`
    );
  }

  if (provenance.inputKind !== expected.inputKind) {
    failures.push(
      `malformed manifest: inputProvenance.inputKind must be ${expected.inputKind} for ${expectedMode}`
    );
  }

  if (!inputProvenanceValuesEqual(provenance, expected)) {
    failures.push(
      `malformed manifest: inputProvenance must match manifest metadata for ${expectedMode}`
    );
  }
}

export function validateInputProvenanceAllowedShape(
  actual: unknown,
  expected: unknown,
  label: string,
  failures: string[]
): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      failures.push(`malformed manifest: ${label} must be an array`);
      return;
    }

    return;
  }

  if (isObjectRecord(expected)) {
    if (!isObjectRecord(actual)) {
      failures.push(`malformed manifest: ${label} must be an object`);
      return;
    }

    validateAllowedKeys(actual, new Set(Object.keys(expected)), label, failures);

    for (const [key, expectedValue] of Object.entries(expected)) {
      if (key in actual) {
        validateInputProvenanceAllowedShape(
          actual[key],
          expectedValue,
          `${label}.${key}`,
          failures
        );
      }
    }
  }
}

export function inputProvenanceValuesEqual(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((entry, index) => inputProvenanceValuesEqual(actual[index], entry))
    );
  }

  if (isObjectRecord(expected)) {
    if (!isObjectRecord(actual)) {
      return false;
    }

    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);

    if (
      expectedKeys.length !== actualKeys.length ||
      expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(actual, key))
    ) {
      return false;
    }

    return expectedKeys.every((key) => inputProvenanceValuesEqual(actual[key], expected[key]));
  }

  return actual === expected;
}
