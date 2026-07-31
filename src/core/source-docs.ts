import type { Dirent } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chunkDocNode, type SemanticChunk, type SemanticChunkWarning } from './chunker.js';
import { detectFormat, getParserForFormat } from './detector.js';
import {
  assertUniqueGeneratedOutputPaths,
  describeGeneratedTextOutput,
} from './generated-output-metadata.js';
import { createDocNode, DocNodeSchema, DocNodeType, type DocNode } from './models.js';
import {
  validateParserPluginManifestFile,
  type ParserPluginFormatMetadata,
  type ParserPluginManifestMetadata,
} from './parser-plugin-manifest.js';
import {
  buildSemanticChunkJsonlManifestIndex,
  type SemanticChunkManifestIndex,
} from './semantic-chunk-index.js';
import type { GeneratorMetadata } from './manifest/types.js';
import {
  buildArtifactSummaryForManifest,
  buildInputProvenanceForManifest,
  buildManifestContract,
  type ArtifactSummary,
  type InputProvenance,
  type ManifestContract,
} from './manifest.js';
import {
  formatDocNode,
  rewriteDocNodeProseInPlace,
  type FormatterSourcePack,
} from './universal-formatter.js';
import { matchesAnyGlob } from './category-globs.js';
import { isUrlLikeInput } from './discovery.js';
import { FormatType, type Parser } from '../parsers/base.js';
import { aggregateSourceFilesHash } from '../utils/source-files-hash.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';
import { isRecord, isFileNotFoundError } from '../utils/guards.js';
import {
  isParentRelativePath,
  isSameOrDescendant,
  resolveEffectiveOutputPath,
} from '../utils/fs-path.js';
import { readJsonFile, writeJsonFileSafely } from '../utils/json.js';
import { writeTextFileSafely } from '../utils/safe-write.js';
import { sha256File } from '../utils/hash.js';
import { isSkippedTraversalDirectory } from '../utils/traversal.js';
import { sanitizeFilenameSegment as sanitizeFileSegment } from '../utils/filename-prefix.js';

const SOURCE_DOCS_FORMATTER_FORMAT = 'universal-llm-docs';
const SOURCE_DOCS_OUTPUT_DIR = 'llm-docs';
const SOURCE_DOCS_CHUNKS_OUTPUT_DIR = 'chunks';
const SOURCE_DOCS_CHUNKS_JSONL = 'semantic-chunks.jsonl';
const SOURCE_DOCS_MANIFEST = 'manifest.json';
const DEFAULT_SOURCE_DOCS_MAX_DEPTH = 16;
const DEFAULT_SOURCE_DOCS_MAX_ENTRIES = 20000;
const DEFAULT_SOURCE_DOCS_MAX_FILES = 5000;
// Cap the recorded skipped-file roster so a source tree with a large vendored
// asset set cannot balloon the manifest; a truncation warning records the fact.
const SOURCE_DOCS_MAX_SKIPPED_FILES = 500;
// Bound the per-extension breakdown in the unsupported-extension warning so a
// tree with many exotic extensions cannot turn one warning into a wall.
const SOURCE_DOCS_MAX_SKIPPED_EXTENSIONS = 10;
const DRAFT_HEADING_PREFIX = 'DRAFT';

export const SOURCE_DOCS_SCHEMA_VERSION = '0.1.0';
export const SOURCE_DOCS_MODE = 'local-source-docs';

const SOURCE_DOCS_FORMAT_HINTS = new Set([
  'auto',
  'markdown',
  'mdx',
  'openapi',
  'openref',
  'rst',
  'html',
]);

const DISCOVERY_REPORT_MODES = new Set([
  'local-bounded-inspection',
  'repo-bounded-inspection',
  'website-bounded-inspection',
]);

type SourceDocsSourceType = 'file' | 'directory';
export type SourceDocsChunksFormat = 'jsonl';
type BuiltInSourceDocsResolvedFormat =
  FormatType.MARKDOWN | FormatType.OPENAPI | FormatType.OPENREF | FormatType.RST | FormatType.HTML;
type SourceDocsResolvedFormat = BuiltInSourceDocsResolvedFormat | string;

export type SourceDocsGeneratorMetadata = GeneratorMetadata;

export interface SourceDocsPresetMetadata {
  name: string;
  configPath: string;
  displayName: string;
  description?: string;
  defaults: {
    format: string;
    filenamePrefix: string;
    title: string;
    systemPrompt: string;
    outputFormats?: string[];
  };
  metadata?: Record<string, unknown>;
  limitations: string[];
}

export interface SourceDocsOutputDefaults {
  filenamePrefix?: string;
  title?: string;
  systemPrompt?: string;
}

export interface GenerateSourceGitContext {
  remoteUrl: string | null;
  commit: string;
  tags: string[];
  dirty: boolean;
  sourceRootFromRepo: string;
}

export type SourceDocsSplitBy = 'dirs';

export interface SourceDocsCategoryDefinition {
  id: string;
  title: string;
  include: string[];
}

export interface SourceDocsCategoriesConfig {
  categories: SourceDocsCategoryDefinition[];
  fallback: string;
}

export interface GenerateSourceDocsOptions {
  source: string;
  outputDir: string;
  format?: string;
  chunks?: string;
  parserPluginManifest?: string;
  output?: SourceDocsOutputDefaults;
  preset?: SourceDocsPresetMetadata;
  generator: SourceDocsGeneratorMetadata;
  gitContext?: GenerateSourceGitContext;
  label?: string;
  splitBy?: SourceDocsSplitBy;
  categories?: SourceDocsCategoriesConfig;
  exclude?: string[];
}

export interface SourceDocsExcludedFile {
  path: string;
  glob: string;
}

export interface SourceDocsSkippedFile {
  path: string;
  reason: string;
}

interface SourceDocsBaseFileManifestEntry {
  path: string;
  resolvedPath: string;
  byteSize: number;
  hash: string;
  lineCount: number;
  estimatedTokenCount: number;
}

export interface SourceDocsFileManifestEntry extends SourceDocsBaseFileManifestEntry {
  format: SourceDocsResolvedFormat;
}

export interface SourceDocsParserPluginProvenance {
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
  format: ParserPluginFormatMetadata;
  execution: {
    codeExecuted: true;
    trust: 'trusted-local-code';
    sandboxed: false;
    statement: string;
  };
}

export interface SourceDocsGeneratedOutput {
  path: string;
  kind: 'llm-docs' | 'semantic-chunks-jsonl';
  name: string;
  byteSize: number;
  hash: string;
  lineCount: number;
  estimatedTokenCount: number;
}

export interface SourceDocsManifest {
  schemaVersion: typeof SOURCE_DOCS_SCHEMA_VERSION;
  generatedAt: string;
  generator: SourceDocsGeneratorMetadata;
  mode: typeof SOURCE_DOCS_MODE;
  manifestContract: ManifestContract;
  inputProvenance: InputProvenance;
  artifactSummary: ArtifactSummary;
  source: {
    input: string;
    resolvedPath: string;
    type: SourceDocsSourceType;
    formatHint: string;
    resolvedFormat: SourceDocsResolvedFormat;
    byteSize?: number;
    hash?: string;
    fileCount?: number;
    aggregateHash?: string;
    label?: string;
    git?: GenerateSourceGitContext;
    // Every --exclude glob as given (trimmed, deduplicated, in given order),
    // including globs that matched nothing. Always present for built-in
    // directory sources (possibly empty) so verify and refresh can distinguish
    // "no excludes recorded" (old manifest) from "no excludes given".
    excludeGlobs?: string[];
    excluded?: SourceDocsExcludedFile[];
    skippedFiles?: SourceDocsSkippedFile[];
  };
  sourceFiles: SourceDocsFileManifestEntry[];
  output: {
    filenamePrefix: string;
    splitBy?: SourceDocsSplitBy;
    categories?: SourceDocsCategoriesConfig;
  };
  parser: {
    name: string;
    version: string;
    format: SourceDocsResolvedFormat;
    plugin?: SourceDocsParserPluginProvenance;
  };
  formatter: {
    name: 'UniversalFormatter';
    version: string;
    format: typeof SOURCE_DOCS_FORMATTER_FORMAT;
  };
  generatedOutputs: SourceDocsGeneratedOutput[];
  semanticChunkIndexes?: SemanticChunkManifestIndex[];
  preset?: SourceDocsPresetMetadata;
  warnings: string[];
}

export interface GenerateSourceDocsResult {
  outputDir: string;
  manifestPath: string;
  llmDocsDir: string;
  manifest: SourceDocsManifest;
}

export interface CleanupSourceDocsArtifactsOptions {
  protectedSourcePath?: string;
}

interface ResolvedSourceDocsInput {
  input: string;
  resolvedPath: string;
  type: SourceDocsSourceType;
}

interface ParsedFormatHint {
  manifestValue: string;
  parserHint: FormatType;
}

interface SourceFileCollection {
  files: BoundedSourceFile[];
  warnings: string[];
  excluded: SourceDocsExcludedFile[];
  skippedFiles: SourceDocsSkippedFile[];
}

