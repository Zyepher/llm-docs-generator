/**
 * Generation manifest writer for the configured SDK compatibility flow.
 */

import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { describeGeneratedTextOutput } from './generated-output-metadata.js';

const HASH_PREFIX = 'sha256:';

export const MANIFEST_SCHEMA_VERSION = '0.1.0';
export const CONFIGURED_SDK_MODE = 'configured-sdk';
const SOURCE_DOCS_MODE = 'local-source-docs';
const CONFIGURED_SDK_GENERATED_OUTPUT_KINDS = new Set<GeneratedOutputKind>([
  'parsed-spec-json',
  'llm-docs',
]);
const SOURCE_DOCS_GENERATED_OUTPUT_KINDS = new Set(['llm-docs', 'semantic-chunks-jsonl']);
const SOURCE_DOCS_SOURCE_TYPES = new Set(['file', 'directory']);
const SOURCE_DOCS_FORMAT_HINTS = new Set([
  'auto',
  'markdown',
  'mdx',
  'openapi',
  'openref',
  'rst',
  'html',
]);
const SOURCE_DOCS_RESOLVED_FORMATS = new Set(['markdown', 'openapi', 'openref', 'rst', 'html']);
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

export type GeneratedOutputKind = 'parsed-spec-json' | 'llm-docs';

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

export interface VerifyGenerationManifestResult {
  manifestPath: string;
  checkedFiles: number;
  failures: string[];
}

export async function writeGenerationManifest(
  options: WriteGenerationManifestOptions
): Promise<void> {
  const manifestDir = dirname(options.manifestPath);
  const sourceFile = await describeFile(options.source.resolvedSpecPath);

  const generatedOutputs: GeneratedOutputManifestEntry[] = (
    await Promise.all(
      options.generatedOutputs
        .filter((output) => output.path !== options.manifestPath)
        .map(async (output) => {
          const file = await describeGeneratedTextOutput(output.path);

          return {
            path: toManifestRelativePath(manifestDir, output.path),
            kind: output.kind,
            byteSize: file.byteSize,
            hash: file.hash,
            lineCount: file.lineCount,
            estimatedTokenCount: file.estimatedTokenCount,
          };
        })
    )
  ).sort((a, b) => compareStringsByCodeUnit(a.path, b.path));

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: options.generatedAt.toISOString(),
    generator: options.generator,
    mode: CONFIGURED_SDK_MODE,
    sdk: options.sdk,
    source: {
      ...options.source,
      byteSize: sourceFile.byteSize,
      contentHash: sourceFile.hash,
    },
    parser: options.parser,
    formatter: options.formatter,
    generatedOutputs,
    warnings: options.warnings ?? [],
  };

  await mkdir(manifestDir, { recursive: true });
  await writeFile(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

export async function verifyGenerationManifest(
  options: VerifyGenerationManifestOptions
): Promise<VerifyGenerationManifestResult> {
  return verifyManifestFile(options.manifestPath);
}

export async function verifyManifestFile(
  manifestPathInput: string
): Promise<VerifyGenerationManifestResult> {
  const manifestPath = resolve(manifestPathInput);
  let manifest: unknown;

  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as unknown;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {
        manifestPath,
        checkedFiles: 0,
        failures: [`manifest not found: ${manifestPath}`],
      };
    }

    return {
      manifestPath,
      checkedFiles: 0,
      failures: [`malformed manifest JSON: ${errorMessage(error)}`],
    };
  }

  if (!isObjectRecord(manifest)) {
    return {
      manifestPath,
      checkedFiles: 0,
      failures: ['malformed manifest: root must be an object'],
    };
  }

  const schemaVersion = manifest.schemaVersion;
  const mode = manifest.mode;

  if (schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return {
      manifestPath,
      checkedFiles: 0,
      failures: [`unsupported manifest schemaVersion: ${String(schemaVersion)}`],
    };
  }

  if (mode === CONFIGURED_SDK_MODE) {
    return verifyConfiguredSdkManifest(manifestPath, manifest);
  }

  if (mode === SOURCE_DOCS_MODE) {
    return verifySourceDocsManifest(manifestPath, manifest);
  }

  return {
    manifestPath,
    checkedFiles: 0,
    failures: [`unsupported manifest mode: ${String(mode)}`],
  };
}

