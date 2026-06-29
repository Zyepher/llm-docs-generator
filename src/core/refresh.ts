import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { writeTextFileSafely } from '../utils/safe-write.js';
import { isObjectRecord, errorMessage } from '../utils/guards.js';

import categoriesConfig from '../../config/categories.json';
import type { CategoryConfig, SDKVersionConfig } from '../config/schemas.js';
import {
  DISCOVERY_REPORT_SCHEMA_VERSION,
  LOCAL_BOUNDED_INSPECTION_MODE,
  discoverLocalSources,
  isUrlLikeInput,
} from './discovery.js';
import { LLMFormatter, type LLMFormatterConfig } from './formatter.js';
import type { SpecData } from './models.js';
import {
  DISCOVERY_REPORT_MODE,
  CONFIGURED_SDK_MODE,
  MANIFEST_SCHEMA_VERSION,
  recordRefreshProvenanceInManifest,
  validateSourceDocsPresetContract,
  verifyGenerationManifest,
  writeDiscoveryReportManifest,
  writeGenerationManifest,
  type RefreshSourceManifestMode,
  type VerifyGenerationManifestResult,
} from './manifest.js';
import {
  generateSourceDocs,
  SOURCE_DOCS_MODE,
  type SourceDocsGeneratorMetadata,
  type SourceDocsPresetMetadata,
} from './source-docs.js';
import { generateSourceTruthDocs, SOURCE_TRUTH_DOCS_MODE } from './source-truth-docs.js';
import {
  SOURCE_VERIFICATION_MODE,
  SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION,
  SourceVerificationNoDocsEvidenceError,
  verifyDocsAgainstSource,
} from './source-verification.js';
import { OpenRefParser } from '../parsers/openref/parser.js';

const SOURCE_DOCS_FORMAT_HINTS = new Set([
  'auto',
  'markdown',
  'mdx',
  'openapi',
  'openref',
  'rst',
  'html',
]);
const SOURCE_DOCS_CHUNKS_JSONL_KIND = 'semantic-chunks-jsonl';
const CONFIGURED_SDK_PARSER_NAME = 'OpenRefParser';
const CONFIGURED_SDK_FORMAT = 'openref-0.1';
const CONFIGURED_SDK_FORMATTER_NAME = 'LLMFormatter';
const CONFIGURED_SDK_FORMATTER_FORMAT = 'legacy-llm-docs';
const CONFIGURED_SDK_GENERATED_OUTPUT_KINDS = new Set(['parsed-spec-json', 'llm-docs']);
const CONFIGURED_SDK_FULL_DOC_PATH_PATTERN = /^llm-docs\/(.+)-full-llms\.txt$/;

export class RefreshManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefreshManifestError';
  }
}

export class RefreshManifestVerificationError extends RefreshManifestError {
  checkedFiles: number;
  failures: string[];

  constructor(result: VerifyGenerationManifestResult) {
    super(`post-refresh manifest verification failed with ${result.failures.length} failure(s)`);
    this.name = 'RefreshManifestVerificationError';
    this.checkedFiles = result.checkedFiles;
    this.failures = result.failures;
  }
}

export interface RefreshManifestOptions {
  manifestPath: string;
  generator: SourceDocsGeneratorMetadata;
}

export interface RefreshManifestResult {
  mode:
    | typeof CONFIGURED_SDK_MODE
    | typeof SOURCE_DOCS_MODE
    | typeof SOURCE_TRUTH_DOCS_MODE
    | typeof DISCOVERY_REPORT_MODE
    | typeof SOURCE_VERIFICATION_MODE;
  manifestPath: string;
  outputDir: string;
  sourcePath: string;
  sourceFiles: number;
  generatedOutputs: number;
  postRefreshVerification: {
    status: 'passed';
    checkedFiles: number;
  };
  chunkOutputPath?: string;
  candidateCount?: number;
  presetName?: string;
  reportPath?: string;
  docsPath?: string;
  docsReferences?: number;
  exactMatches?: number;
  unmatchedReferences?: number;
}

export async function refreshGenerationManifest(
  options: RefreshManifestOptions
): Promise<RefreshManifestResult> {
  const manifestPath = resolve(options.manifestPath);
  const manifest = await readRefreshManifest(manifestPath);

  if (manifest.mode === SOURCE_DOCS_MODE) {
    return refreshSourceDocsManifest({
      manifestPath,
      manifest,
      generator: options.generator,
    });
  }

  if (manifest.mode === SOURCE_TRUTH_DOCS_MODE) {
    return refreshSourceTruthDocsManifest({ manifestPath, manifest });
  }

  if (manifest.mode === CONFIGURED_SDK_MODE) {
    return refreshConfiguredSdkManifest({
      manifestPath,
      manifest,
      generator: options.generator,
    });
  }

  if (manifest.mode === DISCOVERY_REPORT_MODE) {
    return refreshDiscoveryReportManifest({
      manifestPath,
      manifest,
      generator: options.generator,
    });
  }

  if (manifest.mode === SOURCE_VERIFICATION_MODE) {
    return refreshSourceVerificationManifest({
      manifestPath,
      manifest,
      generator: options.generator,
    });
  }

  throw new RefreshManifestError(
    `unsupported refresh manifest mode: ${String(
      manifest.mode
    )}; supported modes are local-source-docs, source-truth-local-docs, configured-sdk with an explicit local source.resolvedSpecPath, discovery-report source, and source-verification-local-evidence`
  );
}

