/**
 * Discovery candidate evidence index types, builders, content-free hasher,
 * and equality check shared by the discovery writer and verifier.
 */

import { isNonEmptyString, isObjectRecord } from '../../utils/guards.js';
import { sha256Prefixed } from '../../utils/hash.js';
import { DISCOVERY_REPORT_MODE_BY_KIND, DISCOVERY_REPORT_SCHEMA_VERSION } from './constants.js';
import type { DiscoveryReportKind } from './constants.js';
import {
  optionalBooleanOrNullField,
  optionalStringArrayField,
  optionalStringOrNullField,
  requireStringArray,
  requiredBooleanField,
  requiredFalseField,
  requiredNonNegativeIntegerField,
  requiredObjectField,
  requiredPositiveIntegerField,
  requiredStringField,
  requiredUnprefixedSha256Field,
} from './field-validators.js';

const DISCOVERY_CANDIDATE_EVIDENCE_INDEX_HASH_SEED =
  'llm-docs-generator:discovery-candidate-evidence-index:v1\n';

export interface DiscoveryCandidateEvidenceIndex {
  candidateCount: number;
  aggregateHash: string;
  context: DiscoveryCandidateEvidenceContext;
  candidates: DiscoveryCandidateEvidenceIndexCandidate[];
}

export type DiscoveryCandidateEvidenceContext =
  | {
      source: {
        input: string;
        resolvedPath: string;
        type: string;
      };
    }
  | {
      repo: {
        input: string;
        normalizedInput: string;
        commit: string | null;
        dirty: boolean | null;
      };
      scope: {
        input: string;
        path: string;
        resolvedPath: string;
        type: string;
      };
    }
  | {
      website: {
        input: string;
        normalizedUrl: string;
        origin: string;
      };
      crawlPolicy: {
        linkedCandidateFetches: false;
        renderedJavaScript: false;
        inspectedResourceCount: number;
        sameOriginWellKnownResourceCount: number;
      };
      resourceFreshness: WebsiteResourceFreshnessIndexEntry[];
    };

export interface DiscoveryCandidateEvidenceIndexCandidate {
  path?: string;
  url?: string;
  order: number;
  kind?: string;
  format?: string;
  hints?: string[];
  formatHints?: string[];
  evidence: {
    category?: string;
    signals?: string[];
    relations?: string[];
    flags?: string[];
  };
  byteSize?: number;
  sha256?: string;
  sameOrigin?: boolean;
  external?: boolean;
  sourceResources?: Array<{
    url: string;
    sourceRole: string;
    evidence: string;
  }>;
}

export type DiscoveryCandidateEvidenceIndexHashData = Omit<
  DiscoveryCandidateEvidenceIndex,
  'aggregateHash'
>;

export interface WebsiteResourceFreshnessIndexEntry {
  url: string;
  sourceRole: string;
  observedAt: string;
  etag: string | null;
  lastModified: string | null;
}

interface DiscoveryReportSummary {
  schemaVersion: string;
  mode: string;
  candidateCount: number;
  warningCount: number;
  urlResourceCount?: number;
}

export function summarizeDiscoveryReport(
  discoveryKind: DiscoveryReportKind,
  report: unknown
): DiscoveryReportSummary {
  if (!isObjectRecord(report)) {
    throw new Error('discovery report must be an object before writing manifest');
  }

  const expectedMode = DISCOVERY_REPORT_MODE_BY_KIND[discoveryKind];
  const candidates = report.candidates;
  const warnings = report.warnings;

  if (report.schemaVersion !== DISCOVERY_REPORT_SCHEMA_VERSION) {
    throw new Error(
      `discovery report schemaVersion must be ${DISCOVERY_REPORT_SCHEMA_VERSION} before writing manifest`
    );
  }

  if (report.mode !== expectedMode) {
    throw new Error(`discovery report mode must be ${expectedMode} before writing manifest`);
  }

  if (!Array.isArray(candidates)) {
    throw new Error('discovery report candidates must be an array before writing manifest');
  }

  if (!Array.isArray(warnings)) {
    throw new Error('discovery report warnings must be an array before writing manifest');
  }

  if (discoveryKind === 'url') {
    const inspectedResources = report.inspectedResources;

    if (!Array.isArray(inspectedResources)) {
      throw new Error(
        'website discovery report inspectedResources must be an array before writing manifest'
      );
    }

    return {
      schemaVersion: DISCOVERY_REPORT_SCHEMA_VERSION,
      mode: expectedMode,
      candidateCount: candidates.length,
      warningCount: warnings.length,
      urlResourceCount: inspectedResources.length,
    };
  }

  return {
    schemaVersion: DISCOVERY_REPORT_SCHEMA_VERSION,
    mode: expectedMode,
    candidateCount: candidates.length,
    warningCount: warnings.length,
  };
}