async function verifyConfiguredSdkManifest(
  manifestPath: string,
  manifest: Record<string, unknown>
): Promise<VerifyGenerationManifestResult> {
  const failures: string[] = [];
  const source = manifest.source;
  const generatedOutputs = manifest.generatedOutputs;

  if (!isObjectRecord(source)) {
    failures.push('malformed manifest: missing source object');
  }

  if (!Array.isArray(generatedOutputs)) {
    failures.push('malformed manifest: missing generatedOutputs array');
  }

  if (failures.length > 0) {
    return {
      manifestPath,
      checkedFiles: 0,
      failures,
    };
  }

  const manifestDir = dirname(manifestPath);
  const fileChecks: FileCheck[] = [];
  const sourceRecord = source as Record<string, unknown>;
  const outputRecords = generatedOutputs as unknown[];
  const sourcePath = sourceRecord.resolvedSpecPath;
  const sourceByteSize = sourceRecord.byteSize;
  const sourceHash = sourceRecord.contentHash;

  if (!isNonEmptyString(sourcePath)) {
    failures.push('malformed manifest: source.resolvedSpecPath must be a non-empty string');
  }

  if (!isNonNegativeInteger(sourceByteSize)) {
    failures.push('malformed manifest: source.byteSize must be a non-negative integer');
  }

  if (!isSha256Hash(sourceHash)) {
    failures.push('malformed manifest: source.contentHash must be a sha256 hash');
  }

  if (
    isNonEmptyString(sourcePath) &&
    isNonNegativeInteger(sourceByteSize) &&
    isSha256Hash(sourceHash)
  ) {
    fileChecks.push({
      label: 'source',
      path: resolveManifestSourcePath(sourcePath, manifestDir),
      expectedByteSize: sourceByteSize,
      expectedHash: sourceHash,
    });
  }

  validateGeneratedOutputs({
    generatedOutputs: outputRecords,
    manifestDir,
    failures,
    fileChecks,
    requireTextMetadata: false,
    rejectSymlinks: false,
    allowedKinds: CONFIGURED_SDK_GENERATED_OUTPUT_KINDS,
  });

  return runFileChecks(manifestPath, failures, fileChecks);
}