async function refreshSourceVerificationManifest(options: {
  manifestPath: string;
  manifest: Record<string, unknown>;
  generator: SourceDocsGeneratorMetadata;
}): Promise<RefreshManifestResult> {
  const sourceVerification = requiredObject(
    options.manifest.sourceVerification,
    'sourceVerification'
  );
  const outputDir = dirname(options.manifestPath);
  const reportPath = sourceVerificationReportPathFromManifest(
    sourceVerification.reportPath,
    outputDir
  );

  await assertSafeSourceVerificationReportReadPath(reportPath);

  const previousReport = await readSourceVerificationRefreshReport(reportPath);

  await assertExistingLocalInputPath('source-verification source path', previousReport.sourcePath);
  await assertExistingLocalInputPath('source-verification docs path', previousReport.docsPath);
  await assertInputsOutsideRefreshOutput({
    sourcePath: previousReport.sourcePath,
    docsPath: previousReport.docsPath,
    outputDir,
  });

  try {
    const result = await verifyDocsAgainstSource({
      source: previousReport.sourcePath,
      docs: previousReport.docsPath,
      outputDir,
      docsMaxDepth: previousReport.docsTraversal.maxDepth,
      docsMaxEntries: previousReport.docsTraversal.maxEntries,
      docsMaxFiles: previousReport.docsTraversal.maxFiles,
      docsMaxFileBytes: previousReport.docsTraversal.maxFileBytes,
      generator: options.generator,
    });

    return withPostRefreshVerification({
      mode: SOURCE_VERIFICATION_MODE,
      manifestPath: result.manifestPath,
      outputDir: result.outputDir,
      sourcePath: result.report.source.resolvedPath,
      docsPath: result.report.docs.resolvedPath,
      sourceFiles: result.report.summary.sourceFileCount,
      generatedOutputs: result.manifest.generatedOutputs.length,
      reportPath: result.reportPath,
      docsReferences: result.report.summary.docsReferenceCount,
      exactMatches: result.report.summary.exactMatchCount,
      unmatchedReferences: result.report.summary.unmatchedReferenceCount,
    });
  } catch (error) {
    if (error instanceof SourceVerificationNoDocsEvidenceError) {
      throw new RefreshManifestError(
        `refreshed local source/docs evidence no longer has supported docs evidence; failure report: ${error.failurePath}; evidence report: ${error.reportPath}`
      );
    }

    throw error;
  }
}

async function refreshDiscoveryReportManifest(options: {
  manifestPath: string;
  manifest: Record<string, unknown>;
  generator: SourceDocsGeneratorMetadata;
}): Promise<RefreshManifestResult> {
  const discovery = requiredObject(options.manifest.discovery, 'discovery');
  const discoveryKind = requiredNonEmptyString(discovery.kind, 'discovery.kind');

  if (discoveryKind !== 'source') {
    if (discoveryKind === 'repo' || discoveryKind === 'url') {
      throw new RefreshManifestError(
        `refresh supports discovery-report manifests only for discovery.kind source; ${discoveryKind} discovery-report refresh is not supported`
      );
    }

    throw new RefreshManifestError(
      'malformed manifest: discovery.kind must be source, repo, or url'
    );
  }

  const outputDir = dirname(options.manifestPath);
  const reportPath = discoveryReportPathFromManifest(discovery.reportPath, outputDir);

  await assertSafeDiscoveryReportReadPath(reportPath);

  const previousReport = await readSourceDiscoveryRefreshReport(reportPath);

  await assertExistingLocalSourcePath(previousReport.sourcePath);
  await assertSourceOutsideRefreshOutput({ sourcePath: previousReport.sourcePath, outputDir });

  const result = await discoverLocalSources({
    source: previousReport.sourcePath,
    outputDir,
    maxDepth: previousReport.traversal.maxDepth,
    maxEntries: previousReport.traversal.maxEntries,
    maxFiles: previousReport.traversal.maxFiles,
  });

  await writeDiscoveryReportManifest({
    manifestPath: options.manifestPath,
    generator: options.generator,
    discoveryKind: 'source',
    reportPath: result.reportPath,
    report: result.report,
  });

  return withPostRefreshVerification({
    mode: DISCOVERY_REPORT_MODE,
    manifestPath: options.manifestPath,
    outputDir,
    sourcePath: result.report.source.resolvedPath,
    sourceFiles: 0,
    generatedOutputs: 1,
    candidateCount: result.report.candidates.length,
    reportPath: result.reportPath,
  });
}

async function readRefreshManifest(manifestPath: string): Promise<Record<string, unknown>> {
  let manifest: unknown;

  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as unknown;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new RefreshManifestError(`manifest not found: ${manifestPath}`);
    }

    throw new RefreshManifestError(`malformed manifest JSON: ${errorMessage(error)}`);
  }

  if (!isObjectRecord(manifest)) {
    throw new RefreshManifestError('malformed manifest: root must be an object');
  }

  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new RefreshManifestError(
      `unsupported manifest schemaVersion: ${String(manifest.schemaVersion)}`
    );
  }

  return manifest;
}

async function refreshSourceDocsManifest(options: {
  manifestPath: string;
  manifest: Record<string, unknown>;
  generator: SourceDocsGeneratorMetadata;
}): Promise<RefreshManifestResult> {
  const source = requiredObject(options.manifest.source, 'source');
  const generatedOutputs = requiredArray(options.manifest.generatedOutputs, 'generatedOutputs');
  const sourcePath = requiredAbsoluteLocalPath(source.resolvedPath, 'source.resolvedPath');
  const formatHint = requiredNonEmptyString(source.formatHint, 'source.formatHint');
  const parser = options.manifest.parser;

  if (isObjectRecord(parser) && parser.plugin !== undefined) {
    throw new RefreshManifestError(
      'refresh does not support parser-plugin local-source-docs manifests; rerun generate --source --parser-plugin-manifest --format explicitly'
    );
  }

  if (!SOURCE_DOCS_FORMAT_HINTS.has(formatHint)) {
    throw new RefreshManifestError(
      "malformed manifest: source.formatHint must be a supported source format hint"
    );
  }

  const preset = sourceDocsPresetFromManifest(options.manifest.preset);
  const outputDir = dirname(options.manifestPath);
  await assertExistingLocalSourcePath(sourcePath);
  await assertSourceOutsideRefreshOutput({ sourcePath, outputDir });
  const chunks = generatedOutputs.some(
    (output) => isObjectRecord(output) && output.kind === SOURCE_DOCS_CHUNKS_JSONL_KIND
  )
    ? 'jsonl'
    : undefined;

  const result = await generateSourceDocs({
    source: sourcePath,
    outputDir,
    format: formatHint,
    ...(chunks === undefined ? {} : { chunks }),
    ...(preset === undefined
      ? {}
      : {
          preset,
          output: {
            filenamePrefix: preset.defaults.filenamePrefix,
            title: preset.defaults.title,
            systemPrompt: preset.defaults.systemPrompt,
          },
        }),
    generator: options.generator,
  });
  const chunkOutput = result.manifest.generatedOutputs.find(
    (output) => output.kind === SOURCE_DOCS_CHUNKS_JSONL_KIND
  );

  return withPostRefreshVerification({
    mode: SOURCE_DOCS_MODE,
    manifestPath: result.manifestPath,
    outputDir: result.outputDir,
    sourcePath: result.manifest.source.resolvedPath,
    sourceFiles: result.manifest.sourceFiles.length,
    generatedOutputs: result.manifest.generatedOutputs.length,
    ...(chunkOutput === undefined ? {} : { chunkOutputPath: chunkOutput.path }),
    ...(result.manifest.preset === undefined ? {} : { presetName: result.manifest.preset.name }),
  });
}

