/**
 * Verifier for discovery-report manifests and its report consistency checks.
 */

import { dirname, isAbsolute, resolve } from 'node:path';

import {
  errorMessage,
  isNonEmptyString,
  isNonNegativeInteger,
  isObjectRecord,
} from '../../../utils/guards.js';
import { isSha256Hash, isUnprefixedSha256Hash } from '../../../utils/hash.js';
import { readJsonFile } from '../../../utils/json.js';
import {
  DISCOVERY_CANDIDATE_EVIDENCE_CONTEXT_KEYS_BY_KIND,
  DISCOVERY_CANDIDATE_EVIDENCE_INDEX_KEYS,
  DISCOVERY_CANDIDATE_EVIDENCE_KEYS,
  DISCOVERY_CANDIDATE_SOURCE_RESOURCE_KEYS,
  DISCOVERY_PATH_CANDIDATE_EVIDENCE_INDEX_CANDIDATE_KEYS,
  DISCOVERY_REPORT_GENERATED_OUTPUT_KINDS,
  DISCOVERY_REPORT_MODE,
  DISCOVERY_REPORT_MODE_BY_KIND,
  DISCOVERY_REPORT_OUTPUT_KIND,
  DISCOVERY_REPORT_SCHEMA_VERSION,
  DISCOVERY_REPO_CONTEXT_KEYS,
  DISCOVERY_REPO_SCOPE_CONTEXT_KEYS,
  DISCOVERY_SOURCE_CONTEXT_KEYS,
  DISCOVERY_URL_CANDIDATE_EVIDENCE_INDEX_CANDIDATE_KEYS,
  DISCOVERY_WEBSITE_CONTEXT_KEYS,
  DISCOVERY_WEBSITE_CRAWL_POLICY_CONTEXT_KEYS,
  DISCOVERY_WEBSITE_RESOURCE_FRESHNESS_KEYS,
} from '../constants.js';
import type { DiscoveryReportKind } from '../constants.js';
import {
  isDiscoveryReportKind,
  isInsideDirectory,
  isIsoTimestampString,
  isPositiveInteger,
} from '../predicates.js';
import { validateAllowedKeys, validateOptionalStringArray } from '../field-validators.js';
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
import {
  buildDiscoveryCandidateEvidenceIndex,
  discoveryCandidateEvidenceIndexesEqual,
  hashDiscoveryCandidateEvidenceIndex,
} from '../discovery-evidence.js';
import type {
  DiscoveryCandidateEvidenceContext,
  DiscoveryCandidateEvidenceIndex,
  DiscoveryCandidateEvidenceIndexCandidate,
  DiscoveryCandidateEvidenceIndexHashData,
  WebsiteResourceFreshnessIndexEntry,
} from '../discovery-evidence.js';
import { validateGeneratedOutputs, validateGeneratorMetadata } from './shared.js';

