import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateSourceTruthDocs } from '../../src/core/source-truth-docs.js';
import { verifyGenerationManifest, writeGenerationManifest } from '../../src/core/manifest.js';

const GENERATOR = { name: 'llm-docs-generator', version: '2.0.0', cliName: 'llm-docs' } as const;

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  tempDirs.push(dir);

  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('outputs-only decoupling: source-truth-docs two-tier verify', () => {
  async function makeSourceTruthPack(): Promise<{
    manifestPath: string;
    outputDir: string;
    sourceDir: string;
    sourceFilePath: string;
  }> {
    const sourceDir = await makeTempDir('llm-docs-truth-src-');
    const sourceFilePath = join(sourceDir, 'alpha.ts');
    await writeFile(sourceFilePath, 'export const alpha = 1;\n', 'utf-8');
    const outputDir = await makeTempDir('llm-docs-truth-out-');

    const result = await generateSourceTruthDocs({ source: sourceDir, outputDir });

    return { manifestPath: result.manifestPath, outputDir, sourceDir, sourceFilePath };
  }

  it('passes both tiers for an intact pack', async () => {
    const { manifestPath } = await makeSourceTruthPack();

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.outputs?.status).toBe('passed');
    expect(result.source?.status).toBe('passed');
    expect(result.failures).toHaveLength(0);
  });

  it('still hash-checks outputs and reports the source unavailable when the source is deleted', async () => {
    const { manifestPath, sourceDir } = await makeSourceTruthPack();
    await rm(sourceDir, { recursive: true, force: true });

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.outputs?.status).toBe('passed');
    expect(result.outputs?.checkedFiles).toBeGreaterThan(0);
    expect(result.source?.status).toBe('unavailable');
    expect(result.checkedFiles).toBe(result.outputs?.checkedFiles);
    expect(
      result.failures.some((failure) => failure.includes('recorded source path is unavailable'))
    ).toBe(true);
  });

  it('fails the source tier (not unavailable) when the source is present but tampered', async () => {
    const { manifestPath, sourceFilePath } = await makeSourceTruthPack();
    await writeFile(sourceFilePath, 'export const alpha = 2;\n', 'utf-8');

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.outputs?.status).toBe('passed');
    expect(result.source?.status).toBe('failed');
    expect(result.failures.some((failure) => failure.includes('hash mismatch'))).toBe(true);
  });

  it('fails the outputs tier when a generated output is tampered, with the source intact', async () => {
    const { manifestPath, outputDir } = await makeSourceTruthPack();
    await writeFile(join(outputDir, 'source-truth.md'), 'tampered\n', 'utf-8');

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.outputs?.status).toBe('failed');
    expect(result.source?.status).toBe('passed');
  });
});

describe('outputs-only decoupling: configured-sdk two-tier verify', () => {
  async function makeConfiguredSdkPack(): Promise<{
    manifestPath: string;
    outputDir: string;
    specPath: string;
    outputPath: string;
  }> {
    const specDir = await makeTempDir('llm-docs-sdk-spec-');
    const specPath = join(specDir, 'spec.yml');
    await writeFile(specPath, 'openref: 0.1\n', 'utf-8');
    const outputDir = await makeTempDir('llm-docs-sdk-out-');
    const outputPath = join(outputDir, 'sdk-full-llms.txt');
    await writeFile(outputPath, 'generated docs\n', 'utf-8');
    const manifestPath = join(outputDir, 'manifest.json');

    await writeGenerationManifest({
      manifestPath,
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
      generator: GENERATOR,
      sdk: { name: 'javascript', resolvedVersion: 'v2', displayName: 'JavaScript' },
      source: {
        configuredUrl: 'https://example.com/spec.yml',
        configuredLocalPath: null,
        resolvedSpecPath: specPath,
        format: 'openref-0.1',
      },
      parser: { name: 'OpenRefParser', version: '1.0.0', format: 'openref-0.1' },
      formatter: { name: 'LLMFormatter', version: '1.0.0', format: 'legacy-llm-docs' },
      generatedOutputs: [{ path: outputPath, kind: 'llm-docs' }],
    });

    return { manifestPath, outputDir, specPath, outputPath };
  }

  it('passes both tiers for an intact pack', async () => {
    const { manifestPath } = await makeConfiguredSdkPack();

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.outputs?.status).toBe('passed');
    expect(result.source?.status).toBe('passed');
    expect(result.failures).toHaveLength(0);
  });

  it('still hash-checks outputs and reports the spec unavailable when the spec is deleted', async () => {
    const { manifestPath, specPath } = await makeConfiguredSdkPack();
    await rm(dirname(specPath), { recursive: true, force: true });

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.outputs?.status).toBe('passed');
    expect(result.outputs?.checkedFiles).toBe(1);
    expect(result.source?.status).toBe('unavailable');
    expect(
      result.failures.some((failure) => failure.includes('recorded source path is unavailable'))
    ).toBe(true);
  });

  it('fails the source tier (not unavailable) when the spec is present but tampered', async () => {
    const { manifestPath, specPath } = await makeConfiguredSdkPack();
    await writeFile(specPath, 'openref: 0.1 # tampered\n', 'utf-8');

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.outputs?.status).toBe('passed');
    expect(result.source?.status).toBe('failed');
    expect(result.failures.some((failure) => failure.includes('hash mismatch'))).toBe(true);
  });

  it('fails the outputs tier when the generated output is tampered, with the spec intact', async () => {
    const { manifestPath, outputPath } = await makeConfiguredSdkPack();
    await writeFile(outputPath, 'tampered docs\n', 'utf-8');

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.outputs?.status).toBe('failed');
    expect(result.source?.status).toBe('passed');
  });
});