async function refreshSourceTruthDocsManifest(options: {
  manifestPath: string;
  manifest: Record<string, unknown>;
}): Promise<RefreshManifestResult> {
  const source = requiredObject(options.manifest.source, 'source');
  requiredArray(options.manifest.generatedOutputs, 'generatedOutputs');
  const sourcePath = requiredAbsoluteLocalPath(source.resolvedPath, 'source.resolvedPath');
  const outputDir = dirname(options.manifestPath);
  await assertExistingLocalSourcePath(sourcePath);
  await assertSourceOutsideRefreshOutput({ sourcePath, outputDir });
  const result = await generateSourceTruthDocs({
    source: sourcePath,
    outputDir,
  });

  return withPostRefreshVerification({
    mode: SOURCE_TRUTH_DOCS_MODE,
    manifestPath: result.manifestPath,
    outputDir: result.outputDir,
    sourcePath: result.manifest.source.resolvedPath,
    sourceFiles: result.manifest.sourceFiles.length,
    generatedOutputs: result.manifest.generatedOutputs.length,
  });
}

async function refreshConfiguredSdkManifest(options: {
  manifestPath: string;
  manifest: Record<string, unknown>;
  generator: SourceDocsGeneratorMetadata;
}): Promise<RefreshManifestResult> {
  const sdk = readConfiguredSdkMetadata(options.manifest.sdk);
  const source = readConfiguredSdkSourceMetadata(options.manifest.source);
  const parser = readConfiguredSdkParserMetadata(options.manifest.parser);
  const formatter = readConfiguredSdkFormatterMetadata(options.manifest.formatter);
  const generatedOutputs = requiredArray(options.manifest.generatedOutputs, 'generatedOutputs');
  const outputDir = dirname(options.manifestPath);
  const filenamePrefix = configuredSdkFilenamePrefixFromManifest(generatedOutputs, outputDir);

  await assertExistingLocalOpenRefSpecFile(source.resolvedSpecPath);
  await assertSourceOutsideRefreshOutput({ sourcePath: source.resolvedSpecPath, outputDir });

  const openRefParser = new OpenRefParser(source.resolvedSpecPath);
  const parsedData = await openRefParser.parse();
  const parsedSpecPath = join(outputDir, 'parsed', `${sdk.name}-${sdk.resolvedVersion}-spec.json`);
  const llmDocsDir = join(outputDir, 'llm-docs');
  const expectedLlmOutputPaths = configuredSdkLlmOutputPaths({
    outputDir,
    filenamePrefix,
    parsedData,
  });

  await assertConfiguredSdkRefreshWriteTargets({
    outputDir,
    parsedSpecPath,
    llmDocsDir,
    llmOutputPaths: expectedLlmOutputPaths,
  });

  // The configured-SDK path is hand-rolled (no generator-level failure
  // cleanup), so wrap the mutating regeneration: if any step throws after the
  // first on-disk write, quarantine the manifest instead of leaving a stale
  // success manifest pointing at half-overwritten outputs.
  let llmOutputPaths: string[];
  try {
    await openRefParser.saveJSON(parsedData, parsedSpecPath);

    const refreshConfig = new ConfiguredSdkRefreshFormatterConfig({
      sdkName: sdk.name,
      displayName: sdk.displayName,
      filenamePrefix,
      source,
    });
    const llmFormatter = new LLMFormatter(
      parsedData,
      refreshConfig,
      sdk.name,
      sdk.resolvedVersion,
      source.resolvedSpecPath
    );
    llmOutputPaths = await llmFormatter.generateAll(outputDir);

    await writeGenerationManifest({
      manifestPath: options.manifestPath,
      generatedAt: new Date(),
      generator: options.generator,
      sdk,
      source,
      parser,
      formatter,
      generatedOutputs: [
        { path: parsedSpecPath, kind: 'parsed-spec-json' },
        ...llmOutputPaths.map((path) => ({ path, kind: 'llm-docs' as const })),
      ],
      warnings: [],
    });
  } catch (error) {
    await quarantineFailedRefresh({
      manifestPath: options.manifestPath,
      outputDir,
      reason: 'configured-sdk-refresh-regeneration-failed',
      error,
    });

    throw error;
  }

  return withPostRefreshVerification({
    mode: CONFIGURED_SDK_MODE,
    manifestPath: options.manifestPath,
    outputDir,
    sourcePath: source.resolvedSpecPath,
    sourceFiles: 1,
    generatedOutputs: llmOutputPaths.length + 1,
  });
}

const REFRESH_FAILURE_FILE = 'failure.json';
const REFRESH_FAILURE_MODE = 'refresh-failure';

/**
 * Make a failed refresh non-deceptive: remove the manifest so a stale "success"
 * manifest can never be left behind for `verify` to accept, and record a
 * failure.json describing why. Idempotent and best-effort (a cleanup failure
 * must not mask the original error).
 */
async function quarantineFailedRefresh(params: {
  manifestPath: string;
  outputDir: string;
  reason: string;
  error: unknown;
}): Promise<void> {
  try {
    await rm(params.manifestPath, { force: true });

    const message = params.error instanceof Error ? params.error.message : String(params.error);
    const failure: Record<string, unknown> = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      mode: REFRESH_FAILURE_MODE,
      reason: params.reason,
      message,
      manifestPath: relative(params.outputDir, params.manifestPath) || basename(params.manifestPath),
    };

    if (params.error instanceof RefreshManifestVerificationError) {
      failure.verificationFailures = params.error.failures;
    }

    await writeTextFileSafely(
      join(params.outputDir, REFRESH_FAILURE_FILE),
      `${JSON.stringify(failure, null, 2)}\n`
    );
  } catch {
    // Best-effort cleanup: never let a quarantine failure hide the real error.
  }
}

