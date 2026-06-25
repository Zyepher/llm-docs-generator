/**
 * Main entry point for programmatic API
 */

// Core exports
export { OpenRefParser, parseOpenRefSpec, getParserStats } from './parsers/openref/parser.js';
export { OpenApiFormatParser, openApiParser, parseOpenApiFile } from './parsers/openapi/index.js';
export { HtmlFormatParser, htmlParser, parseHtmlFile } from './parsers/html/index.js';
export type { HtmlDocument, HtmlLink, HtmlParserWarning } from './parsers/html/index.js';
export { RstFormatParser, parseRstFile, rstParser } from './parsers/rst/index.js';
export type { RstDocument } from './parsers/rst/index.js';
export { LLMFormatter, formatSpecData } from './core/formatter.js';
export { DEFAULT_CHUNK_MAX_CHARACTERS, chunkDocNode, estimateTokenCount } from './core/chunker.js';
export type {
  ChunkDocNodeOptions,
  ChunkDocNodeResult,
  SemanticChunk,
  SemanticChunkMetadata,
  SemanticChunkSource,
  SemanticChunkWarning,
  SemanticChunkWarningCode,
} from './core/chunker.js';
export {
  detectFormat,
  FormatDetector,
  getFormatDetector,
  getParserForFormat,
} from './core/detector.js';
export { BaseParser, FormatType, ParserError } from './parsers/base.js';
export type {
  Parser,
  ValidationError,
  ValidationResult,
  ValidationWarning,
} from './parsers/base.js';
export type { ApiVersionInfo } from './parsers/openapi/index.js';
export { ContentBlockType, DocNodeType, createContentBlock, createDocNode } from './core/models.js';
export type { ContentBlock, DocNode } from './core/models.js';
export type { Example } from './core/models.js';
export type { Operation } from './core/models.js';
export type { SpecInfo } from './core/models.js';
export type { SpecData } from './core/models.js';
export {
  createSpecData,
  getOperationById,
  getOperationsByIds,
  getTotalExamples,
} from './core/models.js';

// Config exports
export { ConfigLoader, loadConfig } from './config/loader.js';
export type { SDKConfig } from './config/schemas.js';
export type { SDKVersionConfig } from './config/schemas.js';
export type { CategoryConfig } from './config/schemas.js';
export type { SpecConfig } from './config/schemas.js';
export type { OutputConfig } from './config/schemas.js';

// Utils exports
export { fetchSpec, isSpecCached, clearSpecCache } from './utils/fetcher.js';
export { Logger, LogLevel } from './utils/logger.js';
export { verifyGenerationManifest, writeGenerationManifest } from './core/manifest.js';
export type {
  VerifyGenerationManifestOptions,
  VerifyGenerationManifestResult,
  WriteGenerationManifestOptions,
} from './core/manifest.js';
export {
  DEFAULT_DISCOVERY_MAX_DEPTH,
  DEFAULT_DISCOVERY_MAX_ENTRIES,
  DEFAULT_DISCOVERY_MAX_FILES,
  DISCOVERY_REPORT_SCHEMA_VERSION,
  LOCAL_BOUNDED_INSPECTION_MODE,
  discoverLocalSource,
  discoverLocalSources,
  inspectLocalSource,
  isUrlLikeInput,
} from './core/discovery.js';
export type {
  DiscoverLocalSourceOptions,
  DiscoverLocalSourcesOptions,
  DiscoverLocalSourcesResult,
  DiscoveryCandidate,
  DiscoveryCandidateEvidence,
  DiscoveryEvidenceCategory,
  DiscoveryCandidateKind,
  DiscoveryInspection,
  DiscoveryReport,
  DiscoverySourceType,
  DiscoveryTraversalSettings,
} from './core/discovery.js';
export {
  DEFAULT_REPO_CACHE_ROOT,
  REPO_BOUNDED_INSPECTION_MODE,
  discoverRepo,
} from './core/repo-discovery.js';
export type {
  DiscoverRepoOptions,
  DiscoverRepoResult,
  RepoDiscoveryReport,
  RepoGitState,
  RepoUpdateState,
} from './core/repo-discovery.js';
export {
  DEFAULT_WEBSITE_FETCH_TIMEOUT_MS,
  DEFAULT_WEBSITE_MAX_BYTES_PER_RESPONSE,
  DEFAULT_WEBSITE_MAX_CANDIDATES,
  WEBSITE_BOUNDED_INSPECTION_MODE,
  discoverWebsite,
  inspectWebsite,
} from './core/website-discovery.js';
export type {
  DiscoverWebsiteResult,
  DiscoverWebsiteOptions,
  WebsiteCandidateEvidence,
  WebsiteCandidateEvidenceFlag,
  WebsiteCandidateEvidenceRelation,
  WebsiteCandidateSourceResource,
  WebsiteCrawlPolicy,
  WebsiteDiscoveryCandidate,
  WebsiteDiscoveryInspection,
  WebsiteDiscoveryReport,
  WebsiteInspectedResource,
  WebsiteResourceRole,
} from './core/website-discovery.js';
export {
  DEFAULT_SOURCE_TRUTH_MAX_DEPTH,
  DEFAULT_SOURCE_TRUTH_MAX_ENTRIES,
  DEFAULT_SOURCE_TRUTH_MAX_FILES,
  DEFAULT_SOURCE_TRUTH_MAX_FILE_BYTES,
  SOURCE_TRUTH_INSPECTION_MODE,
  SOURCE_TRUTH_REPORT_SCHEMA_VERSION,
  inspectSourceTruth,
} from './core/source-truth.js';
export type {
  InspectSourceTruthOptions,
  SourceTruthConfigFact,
  SourceTruthConfigFactKind,
  SourceTruthConfigFileKind,
  SourceTruthConfigLineRangeGranularity,
  SourceTruthContextFact,
  SourceTruthContextFactKind,
  SourceTruthContextLineRangeGranularity,
  SourceTruthFact,
  SourceTruthFactKind,
  SourceTruthFileEvidence,
  SourceTruthFileStatus,
  SourceTruthInspectionReport,
  SourceTruthLineRange,
  SourceTruthProvenance,
  SourceTruthSignatureDeclarationKind,
  SourceTruthSignatureEvidence,
  SourceTruthSignatureHeritage,
  SourceTruthSignatureParameter,
  SourceTruthSignatureVariable,
  SourceTruthSkipReason,
  SourceTruthSourceType,
  SourceTruthSymbolKind,
  SourceTruthTraversalSettings,
  SourceTruthVariableDeclarationKind,
} from './core/source-truth.js';
export {
  SOURCE_TRUTH_DOCS_FAILURE_MODE,
  SOURCE_TRUTH_DOCS_MODE,
  SOURCE_TRUTH_DOCS_SCHEMA_VERSION,
  SourceTruthDocsNoFactsError,
  formatSourceTruthMarkdown,
  generateSourceTruthDocs,
} from './core/source-truth-docs.js';
export type {
  GenerateSourceTruthDocsOptions,
  SourceTruthDocsFailure,
  SourceTruthDocsGenerationResult,
  SourceTruthDocsManifest,
  SourceTruthGeneratedOutput,
  SourceTruthGeneratedOutputKind,
  SourceTruthManifestSourceFile,
} from './core/source-truth-docs.js';