async function verifySourceDocsManifest(
  manifestPath: string,
  manifest: Record<string, unknown>
): Promise<VerifyGenerationManifestResult> {
  const failures: string[] = [];
  const manifestDir = dirname(manifestPath);
  const source = manifest.source;
  const sourceFiles = manifest.sourceFiles;
  const generatedOutputs = manifest.generatedOutputs;
  const preset = manifest.preset;

  if (!isObjectRecord(source)) {
    failures.push('malformed manifest: missing source object');
  }

  if (!Array.isArray(sourceFiles)) {
    failures.push('malformed manifest: missing sourceFiles array');
  }

  if (!Array.isArray(generatedOutputs)) {
    failures.push('malformed manifest: missing generatedOutputs array');
  }

  if (failures.length > 0) {
    return {
      manifestPath,
      checkedFiles: 0,
      failures,
    };
  }

  const fileChecks: FileCheck[] = [];
  const pathTypeChecks: PathTypeCheck[] = [];
  const sourceRecord = source as Record<string, unknown>;
  const sourceFileRecords = sourceFiles as unknown[];
  const outputRecords = generatedOutputs as unknown[];
  const sourceInput = sourceRecord.input;
  const sourcePath = sourceRecord.resolvedPath;
  const sourceType = sourceRecord.type;
  const sourceFormatHint = sourceRecord.formatHint;
  const sourceResolvedFormat = sourceRecord.resolvedFormat;
  const sourceByteSize = sourceRecord.byteSize;
  const sourceHash = sourceRecord.hash;
  const sourceFileCount = sourceRecord.fileCount;
  const sourceAggregateHash = sourceRecord.aggregateHash;

  if (!isNonEmptyString(sourceInput)) {
    failures.push('malformed manifest: source.input must be a non-empty string');
  }

  if (!isNonEmptyString(sourceType) || !SOURCE_DOCS_SOURCE_TYPES.has(sourceType)) {
    failures.push('malformed manifest: source.type must be file or directory');
  }

  if (!isNonEmptyString(sourceFormatHint) || !SOURCE_DOCS_FORMAT_HINTS.has(sourceFormatHint)) {
    failures.push('malformed manifest: source.formatHint must be a supported source format hint');
  }

  if (
    !isNonEmptyString(sourceResolvedFormat) ||
    !SOURCE_DOCS_RESOLVED_FORMATS.has(sourceResolvedFormat)
  ) {
    failures.push('malformed manifest: source.resolvedFormat must be a supported source format');
  }

  if (!isNonEmptyString(sourcePath)) {
    failures.push('malformed manifest: source.resolvedPath must be a non-empty string');
  } else if (!isAbsolute(sourcePath)) {
    failures.push('malformed manifest: source.resolvedPath must be absolute');
  }

  if (sourceType === 'file') {
    if (!isNonNegativeInteger(sourceByteSize)) {
      failures.push('malformed manifest: source.byteSize must be a non-negative integer');
    }

    if (!isSha256Hash(sourceHash)) {
      failures.push('malformed manifest: source.hash must be a sha256 hash');
    }
  }

  if (sourceType === 'directory') {
    if (!isNonNegativeInteger(sourceFileCount)) {
      failures.push('malformed manifest: source.fileCount must be a non-negative integer');
    }

    if (!isSha256Hash(sourceAggregateHash)) {
      failures.push('malformed manifest: source.aggregateHash must be a sha256 hash');
    }
  }

  if (
    isNonEmptyString(sourcePath) &&
    isAbsolute(sourcePath) &&
    isSourceDocsSourceType(sourceType)
  ) {
    pathTypeChecks.push({
      label: 'source',
      path: sourcePath,
      expectedType: sourceType,
    });
  }

  const sourceFileEntries = validateSourceFiles({
    sourceFiles: sourceFileRecords,
    sourcePath,
    sourceType,
    sourceResolvedFormat,
    failures,
    fileChecks,
  });

  if (sourceType === 'file' && sourceFileEntries.length !== 1) {
    failures.push(
      'malformed manifest: file source manifests must contain exactly one sourceFiles entry'
    );
  }

  if (
    sourceType === 'file' &&
    sourceFileEntries.length === 1 &&
    isNonNegativeInteger(sourceByteSize) &&
    isSha256Hash(sourceHash)
  ) {
    const sourceFile = sourceFileEntries[0];

    if (sourceFile !== undefined && sourceFile.byteSize !== sourceByteSize) {
      failures.push('malformed manifest: source.byteSize must match sourceFiles[0].byteSize');
    }

    if (sourceFile !== undefined && sourceFile.hash !== sourceHash) {
      failures.push('malformed manifest: source.hash must match sourceFiles[0].hash');
    }
  }

  if (
    sourceType === 'directory' &&
    isNonNegativeInteger(sourceFileCount) &&
    sourceFileCount !== sourceFileEntries.length
  ) {
    failures.push('malformed manifest: source.fileCount must match sourceFiles length');
  }

  if (
    sourceType === 'directory' &&
    isSha256Hash(sourceAggregateHash) &&
    sourceFileEntries.length === sourceFileRecords.length
  ) {
    const actualAggregateHash = aggregateSourceFilesHash(sourceFileEntries);

    if (sourceAggregateHash !== actualAggregateHash) {
      failures.push('malformed manifest: source.aggregateHash must match sourceFiles metadata');
    }
  }

  validateGeneratedOutputs({
    generatedOutputs: outputRecords,
    manifestDir,
    failures,
    fileChecks,
    requireTextMetadata: true,
    rejectSymlinks: true,
    allowedKinds: SOURCE_DOCS_GENERATED_OUTPUT_KINDS,
  });
  validateSourceDocsPresetMetadata(preset, failures);

  if (failures.length === 0) {
    for (const check of pathTypeChecks) {
      await verifyPathType(check, failures);
    }
  }

  return runFileChecks(manifestPath, failures, fileChecks);
}