async function withPostRefreshVerification(
  result: Omit<RefreshManifestResult, 'postRefreshVerification'>
): Promise<RefreshManifestResult> {
  try {
    await recordRefreshProvenanceInManifest({
      manifestPath: result.manifestPath,
      mode: result.mode as RefreshSourceManifestMode,
    });

    const verification = await verifyGenerationManifest({ manifestPath: result.manifestPath });

    if (verification.failures.length > 0) {
      throw new RefreshManifestVerificationError(verification);
    }

    return {
      ...result,
      postRefreshVerification: {
        status: 'passed',
        checkedFiles: verification.checkedFiles,
      },
    };
  } catch (error) {
    // The refresh produced an output set that fails integrity verification (or
    // the provenance stamp itself failed). Do not leave a manifest that claims
    // a verified success; quarantine it and surface the failure.
    await quarantineFailedRefresh({
      manifestPath: result.manifestPath,
      outputDir: result.outputDir,
      reason:
        error instanceof RefreshManifestVerificationError
          ? 'post-refresh-verification-failed'
          : 'post-refresh-provenance-failed',
      error,
    });

    throw error;
  }
}

function sourceDocsPresetFromManifest(preset: unknown): SourceDocsPresetMetadata | undefined {
  if (preset === undefined) {
    return undefined;
  }

  const failures = validateSourceDocsPresetContract(preset);

  if (failures.length > 0) {
    throw new RefreshManifestError(`malformed manifest: ${failures.join('; ')}`);
  }

  return preset as SourceDocsPresetMetadata;
}

function readConfiguredSdkMetadata(value: unknown): {
  name: string;
  resolvedVersion: string;
  displayName: string;
} {
  const sdk = requiredObject(value, 'sdk');

  return {
    name: requiredSafeFilenameComponent(sdk.name, 'sdk.name'),
    resolvedVersion: requiredSafeFilenameComponent(sdk.resolvedVersion, 'sdk.resolvedVersion'),
    displayName: requiredNonEmptyString(sdk.displayName, 'sdk.displayName'),
  };
}

function readConfiguredSdkSourceMetadata(value: unknown): {
  configuredUrl: string;
  configuredLocalPath: string | null;
  resolvedSpecPath: string;
  format: string;
} {
  const source = requiredObject(value, 'source');
  const format = requiredNonEmptyString(source.format, 'source.format');

  if (format !== CONFIGURED_SDK_FORMAT) {
    throw new RefreshManifestError(
      `malformed manifest: source.format must be ${CONFIGURED_SDK_FORMAT}`
    );
  }

  requiredNonNegativeInteger(source.byteSize, 'source.byteSize');
  requiredSha256Hash(source.contentHash, 'source.contentHash');

  return {
    configuredUrl: requiredUrlString(source.configuredUrl, 'source.configuredUrl'),
    configuredLocalPath: requiredNonEmptyStringOrNull(
      source.configuredLocalPath,
      'source.configuredLocalPath'
    ),
    resolvedSpecPath: requiredAbsoluteLocalPath(source.resolvedSpecPath, 'source.resolvedSpecPath'),
    format,
  };
}

function readConfiguredSdkParserMetadata(value: unknown): {
  name: string;
  version: string;
  format: string;
} {
  const parser = requiredObject(value, 'parser');
  const name = requiredNonEmptyString(parser.name, 'parser.name');
  const version = requiredNonEmptyString(parser.version, 'parser.version');
  const format = requiredNonEmptyString(parser.format, 'parser.format');

  if (name !== CONFIGURED_SDK_PARSER_NAME) {
    throw new RefreshManifestError(
      `malformed manifest: parser.name must be ${CONFIGURED_SDK_PARSER_NAME}`
    );
  }

  if (format !== CONFIGURED_SDK_FORMAT) {
    throw new RefreshManifestError(
      `malformed manifest: parser.format must be ${CONFIGURED_SDK_FORMAT}`
    );
  }

  return { name, version, format };
}

function readConfiguredSdkFormatterMetadata(value: unknown): {
  name: string;
  version: string;
  format: string;
} {
  const formatter = requiredObject(value, 'formatter');
  const name = requiredNonEmptyString(formatter.name, 'formatter.name');
  const version = requiredNonEmptyString(formatter.version, 'formatter.version');
  const format = requiredNonEmptyString(formatter.format, 'formatter.format');

  if (name !== CONFIGURED_SDK_FORMATTER_NAME) {
    throw new RefreshManifestError(
      `malformed manifest: formatter.name must be ${CONFIGURED_SDK_FORMATTER_NAME}`
    );
  }

  if (format !== CONFIGURED_SDK_FORMATTER_FORMAT) {
    throw new RefreshManifestError(
      `malformed manifest: formatter.format must be ${CONFIGURED_SDK_FORMATTER_FORMAT}`
    );
  }

  return { name, version, format };
}