interface CompiledExcludeGlob {
  glob: string;
  regex: RegExp;
}

interface DirectoryTraversalState {
  entries: number;
  files: number;
  warnings: string[];
  excludeGlobs: CompiledExcludeGlob[];
  excluded: SourceDocsExcludedFile[];
  skipped: SourceDocsSkippedFile[];
}

interface BoundedSourceFile extends SourceDocsBaseFileManifestEntry {
  format: SourceFileFormat;
}

interface PreparedSourceDocsInput {
  resolvedFormat: SourceDocsResolvedFormat;
  parser: SourceDocsParser;
  parserVersion?: string;
  parserPlugin?: SourceDocsParserPluginProvenance;
  sourceFiles: BoundedSourceFile[];
  warnings: string[];
  excludeGlobs?: string[];
  excluded?: SourceDocsExcludedFile[];
  skippedFiles?: SourceDocsSkippedFile[];
}

type SourceFileFormat = SourceDocsResolvedFormat | 'structured-spec';

interface SourceDocsParser {
  readonly name: string;
  readonly format: string;
  detect?(sourcePath: string): Promise<boolean> | boolean;
  parse(sourcePath: string): Promise<DocNode> | DocNode;
}

interface ParserPluginParserCandidate {
  name: string;
  format: string;
  detect?: (sourcePath: string) => unknown;
  parse: (sourcePath: string) => unknown;
}

export async function generateSourceDocs(
  options: GenerateSourceDocsOptions
): Promise<GenerateSourceDocsResult> {
  const outputDir = resolve(options.outputDir);
  const manifestPath = join(outputDir, SOURCE_DOCS_MANIFEST);
  const llmDocsDir = join(outputDir, SOURCE_DOCS_OUTPUT_DIR);
  let outputWorkStarted = false;

  try {
    const chunksFormat = parseSourceDocsChunksFormat(options.chunks);
    const source = await resolveSourceInput(options.source);

    await assertSourceOutsideSourceDocsArtifacts(source, outputDir);
    await assertOutputDirOutsideSource(source, outputDir);
    await assertNotDiscoveryReport(source);

    const { formatHint, preparedSource } =
      options.parserPluginManifest === undefined
        ? await prepareBuiltInSourceDocsInput(source, options.format, options.exclude)
        : await prepareParserPluginSourceDocsInput(source, {
            format: options.format,
            chunks: options.chunks,
            preset: options.preset,
            manifestPath: options.parserPluginManifest,
            outputDir,
          });

    await mkdir(outputDir, { recursive: true });
    await clearSourceDocsArtifacts(outputDir);
    outputWorkStarted = true;

    const root = await parsePreparedSource(source, preparedSource);
    const warnings = [...preparedSource.warnings, ...collectDocNodeWarnings(root)];

    // Optional category grouping. Restructures the file sections under CATEGORY
    // nodes so the formatter emits per-category files; the combined -full-llms.txt
    // is always produced regardless.
    if (options.splitBy !== undefined || options.categories !== undefined) {
      applySourceDocsCategories(root, source, options, warnings);
    }

    const packRelpaths = new Set(preparedSource.sourceFiles.map((file) => file.path));
    const sourcePack: FormatterSourcePack = {
      resolvedPath: source.resolvedPath,
      packRelpaths,
      emitToc: true,
      onWarning: (warning) => warnings.push(warning),
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(options.gitContext === undefined ? {} : { gitContext: options.gitContext }),
    };

    // The prefix operators actually get: an explicit --filename-prefix (already
    // sanitization-validated at the CLI) overrides the prefix derived from the
    // source basename. Computed once so the formatter and the manifest record
    // the identical value.
    const resolvedFilenamePrefix =
      options.output?.filenamePrefix ?? filenamePrefixForSource(source.resolvedPath, source.type);

    const outputPaths = await formatDocNode(root, {
      outputDir: llmDocsDir,
      filenamePrefix: resolvedFilenamePrefix,
      title: options.output?.title ?? root.title,
      systemPrompt:
        options.output?.systemPrompt ??
        `This is a local source documentation pack generated from ${source.resolvedPath}.`,
      includeMetadata: false,
      sourcePack,
    });
    const generatedOutputs = await describeGeneratedOutputs(outputDir, outputPaths);
    let chunkOutput: Awaited<ReturnType<typeof writeSemanticChunksJsonl>> | undefined;
    if (chunksFormat === 'jsonl') {
      // Chunk prose must agree with the pack's rewritten prose: rewrite the IR
      // in place with the formatter's exact link machinery (safe here because
      // every pack output has already been written from the original tree).
      rewriteDocNodeProseInPlace(root, sourcePack);
      chunkOutput = await writeSemanticChunksJsonl(outputDir, root);
    }
    const semanticChunkIndexes: SemanticChunkManifestIndex[] = [];
    if (chunkOutput !== undefined) {
      generatedOutputs.push(chunkOutput.output);
      generatedOutputs.sort((a, b) => compareStringsByCodeUnit(a.path, b.path));
      semanticChunkIndexes.push(chunkOutput.index);
    }
    const manifest = buildSourceDocsManifest({
      source,
      formatHint,
      resolvedFormat: preparedSource.resolvedFormat,
      parser: preparedSource.parser,
      ...(preparedSource.parserVersion === undefined
        ? {}
        : { parserVersion: preparedSource.parserVersion }),
      ...(preparedSource.parserPlugin === undefined
        ? {}
        : { parserPlugin: preparedSource.parserPlugin }),
      generator: options.generator,
      sourceFiles: preparedSource.sourceFiles,
      filenamePrefix: resolvedFilenamePrefix,
      generatedOutputs,
      ...(semanticChunkIndexes.length === 0 ? {} : { semanticChunkIndexes }),
      ...(options.preset === undefined ? {} : { preset: options.preset }),
      ...(options.gitContext === undefined ? {} : { gitContext: options.gitContext }),
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(options.splitBy === undefined ? {} : { splitBy: options.splitBy }),
      ...(options.categories === undefined ? {} : { categories: options.categories }),
      ...(preparedSource.excludeGlobs === undefined
        ? {}
        : { excludeGlobs: preparedSource.excludeGlobs }),
      ...(preparedSource.excluded === undefined || preparedSource.excluded.length === 0
        ? {}
        : { excluded: preparedSource.excluded }),
      ...(preparedSource.skippedFiles === undefined || preparedSource.skippedFiles.length === 0
        ? {}
        : { skippedFiles: preparedSource.skippedFiles }),
      warnings,
    });

    await writeJsonFileSafely(manifestPath, manifest);

    return {
      outputDir,
      manifestPath,
      llmDocsDir,
      manifest,
    };
  } catch (error) {
    if (outputWorkStarted) {
      await clearSourceDocsArtifacts(outputDir);
    } else if (options.parserPluginManifest === undefined) {
      await cleanupStaleSourceDocsArtifacts(outputDir, {
        protectedSourcePath: options.source,
      });
    }

    throw error;
  }
}

export async function cleanupStaleSourceDocsArtifacts(
  outputDir: string,
  options: CleanupSourceDocsArtifactsOptions = {}
): Promise<void> {
  const resolvedOutputDir = resolve(outputDir);

  if (isSourceDocsArtifactPath(options.protectedSourcePath, resolvedOutputDir)) {
    return;
  }

  const manifestPath = join(resolvedOutputDir, SOURCE_DOCS_MANIFEST);
  let manifest: unknown;

  try {
    manifest = await readJsonFile(manifestPath);
  } catch (error) {
    if (isFileNotFoundError(error) || error instanceof SyntaxError) {
      return;
    }

    throw error;
  }

  if (!isRecord(manifest) || manifest.mode !== SOURCE_DOCS_MODE) {
    return;
  }

  await clearSourceDocsArtifacts(resolvedOutputDir);
}

function parseSourceDocsFormatHint(format: string | undefined): ParsedFormatHint {
  const normalizedFormat = (format ?? 'auto').trim().toLowerCase();
  const manifestValue = normalizedFormat.length === 0 ? 'auto' : normalizedFormat;

  if (!SOURCE_DOCS_FORMAT_HINTS.has(manifestValue)) {
    throw new Error(
      `--format ${format ?? ''} is not supported for generate --source; supported source formats are auto, markdown, mdx, openapi, openref, rst, html`
    );
  }

  if (manifestValue === 'auto') {
    return { manifestValue, parserHint: FormatType.AUTO };
  }

  if (manifestValue === 'mdx') {
    return { manifestValue, parserHint: FormatType.MARKDOWN };
  }

  return { manifestValue, parserHint: manifestValue as FormatType };
}

function parseSourceDocsChunksFormat(
  chunks: string | undefined
): SourceDocsChunksFormat | undefined {
  if (chunks === undefined) {
    return undefined;
  }

  const normalizedChunks = chunks.trim().toLowerCase();

  if (normalizedChunks !== 'jsonl') {
    throw new Error(
      `--chunks ${chunks} is not supported for generate --source; supported chunk export formats are jsonl`
    );
  }

  return normalizedChunks;
}

