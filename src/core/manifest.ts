/**
 * Generation manifest writer for the configured SDK compatibility flow.
 */

import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, relative, sep } from 'node:path';

const HASH_PREFIX = 'sha256:';

export const MANIFEST_SCHEMA_VERSION = '0.1.0';
export const CONFIGURED_SDK_MODE = 'configured-sdk';

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

export async function writeGenerationManifest(
  options: WriteGenerationManifestOptions
): Promise<void> {
  const manifestDir = dirname(options.manifestPath);
  const sourceFile = await describeFile(options.source.resolvedSpecPath);

  const generatedOutputs = (
    await Promise.all(
      options.generatedOutputs
        .filter((output) => output.path !== options.manifestPath)
        .map(async (output) => {
          const file = await describeFile(output.path);

          return {
            path: toManifestRelativePath(manifestDir, output.path),
            kind: output.kind,
            byteSize: file.byteSize,
            hash: file.hash,
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