function validateGeneratedOutputs(options: {
  generatedOutputs: unknown[];
  manifestDir: string;
  failures: string[];
  fileChecks: FileCheck[];
  requireTextMetadata: boolean;
  rejectSymlinks: boolean;
  allowedKinds: ReadonlySet<string>;
}): void {
  const {
    generatedOutputs,
    manifestDir,
    failures,
    fileChecks,
    requireTextMetadata,
    rejectSymlinks,
    allowedKinds,
  } = options;

  for (const [index, output] of generatedOutputs.entries()) {
    if (!isObjectRecord(output)) {
      failures.push(`malformed manifest: generatedOutputs[${index}] must be an object`);
      continue;
    }

    const outputPath = output.path;
    const outputKind = output.kind;
    const outputByteSize = output.byteSize;
    const outputHash = output.hash;
    const outputLineCount = output.lineCount;
    const outputEstimatedTokenCount = output.estimatedTokenCount;
    const label = `output[${index}]`;

    if (!isNonEmptyString(outputPath)) {
      failures.push(`malformed manifest: ${label}.path must be a non-empty string`);
    } else if (isAbsolute(outputPath)) {
      failures.push(`malformed manifest: ${label}.path must be relative: ${outputPath}`);
    } else if (!isInsideDirectory(manifestDir, resolve(manifestDir, outputPath))) {
      failures.push(`malformed manifest: ${label}.path escapes manifest directory: ${outputPath}`);
    }

    if (!isAllowedOutputKind(outputKind, allowedKinds)) {
      failures.push(
        `malformed manifest: ${label}.kind must be ${formatAllowedOutputKinds(allowedKinds)}`
      );
    }

    if (!isNonNegativeInteger(outputByteSize)) {
      failures.push(`malformed manifest: ${label}.byteSize must be a non-negative integer`);
    }

    if (!isSha256Hash(outputHash)) {
      failures.push(`malformed manifest: ${label}.hash must be a sha256 hash`);
    }

    if (requireTextMetadata && !('lineCount' in output)) {
      failures.push(`malformed manifest: ${label}.lineCount must be a non-negative integer`);
    } else if ('lineCount' in output && !isNonNegativeInteger(outputLineCount)) {
      failures.push(
        `malformed manifest: ${label}.lineCount must be a non-negative integer${
          requireTextMetadata ? '' : ' when present'
        }`
      );
    }

    if (requireTextMetadata && !('estimatedTokenCount' in output)) {
      failures.push(
        `malformed manifest: ${label}.estimatedTokenCount must be a non-negative integer`
      );
    } else if (
      'estimatedTokenCount' in output &&
      !isNonNegativeInteger(outputEstimatedTokenCount)
    ) {
      failures.push(
        `malformed manifest: ${label}.estimatedTokenCount must be a non-negative integer${
          requireTextMetadata ? '' : ' when present'
        }`
      );
    }

    if (
      isNonEmptyString(outputPath) &&
      !isAbsolute(outputPath) &&
      isInsideDirectory(manifestDir, resolve(manifestDir, outputPath)) &&
      isAllowedOutputKind(outputKind, allowedKinds) &&
      isNonNegativeInteger(outputByteSize) &&
      isSha256Hash(outputHash) &&
      (!requireTextMetadata ||
        (isNonNegativeInteger(outputLineCount) && isNonNegativeInteger(outputEstimatedTokenCount)))
    ) {
      const expectedLineCount = requireTextMetadata ? (outputLineCount as number) : undefined;
      const expectedEstimatedTokenCount = requireTextMetadata
        ? (outputEstimatedTokenCount as number)
        : undefined;

      const fileCheck: FileCheck = {
        label: `output ${outputPath}`,
        path: resolve(manifestDir, outputPath),
        expectedByteSize: outputByteSize,
        expectedHash: outputHash,
      };

      if (rejectSymlinks) {
        fileCheck.rejectSymlink = true;
        fileCheck.trustedRoot = manifestDir;
      }

      if (expectedLineCount !== undefined) {
        fileCheck.expectedLineCount = expectedLineCount;
      }

      if (expectedEstimatedTokenCount !== undefined) {
        fileCheck.expectedEstimatedTokenCount = expectedEstimatedTokenCount;
      }

      fileChecks.push(fileCheck);
    }
  }
}

function validateSourceDocsPresetMetadata(preset: unknown, failures: string[]): void {
  for (const failure of validateSourceDocsPresetContract(preset)) {
    failures.push(`malformed manifest: ${failure}`);
  }
}