async function prepareBuiltInSourceDocsInput(
  source: ResolvedSourceDocsInput,
  format: string | undefined,
  exclude: string[] | undefined
): Promise<{ formatHint: string; preparedSource: PreparedSourceDocsInput }> {
  const formatHint = parseSourceDocsFormatHint(format);

  return {
    formatHint: formatHint.manifestValue,
    preparedSource: await prepareSourceDocsInput(source, formatHint, exclude),
  };
}

async function prepareParserPluginSourceDocsInput(
  source: ResolvedSourceDocsInput,
  options: {
    format: string | undefined;
    chunks: string | undefined;
    preset: SourceDocsPresetMetadata | undefined;
    manifestPath: string;
    outputDir: string;
  }
): Promise<{ formatHint: string; preparedSource: PreparedSourceDocsInput }> {
  const requestedFormat = parseParserPluginRequestedFormat(options.format);

  if (options.chunks !== undefined) {
    throw new Error(
      'generate --source --parser-plugin-manifest does not support --chunks in this release'
    );
  }

  if (options.preset !== undefined) {
    throw new Error(
      'generate --source --parser-plugin-manifest does not support --preset in this release'
    );
  }

  const plugin = await loadExplicitParserPlugin({
    manifestPath: options.manifestPath,
    requestedFormat,
    sourcePath: source.resolvedPath,
    sourceType: source.type,
    outputDir: options.outputDir,
  });
  const sourceFiles =
    source.type === 'file'
      ? [
          await describeSourceFile(
            source.resolvedPath,
            basename(source.resolvedPath),
            requestedFormat
          ),
        ]
      : await describeParserPluginDirectorySourceFiles(
          source,
          requestedFormat,
          plugin.provenance.format.extensions
        );

  return {
    formatHint: requestedFormat,
    preparedSource: {
      resolvedFormat: requestedFormat,
      parser: plugin.parser,
      parserVersion: plugin.provenance.version,
      parserPlugin: plugin.provenance,
      sourceFiles,
      warnings: [],
    },
  };
}

function parseParserPluginRequestedFormat(format: string | undefined): string {
  if (format === undefined || format.trim().length === 0) {
    throw new Error(
      'generate --source --parser-plugin-manifest requires explicit --format <plugin-format-id>'
    );
  }

  const normalizedFormat = format.trim().toLowerCase();

  if (SOURCE_DOCS_FORMAT_HINTS.has(normalizedFormat)) {
    throw new Error(
      `generate --source --parser-plugin-manifest requires a custom plugin format id; '${normalizedFormat}' is a built-in source format`
    );
  }

  return normalizedFormat;
}

async function loadExplicitParserPlugin(options: {
  manifestPath: string;
  requestedFormat: string;
  sourcePath: string;
  sourceType: SourceDocsSourceType;
  outputDir: string;
}): Promise<{ parser: SourceDocsParser; provenance: SourceDocsParserPluginProvenance }> {
  const validation = await validateParserPluginManifestFile({
    manifestPath: options.manifestPath,
  });

  if (!validation.valid || validation.manifest === undefined) {
    const details = validation.errors.map((error) => `${error.path}: ${error.message}`).join('; ');

    throw new Error(`parser plugin manifest invalid: ${details}`);
  }

  const selectedFormat = validation.manifest.formats.find(
    (format) => format.id === options.requestedFormat
  );

  if (selectedFormat === undefined) {
    throw new Error(
      `parser plugin manifest does not declare requested format '${options.requestedFormat}'`
    );
  }

  if (options.sourceType === 'directory' && selectedFormat.directorySupport !== true) {
    throw new Error(
      `parser plugin format '${options.requestedFormat}' does not declare directory support; set directorySupport: true in the selected manifest format to use a directory source`
    );
  }

  const manifestFile = await describeParserPluginManifestFile(validation.manifestPath);
  await assertParserPluginInputOutsideSourceDocsArtifacts({
    kind: 'manifest',
    path: validation.manifestPath,
    outputDir: options.outputDir,
  });
  const modulePath = await resolveParserPluginModuleFile(
    validation.manifestPath,
    validation.manifest
  );
  await assertParserPluginInputOutsideSourceDocsArtifacts({
    kind: 'module',
    path: modulePath,
    outputDir: options.outputDir,
  });
  const moduleExports = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  const parser = buildExecutableParserPluginParser(
    moduleExports,
    options.requestedFormat,
    validation.manifestPath
  );

  if (parser.detect !== undefined) {
    const detected = await parser.detect(options.sourcePath);

    if (!detected) {
      throw new Error(
        `parser plugin '${parser.name}' detect returned false for source path: ${options.sourcePath}`
      );
    }
  }

  return {
    parser,
    provenance: {
      manifestPath: options.manifestPath,
      resolvedManifestPath: validation.manifestPath,
      manifestByteSize: manifestFile.byteSize,
      manifestHash: manifestFile.hash,
      name: validation.manifest.name,
      version: validation.manifest.version,
      module: {
        path: validation.manifest.module,
        resolvedPath: modulePath,
      },
      format: cloneParserPluginFormatMetadata(selectedFormat),
      execution: {
        codeExecuted: true,
        trust: 'trusted-local-code',
        sandboxed: false,
        statement:
          'Parser plugin code was executed for generation as trusted local code and was not sandboxed.',
      },
    },
  };
}

async function describeParserPluginManifestFile(
  manifestPath: string
): Promise<{ byteSize: number; hash: string }> {
  const [fileStats, hash] = await Promise.all([stat(manifestPath), sha256File(manifestPath)]);

  return {
    byteSize: fileStats.size,
    hash,
  };
}

async function resolveParserPluginModuleFile(
  manifestPath: string,
  manifest: ParserPluginManifestMetadata
): Promise<string> {
  const manifestDir = dirname(manifestPath);
  const realManifestDir = await realpath(manifestDir);
  const modulePath = resolve(manifestDir, manifest.module);
  let moduleStats: Awaited<ReturnType<typeof lstat>>;

  try {
    moduleStats = await lstat(modulePath);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new Error(`parser plugin module file not found: ${modulePath}`);
    }

    throw error;
  }

  if (moduleStats.isSymbolicLink()) {
    throw new Error(`parser plugin module must not be a symbolic link: ${modulePath}`);
  }

  if (!moduleStats.isFile()) {
    throw new Error(`parser plugin module must be a regular local file: ${modulePath}`);
  }

  const realModulePath = await realpath(modulePath);

  if (!isSameOrDescendant(realManifestDir, realModulePath)) {
    throw new Error(
      `parser plugin module must resolve inside the real manifest directory: ${manifest.module}`
    );
  }

  return realModulePath;
}

function buildExecutableParserPluginParser(
  moduleExports: Record<string, unknown>,
  requestedFormat: string,
  manifestPath: string
): SourceDocsParser {
  const exportedParser = moduleExports.default ?? moduleExports.parser;
  const parser = validateParserPluginParserExport(exportedParser, requestedFormat, manifestPath);

  return {
    name: parser.name,
    format: parser.format,
    ...(parser.detect === undefined
      ? {}
      : {
          detect: async (sourcePath: string) => {
            const detected = await parser.detect?.call(parser, sourcePath);

            if (typeof detected !== 'boolean') {
              throw new Error(
                `parser plugin '${parser.name}' detect must return a boolean for source path: ${sourcePath}`
              );
            }

            return detected;
          },
        }),
    parse: async (sourcePath: string) => {
      const root = await parser.parse.call(parser, sourcePath);

      return validateParserPluginDocNode(root, parser.name);
    },
  };
}

function validateParserPluginParserExport(
  value: unknown,
  requestedFormat: string,
  manifestPath: string
): ParserPluginParserCandidate {
  if (!isRecord(value)) {
    throw new Error(
      `parser plugin module for ${manifestPath} must export a parser object as default or named 'parser'`
    );
  }

  const name = value.name;
  const format = value.format;
  const parse = value.parse;
  const detect = value.detect;

  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('parser plugin parser.name must be a non-empty string');
  }

  if (format !== requestedFormat) {
    throw new Error(
      `parser plugin parser.format must exactly match requested --format '${requestedFormat}'`
    );
  }

  if (typeof parse !== 'function') {
    throw new Error('parser plugin parser.parse must be a function');
  }

  if (detect !== undefined && typeof detect !== 'function') {
    throw new Error('parser plugin parser.detect must be a function when provided');
  }

  return {
    name,
    format,
    parse: parse as (sourcePath: string) => unknown,
    ...(detect === undefined ? {} : { detect: detect as (sourcePath: string) => unknown }),
  };
}

function validateParserPluginDocNode(value: unknown, parserName: string): DocNode {
  const parsed = DocNodeSchema.safeParse(value);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length === 0 ? '$' : issue?.path.join('.');
    const detail =
      issue === undefined ? 'unknown validation error' : `${path ?? '$'}: ${issue.message}`;

    throw new Error(`parser plugin '${parserName}' parse returned invalid DocNode: ${detail}`);
  }

  return parsed.data;
}

