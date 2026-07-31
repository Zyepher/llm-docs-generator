/**
 * Shared manifest constants, mode tables, and key sets.
 */

export const MANIFEST_SCHEMA_VERSION = '0.1.0';
export const CONFIGURED_SDK_MODE = 'configured-sdk';
export const DISCOVERY_REPORT_MODE = 'discovery-report';
export const SOURCE_DOCS_MODE = 'local-source-docs';
export const SOURCE_TRUTH_DOCS_MODE = 'source-truth-local-docs';
export const CONFIGURED_SDK_GENERATED_OUTPUT_KINDS: ReadonlySet<string> =
  new Set<GeneratedOutputKind>(['parsed-spec-json', 'llm-docs']);
export const DISCOVERY_REPORT_SCHEMA_VERSION = '0.2.0';
export const DISCOVERY_REPORT_OUTPUT_KIND = 'discovery-report';
export const DISCOVERY_REPORT_GENERATED_OUTPUT_KINDS = new Set([DISCOVERY_REPORT_OUTPUT_KIND]);

export const DISCOVERY_CANDIDATE_EVIDENCE_INDEX_KEYS = new Set([
  'candidateCount',
  'aggregateHash',
  'context',
  'candidates',
]);
export const DISCOVERY_CANDIDATE_EVIDENCE_CONTEXT_KEYS_BY_KIND: Record<
  DiscoveryReportKind,
  ReadonlySet<string>