export function validateSourceDocsPresetContract(preset: unknown): string[] {
  const failures: string[] = [];

  if (preset === undefined) {
    return failures;
  }

  if (!isObjectRecord(preset)) {
    failures.push('preset must be an object when present');
    return failures;
  }

  if (preset.name !== SOURCE_DOCS_SWIFT_BOOK_PRESET_NAME) {
    failures.push(`preset.name must be ${SOURCE_DOCS_SWIFT_BOOK_PRESET_NAME}`);
  }

  if (!isNonEmptyString(preset.configPath)) {
    failures.push('preset.configPath must be a non-empty string');
  }

  if (!isNonEmptyString(preset.displayName)) {
    failures.push('preset.displayName must be a non-empty string');
  }

  const defaults = preset.defaults;
  if (!isObjectRecord(defaults)) {
    failures.push('preset.defaults must be an object');
  } else {
    if (defaults.format !== 'markdown') {
      failures.push('preset.defaults.format must be markdown');
    }

    if (!isNonEmptyString(defaults.filenamePrefix)) {
      failures.push('preset.defaults.filenamePrefix must be a non-empty string');
    }

    if (!isNonEmptyString(defaults.title)) {
      failures.push('preset.defaults.title must be a non-empty string');
    }

    if (!isNonEmptyString(defaults.systemPrompt)) {
      failures.push('preset.defaults.systemPrompt must be a non-empty string');
    } else {
      const unsupportedPromptClaims = findUnsupportedPresetPromptClaims(defaults.systemPrompt);

      if (unsupportedPromptClaims.length > 0) {
        failures.push(
          `preset.defaults.systemPrompt must not claim ${formatList(unsupportedPromptClaims)}`
        );
      }
    }

    if (
      'outputFormats' in defaults &&
      (!Array.isArray(defaults.outputFormats) ||
        !defaults.outputFormats.every((format) => isNonEmptyString(format)))
    ) {
      failures.push(
        'preset.defaults.outputFormats must be an array of non-empty strings when present'
      );
    }
  }

  const metadata = preset.metadata;
  if (!isObjectRecord(metadata)) {
    failures.push('preset.metadata must be an object');
  } else {
    for (const [field, expectedValue] of Object.entries(SOURCE_DOCS_SWIFT_BOOK_PRESET_METADATA)) {
      if (metadata[field] !== expectedValue) {
        failures.push(`preset.metadata.${field} must be ${expectedValue}`);
      }
    }
  }

  if (!Array.isArray(preset.limitations)) {
    failures.push('preset.limitations must be an array');
    return failures;
  }

  if (!preset.limitations.every((limitation) => isNonEmptyString(limitation))) {
    failures.push('preset.limitations must contain only non-empty strings');
    return failures;
  }

  for (const limitation of SOURCE_DOCS_SWIFT_BOOK_PRESET_LIMITATIONS) {
    if (!preset.limitations.includes(limitation)) {
      failures.push(`preset.limitations must include "${limitation}"`);
    }
  }

  return failures;
}

function findUnsupportedPresetPromptClaims(prompt: string): string[] {
  const normalizedPrompt = prompt.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const claims: string[] = [];

  if (/\b(complete|completeness|comprehensive)\b/.test(normalizedPrompt)) {
    claims.push('completeness');
  }

  if (/\bsource truth\b/.test(normalizedPrompt)) {
    claims.push('source truth');
  }

  if (/\b(verified|verification|validated|validation)\b/.test(normalizedPrompt)) {
    claims.push('source verification');
  }

  if (/\b(authoritative|authority|official)\b/.test(normalizedPrompt)) {
    claims.push('authority or official status');
  }

  return claims;
}

function formatList(values: string[]): string {
  if (values.length <= 1) {
    return values[0] ?? '';
  }

  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}

interface SourceFileEntry {
  path: string;
  resolvedPath: string;
  byteSize: number;
  hash: string;
  format: string;
}