function cloneParserPluginFormatMetadata(
  format: ParserPluginFormatMetadata
): ParserPluginFormatMetadata {
  return {
    id: format.id,
    displayName: format.displayName,
    extensions: [...format.extensions],
    ...(format.mediaTypes === undefined ? {} : { mediaTypes: [...format.mediaTypes] }),
    ...(format.directorySupport === undefined ? {} : { directorySupport: format.directorySupport }),
  };
}

async function resolveSourceInput(sourceInput: string): Promise<ResolvedSourceDocsInput> {
  const trimmedSource = sourceInput.trim();

  if (trimmedSource.length === 0) {
    throw new Error('generate --source requires a non-empty local file or directory path');
  }

  if (isUrlLikeInput(trimmedSource)) {
    throw new Error(
      'generate --source accepts explicit local file or directory paths only; URL-like and git inputs are not supported'
    );
  }

  const resolvedPath = resolve(trimmedSource);

  try {
    const sourceStats = await lstat(resolvedPath);

    if (sourceStats.isSymbolicLink()) {
      throw new Error(`generate --source input must not be a symbolic link: ${resolvedPath}`);
    }

    if (sourceStats.isFile()) {
      return {
        input: sourceInput,
        resolvedPath,
        type: 'file',
      };
    }

    if (sourceStats.isDirectory()) {
      return {
        input: sourceInput,
        resolvedPath,
        type: 'directory',
      };
    }

    throw new Error(`generate --source input must be a local file or directory: ${resolvedPath}`);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new Error(`generate --source path not found: ${resolvedPath}`);
    }

    throw error;
  }
}

async function assertNotDiscoveryReport(source: ResolvedSourceDocsInput): Promise<void> {
  if (source.type !== 'file') {
    return;
  }

  if (basename(source.resolvedPath) === 'discovery-report.json') {
    throw new Error(
      'generate --source requires an explicit local documentation source; discovery reports are candidate evidence for agent review and are not consumed automatically'
    );
  }

  if (extname(source.resolvedPath).toLowerCase() !== '.json') {
    return;
  }

  try {
    const parsed = await readJsonFile(source.resolvedPath);

    if (!isRecord(parsed)) {
      return;
    }

    const mode = parsed.mode;
    const looksLikeDiscoveryReport = typeof mode === 'string' && DISCOVERY_REPORT_MODES.has(mode);

    if (looksLikeDiscoveryReport || isCandidateEvidenceReportShape(parsed)) {
      throw new Error(
        'generate --source requires an explicit local documentation source; discovery reports are candidate evidence for agent review and are not consumed automatically'
      );
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return;
    }

    throw error;
  }
}

async function prepareSourceDocsInput(
  source: ResolvedSourceDocsInput,
  formatHint: ParsedFormatHint,
  exclude: string[] | undefined
): Promise<PreparedSourceDocsInput> {
  if (source.type === 'file') {
    const resolvedFormat = await resolveSourceDocsFormat(
      source.resolvedPath,
      formatHint.parserHint
    );
    const parser = getSourceDocsParser(resolvedFormat);
    const sourceFile = await describeSourceFile(
      source.resolvedPath,
      basename(source.resolvedPath),
      resolvedFormat
    );

    return {
      resolvedFormat,
      parser,
      sourceFiles: [sourceFile],
      warnings: await collectDraftWarnings([sourceFile]),
    };
  }

  if (
    formatHint.parserHint !== FormatType.AUTO &&
    !formatSupportsDirectory(formatHint.parserHint)
  ) {
    throw new Error(
      `generate --source format ${formatHint.parserHint} supports explicit local files only; directory inputs are not supported for this parser`
    );
  }

  const excludeGlobs = compileExcludeGlobs(exclude);
  const sourceFiles = await describeDirectorySourceFiles(source.resolvedPath, excludeGlobs);
  const resolvedFormat =
    formatHint.parserHint === FormatType.AUTO
      ? resolveDirectoryAutoFormat(sourceFiles.files, source.resolvedPath)
      : (formatHint.parserHint as BuiltInSourceDocsResolvedFormat);
  const selectedFiles = sourceFiles.files.filter((file) => file.format === resolvedFormat);

  if (selectedFiles.length === 0) {
    throw new Error(
      `No ${resolvedFormat} source files found under local directory: ${source.resolvedPath}`
    );
  }

  // Files collected during traversal whose format is not the resolved directory
  // format are dropped from the pack; record them as skipped so their omission
  // is a recorded fact rather than a silent gap (for example a config.json in a
  // Markdown docs tree).
  const formatNotSelected: SourceDocsSkippedFile[] = sourceFiles.files
    .filter((file) => file.format !== resolvedFormat)
    .map((file) => ({
      path: file.path,
      reason: `format '${String(file.format)}' not selected (resolved format '${String(resolvedFormat)}')`,
    }));
  const { skippedFiles, truncationWarning } = capSkippedFiles([
    ...sourceFiles.skippedFiles,
    ...formatNotSelected,
  ]);

  const warnings = [
    ...sourceFiles.warnings,
    ...excludeSummaryWarnings(sourceFiles.excluded, excludeGlobs),
    ...skippedSummaryWarnings(skippedFiles, truncationWarning),
    ...unsupportedExtensionSummaryWarnings(sourceFiles.skippedFiles),
    ...(await collectDraftWarnings(selectedFiles)),
  ];

  return {
    resolvedFormat,
    parser: getSourceDocsParser(resolvedFormat),
    sourceFiles: selectedFiles,
    warnings,
    excludeGlobs: excludeGlobs.map((entry) => entry.glob),
    excluded: sourceFiles.excluded,
    skippedFiles,
  };
}

function getSourceDocsParser(format: BuiltInSourceDocsResolvedFormat): Parser {
  const parser = getParserForFormat(format);

  if (parser === undefined) {
    throw new Error(`No parser is registered for source format: ${format}`);
  }

  return parser;
}

async function resolveSourceDocsFormat(
  sourcePath: string,
  parserHint: FormatType
): Promise<BuiltInSourceDocsResolvedFormat> {
  const resolvedFormat = await detectFormat(sourcePath, parserHint);

  if (resolvedFormat === FormatType.AUTO) {
    throw new Error(`Unable to resolve source format for: ${sourcePath}`);
  }

  return resolvedFormat as BuiltInSourceDocsResolvedFormat;
}

function formatSupportsDirectory(
  format: FormatType
): format is FormatType.MARKDOWN | FormatType.RST | FormatType.HTML {
  return format === FormatType.MARKDOWN || format === FormatType.RST || format === FormatType.HTML;
}

async function describeDirectorySourceFiles(
  rootPath: string,
  excludeGlobs: CompiledExcludeGlob[]
): Promise<SourceFileCollection> {
  const state: DirectoryTraversalState = {
    entries: 0,
    files: 0,
    warnings: [],
    excludeGlobs,
    excluded: [],
    skipped: [],
  };
  const files = await collectDirectorySourceFiles({
    rootPath,
    currentPath: rootPath,
    depth: 0,
    state,
  });

  if (files.length === 0) {
    throw new Error(`No supported source files found under local directory: ${rootPath}`);
  }

  return {
    files: files.sort((a, b) => compareStringsByCodeUnit(a.path, b.path)),
    warnings: state.warnings,
    excluded: state.excluded.sort((a, b) => compareStringsByCodeUnit(a.path, b.path)),
    skippedFiles: state.skipped,
  };
}

/**
 * Recompute the relative paths a built-in directory generation would select
 * today, using the exact traversal the generator uses (same bounds, symlink and
 * vendored-directory skips, exclude globs, and format selection). Exists so the
 * verifier's source-tier rescan can never drift from generation behavior; the
 * cost of re-describing (hashing) each candidate file is accepted for that
 * parity. Throws the same traversal-bound errors generation would.
 */
export async function scanSourceDocsDirectorySelection(options: {
  sourcePath: string;
  resolvedFormat: string;
  exclude: string[];
}): Promise<string[]> {
  const excludeGlobs = compileExcludeGlobs(options.exclude);
  const collection = await describeDirectorySourceFiles(resolve(options.sourcePath), excludeGlobs);

  return collection.files
    .filter((file) => file.format === options.resolvedFormat)
    .map((file) => file.path);
}

async function describeParserPluginDirectorySourceFiles(
  source: ResolvedSourceDocsInput,
  format: string,
  extensions: readonly string[]
): Promise<BoundedSourceFile[]> {
  const state = {
    entries: 0,
    files: 0,
  };
  const files = await collectParserPluginDirectorySourceFiles({
    rootPath: source.resolvedPath,
    currentPath: source.resolvedPath,
    depth: 0,
    format,
    // Manifest validation guarantees lowercase extensions without leading dots.
    extensionSuffixes: extensions.map((extension) => `.${extension}`),
    state,
  });

  if (files.length === 0) {
    throw new Error(
      `No source files matching the plugin's declared extensions (${extensions.join(', ')}) found under local directory: ${source.resolvedPath}`
    );
  }

  return files.sort((a, b) => compareStringsByCodeUnit(a.path, b.path));
}