> = {
  source: new Set(['source']),
  repo: new Set(['repo', 'scope']),
  url: new Set(['website', 'crawlPolicy', 'resourceFreshness']),
};
export const DISCOVERY_SOURCE_CONTEXT_KEYS = new Set(['input', 'resolvedPath', 'type']);
export const DISCOVERY_REPO_CONTEXT_KEYS = new Set(['input', 'normalizedInput', 'commit', 'dirty']);
export const DISCOVERY_REPO_SCOPE_CONTEXT_KEYS = new Set(['input', 'path', 'resolvedPath', 'type']);
export const DISCOVERY_WEBSITE_CONTEXT_KEYS = new Set(['input', 'normalizedUrl', 'origin']);
export const DISCOVERY_WEBSITE_CRAWL_POLICY_CONTEXT_KEYS = new Set([
  'linkedCandidateFetches',
  'renderedJavaScript',
  'inspectedResourceCount',
  'sameOriginWellKnownResourceCount',
]);
export const DISCOVERY_WEBSITE_RESOURCE_FRESHNESS_KEYS = new Set([
  'url',
  'sourceRole',
  'observedAt',
  'etag',
  'lastModified',
]);
export const DISCOVERY_PATH_CANDIDATE_EVIDENCE_INDEX_CANDIDATE_KEYS = new Set([
  'path',
  'order',
  'kind',
  'format',
  'hints',
  'formatHints',
  'evidence',
  'byteSize',
  'sha256',
]);
export const DISCOVERY_URL_CANDIDATE_EVIDENCE_INDEX_CANDIDATE_KEYS = new Set([
  'url',
  'order',
  'evidence',
  'sameOrigin',
  'external',
  'sourceResources',
]);
export const DISCOVERY_CANDIDATE_EVIDENCE_KEYS = new Set([
  'category',
  'signals',
  'relations',
  'flags',
]);
export const DISCOVERY_CANDIDATE_SOURCE_RESOURCE_KEYS = new Set(['url', 'sourceRole', 'evidence']);
export const SOURCE_TRUTH_REPORT_SCHEMA_VERSION = '0.1.0';
export const SOURCE_TRUTH_INSPECTION_MODE = 'source-truth-local-evidence';
export const SOURCE_TRUTH_REPORT_OUTPUT_KIND = 'source-truth-report-json';
export const SOURCE_TRUTH_MARKDOWN_OUTPUT_KIND = 'source-truth-markdown';
export const SOURCE_TRUTH_GENERATED_OUTPUT_KINDS = new Set([
  SOURCE_TRUTH_REPORT_OUTPUT_KIND,
  SOURCE_TRUTH_MARKDOWN_OUTPUT_KIND,
]);
export const SOURCE_VERIFICATION_MODE = 'source-verification-local-evidence';
export const SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION = '0.1.0';
export const SOURCE_VERIFICATION_REPORT_OUTPUT_KIND = 'source-verification-report-json';
export const SOURCE_VERIFICATION_GENERATED_OUTPUT_KINDS = new Set([
  SOURCE_VERIFICATION_REPORT_OUTPUT_KIND,
]);
export const SOURCE_VERIFICATION_SUMMARY_FIELDS = [
  'sourceFileCount',
  'sourceExportFactCount',
  'observedExportedNameCount',
  'docsFileCount',
  'docsReferenceCount',
  'exactMatchCount',
  'unmatchedReferenceCount',
  'warningCount',
] as const;
export const DISCOVERY_REPORT_MODE_BY_KIND = {
  source: 'local-bounded-inspection',
  repo: 'repo-bounded-inspection',
  url: 'website-bounded-inspection',
} as const;
export const SOURCE_DOCS_GENERATED_OUTPUT_KINDS = new Set(['llm-docs', 'semantic-chunks-jsonl']);
export const SOURCE_DOCS_SEMANTIC_CHUNK_JSONL_KIND = 'semantic-chunks-jsonl';
export const CONFIGURED_SDK_PARSER_NAME = 'OpenRefParser';
export const CONFIGURED_SDK_PARSER_FORMAT = 'openref-0.1';
export const CONFIGURED_SDK_FORMATTER_NAME = 'LLMFormatter';
export const CONFIGURED_SDK_FORMATTER_FORMAT = 'legacy-llm-docs';
export const SOURCE_DOCS_FORMATTER_NAME = 'UniversalFormatter';
export const SOURCE_DOCS_FORMATTER_FORMAT = 'universal-llm-docs';
export const SOURCE_DOCS_SOURCE_TYPES = new Set(['file', 'directory']);
export const SOURCE_DOCS_FORMAT_HINTS = new Set([
  'auto',
  'markdown',
  'mdx',
  'openapi',
  'openref',
  'rst',
  'html',
]);
export const SOURCE_DOCS_RESOLVED_FORMATS = new Set([
  'markdown',
  'openapi',
  'openref',
  'rst',
  'html',
]);
export const SOURCE_DOCS_PLUGIN_FORMAT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const SOURCE_DOCS_SEMANTIC_CHUNK_INDEX_KEYS = new Set([
  'path',
  'format',
  'chunkCount',
  'aggregateHash',
  'warningCount',
  'chunks',
]);
export const SOURCE_DOCS_SEMANTIC_CHUNK_INDEX_CHUNK_KEYS = new Set([
  'id',
  'order',
  'title',
  'path',
  'nodePath',
  'contentHash',
  'characterCount',
  'estimatedTokenCount',
  'sourceFormat',
  'sourcePath',
  'sourceLines',
  'warningCount',
]);
export const SOURCE_DOCS_SWIFT_BOOK_PRESET_NAME = 'swift-book';
export const SOURCE_DOCS_SWIFT_BOOK_PRESET_METADATA = {
  sourceSelection: 'explicit-local-source-required',
  sourceVerification: 'not-performed',
  sourceTruthClaim: 'not-claimed',
} as const;
export const SOURCE_DOCS_SWIFT_BOOK_PRESET_LIMITATIONS = [
  'Requires an explicit local --source path.',
  'Does not select or infer source paths.',
  'Does not clone repositories or refresh caches.',
  'Does not perform source-code verification.',
  'Does not claim source truth.',
] as const;

