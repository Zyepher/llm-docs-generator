import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertUniqueGeneratedOutputPaths } from '../../src/core/generated-output-metadata.js';
import { generateSourceDocs, type SourceDocsManifest } from '../../src/core/source-docs.js';
import { verifyGenerationManifest } from '../../src/core/manifest.js';

const GENERATOR = { name: 'llm-docs-generator', version: '2.0.0', cliName: 'llm-docs' } as const;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeCorpus(): Promise<{ manifestPath: string; manifest: SourceDocsManifest }> {
  const source = await mkdtemp(join(tmpdir(), 'llm-docs-outpaths-src-'));
  tempDirs.push(source);
  const outputDir = await mkdtemp(join(tmpdir(), 'llm-docs-outpaths-out-'));
  tempDirs.push(outputDir);
  const filePath = join(source, 'guide', 'intro.md');
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, '# Intro\n\nbody\n', 'utf-8');
  await writeFile(join(source, 'overview.md'), '# Overview\n\nbody\n', 'utf-8');

  const result = await generateSourceDocs({
    source,
    outputDir,
    format: 'markdown',
    generator: GENERATOR,
    splitBy: 'dirs',
  });
  return { manifestPath: result.manifestPath, manifest: result.manifest };
}

describe('assertUniqueGeneratedOutputPaths (manifest invariant)', () => {
  it('accepts a list with all-distinct paths', () => {
    expect(() =>
      assertUniqueGeneratedOutputPaths([{ path: 'a-llms.txt' }, { path: 'b-llms.txt' }])
    ).not.toThrow();
  });

  it('accepts an empty list', () => {
    expect(() => assertUniqueGeneratedOutputPaths([])).not.toThrow();
  });

  it('throws, naming the repeated path, when two entries share a path', () => {
    expect(() =>
      assertUniqueGeneratedOutputPaths([
        { path: 'dup-llms.txt' },
        { path: 'other-llms.txt' },
        { path: 'dup-llms.txt' },
      ])
    ).toThrow(/duplicate path dup-llms\.txt/);
  });

  it('holds for a real generated manifest (never emits duplicate paths)', async () => {
    const { manifest } = await makeCorpus();
    const paths = manifest.generatedOutputs.map((output) => output.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(() => assertUniqueGeneratedOutputPaths(manifest.generatedOutputs)).not.toThrow();
  });
});

describe('verify: duplicate generatedOutputs path detection', () => {
  it('a clean manifest verifies with no duplicate-path failure', async () => {
    const { manifestPath } = await makeCorpus();
    const result = await verifyGenerationManifest({ manifestPath });
    expect(result.outputs?.status).toBe('passed');
    expect(result.failures.some((failure) => failure.includes('duplicates an earlier'))).toBe(
      false
    );
  });

  it('flags a manifest whose generatedOutputs repeats a path (verify masking guard)', async () => {
    const { manifestPath } = await makeCorpus();
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as SourceDocsManifest;

    // Simulate the masking a reserved-name collision produced before the fix: a
    // second generatedOutputs entry pointing at an already-recorded output. It
    // hash-checks clean (the file exists and matches), so only the new
    // duplicate-path guard can catch it.
    const first = manifest.generatedOutputs[0];
    expect(first).toBeDefined();
    manifest.generatedOutputs.push({
      ...(first as SourceDocsManifest['generatedOutputs'][number]),
    });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    const result = await verifyGenerationManifest({ manifestPath });

    expect(
      result.failures.some(
        (failure) =>
          failure.includes('duplicates an earlier generatedOutputs path') &&
          failure.includes(first?.path ?? '<missing>')
      )
    ).toBe(true);
  });
});
