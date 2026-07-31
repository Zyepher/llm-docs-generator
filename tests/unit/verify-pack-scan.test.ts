import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateSourceDocs } from '../../src/core/source-docs.js';
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

async function makeSourceDocsPack(): Promise<{ manifestPath: string; outputDir: string }> {
  const source = await makeTempDir('llm-docs-scan-src-');
  await writeFile(join(source, 'a.md'), '# A\n\nbody\n', 'utf-8');
  const outputDir = await makeTempDir('llm-docs-scan-out-');

  const result = await generateSourceDocs({
    source,
    outputDir,
    format: 'markdown',
    generator: GENERATOR,
  });

  return { manifestPath: result.manifestPath, outputDir };
}

describe('verify pack-directory scan (unlisted files)', () => {
  it('verifies a fresh pack clean, reporting only the seeded index as unmanaged', async () => {
    const { manifestPath } = await makeSourceDocsPack();

    const result = await verifyGenerationManifest({ manifestPath });

    // The seeded llm-docs/index.md is agent-owned by design: never listed in
    // generatedOutputs, reported informationally, and never a failure.
    expect(result.outputs?.status).toBe('passed');
    expect(result.failures).toHaveLength(0);
    expect(result.unmanagedFiles).toEqual(['llm-docs/index.md']);
  });

  it('fails when an unlisted file matches the tool output naming', async () => {
    const { manifestPath, outputDir } = await makeSourceDocsPack();
    await writeFile(join(outputDir, 'evil-llms.txt'), 'not a generated output\n', 'utf-8');

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.outputs?.status).toBe('failed');
    expect(
      result.failures.some(
        (failure) =>
          failure.includes(
            'unlisted file matches generated-output naming; not covered by this manifest'
          ) && failure.includes('evil-llms.txt')
      )
    ).toBe(true);
  });

  it('fails a nested manifest.json but exempts the root manifest', async () => {
    const { manifestPath, outputDir } = await makeSourceDocsPack();
    await mkdir(join(outputDir, 'nested'), { recursive: true });
    await writeFile(join(outputDir, 'nested', 'manifest.json'), '{}\n', 'utf-8');

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.outputs?.status).toBe('failed');
    expect(
      result.failures.some(
        (failure) =>
          failure.includes('unlisted file matches generated-output naming') &&
          failure.includes('nested/manifest.json')
      )
    ).toBe(true);
    // The root manifest itself is never reported.
    expect(
      result.failures.some((failure) => failure.endsWith('this manifest: manifest.json'))
    ).toBe(false);
  });

  it('reports index.md and .DS_Store as unmanaged, never as failures', async () => {
    const { manifestPath, outputDir } = await makeSourceDocsPack();
    await writeFile(join(outputDir, 'index.md'), '# Nav\n', 'utf-8');
    await writeFile(join(outputDir, '.DS_Store'), 'junk', 'utf-8');

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.outputs?.status).toBe('passed');
    expect(result.failures).toHaveLength(0);
    expect(result.unmanagedFiles).toEqual(['.DS_Store', 'index.md', 'llm-docs/index.md']);
  });

  it('reports an unlisted symlink as unmanaged with a note and never follows it', async () => {
    const { manifestPath, outputDir } = await makeSourceDocsPack();
    const targetDir = await makeTempDir('llm-docs-scan-target-');
    await writeFile(join(targetDir, 'target-llms.txt'), 'outside content\n', 'utf-8');
    await symlink(join(targetDir, 'target-llms.txt'), join(outputDir, 'linked-llms.txt'));

    const result = await verifyGenerationManifest({ manifestPath });

    // A symlink is never followed or hashed, so even a tool-pattern name is
    // reported informationally rather than failed.
    expect(result.failures).toHaveLength(0);
    expect(result.unmanagedFiles).toEqual([
      'linked-llms.txt (symbolic link; not followed)',
      'llm-docs/index.md',
    ]);
  });

  it('bounds the unmanaged listing to 20 entries plus a +N more marker', async () => {
    const { manifestPath, outputDir } = await makeSourceDocsPack();

    for (let index = 0; index < 25; index++) {
      await writeFile(
        join(outputDir, `stray-${String(index).padStart(2, '0')}.txt`),
        'stray\n',
        'utf-8'
      );
    }

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.failures).toHaveLength(0);
    expect(result.unmanagedFiles).toHaveLength(21);
    expect(result.unmanagedFiles?.at(0)).toBe('llm-docs/index.md');
    expect(result.unmanagedFiles?.at(1)).toBe('stray-00.txt');
    expect(result.unmanagedFiles?.at(-1)).toBe('+6 more');
  });

  it('applies the pack scan in configured-sdk mode too', async () => {
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

    await writeFile(join(outputDir, 'planted-llms.txt'), 'planted\n', 'utf-8');
    await writeFile(join(outputDir, 'notes.md'), 'notes\n', 'utf-8');

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.outputs?.status).toBe('failed');
    expect(
      result.failures.some(
        (failure) =>
          failure.includes('unlisted file matches generated-output naming') &&
          failure.includes('planted-llms.txt')
      )
    ).toBe(true);
    expect(result.unmanagedFiles).toEqual(['notes.md']);
  });
});