function validateSourceFiles(options: {
  sourceFiles: unknown[];
  sourcePath: unknown;
  sourceType: unknown;
  sourceResolvedFormat: unknown;
  failures: string[];
  fileChecks: FileCheck[];
}): SourceFileEntry[] {
  const { sourceFiles, sourcePath, sourceType, sourceResolvedFormat, failures, fileChecks } =
    options;
  const sourceFileEntries: SourceFileEntry[] = [];
  const sourceRoot =
    isNonEmptyString(sourcePath) && isAbsolute(sourcePath) ? sourcePath : undefined;
  const trustedRoot =
    sourceRoot === undefined
      ? undefined
      : sourceType === 'directory'
        ? sourceRoot
        : dirname(sourceRoot);

  for (const [index, sourceFile] of sourceFiles.entries()) {
    const label = `sourceFiles[${index}]`;

    if (!isObjectRecord(sourceFile)) {
      failures.push(`malformed manifest: ${label} must be an object`);
      continue;
    }

    const sourceFilePath = sourceFile.path;
    const sourceFileResolvedPath = sourceFile.resolvedPath;
    const sourceFileByteSize = sourceFile.byteSize;
    const sourceFileHash = sourceFile.hash;
    const sourceFileFormat = sourceFile.format;

    if (!isNonEmptyString(sourceFilePath)) {
      failures.push(`malformed manifest: ${label}.path must be a non-empty string`);
    } else if (isAbsolute(sourceFilePath)) {
      failures.push(`malformed manifest: ${label}.path must be relative: ${sourceFilePath}`);
    } else if (
      sourceRoot !== undefined &&
      sourceType === 'directory' &&
      !isInsideDirectory(sourceRoot, resolve(sourceRoot, sourceFilePath))
    ) {
      failures.push(`malformed manifest: ${label}.path escapes source root: ${sourceFilePath}`);
    }

    if (!isNonEmptyString(sourceFileResolvedPath)) {
      failures.push(`malformed manifest: ${label}.resolvedPath must be a non-empty string`);
    } else if (!isAbsolute(sourceFileResolvedPath)) {
      failures.push(`malformed manifest: ${label}.resolvedPath must be absolute`);
    } else if (
      sourceRoot !== undefined &&
      sourceType === 'directory' &&
      !isInsideDirectory(sourceRoot, sourceFileResolvedPath)
    ) {
      failures.push(
        `malformed manifest: ${label}.resolvedPath escapes source root: ${sourceFileResolvedPath}`
      );
    }

    if (
      sourceRoot !== undefined &&
      isNonEmptyString(sourceFilePath) &&
      !isAbsolute(sourceFilePath) &&
      isNonEmptyString(sourceFileResolvedPath) &&
      isAbsolute(sourceFileResolvedPath) &&
      isSourceDocsSourceType(sourceType)
    ) {
      const expectedResolvedPath =
        sourceType === 'directory'
          ? resolve(sourceRoot, sourceFilePath)
          : resolve(dirname(sourceRoot), sourceFilePath);

      if (expectedResolvedPath !== sourceFileResolvedPath) {
        failures.push(
          `malformed manifest: ${label}.resolvedPath must match ${label}.path under source.resolvedPath`
        );
      }

      if (sourceType === 'file' && sourceFileResolvedPath !== sourceRoot) {
        failures.push(
          `malformed manifest: ${label}.resolvedPath must match source.resolvedPath for file sources`
        );
      }
    }

    if (!isNonNegativeInteger(sourceFileByteSize)) {
      failures.push(`malformed manifest: ${label}.byteSize must be a non-negative integer`);
    }

    if (!isSha256Hash(sourceFileHash)) {
      failures.push(`malformed manifest: ${label}.hash must be a sha256 hash`);
    }

    if (!isNonEmptyString(sourceFileFormat)) {
      failures.push(`malformed manifest: ${label}.format must be a non-empty string`);
    } else if (
      isNonEmptyString(sourceResolvedFormat) &&
      SOURCE_DOCS_RESOLVED_FORMATS.has(sourceResolvedFormat) &&
      sourceFileFormat !== sourceResolvedFormat
    ) {
      failures.push(`malformed manifest: ${label}.format must match source.resolvedFormat`);
    }

    if (
      isNonEmptyString(sourceFilePath) &&
      !isAbsolute(sourceFilePath) &&
      isNonEmptyString(sourceFileResolvedPath) &&
      isAbsolute(sourceFileResolvedPath) &&
      isNonNegativeInteger(sourceFileByteSize) &&
      isSha256Hash(sourceFileHash) &&
      isNonEmptyString(sourceFileFormat)
    ) {
      sourceFileEntries.push({
        path: sourceFilePath,
        resolvedPath: sourceFileResolvedPath,
        byteSize: sourceFileByteSize,
        hash: sourceFileHash,
        format: sourceFileFormat,
      });
      const fileCheck: FileCheck = {
        label,
        path: sourceFileResolvedPath,
        expectedByteSize: sourceFileByteSize,
        expectedHash: sourceFileHash,
        rejectSymlink: true,
      };

      if (trustedRoot !== undefined) {
        fileCheck.trustedRoot = trustedRoot;
      }

      fileChecks.push(fileCheck);
    }
  }

  return sourceFileEntries;
}