export function buildDiscoveryCandidateEvidenceIndex(
  discoveryKind: DiscoveryReportKind,
  report: unknown
): DiscoveryCandidateEvidenceIndex {
  if (!isObjectRecord(report)) {
    throw new Error('discovery report must be an object before writing candidate evidence index');
  }

  const candidates = report.candidates;

  if (!Array.isArray(candidates)) {
    throw new Error(
      'discovery report candidates must be an array before writing candidate evidence index'
    );
  }

  const context = buildDiscoveryCandidateEvidenceContext(discoveryKind, report);
  const candidateEntries = candidates.map((candidate, index) =>
    buildDiscoveryCandidateEvidenceIndexCandidate(discoveryKind, candidate, index)
  );
  const hashData: DiscoveryCandidateEvidenceIndexHashData = {
    candidateCount: candidateEntries.length,
    context,
    candidates: candidateEntries,
  };

  return {
    candidateCount: hashData.candidateCount,
    aggregateHash: hashDiscoveryCandidateEvidenceIndex(hashData),
    context: hashData.context,
    candidates: hashData.candidates,
  };
}
function buildDiscoveryCandidateEvidenceContext(
  discoveryKind: DiscoveryReportKind,
  report: Record<string, unknown>
): DiscoveryCandidateEvidenceContext {
  if (discoveryKind === 'source') {
    const source = requiredObjectField(report, 'source', 'discovery report source');

    return {
      source: {
        input: requiredStringField(source, 'input', 'discovery report source'),
        resolvedPath: requiredStringField(source, 'resolvedPath', 'discovery report source'),
        type: requiredStringField(source, 'type', 'discovery report source'),
      },
    };
  }

  if (discoveryKind === 'repo') {
    const repo = requiredObjectField(report, 'repo', 'discovery report repo');
    const repoGit = requiredObjectField(repo, 'git', 'discovery report repo.git');
    const scope = requiredObjectField(report, 'scope', 'discovery report scope');

    return {
      repo: {
        input: requiredStringField(repo, 'input', 'discovery report repo'),
        normalizedInput: requiredStringField(repo, 'normalizedInput', 'discovery report repo'),
        commit: optionalStringOrNullField(repoGit, 'commit', 'discovery report repo.git'),
        dirty: optionalBooleanOrNullField(repoGit, 'dirty', 'discovery report repo.git'),
      },
      scope: {
        input: requiredStringField(scope, 'input', 'discovery report scope'),
        path: requiredStringField(scope, 'path', 'discovery report scope'),
        resolvedPath: requiredStringField(scope, 'resolvedPath', 'discovery report scope'),
        type: requiredStringField(scope, 'type', 'discovery report scope'),
      },
    };
  }

  const website = requiredObjectField(report, 'website', 'discovery report website');
  const crawlPolicy = requiredObjectField(report, 'crawlPolicy', 'discovery report crawlPolicy');
  const inspectedResources = report.inspectedResources;
  const sameOriginWellKnownResources = crawlPolicy.sameOriginWellKnownResources;

  if (!Array.isArray(inspectedResources)) {
    throw new Error(
      'discovery report inspectedResources must be an array before writing candidate evidence index'
    );
  }

  if (!Array.isArray(sameOriginWellKnownResources)) {
    throw new Error(
      'discovery report crawlPolicy.sameOriginWellKnownResources must be an array before writing candidate evidence index'
    );
  }

  const resourceFreshness = inspectedResources.map((resource, index) =>
    buildDiscoveryWebsiteResourceFreshnessIndexEntry(resource, index)
  );

  return {
    website: {
      input: requiredStringField(website, 'input', 'discovery report website'),
      normalizedUrl: requiredStringField(website, 'normalizedUrl', 'discovery report website'),
      origin: requiredStringField(website, 'origin', 'discovery report website'),
    },
    crawlPolicy: {
      linkedCandidateFetches: requiredFalseField(
        crawlPolicy,
        'linkedCandidateFetches',
        'discovery report crawlPolicy'
      ),
      renderedJavaScript: requiredFalseField(
        crawlPolicy,
        'renderedJavaScript',
        'discovery report crawlPolicy'
      ),
      inspectedResourceCount: inspectedResources.length,
      sameOriginWellKnownResourceCount: sameOriginWellKnownResources.length,
    },
    resourceFreshness,
  };
}
function buildDiscoveryWebsiteResourceFreshnessIndexEntry(
  resource: unknown,
  resourceIndex: number
): WebsiteResourceFreshnessIndexEntry {
  if (!isObjectRecord(resource)) {
    throw new Error(
      `discovery report inspectedResources[${resourceIndex}] must be an object before writing candidate evidence index`
    );
  }

  const resourceLabel = `discovery report inspectedResources[${resourceIndex}]`;
  const freshness = requiredObjectField(resource, 'freshness', resourceLabel);
  const freshnessLabel = `${resourceLabel}.freshness`;

  return {
    url: requiredStringField(resource, 'url', resourceLabel),
    sourceRole: requiredStringField(resource, 'sourceRole', resourceLabel),
    observedAt: requiredStringField(freshness, 'observedAt', freshnessLabel),
    etag: optionalStringOrNullField(freshness, 'etag', freshnessLabel),
    lastModified: optionalStringOrNullField(freshness, 'lastModified', freshnessLabel),
  };
}
function buildDiscoveryCandidateEvidenceIndexCandidate(
  discoveryKind: DiscoveryReportKind,
  candidate: unknown,
  index: number
): DiscoveryCandidateEvidenceIndexCandidate {
  if (!isObjectRecord(candidate)) {
    throw new Error(
      `discovery report candidates[${index}] must be an object before writing candidate evidence index`
    );
  }

  const order = requiredPositiveIntegerField(
    candidate,
    'order',
    `discovery report candidates[${index}]`
  );
  const evidence = buildDiscoveryCandidateEvidence(candidate.evidence, index);

  if (discoveryKind === 'url') {
    const entry: DiscoveryCandidateEvidenceIndexCandidate = {
      url: requiredStringField(candidate, 'url', `discovery report candidates[${index}]`),
      order,
      evidence,
      sameOrigin: requiredBooleanField(
        candidate,
        'sameOrigin',
        `discovery report candidates[${index}]`
      ),
      external: requiredBooleanField(
        candidate,
        'external',
        `discovery report candidates[${index}]`
      ),
    };

    if (Array.isArray(candidate.sourceResources) && candidate.sourceResources.length > 0) {
      entry.sourceResources = candidate.sourceResources.map((sourceResource, sourceIndex) =>
        buildDiscoveryCandidateSourceResource(sourceResource, index, sourceIndex)
      );
    }

    return entry;
  }

  const hints = optionalStringArrayField(
    candidate,
    'hints',
    `discovery report candidates[${index}]`
  );
  const formatHints = optionalStringArrayField(
    candidate,
    'formatHints',
    `discovery report candidates[${index}]`
  );
  const entry: DiscoveryCandidateEvidenceIndexCandidate = {
    path: requiredStringField(candidate, 'path', `discovery report candidates[${index}]`),
    order,
    kind: requiredStringField(candidate, 'kind', `discovery report candidates[${index}]`),
    format: requiredStringField(candidate, 'format', `discovery report candidates[${index}]`),
    evidence,
    byteSize: requiredNonNegativeIntegerField(
      candidate,
      'byteSize',
      `discovery report candidates[${index}]`
    ),
    sha256: requiredUnprefixedSha256Field(
      candidate,
      'sha256',
      `discovery report candidates[${index}]`
    ),
  };

  if (hints.length > 0) {
    entry.hints = hints;
  }

  if (formatHints.length > 0) {
    entry.formatHints = formatHints;
  }

  return entry;
}
function buildDiscoveryCandidateEvidence(
  evidence: unknown,
  candidateIndex: number
): DiscoveryCandidateEvidenceIndexCandidate['evidence'] {
  if (!isObjectRecord(evidence)) {
    throw new Error(
      `discovery report candidates[${candidateIndex}].evidence must be an object before writing candidate evidence index`
    );
  }

  const entry: DiscoveryCandidateEvidenceIndexCandidate['evidence'] = {};
  const category = evidence.category;
  const signals = evidence.signals;
  const relations = evidence.relations;
  const flags = evidence.flags;

  if (isNonEmptyString(category)) {
    entry.category = category;
  }

  if (Array.isArray(signals)) {
    entry.signals = requireStringArray(
      signals,
      `discovery report candidates[${candidateIndex}].evidence.signals`
    );
  }

  if (Array.isArray(relations)) {
    entry.relations = requireStringArray(
      relations,
      `discovery report candidates[${candidateIndex}].evidence.relations`
    );
  }

  if (Array.isArray(flags)) {
    entry.flags = requireStringArray(
      flags,
      `discovery report candidates[${candidateIndex}].evidence.flags`
    );
  }

  return entry;
}
function buildDiscoveryCandidateSourceResource(
  sourceResource: unknown,
  candidateIndex: number,
  sourceIndex: number
): NonNullable<DiscoveryCandidateEvidenceIndexCandidate['sourceResources']>[number] {
  if (!isObjectRecord(sourceResource)) {
    throw new Error(
      `discovery report candidates[${candidateIndex}].sourceResources[${sourceIndex}] must be an object before writing candidate evidence index`
    );
  }

  const label = `discovery report candidates[${candidateIndex}].sourceResources[${sourceIndex}]`;

  return {
    url: requiredStringField(sourceResource, 'url', label),
    sourceRole: requiredStringField(sourceResource, 'sourceRole', label),
    evidence: requiredStringField(sourceResource, 'evidence', label),
  };
}

export function hashDiscoveryCandidateEvidenceIndex(
  index: DiscoveryCandidateEvidenceIndexHashData
): string {
  return sha256Prefixed(
    `${DISCOVERY_CANDIDATE_EVIDENCE_INDEX_HASH_SEED}${JSON.stringify(index)}\n`
  );
}

export function discoveryCandidateEvidenceIndexesEqual(
  expected: DiscoveryCandidateEvidenceIndex,
  actual: DiscoveryCandidateEvidenceIndex
): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
}