export const MANIFEST_CONTRACT_SCHEMA = 'llm-docs-generator.manifest-contract.v1';
export const MANIFEST_CONTRACT_KEYS = new Set([
  'schema',
  'manifestMode',
  'artifactRole',
  'cliGuarantees',
  'agentResponsibilities',
  'unsupportedAutomation',
]);
export const MANIFEST_CONTRACT_ARTIFACT_ROLES = new Set([
  'generated-docs',
  'candidate-evidence-report',
  'local-source-evidence-report',
]);
export const MANIFEST_CONTRACT_BY_MODE = {
  [CONFIGURED_SDK_MODE]: {
    artifactRole: 'generated-docs',
    cliGuarantees: [
      'Writes docs from one configured SDK manifest entry using recorded parser and formatter metadata.',
      'Records deterministic file metadata for the explicit local spec and generated outputs.',
    ],
    agentResponsibilities: [
      'Choose the SDK version and decide whether generated docs fit the user task.',
      'Determine source authority and freshness outside this manifest.',
    ],
    unsupportedAutomation: [
      'No discovery report consumption or candidate selection.',
      'No source-code behavior validation or remote freshness proof.',
    ],
  },
  [SOURCE_DOCS_MODE]: {
    artifactRole: 'generated-docs',
    cliGuarantees: [
      'Writes docs from one explicit local source path using the selected parser and formatter.',
      'Records deterministic file metadata for source files and generated outputs.',
    ],
    agentResponsibilities: [
      'Choose the source path and decide whether generated docs fit the user task.',
      'Determine source authority, source truth, and freshness outside this manifest.',
    ],
    unsupportedAutomation: [
      'No automatic source selection or discovery report consumption.',
      'No source-code behavior validation, broad crawling, or remote freshness proof.',
    ],
  },
  [SOURCE_TRUTH_DOCS_MODE]: {
    artifactRole: 'local-source-evidence-report',
    cliGuarantees: [
      'Writes local evidence reports from one explicit local source inspection.',
      'Records deterministic file metadata for reported source files and generated outputs.',
    ],
    agentResponsibilities: [
      'Decide whether observed evidence is relevant to the user task.',
      'Use evidence as local observations, not source truth proof.',
    ],
    unsupportedAutomation: [
      'No runtime inference or test execution.',
      'No broad docs claim verification, source selection, or freshness proof.',
    ],
  },
  [DISCOVERY_REPORT_MODE]: {
    artifactRole: 'candidate-evidence-report',
    cliGuarantees: [
      'Writes deterministic candidate evidence for agent review only from the explicit discovery input.',
      'Records content-free candidate evidence index metadata derived from discovery-report.json.',
    ],
    agentResponsibilities: [
      'Review candidates and explicitly choose any source used for generation.',
      'Decide source authority, source truth, freshness, and task fit outside this manifest.',
    ],
    unsupportedAutomation: [
      'No authoritative source selection, candidate scoring, or candidate consumption.',
      'No docs generation, broad crawling, behavior verification, or remote freshness proof.',
    ],
  },
  [SOURCE_VERIFICATION_MODE]: {
    artifactRole: 'local-source-evidence-report',
    cliGuarantees: [
      'Writes local lexical source/docs evidence from explicit local source and docs paths.',
      'Records deterministic report metadata and content-free source/docs file evidence indexes.',
    ],
    agentResponsibilities: [
      'Decide whether lexical matches and unmatched references matter for the user task.',
      'Treat evidence as local observations, not source truth proof or docs correctness proof.',
    ],
    unsupportedAutomation: [
      'No broad docs claim verification or source-code runtime validation.',
      'No source selection, freshness proof, crawling, or network work.',
    ],
  },
} as const;

export type ManifestContractMode = keyof typeof MANIFEST_CONTRACT_BY_MODE;

export const INPUT_PROVENANCE_SCHEMA = 'llm-docs-generator.input-provenance.v1';
export const INPUT_PROVENANCE_INPUT_KINDS = new Set([
  'configured-sdk',
  'built-in-local-source-docs',
  'parser-plugin-local-source-docs',
  'source-truth-local-source',
  'discovery-source-report',
  'discovery-repo-report',
  'discovery-url-report',
  'source-verification-local-evidence',
]);

export const ARTIFACT_SUMMARY_SCHEMA = 'llm-docs-generator.artifact-summary.v1';

