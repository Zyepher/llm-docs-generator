/**
 * Main entry point for programmatic API
 */

// Core exports
export { OpenRefParser, parseOpenRefSpec, getParserStats } from './parsers/openref/parser.js';
export { LLMFormatter, formatSpecData } from './core/formatter.js';
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
  isUrlLikeInput,
} from './core/discovery.js';
export type {
  DiscoverLocalSourceOptions,
  DiscoverLocalSourcesOptions,
  DiscoverLocalSourcesResult,
  DiscoveryCandidate,
  DiscoveryCandidateKind,
  DiscoveryReport,
  DiscoverySourceType,
  DiscoveryTraversalSettings,
} from './core/discovery.js';