async function runFileChecks(
  manifestPath: string,
  failures: string[],
  fileChecks: FileCheck[]
): Promise<VerifyGenerationManifestResult> {
  const checkedFiles = failures.length === 0 ? fileChecks.length : 0;

  if (failures.length === 0) {
    for (const check of fileChecks) {
      await verifyFile(check, failures);
    }
  }

  return {
    manifestPath,
    checkedFiles,
    failures,
  };
}

async function describeFile(path: string): Promise<{ byteSize: number; hash: string }> {
  const [fileStats, hash] = await Promise.all([stat(path), sha256File(path)]);

  return {
    byteSize: fileStats.size,
    hash,
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  return `${HASH_PREFIX}${hash.digest('hex')}`;
}

function toManifestRelativePath(manifestDir: string, outputPath: string): string {
  return relative(manifestDir, outputPath).split(sep).join('/');
}

function resolveManifestSourcePath(sourcePath: string, manifestDir: string): string {
  if (isAbsolute(sourcePath)) {
    return sourcePath;
  }

  return resolve(manifestDir, sourcePath);
}

function compareStringsByCodeUnit(a: string, b: string): number {
  const length = Math.min(a.length, b.length);

  for (let index = 0; index < length; index++) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);

    if (difference !== 0) {
      return difference;
    }
  }

  return a.length - b.length;
}

interface FileCheck {
  label: string;
  path: string;
  expectedByteSize: number;
  expectedHash: string;
  expectedLineCount?: number;
  expectedEstimatedTokenCount?: number;
  rejectSymlink?: boolean;
  trustedRoot?: string;
}

interface PathTypeCheck {
  label: string;
  path: string;
  expectedType: 'file' | 'directory';
}

async function verifyFile(check: FileCheck, failures: string[]): Promise<void> {
  let actual: {
    byteSize: number;
    hash: string;
    lineCount?: number;
    estimatedTokenCount?: number;
  };

  try {
    if (check.rejectSymlink === true) {
      const pathIsAllowed = await verifyNoSymlinkPathComponents(
        {
          label: check.label,
          path: check.path,
          trustedRoot: check.trustedRoot ?? dirname(check.path),
        },
        failures
      );

      if (!pathIsAllowed) {
        return;
      }
    }

    actual =
      check.expectedLineCount === undefined && check.expectedEstimatedTokenCount === undefined
        ? await describeFile(check.path)
        : await describeGeneratedTextOutput(check.path);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      failures.push(`${check.label}: missing file at ${check.path}`);
      return;
    }

    failures.push(`${check.label}: cannot read ${check.path}: ${errorMessage(error)}`);
    return;
  }

  if (actual.byteSize !== check.expectedByteSize) {
    failures.push(
      `${check.label}: byte size mismatch (expected ${check.expectedByteSize}, actual ${actual.byteSize})`
    );
  }

  if (actual.hash !== check.expectedHash) {
    failures.push(
      `${check.label}: hash mismatch (expected ${check.expectedHash}, actual ${actual.hash})`
    );
  }

  if (check.expectedLineCount !== undefined && actual.lineCount !== check.expectedLineCount) {
    failures.push(
      `${check.label}: line count mismatch (expected ${check.expectedLineCount}, actual ${String(
        actual.lineCount
      )})`
    );
  }

  if (
    check.expectedEstimatedTokenCount !== undefined &&
    actual.estimatedTokenCount !== check.expectedEstimatedTokenCount
  ) {
    failures.push(
      `${check.label}: estimated token count mismatch (expected ${check.expectedEstimatedTokenCount}, actual ${String(
        actual.estimatedTokenCount
      )})`
    );
  }
}