function configuredSdkFilenamePrefixFromManifest(
  generatedOutputs: unknown[],
  outputDir: string
): string {
  const prefixes = new Set<string>();

  generatedOutputs.forEach((output, index) => {
    if (!isObjectRecord(output)) {
      throw new RefreshManifestError(
        `malformed manifest: generatedOutputs[${index}] must be an object`
      );
    }

    const outputPath = requiredNonEmptyString(output.path, `generatedOutputs[${index}].path`);
    const outputKind = requiredNonEmptyString(output.kind, `generatedOutputs[${index}].kind`);

    if (!CONFIGURED_SDK_GENERATED_OUTPUT_KINDS.has(outputKind)) {
      throw new RefreshManifestError(
        'malformed manifest: generated output kind must be parsed-spec-json or llm-docs'
      );
    }

    if (isAbsolute(outputPath)) {
      throw new RefreshManifestError(
        `malformed manifest: generatedOutputs[${index}].path must be relative`
      );
    }

    if (outputPath.includes('\\')) {
      throw new RefreshManifestError(
        `malformed manifest: generatedOutputs[${index}].path must use forward slashes`
      );
    }

    if (!isSameOrDescendant(outputDir, resolve(outputDir, outputPath))) {
      throw new RefreshManifestError(
        `malformed manifest: generatedOutputs[${index}].path escapes manifest directory`
      );
    }

    if (outputKind === 'llm-docs') {
      const match = CONFIGURED_SDK_FULL_DOC_PATH_PATTERN.exec(outputPath);

      if (match !== null) {
        prefixes.add(
          requiredSafeFilenameComponent(
            match[1],
            `generatedOutputs[${index}] full-doc filename prefix`
          )
        );
      }
    }
  });

  if (prefixes.size !== 1) {
    throw new RefreshManifestError(
      'configured-sdk refresh requires exactly one llm-docs/*-full-llms.txt generated output to recover the manifest-recorded filename prefix'
    );
  }

  return [...prefixes][0]!;
}

function configuredSdkLlmOutputPaths(options: {
  outputDir: string;
  filenamePrefix: string;
  parsedData: SpecData;
}): string[] {
  const operationIds = new Set(options.parsedData.operations.map((operation) => operation.id));
  const paths = [join(options.outputDir, 'llm-docs', `${options.filenamePrefix}-full-llms.txt`)];

  for (const [categoryName, category] of Object.entries(categoriesConfig.categories).sort(
    (a, b) => a[1].order - b[1].order
  )) {
    requiredSafeFilenameComponent(categoryName, `configured SDK category name ${categoryName}`);

    if (category.operations.some((operationId) => operationIds.has(operationId))) {
      paths.push(
        join(options.outputDir, 'llm-docs', `${options.filenamePrefix}-${categoryName}-llms.txt`)
      );
    }
  }

  return paths;
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObjectRecord(value)) {
    throw new RefreshManifestError(`malformed manifest: missing ${label} object`);
  }

  return value;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new RefreshManifestError(`malformed manifest: missing ${label} array`);
  }

  return value;
}

function requiredNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RefreshManifestError(`malformed manifest: ${label} must be a non-empty string`);
  }

  return value;
}

function requiredSafeFilenameComponent(value: unknown, label: string): string {
  const component = requiredNonEmptyString(value, label);

  if (
    component === '.' ||
    component === '..' ||
    component.includes('/') ||
    component.includes('\\') ||
    component.includes('\0') ||
    !/^[A-Za-z0-9._-]+$/.test(component)
  ) {
    throw new RefreshManifestError(
      `malformed manifest: ${label} must be a safe filename component`
    );
  }

  return component;
}

function requiredUrlString(value: unknown, label: string): string {
  const url = requiredNonEmptyString(value, label);

  try {
    new URL(url);
  } catch {
    throw new RefreshManifestError(`malformed manifest: ${label} must be a valid URL`);
  }

  return url;
}

function requiredNonEmptyStringOrNull(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new RefreshManifestError(
      `malformed manifest: ${label} must be a non-empty string or null`
    );
  }

  return value;
}

function requiredAbsoluteLocalPath(value: unknown, label: string): string {
  const path = requiredNonEmptyString(value, label);

  if (isUrlLikeInput(path)) {
    throw new RefreshManifestError(`malformed manifest: ${label} must be a local path`);
  }

  if (!isAbsolute(path)) {
    throw new RefreshManifestError(`malformed manifest: ${label} must be absolute`);
  }

  return path;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new RefreshManifestError(`malformed manifest: ${label} must be a non-negative integer`);
  }

  return value;
}

function requiredSha256Hash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new RefreshManifestError(`malformed manifest: ${label} must be a sha256 hash`);
  }

  return value;
}

function discoveryReportPathFromManifest(value: unknown, outputDir: string): string {
  const reportPath = requiredNonEmptyString(value, 'discovery.reportPath');

  if (isAbsolute(reportPath)) {
    throw new RefreshManifestError(
      `malformed manifest: discovery.reportPath must be relative: ${reportPath}`
    );
  }

  if (reportPath.includes('\\')) {
    throw new RefreshManifestError(
      'malformed manifest: discovery.reportPath must use forward slashes'
    );
  }

  const resolvedReportPath = resolve(outputDir, reportPath);

  if (!isSameOrDescendant(outputDir, resolvedReportPath)) {
    throw new RefreshManifestError(
      `malformed manifest: discovery.reportPath escapes manifest directory: ${reportPath}`
    );
  }

  return resolvedReportPath;
}

function sourceVerificationReportPathFromManifest(value: unknown, outputDir: string): string {
  const reportPath = requiredNonEmptyString(value, 'sourceVerification.reportPath');

  if (/^[a-z][a-z0-9+.-]*:/i.test(reportPath)) {
    throw new RefreshManifestError(
      'malformed manifest: sourceVerification.reportPath must be a relative local report path'
    );
  }

  if (isAbsolute(reportPath)) {
    throw new RefreshManifestError(
      `malformed manifest: sourceVerification.reportPath must be relative: ${reportPath}`
    );
  }

  if (reportPath.includes('\\')) {
    throw new RefreshManifestError(
      'malformed manifest: sourceVerification.reportPath must use forward slashes'
    );
  }

  const resolvedReportPath = resolve(outputDir, reportPath);

  if (!isSameOrDescendant(outputDir, resolvedReportPath)) {
    throw new RefreshManifestError(
      `malformed manifest: sourceVerification.reportPath escapes manifest directory: ${reportPath}`
    );
  }

  return resolvedReportPath;
}

async function assertSafeDiscoveryReportReadPath(reportPath: string): Promise<void> {
  await assertSafeRefreshWritePath({
    path: reportPath,
    label: 'discovery report path',
    expectedType: 'file',
  });
}

async function assertSafeSourceVerificationReportReadPath(reportPath: string): Promise<void> {
  await assertSafeExistingRegularFilePath({
    path: reportPath,
    label: 'source-verification report path',
  });
}

