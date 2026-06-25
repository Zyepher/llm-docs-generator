/**
 * Generation manifest writer for the configured SDK compatibility flow.
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { describeGeneratedTextOutput } from './generated-output-metadata.js';

const HASH_PREFIX = 'sha256:';

export const MANIFEST_SCHEMA_VERSION = '0.1.0';
export const CONFIGURED_SDK_MODE = 'configured-sdk';
const GENERATED_OUTPUT_KINDS = new Set<GeneratedOutputKind>(['parsed-spec-json', 'llm-docs']);

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
  const failures: string[] = [];
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

  if (mode !== CONFIGURED_SDK_MODE) {
    return {
      manifestPath,
      checkedFiles: 0,
      failures: [`unsupported manifest mode: ${String(mode)}`],
    };
  }

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

  const outputRecords = generatedOutputs as unknown[];

  for (const [index, output] of outputRecords.entries()) {
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

    if (!isGeneratedOutputKind(outputKind)) {
      failures.push(`malformed manifest: ${label}.kind must be parsed-spec-json or llm-docs`);
    }

    if (!isNonNegativeInteger(outputByteSize)) {
      failures.push(`malformed manifest: ${label}.byteSize must be a non-negative integer`);
    }

    if (!isSha256Hash(outputHash)) {
      failures.push(`malformed manifest: ${label}.hash must be a sha256 hash`);
    }

    if ('lineCount' in output && !isNonNegativeInteger(outputLineCount)) {
      failures.push(
        `malformed manifest: ${label}.lineCount must be a non-negative integer when present`
      );
    }

    if (
      'estimatedTokenCount' in output &&
      !isNonNegativeInteger(outputEstimatedTokenCount)
    ) {
      failures.push(
        `malformed manifest: ${label}.estimatedTokenCount must be a non-negative integer when present`
      );
    }

    if (
      isNonEmptyString(outputPath) &&
      !isAbsolute(outputPath) &&
      isInsideDirectory(manifestDir, resolve(manifestDir, outputPath)) &&
      isGeneratedOutputKind(outputKind) &&
      isNonNegativeInteger(outputByteSize) &&
      isSha256Hash(outputHash)
    ) {
      fileChecks.push({
        label: `output ${outputPath}`,
        path: resolve(manifestDir, outputPath),
        expectedByteSize: outputByteSize,
        expectedHash: outputHash,
      });
    }
  }

  let checkedFiles = 0;

  if (failures.length === 0) {
    await Promise.all(fileChecks.map((check) => verifyFile(check, failures)));
    checkedFiles = fileChecks.length;
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
}

async function verifyFile(check: FileCheck, failures: string[]): Promise<void> {
  let actual: { byteSize: number; hash: string };

  try {
    actual = await describeFile(check.path);
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

function isGeneratedOutputKind(value: unknown): value is GeneratedOutputKind {
  return typeof value === 'string' && GENERATED_OUTPUT_KINDS.has(value as GeneratedOutputKind);
}

function isInsideDirectory(parentDir: string, childPath: string): boolean {
  const relativePath = relative(parentDir, childPath);

  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    isObjectRecord(error) &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