export const ARTIFACT_SUMMARY_KEYS = new Set([
  'schema',
  'manifestMode',
  'generatedOutputs',
  'sourceFiles',
  'warnings',
  'indexes',
]);
export const ARTIFACT_SUMMARY_FILE_SECTION_KEYS = new Set([
  'count',
  'kinds',
  'totalByteSize',
  'totalLineCount',
  'totalEstimatedTokenCount',
  'aggregateHash',
]);
export const ARTIFACT_SUMMARY_SOURCE_FILE_SECTION_KEYS = new Set([
  'count',
  'formats',
  'totalByteSize',
  'totalLineCount',
  'totalEstimatedTokenCount',
  'aggregateHash',
]);
export const ARTIFACT_SUMMARY_WARNINGS_KEYS = new Set(['count']);
export const ARTIFACT_SUMMARY_INDEX_KEYS = new Set([
  'semanticChunkIndexCount',
  'semanticChunkCount',
  'candidateEvidenceCandidateCount',
  'sourceVerificationSourceFileCount',
  'sourceVerificationDocsFileCount',
]);

export const REFRESH_PROVENANCE_KEYS = new Set([
  'refreshedAt',
  'sourceManifestMode',
  'strategy',
  'inputBoundary',
  'limitations',
]);
export const REFRESH_PROVENANCE_ISO_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const REFRESH_PROVENANCE_BY_MODE = {
  [SOURCE_DOCS_MODE]: {
    strategy: 'explicit-local-source-docs',
    inputBoundary:
      'Existing built-in-parser local-source-docs manifest with recorded local source path.',
    limitations: [
      'Records refresh provenance only; it does not validate freshness or source truth.',
      'Uses only the manifest-recorded local source path, format hint, preset metadata, and prior chunk output presence.',
      'Does not refresh parser-plugin manifests, fetch URLs, crawl, select sources, or verify source-code behavior.',
    ],
  },
  [SOURCE_TRUTH_DOCS_MODE]: {
    strategy: 'explicit-local-source-truth-docs',
    inputBoundary: 'Existing source-truth-local-docs manifest with recorded local source path.',
    limitations: [
      'Records refresh provenance only; it does not prove source truth or validate freshness.',
      'Uses only the manifest-recorded local source path.',
      'Does not fetch URLs, crawl, select sources, run source project scripts, verify broad official-docs claims, or validate runtime behavior.',
    ],
  },
  [CONFIGURED_SDK_MODE]: {
    strategy: 'configured-sdk-local-openref',
    inputBoundary:
      'Existing configured-sdk manifest with recorded absolute local OpenRef spec path.',
    limitations: [
      'Records refresh provenance only; it does not validate freshness or source truth.',
      'Uses only the manifest-recorded local spec path, SDK metadata, parser/formatter metadata, and filename prefix.',
      'Does not fetch URLs, query registries, crawl, select candidates, refresh remote freshness, or verify source-code behavior.',
    ],
  },
  [DISCOVERY_REPORT_MODE]: {
    strategy: 'local-source-discovery-report',
    inputBoundary:
      'Existing discovery-report manifest whose report is local-bounded source discovery.',
    limitations: [
      'Records refresh provenance only; candidate evidence remains for agent review.',
      'Uses only the local report source path and traversal bounds from discovery-report.json.',
      'Does not generate docs, select sources, consume candidates, refresh repo or URL reports, validate freshness, crawl, or access the network.',
    ],
  },
  [SOURCE_VERIFICATION_MODE]: {
    strategy: 'local-source-verification-evidence',
    inputBoundary:
      'Existing source-verification-local-evidence manifest with local source-verification report paths.',
    limitations: [
      'Records refresh provenance only; local source/docs evidence is not source-truth proof.',
      'Uses only the local report source/docs paths and docs traversal bounds from source-verification-report.json.',
      'Does not perform broad official-docs claim verification, source-code behavior validation, freshness validation, crawling, source selection, or network access.',
    ],
  },
} as const;

export type RefreshSourceManifestMode = keyof typeof REFRESH_PROVENANCE_BY_MODE;

export type GeneratedOutputKind = 'parsed-spec-json' | 'llm-docs';
export type DiscoveryReportKind = keyof typeof DISCOVERY_REPORT_MODE_BY_KIND;