async function readSourceDiscoveryRefreshReport(reportPath: string): Promise<{
  sourcePath: string;
  traversal: {
    maxDepth: number;
    maxEntries: number;
    maxFiles: number;
  };
}> {
  let report: unknown;

  try {
    report = JSON.parse(await readFile(reportPath, 'utf-8')) as unknown;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new RefreshManifestError(`discovery report not found: ${reportPath}`);
    }

    throw new RefreshManifestError(`malformed discovery report JSON: ${errorMessage(error)}`);
  }

  if (!isObjectRecord(report)) {
    throw new RefreshManifestError('malformed discovery report: root must be an object');
  }

  if (report.schemaVersion !== DISCOVERY_REPORT_SCHEMA_VERSION) {
    throw new RefreshManifestError(
      `malformed discovery report: schemaVersion must be ${DISCOVERY_REPORT_SCHEMA_VERSION}`
    );
  }

  if (report.mode !== LOCAL_BOUNDED_INSPECTION_MODE) {
    throw new RefreshManifestError(
      `malformed discovery report: mode must be ${LOCAL_BOUNDED_INSPECTION_MODE}`
    );
  }

  const source = requiredDiscoveryReportObject(report.source, 'source');
  requiredDiscoveryReportNonEmptyString(source.input, 'source.input');
  const sourcePath = requiredDiscoveryReportAbsoluteLocalPath(
    source.resolvedPath,
    'source.resolvedPath'
  );
  const sourceType = requiredDiscoveryReportNonEmptyString(source.type, 'source.type');

  if (sourceType !== 'file' && sourceType !== 'directory') {
    throw new RefreshManifestError(
      'malformed discovery report: source.type must be file or directory'
    );
  }

  const output = requiredDiscoveryReportObject(report.output, 'output');
  requiredDiscoveryReportNonEmptyString(output.reportPath, 'output.reportPath');

  const traversal = requiredDiscoveryReportObject(report.traversal, 'traversal');

  if (traversal.followSymlinks !== false) {
    throw new RefreshManifestError(
      'malformed discovery report: traversal.followSymlinks must be false'
    );
  }

  if (!Array.isArray(report.candidates)) {
    throw new RefreshManifestError('malformed discovery report: candidates must be an array');
  }

  if (!Array.isArray(report.warnings)) {
    throw new RefreshManifestError('malformed discovery report: warnings must be an array');
  }

  return {
    sourcePath,
    traversal: {
      maxDepth: requiredDiscoveryTraversalBound(traversal.maxDepth, 'traversal.maxDepth', true),
      maxEntries: requiredDiscoveryTraversalBound(
        traversal.maxEntries,
        'traversal.maxEntries',
        false
      ),
      maxFiles: requiredDiscoveryTraversalBound(traversal.maxFiles, 'traversal.maxFiles', false),
    },
  };
}

async function readSourceVerificationRefreshReport(reportPath: string): Promise<{
  sourcePath: string;
  docsPath: string;
  docsTraversal: {
    maxDepth: number;
    maxEntries: number;
    maxFiles: number;
    maxFileBytes: number;
  };
}> {
  let report: unknown;

  try {
    report = JSON.parse(await readFile(reportPath, 'utf-8')) as unknown;
  } catch (error) {
    throw new RefreshManifestError(
      `malformed source-verification report JSON: ${errorMessage(error)}`
    );
  }

  if (!isObjectRecord(report)) {
    throw new RefreshManifestError('malformed source-verification report: root must be an object');
  }

  if (report.schemaVersion !== SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION) {
    throw new RefreshManifestError(
      `malformed source-verification report: schemaVersion must be ${SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION}`
    );
  }

  if (report.mode !== SOURCE_VERIFICATION_MODE) {
    throw new RefreshManifestError(
      `malformed source-verification report: mode must be ${SOURCE_VERIFICATION_MODE}`
    );
  }

  const source = requiredSourceVerificationReportObject(report.source, 'source');
  requiredSourceVerificationReportNonEmptyString(source.input, 'source.input');
  const sourcePath = requiredSourceVerificationReportAbsoluteLocalPath(
    source.resolvedPath,
    'source.resolvedPath'
  );
  const sourceType = requiredSourceVerificationReportNonEmptyString(source.type, 'source.type');

  if (sourceType !== 'file' && sourceType !== 'directory') {
    throw new RefreshManifestError(
      'malformed source-verification report: source.type must be file or directory'
    );
  }

  const docs = requiredSourceVerificationReportObject(report.docs, 'docs');
  requiredSourceVerificationReportNonEmptyString(docs.input, 'docs.input');
  const docsPath = requiredSourceVerificationReportAbsoluteLocalPath(
    docs.resolvedPath,
    'docs.resolvedPath'
  );
  const docsType = requiredSourceVerificationReportNonEmptyString(docs.type, 'docs.type');

  if (docsType !== 'file' && docsType !== 'directory') {
    throw new RefreshManifestError(
      'malformed source-verification report: docs.type must be file or directory'
    );
  }

  const traversal = requiredSourceVerificationReportObject(docs.traversal, 'docs.traversal');

  if (traversal.followSymlinks !== false) {
    throw new RefreshManifestError(
      'malformed source-verification report: docs.traversal.followSymlinks must be false'
    );
  }

  return {
    sourcePath,
    docsPath,
    docsTraversal: {
      maxDepth: requiredSourceVerificationTraversalBound(
        traversal.maxDepth,
        'docs.traversal.maxDepth',
        true
      ),
      maxEntries: requiredSourceVerificationTraversalBound(
        traversal.maxEntries,
        'docs.traversal.maxEntries',
        false
      ),
      maxFiles: requiredSourceVerificationTraversalBound(
        traversal.maxFiles,
        'docs.traversal.maxFiles',
        false
      ),
      maxFileBytes: requiredSourceVerificationTraversalBound(
        traversal.maxFileBytes,
        'docs.traversal.maxFileBytes',
        false
      ),
    },
  };
}

function requiredDiscoveryReportObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObjectRecord(value)) {
    throw new RefreshManifestError(`malformed discovery report: missing ${label} object`);
  }

  return value;
}

function requiredSourceVerificationReportObject(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!isObjectRecord(value)) {
    throw new RefreshManifestError(`malformed source-verification report: missing ${label} object`);
  }

  return value;
}

function requiredSourceVerificationReportNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RefreshManifestError(
      `malformed source-verification report: ${label} must be a non-empty string`
    );
  }

  return value;
}

function requiredSourceVerificationReportAbsoluteLocalPath(value: unknown, label: string): string {
  const path = requiredSourceVerificationReportNonEmptyString(value, label);

  if (isUrlLikeInput(path)) {
    throw new RefreshManifestError(
      `malformed source-verification report: ${label} must be a local path`
    );
  }

  if (!isAbsolute(path)) {
    throw new RefreshManifestError(
      `malformed source-verification report: ${label} must be absolute`
    );
  }

  return path;
}

function requiredSourceVerificationTraversalBound(
  value: unknown,
  label: string,
  allowZero: boolean
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (!allowZero && value === 0)
  ) {
    const lowerBound = allowZero ? 'non-negative' : 'positive';

    throw new RefreshManifestError(
      `malformed source-verification report: ${label} must be a ${lowerBound} safe integer`
    );
  }

  return value;
}

function requiredDiscoveryReportNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RefreshManifestError(
      `malformed discovery report: ${label} must be a non-empty string`
    );
  }

  return value;
}

function requiredDiscoveryReportAbsoluteLocalPath(value: unknown, label: string): string {
  const path = requiredDiscoveryReportNonEmptyString(value, label);

  if (isUrlLikeInput(path)) {
    throw new RefreshManifestError(`malformed discovery report: ${label} must be a local path`);
  }

  if (!isAbsolute(path)) {
    throw new RefreshManifestError(`malformed discovery report: ${label} must be absolute`);
  }

  return path;
}

function requiredDiscoveryTraversalBound(
  value: unknown,
  label: string,
  allowZero: boolean
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (!allowZero && value === 0)
  ) {
    const lowerBound = allowZero ? 'non-negative' : 'positive';

    throw new RefreshManifestError(
      `malformed discovery report: ${label} must be a ${lowerBound} safe integer`
    );
  }

  return value;
}

async function assertExistingLocalOpenRefSpecFile(sourcePath: string): Promise<void> {
  try {
    const stats = await lstat(sourcePath);

    if (stats.isSymbolicLink()) {
      throw new RefreshManifestError(
        `manifest source.resolvedSpecPath must not be a symbolic link: ${sourcePath}`
      );
    }

    if (!stats.isFile()) {
      throw new RefreshManifestError(
        `manifest source.resolvedSpecPath must be an existing local OpenRef spec file: ${sourcePath}`
      );
    }

    await assertNoSymlinkPathComponents(sourcePath);
  } catch (error) {
    if (error instanceof RefreshManifestError) {
      throw error;
    }

    if (isFileNotFoundError(error)) {
      throw new RefreshManifestError(`manifest source.resolvedSpecPath not found: ${sourcePath}`);
    }

    throw new RefreshManifestError(
      `manifest source.resolvedSpecPath cannot be read: ${sourcePath}: ${errorMessage(error)}`
    );
  }
}

async function assertConfiguredSdkRefreshWriteTargets(options: {
  outputDir: string;
  parsedSpecPath: string;
  llmDocsDir: string;
  llmOutputPaths: string[];
}): Promise<void> {
  assertPathInsideDirectory(
    options.outputDir,
    options.parsedSpecPath,
    'configured-sdk parsed output path'
  );
  await assertSafeRefreshWritePath({
    path: options.parsedSpecPath,
    label: 'configured-sdk parsed output path',
    expectedType: 'file',
  });

  assertPathInsideDirectory(
    options.outputDir,
    options.llmDocsDir,
    'configured-sdk llm-docs output directory'
  );
  await assertSafeRefreshWritePath({
    path: options.llmDocsDir,
    label: 'configured-sdk llm-docs output directory',
    expectedType: 'directory',
  });

  for (const outputPath of options.llmOutputPaths) {
    assertPathInsideDirectory(options.outputDir, outputPath, 'configured-sdk llm-docs output path');
    await assertSafeRefreshWritePath({
      path: outputPath,
      label: 'configured-sdk llm-docs output path',
      expectedType: 'file',
    });
  }
}

function assertPathInsideDirectory(parentDir: string, targetPath: string, label: string): void {
  if (!isSameOrDescendant(parentDir, targetPath)) {
    throw new RefreshManifestError(`${label} escapes manifest output directory: ${targetPath}`);
  }
}

async function assertSafeRefreshWritePath(options: {
  path: string;
  label: string;
  expectedType: 'directory' | 'file';
}): Promise<void> {
  const parsedPath = parse(options.path);
  const parts = options.path.slice(parsedPath.root.length).split(sep).filter(Boolean);
  let currentPath = parsedPath.root;

  for (let index = 0; index < parts.length; index++) {
    currentPath = join(currentPath, parts[index]!);

    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(currentPath);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return;
      }

      throw new RefreshManifestError(
        `${options.label} cannot be checked: ${currentPath}: ${errorMessage(error)}`
      );
    }

    if (stats.isSymbolicLink()) {
      throw new RefreshManifestError(
        `${options.label}: symbolic links are not allowed in path: ${currentPath}`
      );
    }

    const isTarget = index === parts.length - 1;

    if (isTarget) {
      if (options.expectedType === 'directory' && !stats.isDirectory()) {
        throw new RefreshManifestError(`${options.label} must be a directory: ${currentPath}`);
      }

      if (options.expectedType === 'file' && !stats.isFile()) {
        throw new RefreshManifestError(`${options.label} must be a regular file: ${currentPath}`);
      }
    } else if (!stats.isDirectory()) {
      throw new RefreshManifestError(
        `${options.label} parent path must be a directory: ${currentPath}`
      );
    }
  }
}