async function verifyNoSymlinkPathComponents(
  check: { label: string; path: string; trustedRoot: string },
  failures: string[]
): Promise<boolean> {
  const trustedRoot = resolve(check.trustedRoot);
  const targetPath = resolve(check.path);
  const relativePath = relative(trustedRoot, targetPath);

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    failures.push(`${check.label}: path escapes trusted root: ${targetPath}`);
    return false;
  }

  const pathParts = relativePath === '' ? [] : relativePath.split(sep).filter(Boolean);
  let currentPath = trustedRoot;

  if (pathParts.length === 0) {
    return verifyNoSymlinkPathComponent({
      label: check.label,
      path: currentPath,
      targetPath,
      isLeaf: true,
      failures,
    });
  }

  for (const [index, pathPart] of pathParts.entries()) {
    currentPath = resolve(currentPath, pathPart);

    const pathIsAllowed = await verifyNoSymlinkPathComponent({
      label: check.label,
      path: currentPath,
      targetPath,
      isLeaf: index === pathParts.length - 1,
      failures,
    });

    if (!pathIsAllowed) {
      return false;
    }
  }

  return true;
}

async function verifyNoSymlinkPathComponent(options: {
  label: string;
  path: string;
  targetPath: string;
  isLeaf: boolean;
  failures: string[];
}): Promise<boolean> {
  const { label, path, targetPath, isLeaf, failures } = options;
  let stats;

  try {
    stats = await lstat(path);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      failures.push(
        isLeaf
          ? `${label}: missing file at ${targetPath}`
          : `${label}: missing path component at ${path}`
      );
      return false;
    }

    failures.push(`${label}: cannot inspect ${path}: ${errorMessage(error)}`);
    return false;
  }

  if (stats.isSymbolicLink()) {
    failures.push(`${label}: symbolic links are not allowed in path at ${path}`);
    return false;
  }

  if (isLeaf && !stats.isFile()) {
    failures.push(`${label}: expected file at ${path}`);
    return false;
  }

  if (!isLeaf && !stats.isDirectory()) {
    failures.push(`${label}: expected directory at ${path}`);
    return false;
  }

  return true;
}

async function verifyPathType(check: PathTypeCheck, failures: string[]): Promise<void> {
  let stats;

  try {
    stats = await lstat(check.path);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      failures.push(`${check.label}: missing ${check.expectedType} at ${check.path}`);
      return;
    }

    failures.push(`${check.label}: cannot inspect ${check.path}: ${errorMessage(error)}`);
    return;
  }

  if (
    (check.expectedType === 'file' && !stats.isFile()) ||
    (check.expectedType === 'directory' && !stats.isDirectory())
  ) {
    failures.push(`${check.label}: expected ${check.expectedType} at ${check.path}`);
  }
}

function aggregateSourceFilesHash(files: SourceFileEntry[]): string {
  const hash = createHash('sha256');
  hash.update('llm-docs-generator:source-docs-directory:v1\n');

  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.byteSize));
    hash.update('\0');
    hash.update(file.hash);
    hash.update('\n');
  }

  return `${HASH_PREFIX}${hash.digest('hex')}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isSha256Hash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isAllowedOutputKind(value: unknown, allowedKinds: ReadonlySet<string>): value is string {
  return typeof value === 'string' && allowedKinds.has(value);
}

function formatAllowedOutputKinds(allowedKinds: ReadonlySet<string>): string {
  const kinds = [...allowedKinds];

  if (kinds.length <= 1) {
    return kinds[0] ?? 'a supported output kind';
  }

  return `${kinds.slice(0, -1).join(', ')} or ${kinds[kinds.length - 1]}`;
}

function isSourceDocsSourceType(value: unknown): value is 'file' | 'directory' {
  return typeof value === 'string' && SOURCE_DOCS_SOURCE_TYPES.has(value);
}

function isInsideDirectory(parentDir: string, childPath: string): boolean {
  const relativePath = relative(parentDir, childPath);

  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isFileNotFoundError(error: unknown): boolean {
  return isObjectRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