async function collectParserPluginDirectorySourceFiles(options: {
  rootPath: string;
  currentPath: string;
  depth: number;
  format: string;
  extensionSuffixes: readonly string[];
  state: { entries: number; files: number };
}): Promise<BoundedSourceFile[]> {
  const { rootPath, currentPath, depth, format, extensionSuffixes, state } = options;

  if (depth > DEFAULT_SOURCE_DOCS_MAX_DEPTH) {
    throw new Error(
      `generate --source directory exceeds max traversal depth ${DEFAULT_SOURCE_DOCS_MAX_DEPTH}: ${currentPath}`
    );
  }

  const entries = (await readdir(currentPath, { withFileTypes: true })).sort((a, b) =>
    compareStringsByCodeUnit(a.name, b.name)
  );
  const files: BoundedSourceFile[] = [];

  for (const entry of entries) {
    state.entries++;

    if (state.entries > DEFAULT_SOURCE_DOCS_MAX_ENTRIES) {
      throw new Error(
        `generate --source directory exceeds max traversal entries ${DEFAULT_SOURCE_DOCS_MAX_ENTRIES}`
      );
    }

    const entryPath = join(currentPath, entry.name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      if (isSkippedTraversalDirectory(entry.name)) {
        continue;
      }

      files.push(
        ...(await collectParserPluginDirectorySourceFiles({
          rootPath,
          currentPath: entryPath,
          depth: depth + 1,
          format,
          extensionSuffixes,
          state,
        }))
      );
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const lowerCaseName = entry.name.toLowerCase();

    if (!extensionSuffixes.some((suffix) => lowerCaseName.endsWith(suffix))) {
      continue;
    }

    state.files++;

    if (state.files > DEFAULT_SOURCE_DOCS_MAX_FILES) {
      throw new Error(
        `generate --source directory exceeds max source files ${DEFAULT_SOURCE_DOCS_MAX_FILES}`
      );
    }

    files.push(
      await describeSourceFile(entryPath, relativeSourcePath(rootPath, entryPath), format)
    );
  }

  return files;
}

async function collectDirectorySourceFiles(options: {
  rootPath: string;
  currentPath: string;
  depth: number;
  state: DirectoryTraversalState;
}): Promise<BoundedSourceFile[]> {
  const { rootPath, currentPath, depth, state } = options;

  if (depth > DEFAULT_SOURCE_DOCS_MAX_DEPTH) {
    throw new Error(
      `generate --source directory exceeds max traversal depth ${DEFAULT_SOURCE_DOCS_MAX_DEPTH}: ${currentPath}`
    );
  }

  const entries = (await readdir(currentPath, { withFileTypes: true })).sort((a, b) =>
    compareStringsByCodeUnit(a.name, b.name)
  );
  const files: BoundedSourceFile[] = [];

  for (const entry of entries) {
    state.entries++;

    if (state.entries > DEFAULT_SOURCE_DOCS_MAX_ENTRIES) {
      throw new Error(
        `generate --source directory exceeds max traversal entries ${DEFAULT_SOURCE_DOCS_MAX_ENTRIES}`
      );
    }

    const entryPath = join(currentPath, entry.name);

    if (entry.isSymbolicLink()) {
      state.warnings.push(
        `Skipped symlinked source entry: ${relativeSourcePath(rootPath, entryPath)}`
      );
      continue;
    }

    if (entry.isDirectory()) {
      if (isSkippedTraversalDirectory(entry.name)) {
        state.warnings.push(
          `Skipped vendored or build directory: ${relativeSourcePath(rootPath, entryPath)}`
        );
        continue;
      }

      files.push(
        ...(await collectDirectorySourceFiles({
          rootPath,
          currentPath: entryPath,
          depth: depth + 1,
          state,
        }))
      );
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const relativePath = relativeSourcePath(rootPath, entryPath);
    const matchedGlob = matchExcludeGlob(relativePath, state.excludeGlobs);

    if (matchedGlob !== undefined) {
      state.excluded.push({ path: relativePath, glob: matchedGlob });
      continue;
    }

    const fileFormat = formatForDirectorySourceFile(entry.name);

    if (fileFormat === undefined) {
      // A regular file with no built-in documentation format is not part of the
      // pack; record the omission rather than dropping it silently.
      state.skipped.push({ path: relativePath, reason: 'unsupported-file-type' });
      continue;
    }

    state.files++;

    if (state.files > DEFAULT_SOURCE_DOCS_MAX_FILES) {
      throw new Error(
        `generate --source directory exceeds max source files ${DEFAULT_SOURCE_DOCS_MAX_FILES}`
      );
    }

    files.push(await describeSourceFile(entryPath, relativePath, fileFormat));
  }

  return files;
}

async function describeSourceFile(
  resolvedPath: string,
  manifestPath: string,
  format: SourceFileFormat
): Promise<BoundedSourceFile> {
  const [fileStats, file] = await Promise.all([
    lstat(resolvedPath),
    describeGeneratedTextOutput(resolvedPath),
  ]);

  return {
    path: normalizeManifestPath(manifestPath),
    resolvedPath,
    byteSize: fileStats.size,
    hash: file.hash,
    lineCount: file.lineCount,
    estimatedTokenCount: file.estimatedTokenCount,
    format,
  };
}

function formatForDirectorySourceFile(fileName: string): SourceFileFormat | undefined {
  const extension = extname(fileName).toLowerCase();

  if (extension === '.md' || extension === '.mdx' || extension === '.markdown') {
    return FormatType.MARKDOWN;
  }

  if (extension === '.rst') {
    return FormatType.RST;
  }

  if (extension === '.html' || extension === '.htm') {
    return FormatType.HTML;
  }

  if (extension === '.json' || extension === '.yaml' || extension === '.yml') {
    return 'structured-spec';
  }

  return undefined;
}

function resolveDirectoryAutoFormat(
  files: BoundedSourceFile[],
  sourcePath: string
): BuiltInSourceDocsResolvedFormat {
  const formats = [...new Set(files.map((file) => file.format))].sort(compareStringsByCodeUnit);
  const directoryFormats = formats.filter((format) =>
    formatSupportsDirectory(format as FormatType)
  );
  const structuredSpecOnly = formats.length === 1 && formats[0] === 'structured-spec';

  if (directoryFormats.length === 1 && formats.length === 1) {
    return directoryFormats[0] as BuiltInSourceDocsResolvedFormat;
  }

  if (structuredSpecOnly) {
    throw new Error(
      `Directory auto-detection for generate --source found only structured spec files under ${sourcePath}; pass an explicit local OpenAPI/OpenRef file instead`
    );
  }

  throw new Error(
    `Directory auto-detection for generate --source is ambiguous for ${sourcePath}; found source formats: ${formats.join(
      ', '
    )}. Specify --format markdown, rst, or html for directory generation.`
  );
}

async function parsePreparedSource(
  source: ResolvedSourceDocsInput,
  preparedSource: PreparedSourceDocsInput
): Promise<DocNode> {
  if (source.type === 'file' || preparedSource.parserPlugin !== undefined) {
    const root = await preparedSource.parser.parse(source.resolvedPath);
    // Tag the single-file section with its source relpath so the formatter emits
    // a [source:] marker and can resolve pack: links against it.
    const relpath = preparedSource.sourceFiles[0]?.path ?? basename(source.resolvedPath);
    root.metadata.set('sourceRelPath', relpath);
    return root;
  }

  const children: DocNode[] = [];

  for (const file of preparedSource.sourceFiles) {
    const child = await preparedSource.parser.parse(file.resolvedPath);
    child.metadata.set('sourceRelPath', file.path);
    children.push(child);
  }

  const title = basename(source.resolvedPath) || 'Documentation';
  const metadata = new Map<string, unknown>([
    ['format', preparedSource.resolvedFormat],
    ['sourcePath', source.resolvedPath],
    ['count', children.length],
  ]);
  const root = createDocNode(DocNodeType.ROOT, sanitizeFileSegment(title.toLowerCase()), title, {
    metadata,
  });
  root.children = children;

  return root;
}

/**
 * Group the parsed file sections under CATEGORY nodes so the formatter emits
 * per-category output files. `dirs` uses the first path segment of each file's
 * relpath (files at the root become category "root"). Explicit `categories`
 * assign by first-matching include glob in listed order; unmatched files fall to
 * the fallback category and are reported as a warning.
 */
function applySourceDocsCategories(
  root: DocNode,
  source: ResolvedSourceDocsInput,
  options: GenerateSourceDocsOptions,
  warnings: string[]
): void {
  if (options.splitBy !== undefined && options.categories !== undefined) {
    throw new Error('generate --source --split-by and --categories are mutually exclusive');
  }

  if (root.type !== DocNodeType.ROOT || source.type !== 'directory') {
    throw new Error(
      'generate --source --split-by/--categories require a directory source with multiple files'
    );
  }

  const files = root.children;
  const groups = new Map<string, { title: string; nodes: DocNode[] }>();
  const orderedIds: string[] = [];

  const pushInto = (id: string, title: string, node: DocNode): void => {
    let group = groups.get(id);
    if (group === undefined) {
      group = { title, nodes: [] };
      groups.set(id, group);
      orderedIds.push(id);
    }
    group.nodes.push(node);
  };

  const unmatched: string[] = [];

  for (const node of files) {
    const relpath = sourceRelPathOfNode(node);

    if (options.splitBy === 'dirs') {
      const segment = relpath.includes('/') ? (relpath.split('/')[0] as string) : 'root';
      pushInto(segment, segment, node);
      continue;
    }

    const config = options.categories;
    if (config === undefined) {
      continue;
    }
    const matched = config.categories.find((category) => matchesAnyGlob(relpath, category.include));
    if (matched !== undefined) {
      pushInto(matched.id, matched.title, node);
    } else {
      unmatched.push(relpath);
      pushInto(config.fallback, config.fallback, node);
    }
  }

  if (unmatched.length > 0) {
    warnings.push(
      `${unmatched.length} source file(s) matched no category and used the fallback: ${[...unmatched].sort(compareStringsByCodeUnit).join(', ')}`
    );
  }

  root.children = orderedIds.map((id) => {
    const group = groups.get(id) as { title: string; nodes: DocNode[] };
    const metadata = new Map<string, unknown>([['category', id]]);
    return createDocNode(DocNodeType.CATEGORY, sanitizeFileSegment(id), group.title, {
      children: group.nodes,
      metadata,
    });
  });
}

function sourceRelPathOfNode(node: DocNode): string {
  const relpath = node.metadata.get('sourceRelPath');
  return typeof relpath === 'string' ? relpath : '';
}

async function describeGeneratedOutputs(
  outputDir: string,
  outputPaths: string[]
): Promise<SourceDocsGeneratedOutput[]> {
  const generatedOutputs = await Promise.all(
    outputPaths.map(async (outputPath) => {
      const file = await describeGeneratedTextOutput(outputPath);

      return {
        path: relativeOutputPath(outputDir, outputPath),
        kind: 'llm-docs' as const,
        name: 'agent-readable docs text',
        byteSize: file.byteSize,
        hash: file.hash,
        lineCount: file.lineCount,
        estimatedTokenCount: file.estimatedTokenCount,
      };
    })
  );

  return generatedOutputs.sort((a, b) => compareStringsByCodeUnit(a.path, b.path));
}

async function writeSemanticChunksJsonl(
  outputDir: string,
  root: DocNode
): Promise<{ output: SourceDocsGeneratedOutput; index: SemanticChunkManifestIndex }> {
  const chunksDir = join(outputDir, SOURCE_DOCS_CHUNKS_OUTPUT_DIR);
  const chunksPath = join(chunksDir, SOURCE_DOCS_CHUNKS_JSONL);
  const chunkResult = chunkDocNode(root);
  // Index node-wide warnings by node path ONCE (O(W)) so each chunk merges its
  // warnings in O(1) instead of rescanning the whole global list per chunk
  // (which was O(chunks x warnings), i.e. O(C^2) when oversized-block warnings
  // scale with chunk count).
  const nodeWideWarnings = buildNodeWideWarningIndex(chunkResult.warnings);
  const lines = chunkResult.chunks.map((chunk) =>
    JSON.stringify(toSemanticChunkJsonlRecord(chunk, nodeWideWarnings))
  );
  const jsonl = lines.length === 0 ? '' : `${lines.join('\n')}\n`;

  await mkdir(chunksDir, { recursive: true });
  await writeTextFileSafely(chunksPath, jsonl);

  const file = await describeGeneratedTextOutput(chunksPath);
  const outputPath = relativeOutputPath(outputDir, chunksPath);

  return {
    output: {
      path: outputPath,
      kind: 'semantic-chunks-jsonl',
      name: 'semantic chunks JSONL export',
      byteSize: file.byteSize,
      hash: file.hash,
      lineCount: file.lineCount,
      estimatedTokenCount: file.estimatedTokenCount,
    },
    index: await buildSemanticChunkJsonlManifestIndex({
      manifestDir: outputDir,
      outputPath,
    }),
  };
}

function toSemanticChunkJsonlRecord(
  chunk: SemanticChunk,
  nodeWideWarnings: Map<string, SemanticChunkWarning[]>
): SemanticChunk {
  const warnings = semanticChunkWarningsForRecord(chunk, nodeWideWarnings);
  const record: SemanticChunk = {
    id: chunk.id,
    ordinal: chunk.ordinal,
    title: chunk.title,
    path: chunk.path,
    nodePath: chunk.nodePath,
    content: chunk.content,
    contentHash: chunk.contentHash,
    characterCount: chunk.characterCount,
    estimatedTokenCount: chunk.estimatedTokenCount,
    warnings,
    metadata: chunk.metadata,
  };

  if (chunk.sourceFormat !== undefined) {
    record.sourceFormat = chunk.sourceFormat;
  }
  if (chunk.sourcePath !== undefined) {
    record.sourcePath = chunk.sourcePath;
  }
  if (chunk.sourceLines !== undefined) {
    record.sourceLines = chunk.sourceLines;
  }

  return record;
}

// Block-specific warning codes are already attached to the exact chunk that
// produced them (via chunk.warnings). Merging them back from the global list by
// node path would wrongly copy one chunk's per-piece warning onto sibling
// chunks of the same node, inflating warningCount. Only node-wide warnings are
// merged.
const BLOCK_SPECIFIC_WARNING_CODES: ReadonlySet<string> = new Set([
  'hard_text_split',
  'oversized_indivisible_block',
]);

function nodePathKey(nodePath: string[]): string {
  return JSON.stringify(nodePath);
}

function buildNodeWideWarningIndex(
  globalWarnings: SemanticChunkWarning[]
): Map<string, SemanticChunkWarning[]> {
  const index = new Map<string, SemanticChunkWarning[]>();

  for (const warning of globalWarnings) {
    if (BLOCK_SPECIFIC_WARNING_CODES.has(warning.code)) {
      continue;
    }

    const key = nodePathKey(warning.nodePath);
    const bucket = index.get(key);
    if (bucket === undefined) {
      index.set(key, [warning]);
    } else {
      bucket.push(warning);
    }
  }

  return index;
}

function semanticChunkWarningsForRecord(
  chunk: SemanticChunk,
  nodeWideWarnings: Map<string, SemanticChunkWarning[]>
): SemanticChunkWarning[] {
  const warnings = [...chunk.warnings];
  const candidates = nodeWideWarnings.get(nodePathKey(chunk.nodePath)) ?? [];

  for (const warning of candidates) {
    if (warnings.some((existingWarning) => sameSemanticChunkWarning(existingWarning, warning))) {
      continue;
    }

    warnings.push({ ...warning, chunkId: chunk.id });
  }

  return warnings;
}

function sameSemanticChunkWarning(
  left: SemanticChunkWarning,
  right: SemanticChunkWarning
): boolean {
  return (
    left.code === right.code &&
    left.message === right.message &&
    sameStringArray(left.nodePath, right.nodePath)
  );
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildSourceDocsManifest(options: {
  source: ResolvedSourceDocsInput;
  formatHint: string;
  resolvedFormat: SourceDocsResolvedFormat;
  parser: SourceDocsParser;
  parserVersion?: string;
  parserPlugin?: SourceDocsParserPluginProvenance;
  generator: SourceDocsGeneratorMetadata;
  sourceFiles: BoundedSourceFile[];
  filenamePrefix: string;
  generatedOutputs: SourceDocsGeneratedOutput[];
  semanticChunkIndexes?: SemanticChunkManifestIndex[];
  preset?: SourceDocsPresetMetadata;
  gitContext?: GenerateSourceGitContext;
  label?: string;
  splitBy?: SourceDocsSplitBy;
  categories?: SourceDocsCategoriesConfig;
  excludeGlobs?: string[];
  excluded?: SourceDocsExcludedFile[];
  skippedFiles?: SourceDocsSkippedFile[];
  warnings: string[];
}): SourceDocsManifest {
  const sourceFiles: SourceDocsFileManifestEntry[] = options.sourceFiles.map((file) => ({
    path: file.path,
    resolvedPath: file.resolvedPath,
    byteSize: file.byteSize,
    hash: file.hash,
    lineCount: file.lineCount,
    estimatedTokenCount: file.estimatedTokenCount,
    format: options.resolvedFormat,
  }));
  const sourceFile = options.source.type === 'file' ? sourceFiles[0] : undefined;

  // Invariant: no two generated outputs may share a path (see
  // assertUniqueGeneratedOutputPaths). Enforced at manifest construction so a
  // reserved-name collision can never ship a masked, duplicate-path manifest.
  assertUniqueGeneratedOutputPaths(options.generatedOutputs);

  const manifest = {
    schemaVersion: SOURCE_DOCS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generator: options.generator,
    mode: SOURCE_DOCS_MODE,
    manifestContract: buildManifestContract(SOURCE_DOCS_MODE),
    source: {
      input: options.source.input,
      resolvedPath: options.source.resolvedPath,
      type: options.source.type,
      formatHint: options.formatHint,
      resolvedFormat: options.resolvedFormat,
      ...(sourceFile === undefined
        ? {
            fileCount: sourceFiles.length,
            aggregateHash: aggregateSourceFilesHash(sourceFiles),
          }
        : {
            byteSize: sourceFile.byteSize,
            hash: sourceFile.hash,
          }),
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(options.gitContext === undefined ? {} : { git: options.gitContext }),
      ...(options.excludeGlobs === undefined ? {} : { excludeGlobs: [...options.excludeGlobs] }),
      ...(options.excluded === undefined || options.excluded.length === 0
        ? {}
        : { excluded: options.excluded }),
      ...(options.skippedFiles === undefined || options.skippedFiles.length === 0
        ? {}
        : { skippedFiles: options.skippedFiles }),
    },
    sourceFiles,
    output: {
      filenamePrefix: options.filenamePrefix,
      ...(options.splitBy === undefined ? {} : { splitBy: options.splitBy }),
      ...(options.categories === undefined
        ? {}
        : { categories: cloneSourceDocsCategoriesConfig(options.categories) }),
    },
    parser: {
      name: options.parser.name,
      version: options.parserVersion ?? options.generator.version,
      format: options.resolvedFormat,
      ...(options.parserPlugin === undefined ? {} : { plugin: options.parserPlugin }),
    },
    formatter: {
      name: 'UniversalFormatter',
      version: options.generator.version,
      format: SOURCE_DOCS_FORMATTER_FORMAT,
    },
    generatedOutputs: options.generatedOutputs,
    ...(options.semanticChunkIndexes === undefined
      ? {}
      : { semanticChunkIndexes: options.semanticChunkIndexes }),
    ...(options.preset === undefined ? {} : { preset: options.preset }),
    warnings: [...new Set(options.warnings)].sort(compareStringsByCodeUnit),
  } satisfies Omit<SourceDocsManifest, 'inputProvenance' | 'artifactSummary'>;
  const manifestWithProvenance = {
    ...manifest,
    inputProvenance: buildInputProvenanceForManifest(manifest),
  };

  return {
    ...manifestWithProvenance,
    artifactSummary: buildArtifactSummaryForManifest(manifestWithProvenance),
  };
}

function isCandidateEvidenceReportShape(value: Record<string, unknown>): boolean {
  const candidates = value.candidates;

  if (!Array.isArray(candidates)) {
    return false;
  }

  if (
    isRecord(value.source) ||
    isRecord(value.repo) ||
    isRecord(value.website) ||
    isRecord(value.traversal) ||
    isRecord(value.crawlPolicy) ||
    Array.isArray(value.inspectedResources)
  ) {
    return true;
  }

  return candidates.some(
    (candidate) =>
      isRecord(candidate) &&
      (isRecord(candidate.evidence) ||
        Array.isArray(candidate.sourceResources) ||
        Array.isArray(candidate.formatHints) ||
        Array.isArray(candidate.hints))
  );
}

function collectDocNodeWarnings(root: {
  metadata?: Map<string, unknown>;
  children?: unknown[];
}): string[] {
  const warnings: string[] = [];
  const stack: unknown[] = [root];

  while (stack.length > 0) {
    const current = stack.pop();

    if (!isDocNodeLike(current)) {
      continue;
    }

    const metadataWarnings = current.metadata.get('warnings');

    if (Array.isArray(metadataWarnings)) {
      for (const warning of metadataWarnings) {
        warnings.push(formatWarning(warning));
      }
    }

    for (const child of current.children) {
      stack.push(child);
    }
  }

  return warnings.filter((warning) => warning.length > 0);
}

function formatWarning(warning: unknown): string {
  if (typeof warning === 'string') {
    return warning;
  }

  if (isRecord(warning) && typeof warning.message === 'string') {
    return warning.message;
  }

  return '';
}

function filenamePrefixForSource(sourcePath: string, type: SourceDocsSourceType): string {
  const sourceBasename = basename(sourcePath);
  const rawPrefix =
    type === 'file'
      ? sourceBasename.slice(0, sourceBasename.length - extname(sourceBasename).length)
      : sourceBasename;

  return sanitizeFileSegment(rawPrefix.toLowerCase());
}

/**
 * Remove only the artifacts this mode owns: the manifest, generated
 * `*-llms.txt` outputs (the combined `-full-llms.txt`, any per-category
 * `-<categoryId>-llms.txt`, and the `-toc-llms.txt` table of contents), and the
 * semantic-chunks JSONL. Anything else in the output tree (for example an
 * agent-authored llm-docs/index.md navigation file, which the documented
 * workflow encourages) is deliberately preserved.
 */
async function clearSourceDocsArtifacts(outputDir: string): Promise<void> {
  const llmDocsDir = join(outputDir, SOURCE_DOCS_OUTPUT_DIR);
  const chunksDir = join(outputDir, SOURCE_DOCS_CHUNKS_OUTPUT_DIR);

  await Promise.all([
    rm(join(outputDir, SOURCE_DOCS_MANIFEST), { force: true }),
    rm(join(chunksDir, SOURCE_DOCS_CHUNKS_JSONL), { force: true }),
    removeOwnedLlmDocsOutputs(llmDocsDir),
  ]);
  await removeDirectoryIfEmpty(chunksDir);
  await removeDirectoryIfEmpty(llmDocsDir);
}

async function removeOwnedLlmDocsOutputs(llmDocsDir: string): Promise<void> {
  let entries: Dirent[];

  try {
    entries = await readdir(llmDocsDir, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return;
    }

    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('-llms.txt'))
      .map((entry) => rm(join(llmDocsDir, entry.name), { force: true }))
  );
}

async function removeDirectoryIfEmpty(directoryPath: string): Promise<void> {
  try {
    await rmdir(directoryPath);
  } catch (error) {
    if (isFileNotFoundError(error) || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
      return;
    }

    throw error;
  }
}

/**
 * Refuse source inputs that overlap the artifacts this mode deletes and
 * rewrites. Both the literal and canonical (realpath) spellings of the source
 * and output roots are compared, so a symlink alias of either side (for
 * example macOS's /tmp -> /private/tmp) cannot slip a source inside the
 * cleared llm-docs/ or chunks/ directories.
 */
async function assertSourceOutsideSourceDocsArtifacts(
  source: ResolvedSourceDocsInput,
  outputDir: string
): Promise<void> {
  const outputRoots = uniquePaths([
    resolve(outputDir),
    await resolveEffectiveOutputPath(outputDir),
  ]);
  const sourcePaths = uniquePaths([source.resolvedPath, await realpath(source.resolvedPath)]);
  const label = source.type === 'file' ? 'file input' : 'directory input';

  for (const outputRoot of outputRoots) {
    const manifestPath = join(outputRoot, SOURCE_DOCS_MANIFEST);
    const llmDocsDir = join(outputRoot, SOURCE_DOCS_OUTPUT_DIR);
    const chunksDir = join(outputRoot, SOURCE_DOCS_CHUNKS_OUTPUT_DIR);

    for (const sourcePath of sourcePaths) {
      if (sourcePath === manifestPath) {
        throw new Error(
          `generate --source ${label} must not be the source-mode manifest path for --output-dir`
        );
      }

      if (isSameOrDescendant(llmDocsDir, sourcePath)) {
        throw new Error(
          `generate --source ${label} must not be inside the source-mode generated docs directory for --output-dir`
        );
      }

      if (isSameOrDescendant(chunksDir, sourcePath)) {
        throw new Error(
          `generate --source ${label} must not be inside the source-mode generated chunks directory for --output-dir`
        );
      }
    }
  }
}

async function assertParserPluginInputOutsideSourceDocsArtifacts(options: {
  kind: 'manifest' | 'module';
  path: string;
  outputDir: string;
}): Promise<void> {
  const outputRoots = uniquePaths([
    resolve(options.outputDir),
    await resolveEffectiveOutputPath(options.outputDir),
  ]);
  const inputPaths = uniquePaths([resolve(options.path), await realpath(options.path)]);
  const label = `parser plugin ${options.kind}`;

  for (const outputRoot of outputRoots) {
    const manifestPath = join(outputRoot, SOURCE_DOCS_MANIFEST);
    const llmDocsDir = join(outputRoot, SOURCE_DOCS_OUTPUT_DIR);
    const chunksDir = join(outputRoot, SOURCE_DOCS_CHUNKS_OUTPUT_DIR);

    for (const inputPath of inputPaths) {
      if (inputPath === manifestPath) {
        throw new Error(`${label} path must not be the source-docs manifest path for --output-dir`);
      }

      if (isSameOrDescendant(llmDocsDir, inputPath)) {
        throw new Error(
          `${label} path must not be inside the source-docs generated docs directory for --output-dir`
        );
      }

      if (isSameOrDescendant(chunksDir, inputPath)) {
        throw new Error(
          `${label} path must not be inside the source-docs generated chunks directory for --output-dir`
        );
      }
    }
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function isSourceDocsArtifactPath(
  sourcePath: string | undefined,
  resolvedOutputDir: string
): boolean {
  if (sourcePath === undefined) {
    return false;
  }

  const trimmedSourcePath = sourcePath.trim();

  if (trimmedSourcePath.length === 0) {
    return false;
  }

  const resolvedSourcePath = resolve(trimmedSourcePath);
  const manifestPath = join(resolvedOutputDir, SOURCE_DOCS_MANIFEST);
  const llmDocsDir = join(resolvedOutputDir, SOURCE_DOCS_OUTPUT_DIR);
  const chunksDir = join(resolvedOutputDir, SOURCE_DOCS_CHUNKS_OUTPUT_DIR);

  return (
    resolvedSourcePath === manifestPath ||
    isSameOrDescendant(llmDocsDir, resolvedSourcePath) ||
    isSameOrDescendant(chunksDir, resolvedSourcePath)
  );
}

async function assertOutputDirOutsideSource(
  source: ResolvedSourceDocsInput,
  outputDir: string
): Promise<void> {
  const canonicalSourcePath = await realpath(source.resolvedPath);
  const effectiveOutputPath = await resolveEffectiveOutputPath(outputDir);

  if (source.type === 'file') {
    if (canonicalSourcePath === effectiveOutputPath || source.resolvedPath === outputDir) {
      throw new Error('generate --source --output-dir must not be the same as the source file');
    }

    return;
  }

  if (
    isSameOrDescendant(canonicalSourcePath, effectiveOutputPath) ||
    isSameOrDescendant(source.resolvedPath, outputDir)
  ) {
    throw new Error(
      'generate --source --output-dir must not be the same as, or inside, the explicit --source directory'
    );
  }
}

function relativeSourcePath(rootPath: string, filePath: string): string {
  return normalizeManifestPath(relative(rootPath, filePath));
}

/**
 * Compile a --exclude glob subset (**, *, ?) into an anchored RegExp matched
 * against POSIX source-root-relative file paths. `**` spans path separators,
 * `*` matches within a single segment, `?` matches one non-separator character.
 * A leading `**\/` is optional so `**\/x` matches both `x` and `a/x`.
 */
function compileExcludeGlobs(exclude: string[] | undefined): CompiledExcludeGlob[] {
  if (exclude === undefined) {
    return [];
  }

  const compiled: CompiledExcludeGlob[] = [];
  const seen = new Set<string>();

  for (const rawGlob of exclude) {
    const glob = rawGlob.trim();

    if (glob.length === 0) {
      throw new Error('generate --source --exclude requires a non-empty glob pattern');
    }

    if (seen.has(glob)) {
      continue;
    }

    seen.add(glob);
    compiled.push({ glob, regex: new RegExp(`^${globToRegExpSource(glob)}$`) });
  }

  return compiled;
}

function globToRegExpSource(glob: string): string {
  let source = '';

  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];

    if (character === '*') {
      if (glob[index + 1] === '*') {
        index++;

        if (glob[index + 1] === '/') {
          index++;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += (character ?? '').replace(/[.+^${}()|[\]\\/]/g, '\\$&');
    }
  }

  return source;
}

function matchExcludeGlob(
  relativePath: string,
  excludeGlobs: CompiledExcludeGlob[]
): string | undefined {
  for (const { glob, regex } of excludeGlobs) {
    if (regex.test(relativePath)) {
      return glob;
    }
  }

  return undefined;
}

function capSkippedFiles(skippedFiles: SourceDocsSkippedFile[]): {
  skippedFiles: SourceDocsSkippedFile[];
  truncationWarning?: string;
} {
  const sorted = [...skippedFiles].sort((a, b) => compareStringsByCodeUnit(a.path, b.path));

  if (sorted.length <= SOURCE_DOCS_MAX_SKIPPED_FILES) {
    return { skippedFiles: sorted };
  }

  return {
    skippedFiles: sorted.slice(0, SOURCE_DOCS_MAX_SKIPPED_FILES),
    truncationWarning: `Skipped-file roster truncated to the first ${SOURCE_DOCS_MAX_SKIPPED_FILES} of ${sorted.length} entries in source.skippedFiles.`,
  };
}

function excludeSummaryWarnings(
  excluded: SourceDocsExcludedFile[],
  excludeGlobs: CompiledExcludeGlob[]
): string[] {
  if (excluded.length === 0) {
    return [];
  }

  const globs = excludeGlobs.map((entry) => entry.glob).join(', ');

  return [
    `Excluded ${excluded.length} file(s) from generation via --exclude pattern(s): ${globs} (see source.excluded).`,
  ];
}

function skippedSummaryWarnings(
  skippedFiles: SourceDocsSkippedFile[],
  truncationWarning: string | undefined
): string[] {
  const warnings: string[] = [];

  if (skippedFiles.length > 0) {
    warnings.push(
      `Skipped ${skippedFiles.length} file(s) not included as source in this pack (see source.skippedFiles).`
    );
  }

  if (truncationWarning !== undefined) {
    warnings.push(truncationWarning);
  }

  return warnings;
}

/**
 * Aggregate warning for real skipped content: regular files whose extension no
 * built-in parser supports (for example .pdf). Hidden files (basename starting
 * with '.') are left out of this warning because dotfiles are tooling metadata,
 * not documentation content, and counting them would bury the signal; they are
 * still listed in source.skippedFiles. Aggregated per extension with a bounded,
 * code-unit-sorted breakdown, never per file.
 */
function unsupportedExtensionSummaryWarnings(skippedFiles: SourceDocsSkippedFile[]): string[] {
  const counts = new Map<string, number>();
  let total = 0;

  for (const skipped of skippedFiles) {
    if (skipped.reason !== 'unsupported-file-type') {
      continue;
    }

    const fileName = skipped.path.split('/').at(-1) ?? skipped.path;

    if (fileName.startsWith('.')) {
      continue;
    }

    const extension = extname(fileName).toLowerCase();
    const key = extension.length === 0 ? '(no extension)' : extension;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total++;
  }

  if (total === 0) {
    return [];
  }

  const entries = [...counts.entries()].sort((a, b) => compareStringsByCodeUnit(a[0], b[0]));
  const shown = entries
    .slice(0, SOURCE_DOCS_MAX_SKIPPED_EXTENSIONS)
    .map(([extension, count]) => `${extension}: ${count}`);
  const remainder = entries.length - shown.length;
  const suffix = remainder > 0 ? `, +${remainder} more extension(s)` : '';

  return [
    `Skipped ${total} file(s) with unsupported extensions (${shown.join(', ')}${suffix}); see source.skippedFiles.`,
  ];
}

function cloneSourceDocsCategoriesConfig(
  config: SourceDocsCategoriesConfig
): SourceDocsCategoriesConfig {
  return {
    categories: config.categories.map((category) => ({
      id: category.id,
      title: category.title,
      include: [...category.include],
    })),
    fallback: config.fallback,
  };
}

/**
 * Report, without excluding, source files that look like drafts: a `.draft.md`
 * name, a `drafts/` path segment, or a first heading beginning with "DRAFT".
 * The operating agent decides whether draft content belongs in the pack; the
 * engine only surfaces the fact.
 */
async function collectDraftWarnings(files: BoundedSourceFile[]): Promise<string[]> {
  const draftPaths: string[] = [];

  for (const file of files) {
    if (draftPathSignals(file.path) || (await firstHeadingBeginsWithDraft(file.resolvedPath))) {
      draftPaths.push(file.path);
    }
  }

  if (draftPaths.length === 0) {
    return [];
  }

  draftPaths.sort(compareStringsByCodeUnit);

  return [
    `Draft-like source file(s) included as authoritative content (not excluded): ${draftPaths.join(', ')}.`,
  ];
}

function draftPathSignals(manifestPath: string): boolean {
  const segments = manifestPath.split('/');
  const fileName = segments.at(-1) ?? manifestPath;

  return /\.draft\.md$/i.test(fileName) || segments.slice(0, -1).includes('drafts');
}

async function firstHeadingBeginsWithDraft(resolvedPath: string): Promise<boolean> {
  let text: string;

  try {
    text = await readFile(resolvedPath, 'utf-8');
  } catch {
    return false;
  }

  for (const line of text.split('\n')) {
    const heading = /^\s{0,3}#{1,6}\s+(\S.*)$/.exec(line);

    if (heading !== null) {
      return (heading[1] ?? '').startsWith(DRAFT_HEADING_PREFIX);
    }
  }

  return false;
}

function relativeOutputPath(outputDir: string, outputPath: string): string {
  const relativePath = relative(outputDir, outputPath);

  // Use the shared parent-relative check so this guard matches the sibling
  // source-truth-docs / source-verification writers exactly. The prior inline
  // `startsWith('../')` missed a bare `..` (an output resolving to the output
  // dir's own parent), the exact case isParentRelativePath handles.
  if (relativePath === '' || isParentRelativePath(relativePath) || isAbsolute(relativePath)) {
    throw new Error(`generated output path escapes output directory: ${outputPath}`);
  }

  return normalizeManifestPath(relativePath);
}

function normalizeManifestPath(path: string): string {
  return path.split(sep).join('/');
}

function isDocNodeLike(value: unknown): value is {
  metadata: Map<string, unknown>;
  children: unknown[];
} {
  return isRecord(value) && value.metadata instanceof Map && Array.isArray(value.children);
}