async function assertSafeExistingRegularFilePath(options: {
  path: string;
  label: string;
}): Promise<void> {
  const parsedPath = parse(options.path);
  const parts = options.path.slice(parsedPath.root.length).split(sep).filter(Boolean);
  let currentPath = parsedPath.root;

  for (let index = 0; index < parts.length; index++) {
    currentPath = join(currentPath, parts[index]!);

    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(currentPath);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        throw new RefreshManifestError(`${options.label} not found: ${options.path}`);
      }

      throw new RefreshManifestError(
        `${options.label} cannot be checked: ${currentPath}: ${errorMessage(error)}`
      );
    }

    if (stats.isSymbolicLink()) {
      throw new RefreshManifestError(
        `${options.label}: symbolic links are not allowed in path: ${currentPath}`
      );
    }

    const isTarget = index === parts.length - 1;

    if (isTarget) {
      if (!stats.isFile()) {
        throw new RefreshManifestError(`${options.label} must be a regular file: ${currentPath}`);
      }
    } else if (!stats.isDirectory()) {
      throw new RefreshManifestError(
        `${options.label} parent path must be a directory: ${currentPath}`
      );
    }
  }
}

async function assertExistingLocalSourcePath(sourcePath: string): Promise<void> {
  await assertExistingLocalInputPath('manifest source path', sourcePath);
}

async function assertExistingLocalInputPath(label: string, sourcePath: string): Promise<void> {
  try {
    if (isUrlLikeInput(sourcePath)) {
      throw new RefreshManifestError(`${label} must be a local path: ${sourcePath}`);
    }

    const stats = await lstat(sourcePath);

    if (stats.isSymbolicLink()) {
      throw new RefreshManifestError(`${label} must not be a symbolic link: ${sourcePath}`);
    }

    if (!stats.isFile() && !stats.isDirectory()) {
      throw new RefreshManifestError(`${label} must be a local file or directory: ${sourcePath}`);
    }

    await assertNoSymlinkPathComponents(sourcePath, label);
  } catch (error) {
    if (error instanceof RefreshManifestError) {
      throw error;
    }

    if (isFileNotFoundError(error)) {
      throw new RefreshManifestError(`${label} not found: ${sourcePath}`);
    }

    throw new RefreshManifestError(
      `${label} cannot be read: ${sourcePath}: ${errorMessage(error)}`
    );
  }
}

async function assertNoSymlinkPathComponents(
  sourcePath: string,
  label = 'manifest source path'
): Promise<void> {
  const parsedPath = parse(sourcePath);
  const parts = sourcePath.slice(parsedPath.root.length).split(sep).filter(Boolean);
  let currentPath = parsedPath.root;

  for (const part of parts) {
    currentPath = join(currentPath, part);

    const stats = await lstat(currentPath);

    if (stats.isSymbolicLink()) {
      throw new RefreshManifestError(
        `${label} must not contain a symbolic link component: ${currentPath}`
      );
    }
  }
}

async function assertInputsOutsideRefreshOutput(options: {
  sourcePath: string;
  docsPath: string;
  outputDir: string;
}): Promise<void> {
  const resolvedOutputDir = resolve(options.outputDir);
  const effectiveOutputPath = await resolveEffectiveOutputPath(resolvedOutputDir);

  for (const inputPath of [options.sourcePath, options.docsPath]) {
    const canonicalInputPath = await realpath(inputPath);

    if (
      isSameOrDescendant(inputPath, resolvedOutputDir) ||
      isSameOrDescendant(canonicalInputPath, effectiveOutputPath)
    ) {
      throw new RefreshManifestError(
        'manifest output directory must not be the same as, or inside, the source-verification source or docs path'
      );
    }
  }
}

async function assertSourceOutsideRefreshOutput(options: {
  sourcePath: string;
  outputDir: string;
}): Promise<void> {
  const resolvedOutputDir = resolve(options.outputDir);
  const effectiveOutputPath = await resolveEffectiveOutputPath(resolvedOutputDir);
  const canonicalSourcePath = await realpathIfExists(options.sourcePath);

  if (
    (canonicalSourcePath !== undefined &&
      isSameOrDescendant(effectiveOutputPath, canonicalSourcePath)) ||
    isSameOrDescendant(resolvedOutputDir, options.sourcePath)
  ) {
    throw new RefreshManifestError(
      'manifest source path must not be the same as, or inside, the manifest output directory'
    );
  }
}

async function realpathIfExists(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function resolveEffectiveOutputPath(outputDir: string): Promise<string> {
  const resolvedOutputDir = resolve(outputDir);
  const missingSegments: string[] = [];
  let currentPath = resolvedOutputDir;

  while (true) {
    try {
      const canonicalExistingPath = await realpath(currentPath);

      return missingSegments.length === 0
        ? canonicalExistingPath
        : join(canonicalExistingPath, ...missingSegments.reverse());
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
    }

    const parentPath = dirname(currentPath);

    if (parentPath === currentPath) {
      return resolvedOutputDir;
    }

    missingSegments.push(basename(currentPath));
    currentPath = parentPath;
  }
}

function isSameOrDescendant(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(parentPath, candidatePath);

  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

class ConfiguredSdkRefreshFormatterConfig implements LLMFormatterConfig {
  private readonly versionConfig: SDKVersionConfig;
  private readonly categories: Map<string, CategoryConfig>;
  private readonly sortedCategories: [string, CategoryConfig][];

  constructor(options: {
    sdkName: string;
    displayName: string;
    filenamePrefix: string;
    source: {
      configuredUrl: string;
      configuredLocalPath: string | null;
      resolvedSpecPath: string;
      format: string;
    };
  }) {
    this.versionConfig = {
      displayName: options.displayName,
      spec: {
        url: options.source.configuredUrl,
        localPath: options.source.configuredLocalPath,
        format: options.source.format,
      },
      output: {
        baseDir: options.sdkName,
        filenamePrefix: options.filenamePrefix,
      },
    };
    this.categories = new Map(Object.entries(categoriesConfig.categories));
    this.sortedCategories = Array.from(this.categories.entries()).sort(
      (a, b) => a[1].order - b[1].order
    );
  }

  getSDKVersionConfig(_sdkName: string, _version: string): SDKVersionConfig {
    return this.versionConfig;
  }

  getCategories(): ReadonlyMap<string, CategoryConfig> {
    return this.categories;
  }

  getCategory(name: string): CategoryConfig {
    const category = this.categories.get(name);

    if (category === undefined) {
      throw new RefreshManifestError(`configured SDK category '${name}' not found`);
    }

    return category;
  }

  getSortedCategories(): ReadonlyArray<[string, CategoryConfig]> {
    return this.sortedCategories;
  }
}