export async function verifyDiscoveryReportManifest(
  manifestPath: string,
  manifest: Record<string, unknown>
): Promise<VerifyGenerationManifestResult> {
  const failures: string[] = [];
  const manifestDir = dirname(manifestPath);
  const generator = manifest.generator;
  const discovery = manifest.discovery;
  const candidateEvidenceIndex = manifest.candidateEvidenceIndex;
  const generatedOutputs = manifest.generatedOutputs;

  if (!isObjectRecord(generator)) {
    failures.push('malformed manifest: missing generator object');
  } else {
    validateGeneratorMetadata(generator, failures);
  }

  if (!isObjectRecord(discovery)) {
    failures.push('malformed manifest: missing discovery object');
  }

  if (!Array.isArray(generatedOutputs)) {
    failures.push('malformed manifest: missing generatedOutputs array');
  }

  validateRequiredManifestContract(manifest.manifestContract, DISCOVERY_REPORT_MODE, failures);
  validateRequiredInputProvenance(
    manifest.inputProvenance,
    DISCOVERY_REPORT_MODE,
    manifest,
    failures
  );
  validateRequiredArtifactSummary(
    manifest.artifactSummary,
    DISCOVERY_REPORT_MODE,
    manifest,
    failures
  );

  if (candidateEvidenceIndex === undefined) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex is required for V2 discovery-report manifests; unsupported pre-V2 manifest; regenerate with V2'
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
  const discoveryRecord = discovery as Record<string, unknown>;
  const outputRecords = generatedOutputs as unknown[];
  const discoveryKind = discoveryRecord.kind;
  const reportPath = discoveryRecord.reportPath;
  const reportSchemaVersion = discoveryRecord.reportSchemaVersion;
  const reportMode = discoveryRecord.reportMode;
  const candidateCount = discoveryRecord.candidateCount;
  const warningCount = discoveryRecord.warningCount;
  const urlResourceCount = discoveryRecord.urlResourceCount;
  let candidateEvidenceIndexEntry: DiscoveryCandidateEvidenceIndex | undefined;

  if (candidateEvidenceIndex !== undefined && isDiscoveryReportKind(discoveryKind)) {
    candidateEvidenceIndexEntry = validateDiscoveryCandidateEvidenceIndex({
      index: candidateEvidenceIndex,
      discoveryKind,
      failures,
    });
  }

  if (!isDiscoveryReportKind(discoveryKind)) {
    failures.push('malformed manifest: discovery.kind must be source, repo, or url');
  }

  if (manifest.refresh !== undefined) {
    if (discoveryKind !== 'source') {
      failures.push(
        'malformed manifest: refresh is supported for discovery-report manifests only when discovery.kind is source'
      );
    } else {
      validateRefreshProvenance(manifest.refresh, DISCOVERY_REPORT_MODE, failures);
    }
  }

  if (!isNonEmptyString(reportPath)) {
    failures.push('malformed manifest: discovery.reportPath must be a non-empty string');
  } else if (isAbsolute(reportPath)) {
    failures.push(`malformed manifest: discovery.reportPath must be relative: ${reportPath}`);
  } else if (!isInsideDirectory(manifestDir, resolve(manifestDir, reportPath))) {
    failures.push(
      `malformed manifest: discovery.reportPath escapes manifest directory: ${reportPath}`
    );
  }

  if (reportSchemaVersion !== DISCOVERY_REPORT_SCHEMA_VERSION) {
    failures.push(
      `malformed manifest: discovery.reportSchemaVersion must be ${DISCOVERY_REPORT_SCHEMA_VERSION}`
    );
  }

  if (
    isDiscoveryReportKind(discoveryKind) &&
    reportMode !== DISCOVERY_REPORT_MODE_BY_KIND[discoveryKind]
  ) {
    failures.push(
      `malformed manifest: discovery.reportMode must be ${DISCOVERY_REPORT_MODE_BY_KIND[discoveryKind]}`
    );
  }

  if (!isNonNegativeInteger(candidateCount)) {
    failures.push('malformed manifest: discovery.candidateCount must be a non-negative integer');
  }

  if (!isNonNegativeInteger(warningCount)) {
    failures.push('malformed manifest: discovery.warningCount must be a non-negative integer');
  }

  if (discoveryKind === 'url') {
    if (!isNonNegativeInteger(urlResourceCount)) {
      failures.push(
        'malformed manifest: discovery.urlResourceCount must be a non-negative integer'
      );
    }
  } else if ('urlResourceCount' in discoveryRecord) {
    failures.push('malformed manifest: discovery.urlResourceCount is only valid for url discovery');
  }

  if (outputRecords.length !== 1) {
    failures.push('malformed manifest: discovery manifests must contain exactly one output');
  }

  const outputRecord = outputRecords[0];
  if (isObjectRecord(outputRecord)) {
    if (
      isNonEmptyString(reportPath) &&
      !isAbsolute(reportPath) &&
      outputRecord.path !== reportPath
    ) {
      failures.push('malformed manifest: generatedOutputs[0].path must match discovery.reportPath');
    }

    if (outputRecord.kind !== DISCOVERY_REPORT_OUTPUT_KIND) {
      failures.push(
        `malformed manifest: generatedOutputs[0].kind must be ${DISCOVERY_REPORT_OUTPUT_KIND}`
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
    allowedKinds: DISCOVERY_REPORT_GENERATED_OUTPUT_KINDS,
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

  // Outputs tier only: this mode records no source-side hash checks, so the
  // discovery report IS the entire verification.
  const outputFailures: string[] = [];

  for (const check of fileChecks) {
    await verifyFile(check, outputFailures);
  }

  if (
    outputFailures.length === 0 &&
    isDiscoveryReportKind(discoveryKind) &&
    isNonEmptyString(reportPath) &&
    !isAbsolute(reportPath)
  ) {
    const expectedReport = {
      kind: discoveryKind,
      schemaVersion: DISCOVERY_REPORT_SCHEMA_VERSION,
      mode: DISCOVERY_REPORT_MODE_BY_KIND[discoveryKind],
      candidateCount: candidateCount as number,
      warningCount: warningCount as number,
      ...(discoveryKind === 'url' ? { urlResourceCount: urlResourceCount as number } : {}),
    };

    await verifyDiscoveryReportFile({
      manifestDir,
      reportPath: resolve(manifestDir, reportPath),
      expected: expectedReport,
      candidateEvidenceIndex: candidateEvidenceIndexEntry,
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
async function verifyDiscoveryReportFile(options: {
  manifestDir: string;
  reportPath: string;
  expected: {
    kind: DiscoveryReportKind;
    schemaVersion: string;
    mode: string;
    candidateCount: number;
    warningCount: number;
    urlResourceCount?: number;
  };
  candidateEvidenceIndex: DiscoveryCandidateEvidenceIndex | undefined;
  failures: string[];
}): Promise<void> {
  const { manifestDir, reportPath, expected, candidateEvidenceIndex, failures } = options;
  let report: unknown;

  try {
    report = await readJsonFile(reportPath);
  } catch (error) {
    failures.push(`discovery report: malformed JSON: ${errorMessage(error)}`);
    return;
  }

  if (!isObjectRecord(report)) {
    failures.push('discovery report: root must be an object');
    return;
  }

  if (report.schemaVersion !== expected.schemaVersion) {
    failures.push(
      `discovery report: schemaVersion mismatch (expected ${expected.schemaVersion}, actual ${String(
        report.schemaVersion
      )})`
    );
  }

  if (report.mode !== expected.mode) {
    failures.push(
      `discovery report: mode mismatch (expected ${expected.mode}, actual ${String(report.mode)})`
    );
  }

  const output = report.output;
  if (!isObjectRecord(output)) {
    failures.push('discovery report: missing output object');
  } else if (!isNonEmptyString(output.reportPath)) {
    failures.push('discovery report: output.reportPath must be a non-empty string');
  } else if (resolveManifestSourcePath(output.reportPath, manifestDir) !== reportPath) {
    failures.push('discovery report: output.reportPath must match manifest discovery.reportPath');
  }

  validateDiscoveryReportKindShape(report, expected.kind, failures);
  validateDiscoveryReportCounts(report, expected, failures);

  if (candidateEvidenceIndex !== undefined) {
    verifyDiscoveryCandidateEvidenceIndexAgainstReport({
      discoveryKind: expected.kind,
      report,
      manifestIndex: candidateEvidenceIndex,
      failures,
    });
  }
}
function validateDiscoveryReportKindShape(
  report: Record<string, unknown>,
  kind: DiscoveryReportKind,
  failures: string[]
): void {
  if (kind === 'source') {
    if (!isObjectRecord(report.source)) {
      failures.push('discovery report: source discovery must include source object');
    }

    return;
  }

  if (kind === 'repo') {
    if (!isObjectRecord(report.repo)) {
      failures.push('discovery report: repo discovery must include repo object');
    }

    if (!isObjectRecord(report.scope)) {
      failures.push('discovery report: repo discovery must include scope object');
    }

    return;
  }

  if (!isObjectRecord(report.website)) {
    failures.push('discovery report: url discovery must include website object');
  }

  if (!isObjectRecord(report.crawlPolicy)) {
    failures.push('discovery report: url discovery must include crawlPolicy object');
  }
}
function validateDiscoveryReportCounts(
  report: Record<string, unknown>,
  expected: {
    kind: DiscoveryReportKind;
    candidateCount: number;
    warningCount: number;
    urlResourceCount?: number;
  },
  failures: string[]
): void {
  const candidates = report.candidates;
  const warnings = report.warnings;

  if (!Array.isArray(candidates)) {
    failures.push('discovery report: candidates must be an array');
  } else if (candidates.length !== expected.candidateCount) {
    failures.push(
      `discovery report: candidate count mismatch (expected ${expected.candidateCount}, actual ${candidates.length})`
    );
  }

  if (!Array.isArray(warnings)) {
    failures.push('discovery report: warnings must be an array');
  } else if (warnings.length !== expected.warningCount) {
    failures.push(
      `discovery report: warning count mismatch (expected ${expected.warningCount}, actual ${warnings.length})`
    );
  }

  if (expected.kind !== 'url') {
    return;
  }

  const inspectedResources = report.inspectedResources;

  if (!Array.isArray(inspectedResources)) {
    failures.push('discovery report: inspectedResources must be an array for url discovery');
  } else if (inspectedResources.length !== expected.urlResourceCount) {
    failures.push(
      `discovery report: URL resource count mismatch (expected ${String(
        expected.urlResourceCount
      )}, actual ${inspectedResources.length})`
    );
  }
}
function validateDiscoveryCandidateEvidenceIndex(options: {
  index: unknown;
  discoveryKind: DiscoveryReportKind;
  failures: string[];
}): DiscoveryCandidateEvidenceIndex | undefined {
  const { index, discoveryKind, failures } = options;
  const initialFailureCount = failures.length;

  if (!isObjectRecord(index)) {
    failures.push('malformed manifest: candidateEvidenceIndex must be an object when present');
    return undefined;
  }

  validateAllowedKeys(
    index,
    DISCOVERY_CANDIDATE_EVIDENCE_INDEX_KEYS,
    'candidateEvidenceIndex',
    failures
  );

  const candidateCount = index.candidateCount;
  const aggregateHash = index.aggregateHash;
  const context = validateDiscoveryCandidateEvidenceIndexContext({
    context: index.context,
    discoveryKind,
    failures,
  });
  const candidateEntries: DiscoveryCandidateEvidenceIndexCandidate[] = [];

  if (!isNonNegativeInteger(candidateCount)) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.candidateCount must be a non-negative integer'
    );
  }

  if (!isSha256Hash(aggregateHash)) {
    failures.push('malformed manifest: candidateEvidenceIndex.aggregateHash must be a sha256 hash');
  }

  if (!Array.isArray(index.candidates)) {
    failures.push('malformed manifest: candidateEvidenceIndex.candidates must be an array');
  } else {
    for (const [candidateIndex, candidate] of index.candidates.entries()) {
      const entry = validateDiscoveryCandidateEvidenceIndexCandidate({
        candidate,
        candidateIndex,
        discoveryKind,
        failures,
      });

      if (entry !== undefined) {
        candidateEntries.push(entry);
      }
    }

    if (isNonNegativeInteger(candidateCount) && candidateCount !== index.candidates.length) {
      failures.push(
        'malformed manifest: candidateEvidenceIndex.candidateCount must match candidates length'
      );
    }
  }

  if (
    context !== undefined &&
    isNonNegativeInteger(candidateCount) &&
    isSha256Hash(aggregateHash) &&
    Array.isArray(index.candidates) &&
    candidateEntries.length === index.candidates.length
  ) {
    const hashData: DiscoveryCandidateEvidenceIndexHashData = {
      candidateCount,
      context,
      candidates: candidateEntries,
    };
    const actualAggregateHash = hashDiscoveryCandidateEvidenceIndex(hashData);

    if (aggregateHash !== actualAggregateHash) {
      failures.push(
        'malformed manifest: candidateEvidenceIndex.aggregateHash must match candidate evidence index metadata'
      );
    }
  }

  if (failures.length !== initialFailureCount) {
    return undefined;
  }

  return {
    candidateCount: candidateCount as number,
    aggregateHash: aggregateHash as string,
    context: context as DiscoveryCandidateEvidenceContext,
    candidates: candidateEntries,
  };
}
function validateDiscoveryCandidateEvidenceIndexContext(options: {
  context: unknown;
  discoveryKind: DiscoveryReportKind;
  failures: string[];
}): DiscoveryCandidateEvidenceContext | undefined {
  const { context, discoveryKind, failures } = options;

  if (!isObjectRecord(context)) {
    failures.push('malformed manifest: candidateEvidenceIndex.context must be an object');
    return undefined;
  }

  validateAllowedKeys(
    context,
    DISCOVERY_CANDIDATE_EVIDENCE_CONTEXT_KEYS_BY_KIND[discoveryKind],
    'candidateEvidenceIndex.context',
    failures
  );

  if (discoveryKind === 'source') {
    return validateDiscoverySourceCandidateEvidenceContext(context, failures);
  }

  if (discoveryKind === 'repo') {
    return validateDiscoveryRepoCandidateEvidenceContext(context, failures);
  }

  return validateDiscoveryWebsiteCandidateEvidenceContext(context, failures);
}
function validateDiscoverySourceCandidateEvidenceContext(
  context: Record<string, unknown>,
  failures: string[]
): DiscoveryCandidateEvidenceContext | undefined {
  const source = context.source;

  if (!isObjectRecord(source)) {
    failures.push('malformed manifest: candidateEvidenceIndex.context.source must be an object');
    return undefined;
  }

  validateAllowedKeys(
    source,
    DISCOVERY_SOURCE_CONTEXT_KEYS,
    'candidateEvidenceIndex.context.source',
    failures
  );

  if (
    !isNonEmptyString(source.input) ||
    !isNonEmptyString(source.resolvedPath) ||
    !isNonEmptyString(source.type)
  ) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.source must include input, resolvedPath, and type strings'
    );
    return undefined;
  }

  return {
    source: {
      input: source.input,
      resolvedPath: source.resolvedPath,
      type: source.type,
    },
  };
}
function validateDiscoveryRepoCandidateEvidenceContext(
  context: Record<string, unknown>,
  failures: string[]
): DiscoveryCandidateEvidenceContext | undefined {
  const repo = context.repo;
  const scope = context.scope;

  if (!isObjectRecord(repo)) {
    failures.push('malformed manifest: candidateEvidenceIndex.context.repo must be an object');
    return undefined;
  }

  if (!isObjectRecord(scope)) {
    failures.push('malformed manifest: candidateEvidenceIndex.context.scope must be an object');
    return undefined;
  }

  validateAllowedKeys(
    repo,
    DISCOVERY_REPO_CONTEXT_KEYS,
    'candidateEvidenceIndex.context.repo',
    failures
  );
  validateAllowedKeys(
    scope,
    DISCOVERY_REPO_SCOPE_CONTEXT_KEYS,
    'candidateEvidenceIndex.context.scope',
    failures
  );

  if (!isNonEmptyString(repo.input) || !isNonEmptyString(repo.normalizedInput)) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.repo must include input and normalizedInput strings'
    );
    return undefined;
  }

  if (repo.commit !== null && !isNonEmptyString(repo.commit)) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.repo.commit must be a string or null'
    );
    return undefined;
  }

  if (repo.dirty !== null && typeof repo.dirty !== 'boolean') {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.repo.dirty must be a boolean or null'
    );
    return undefined;
  }

  if (
    !isNonEmptyString(scope.input) ||
    !isNonEmptyString(scope.path) ||
    !isNonEmptyString(scope.resolvedPath) ||
    !isNonEmptyString(scope.type)
  ) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.scope must include input, path, resolvedPath, and type strings'
    );
    return undefined;
  }

  return {
    repo: {
      input: repo.input,
      normalizedInput: repo.normalizedInput,
      commit: repo.commit,
      dirty: repo.dirty,
    },
    scope: {
      input: scope.input,
      path: scope.path,
      resolvedPath: scope.resolvedPath,
      type: scope.type,
    },
  };
}
function validateDiscoveryWebsiteCandidateEvidenceContext(
  context: Record<string, unknown>,
  failures: string[]
): DiscoveryCandidateEvidenceContext | undefined {
  const website = context.website;
  const crawlPolicy = context.crawlPolicy;
  const resourceFreshness = context.resourceFreshness;

  if (!isObjectRecord(website)) {
    failures.push('malformed manifest: candidateEvidenceIndex.context.website must be an object');
    return undefined;
  }

  if (!isObjectRecord(crawlPolicy)) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.crawlPolicy must be an object'
    );
    return undefined;
  }

  validateAllowedKeys(
    website,
    DISCOVERY_WEBSITE_CONTEXT_KEYS,
    'candidateEvidenceIndex.context.website',
    failures
  );
  validateAllowedKeys(
    crawlPolicy,
    DISCOVERY_WEBSITE_CRAWL_POLICY_CONTEXT_KEYS,
    'candidateEvidenceIndex.context.crawlPolicy',
    failures
  );
  const resourceFreshnessEntries = validateDiscoveryWebsiteResourceFreshnessIndex(
    resourceFreshness,
    'candidateEvidenceIndex.context.resourceFreshness',
    failures
  );

  if (
    !isNonEmptyString(website.input) ||
    !isNonEmptyString(website.normalizedUrl) ||
    !isNonEmptyString(website.origin)
  ) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.website must include input, normalizedUrl, and origin strings'
    );
    return undefined;
  }

  if (crawlPolicy.linkedCandidateFetches !== false) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.crawlPolicy.linkedCandidateFetches must be false'
    );
    return undefined;
  }

  if (crawlPolicy.renderedJavaScript !== false) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.crawlPolicy.renderedJavaScript must be false'
    );
    return undefined;
  }

  if (
    !isNonNegativeInteger(crawlPolicy.inspectedResourceCount) ||
    !isNonNegativeInteger(crawlPolicy.sameOriginWellKnownResourceCount)
  ) {
    failures.push(
      'malformed manifest: candidateEvidenceIndex.context.crawlPolicy resource counts must be non-negative integers'
    );
    return undefined;
  }

  if (resourceFreshnessEntries === undefined) {
    return undefined;
  }

  return {
    website: {
      input: website.input,
      normalizedUrl: website.normalizedUrl,
      origin: website.origin,
    },
    crawlPolicy: {
      linkedCandidateFetches: false,
      renderedJavaScript: false,
      inspectedResourceCount: crawlPolicy.inspectedResourceCount,
      sameOriginWellKnownResourceCount: crawlPolicy.sameOriginWellKnownResourceCount,
    },
    resourceFreshness: resourceFreshnessEntries,
  };
}
function validateDiscoveryWebsiteResourceFreshnessIndex(
  value: unknown,
  label: string,
  failures: string[]
): WebsiteResourceFreshnessIndexEntry[] | undefined {
  if (!Array.isArray(value)) {
    failures.push(`malformed manifest: ${label} must be an array`);
    return undefined;
  }

  const entries: WebsiteResourceFreshnessIndexEntry[] = [];

  for (const [index, entry] of value.entries()) {
    const entryLabel = `${label}[${index}]`;

    if (!isObjectRecord(entry)) {
      failures.push(`malformed manifest: ${entryLabel} must be an object`);
      return undefined;
    }

    validateAllowedKeys(entry, DISCOVERY_WEBSITE_RESOURCE_FRESHNESS_KEYS, entryLabel, failures);
    const etag = entry.etag;
    const lastModified = entry.lastModified;
    const normalizedEtag =
      etag === undefined || etag === null ? null : isNonEmptyString(etag) ? etag : undefined;
    const normalizedLastModified =
      lastModified === undefined || lastModified === null
        ? null
        : isNonEmptyString(lastModified)
          ? lastModified
          : undefined;

    if (!isNonEmptyString(entry.url)) {
      failures.push(`malformed manifest: ${entryLabel}.url must be a non-empty string`);
    }

    if (!isNonEmptyString(entry.sourceRole)) {
      failures.push(`malformed manifest: ${entryLabel}.sourceRole must be a non-empty string`);
    }

    if (!isIsoTimestampString(entry.observedAt)) {
      failures.push(`malformed manifest: ${entryLabel}.observedAt must be an ISO timestamp`);
    }

    if (normalizedEtag === undefined) {
      failures.push(`malformed manifest: ${entryLabel}.etag must be a non-empty string or null`);
    }

    if (normalizedLastModified === undefined) {
      failures.push(
        `malformed manifest: ${entryLabel}.lastModified must be a non-empty string or null`
      );
    }

    if (
      !isNonEmptyString(entry.url) ||
      !isNonEmptyString(entry.sourceRole) ||
      !isIsoTimestampString(entry.observedAt) ||
      normalizedEtag === undefined ||
      normalizedLastModified === undefined
    ) {
      return undefined;
    }

    entries.push({
      url: entry.url,
      sourceRole: entry.sourceRole,
      observedAt: entry.observedAt,
      etag: normalizedEtag,
      lastModified: normalizedLastModified,
    });
  }

  return entries;
}
function validateDiscoveryCandidateEvidenceIndexCandidate(options: {
  candidate: unknown;
  candidateIndex: number;
  discoveryKind: DiscoveryReportKind;
  failures: string[];
}): DiscoveryCandidateEvidenceIndexCandidate | undefined {
  const { candidate, candidateIndex, discoveryKind, failures } = options;
  const label = `candidateEvidenceIndex.candidates[${candidateIndex}]`;

  if (!isObjectRecord(candidate)) {
    failures.push(`malformed manifest: ${label} must be an object`);
    return undefined;
  }

  const allowedKeys =
    discoveryKind === 'url'
      ? DISCOVERY_URL_CANDIDATE_EVIDENCE_INDEX_CANDIDATE_KEYS
      : DISCOVERY_PATH_CANDIDATE_EVIDENCE_INDEX_CANDIDATE_KEYS;

  validateAllowedKeys(candidate, allowedKeys, label, failures);

  const order = candidate.order;
  const evidence = validateDiscoveryCandidateEvidenceIndexEvidence(
    candidate.evidence,
    label,
    failures
  );

  if (!isPositiveInteger(order)) {
    failures.push(`malformed manifest: ${label}.order must be a positive integer`);
  } else if (order !== candidateIndex + 1) {
    failures.push(`malformed manifest: ${label}.order must match candidate index order`);
  }

  if (discoveryKind === 'url') {
    return validateDiscoveryUrlCandidateEvidenceIndexCandidate({
      candidate,
      label,
      order,
      evidence,
      failures,
    });
  }

  return validateDiscoveryPathCandidateEvidenceIndexCandidate({
    candidate,
    label,
    order,
    evidence,
    failures,
  });
}
function validateDiscoveryPathCandidateEvidenceIndexCandidate(options: {
  candidate: Record<string, unknown>;
  label: string;
  order: unknown;
  evidence: DiscoveryCandidateEvidenceIndexCandidate['evidence'] | undefined;
  failures: string[];
}): DiscoveryCandidateEvidenceIndexCandidate | undefined {
  const { candidate, label, order, evidence, failures } = options;
  const hints = validateOptionalStringArray(candidate.hints, `${label}.hints`, failures);
  const formatHints = validateOptionalStringArray(
    candidate.formatHints,
    `${label}.formatHints`,
    failures
  );

  if (!isNonEmptyString(candidate.path)) {
    failures.push(`malformed manifest: ${label}.path must be a non-empty string`);
  }

  if (!isNonEmptyString(candidate.kind)) {
    failures.push(`malformed manifest: ${label}.kind must be a non-empty string`);
  }

  if (!isNonEmptyString(candidate.format)) {
    failures.push(`malformed manifest: ${label}.format must be a non-empty string`);
  }

  if (!isNonNegativeInteger(candidate.byteSize)) {
    failures.push(`malformed manifest: ${label}.byteSize must be a non-negative integer`);
  }

  if (!isUnprefixedSha256Hash(candidate.sha256)) {
    failures.push(`malformed manifest: ${label}.sha256 must be a sha256 hex digest`);
  }

  if (
    !isPositiveInteger(order) ||
    !isNonEmptyString(candidate.path) ||
    !isNonEmptyString(candidate.kind) ||
    !isNonEmptyString(candidate.format) ||
    !isNonNegativeInteger(candidate.byteSize) ||
    !isUnprefixedSha256Hash(candidate.sha256) ||
    evidence === undefined ||
    hints === undefined ||
    formatHints === undefined
  ) {
    return undefined;
  }

  const entry: DiscoveryCandidateEvidenceIndexCandidate = {
    path: candidate.path,
    order,
    kind: candidate.kind,
    format: candidate.format,
    evidence,
    byteSize: candidate.byteSize,
    sha256: candidate.sha256,
  };

  if (hints.length > 0) {
    entry.hints = hints;
  }

  if (formatHints.length > 0) {
    entry.formatHints = formatHints;
  }

  return entry;
}
function validateDiscoveryUrlCandidateEvidenceIndexCandidate(options: {
  candidate: Record<string, unknown>;
  label: string;
  order: unknown;
  evidence: DiscoveryCandidateEvidenceIndexCandidate['evidence'] | undefined;
  failures: string[];
}): DiscoveryCandidateEvidenceIndexCandidate | undefined {
  const { candidate, label, order, evidence, failures } = options;
  const sourceResources = validateOptionalCandidateSourceResources(
    candidate.sourceResources,
    `${label}.sourceResources`,
    failures
  );

  if (!isNonEmptyString(candidate.url)) {
    failures.push(`malformed manifest: ${label}.url must be a non-empty string`);
  }

  if (typeof candidate.sameOrigin !== 'boolean') {
    failures.push(`malformed manifest: ${label}.sameOrigin must be a boolean`);
  }

  if (typeof candidate.external !== 'boolean') {
    failures.push(`malformed manifest: ${label}.external must be a boolean`);
  }

  if (
    !isPositiveInteger(order) ||
    !isNonEmptyString(candidate.url) ||
    typeof candidate.sameOrigin !== 'boolean' ||
    typeof candidate.external !== 'boolean' ||
    evidence === undefined ||
    sourceResources === undefined
  ) {
    return undefined;
  }

  const entry: DiscoveryCandidateEvidenceIndexCandidate = {
    url: candidate.url,
    order,
    evidence,
    sameOrigin: candidate.sameOrigin,
    external: candidate.external,
  };

  if (sourceResources.length > 0) {
    entry.sourceResources = sourceResources;
  }

  return entry;
}
function validateDiscoveryCandidateEvidenceIndexEvidence(
  evidence: unknown,
  label: string,
  failures: string[]
): DiscoveryCandidateEvidenceIndexCandidate['evidence'] | undefined {
  if (!isObjectRecord(evidence)) {
    failures.push(`malformed manifest: ${label}.evidence must be an object`);
    return undefined;
  }

  validateAllowedKeys(evidence, DISCOVERY_CANDIDATE_EVIDENCE_KEYS, `${label}.evidence`, failures);

  const category = evidence.category;
  const signals = validateOptionalStringArray(
    evidence.signals,
    `${label}.evidence.signals`,
    failures
  );
  const relations = validateOptionalStringArray(
    evidence.relations,
    `${label}.evidence.relations`,
    failures
  );
  const flags = validateOptionalStringArray(evidence.flags, `${label}.evidence.flags`, failures);

  if ('category' in evidence && !isNonEmptyString(category)) {
    failures.push(`malformed manifest: ${label}.evidence.category must be a non-empty string`);
  }

  if (signals === undefined || relations === undefined || flags === undefined) {
    return undefined;
  }

  const entry: DiscoveryCandidateEvidenceIndexCandidate['evidence'] = {};

  if (isNonEmptyString(category)) {
    entry.category = category;
  }

  if ('signals' in evidence) {
    entry.signals = signals;
  }

  if ('relations' in evidence) {
    entry.relations = relations;
  }

  if ('flags' in evidence) {
    entry.flags = flags;
  }

  return entry;
}
function validateOptionalCandidateSourceResources(
  value: unknown,
  label: string,
  failures: string[]
): NonNullable<DiscoveryCandidateEvidenceIndexCandidate['sourceResources']> | undefined {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    failures.push(`malformed manifest: ${label} must be an array when present`);
    return undefined;
  }

  const resources: NonNullable<DiscoveryCandidateEvidenceIndexCandidate['sourceResources']> = [];

  for (const [index, resource] of value.entries()) {
    const resourceLabel = `${label}[${index}]`;

    if (!isObjectRecord(resource)) {
      failures.push(`malformed manifest: ${resourceLabel} must be an object`);
      return undefined;
    }

    validateAllowedKeys(
      resource,
      DISCOVERY_CANDIDATE_SOURCE_RESOURCE_KEYS,
      resourceLabel,
      failures
    );

    if (
      !isNonEmptyString(resource.url) ||
      !isNonEmptyString(resource.sourceRole) ||
      !isNonEmptyString(resource.evidence)
    ) {
      failures.push(
        `malformed manifest: ${resourceLabel} must include url, sourceRole, and evidence strings`
      );
      return undefined;
    }

    resources.push({
      url: resource.url,
      sourceRole: resource.sourceRole,
      evidence: resource.evidence,
    });
  }

  return resources;
}
function verifyDiscoveryCandidateEvidenceIndexAgainstReport(options: {
  discoveryKind: DiscoveryReportKind;
  report: Record<string, unknown>;
  manifestIndex: DiscoveryCandidateEvidenceIndex;
  failures: string[];
}): void {
  let reportIndex: DiscoveryCandidateEvidenceIndex;

  try {
    reportIndex = buildDiscoveryCandidateEvidenceIndex(options.discoveryKind, options.report);
  } catch (error) {
    options.failures.push(
      `discovery candidate evidence index: could not rebuild from discovery-report.json: ${errorMessage(error)}`
    );
    return;
  }

  if (!discoveryCandidateEvidenceIndexesEqual(options.manifestIndex, reportIndex)) {
    options.failures.push(
      'discovery candidate evidence index: manifest metadata does not match discovery-report.json'
    );
  }
}
