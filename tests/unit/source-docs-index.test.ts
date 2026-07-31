import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateSourceDocs } from '../../src/core/source-docs.js';
import { refreshGenerationManifest } from '../../src/core/refresh.js';

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

async function makeDocsSourceDir(): Promise<string> {
  const source = await makeTempDir('llm-docs-index-src-');

  await mkdir(join(source, 'guide'), { recursive: true });
  await mkdir(join(source, 'api'), { recursive: true });
  await writeFile(join(source, 'guide', 'intro.md'), '# Introduction\n\nGuide body.\n', 'utf-8');
  await writeFile(join(source, 'api', 'reference.md'), '# Reference\n\nApi body.\n', 'utf-8');

  return source;
}

describe('seeded llm-docs/index.md', () => {
  it('seeds a deterministic starter index for a single-file pack', async () => {
    const dir = await makeTempDir('llm-docs-index-single-');
    const sourcePath = join(dir, 'docs.md');
    await writeFile(sourcePath, '# Docs\n\n## Intro\n\nHello.\n', 'utf-8');
    const outputDir = join(dir, 'output');

    const result = await generateSourceDocs({
      source: sourcePath,
      outputDir,
      format: 'markdown',
      generator: GENERATOR,
    });
    const index = await readFile(join(result.llmDocsDir, 'index.md'), 'utf-8');
    const fullOutput = result.manifest.generatedOutputs.find((output) =>
      output.path.endsWith('-full-llms.txt')
    );
    const tocOutput = result.manifest.generatedOutputs.find((output) =>
      output.path.endsWith('-toc-llms.txt')
    );

    expect(result.indexSeeded).toBe(true);
    expect(index).toContain('# docs.md: pack index');
    expect(index).toContain('yours to edit and extend');
    expect(index).toContain('not part of the verified pack');
    // No dates and no machine paths: the file must be byte-stable across runs.
    expect(index).not.toContain(outputDir);
    expect(index).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // Inventory rows carry the manifest's own token estimates.
    expect(fullOutput).toBeDefined();
    expect(tocOutput).toBeDefined();
    expect(index).toContain(
      `| ${fullOutput?.path} | ${fullOutput?.estimatedTokenCount} | Full pack: 1. Intro |`
    );
    expect(index).toContain(
      `| ${tocOutput?.path} | ${tocOutput?.estimatedTokenCount} | Table of contents for the full pack |`
    );
    // Agent-owned by design: never a recorded output of the tool.
    expect(
      result.manifest.generatedOutputs.some((output) => output.path.endsWith('index.md'))
    ).toBe(false);
  });

  it('lists each category slice with its own top-level sections', async () => {
    const source = await makeDocsSourceDir();
    const outputDir = await makeTempDir('llm-docs-index-split-');

    const result = await generateSourceDocs({
      source,
      outputDir,
      format: 'markdown',
      splitBy: 'dirs',
      output: { filenamePrefix: 'demo' },
      generator: GENERATOR,
    });
    const index = await readFile(join(result.llmDocsDir, 'index.md'), 'utf-8');

    expect(result.indexSeeded).toBe(true);
    // The full file lists the categories; each slice lists its file sections.
    expect(index).toMatch(
      /\| llm-docs\/demo-full-llms\.txt \| \d+ \| Full pack: 1\. api; 2\. guide \|/
    );
    expect(index).toMatch(/\| llm-docs\/demo-api-llms\.txt \| \d+ \| Slice: 1\. Reference \|/);
    expect(index).toMatch(/\| llm-docs\/demo-guide-llms\.txt \| \d+ \| Slice: 1\. Introduction \|/);
  });

  it('mentions the chunks export and pinned git provenance when recorded', async () => {
    const source = await makeDocsSourceDir();
    const outputDir = await makeTempDir('llm-docs-index-chunks-');

    const result = await generateSourceDocs({
      source,
      outputDir,
      format: 'markdown',
      chunks: 'jsonl',
      label: 'widget@2.0.0 @ cafe123',
      gitContext: {
        remoteUrl: 'https://github.com/acme/widget',
        commit: 'cafe1234',
        tags: ['v2.0.0'],
        dirty: false,
        sourceRootFromRepo: 'docs',
      },
      generator: GENERATOR,
    });
    const index = await readFile(join(result.llmDocsDir, 'index.md'), 'utf-8');

    expect(index).toContain('# widget@2.0.0 @ cafe123: pack index');
    expect(index).toContain(
      'Pinned source: https://github.com/acme/widget@cafe1234 (tags: v2.0.0)'
    );
    expect(index).toMatch(
      /\| chunks\/semantic-chunks\.jsonl \| \d+ \| Semantic chunk export, one JSON record per line \|/
    );
  });

  it('preserves an edited index byte-identical through regenerate and refresh', async () => {
    const source = await makeDocsSourceDir();
    const outputDir = await makeTempDir('llm-docs-index-preserve-');
    const options = {
      source,
      outputDir,
      format: 'markdown',
      generator: GENERATOR,
    } as const;

    const first = await generateSourceDocs(options);
    const indexPath = join(first.llmDocsDir, 'index.md');
    const edited = '# My own index\n\nCurated by the agent, with | pipes and notes.\n';
    await writeFile(indexPath, edited, 'utf-8');

    const second = await generateSourceDocs(options);

    expect(first.indexSeeded).toBe(true);
    expect(second.indexSeeded).toBe(false);
    expect(await readFile(indexPath, 'utf-8')).toBe(edited);

    const refresh = await refreshGenerationManifest({
      manifestPath: second.manifestPath,
      generator: GENERATOR,
    });

    expect(refresh.postRefreshVerification.status).toBe('passed');
    expect(await readFile(indexPath, 'utf-8')).toBe(edited);
  });

  it('reseeds on regenerate only when the index is absent', async () => {
    const dir = await makeTempDir('llm-docs-index-reseed-');
    const sourcePath = join(dir, 'docs.md');
    await writeFile(sourcePath, '# Docs\n\nBody.\n', 'utf-8');
    const outputDir = join(dir, 'output');
    const options = {
      source: sourcePath,
      outputDir,
      format: 'markdown',
      generator: GENERATOR,
    } as const;

    const first = await generateSourceDocs(options);
    const indexPath = join(first.llmDocsDir, 'index.md');
    const seeded = await readFile(indexPath, 'utf-8');
    await rm(indexPath);

    const second = await generateSourceDocs(options);

    // Deterministic content: an identical rerun reseeds identical bytes.
    expect(second.indexSeeded).toBe(true);
    expect(await readFile(indexPath, 'utf-8')).toBe(seeded);
  });
});
