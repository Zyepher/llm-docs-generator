import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  generateSourceDocs,
  type GenerateSourceDocsOptions,
  type GenerateSourceGitContext,
} from '../../src/core/source-docs.js';

const FIXTURE_DOCS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/formatter-fidelity/docs'
);

const GENERATOR = { name: 'llm-docs', version: '0.0.0-test', cliName: 'llm-docs' } as const;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function generate(
  extra: Partial<GenerateSourceDocsOptions> = {}
): Promise<{ outputDir: string; full: string; llmDir: string; warnings: string[] }> {
  const outputDir = await mkdtemp(join(tmpdir(), 'llm-docs-fidelity-'));
  tempDirs.push(outputDir);
  const result = await generateSourceDocs({
    source: FIXTURE_DOCS,
    outputDir,
    format: 'markdown',
    generator: GENERATOR,
    ...extra,
  });
  const llmDir = result.llmDocsDir;
  const full = await readFile(join(llmDir, 'docs-full-llms.txt'), 'utf-8');
  return { outputDir, full, llmDir, warnings: result.manifest.warnings };
}

/** Extract fenced code block bodies from markdown/generated text, fence-aware. */
function extractFencedBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const open = lines[index]?.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open?.[1] !== undefined) {
      const marker = open[1];
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const close = lines[index]?.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (
          close?.[1] !== undefined &&
          close[1][0] === marker[0] &&
          close[1].length >= marker.length
        ) {
          break;
        }
        body.push(lines[index] ?? '');
        index += 1;
      }
      blocks.push(body.join('\n'));
    }
    index += 1;
  }
  return blocks;
}

describe('formatter fidelity: frontmatter titles', () => {
  it('uses frontmatter title, first H1, or filename slug in that order', async () => {
    const { full } = await generate();
    // Frontmatter titles
    expect(full).toContain('Router API');
    expect(full).toContain('Introduction');
    expect(full).toContain('Overview');
    // No frontmatter, first H1 used
    expect(full).toContain('Heading Title Only');
    // No frontmatter and no heading, filename slug used
    expect(full).toMatch(/^#{1,6} [\d.]+\. plain$/m);
    // Frontmatter never leaks as body text
    expect(full).not.toContain('id: router');
    expect(full).not.toMatch(/^title: /m);
  });
});

describe('formatter fidelity: per-section source markers', () => {
  it('emits a greppable [source: relpath] line after each file section heading', async () => {
    const { full } = await generate();
    expect(full).toMatch(/^\[source: guide\/intro\.md\]$/m);
    expect(full).toMatch(/^\[source: api\/router\.md\]$/m);
    const markerCount = (full.match(/^\[source: /gm) ?? []).length;
    expect(markerCount).toBe(5);
  });
});

describe('formatter fidelity: heading depth preservation', () => {
  it('preserves relative depth down to the H6 floor with continuing numbering', async () => {
    const { full } = await generate();
    // The file section is the ## root, so its in-body headings render one level
    // deeper: "Nested detail" (source h4) reaches ##### (past the old H4 cap) and
    // the two deepest headings floor at ###### while numbering keeps going.
    expect(full).toMatch(/^##### [\d.]+\. Nested detail$/m);
    expect(full).toMatch(/^###### [\d.]+\. Deeper detail$/m);
    expect(full).toMatch(/^###### [\d.]+\. Deepest detail at the floor$/m);
    // Author-numbered heading text is kept verbatim (double numbering accepted).
    expect(full).toContain('. 1. Create the config file');
    expect(full).toContain('. 2. Second Step');
  });
});

describe('formatter fidelity: tab directives', () => {
  it('composes tab item headings and leaves zero bare labels', async () => {
    const { full } = await generate();
    expect(full).toContain('npm (package-managers)');
    expect(full).toContain('pnpm (package-managers)');
    expect(full).toContain('React (framework)');
    expect(full).toContain('Solid (framework)');
    const bare = full.match(/^#{1,6} [\d.]+\. (React|Vite|npm|pnpm|yarn|bun|Solid|Rsbuild)$/gm);
    expect(bare).toBeNull();
    // Directive markers are removed.
    expect(full).not.toContain('::start:tabs');
    expect(full).not.toContain('::end:framework');
  });
});

describe('formatter fidelity: link handling', () => {
  it('inlines reference definitions, rewrites in-pack links, and warns otherwise', async () => {
    const { full, warnings } = await generate();
    expect(full).toContain('[reference site](https://example.com/site)');
    expect(full).toContain('[in-pack page](pack:api/router.md#usage)');
    // In-page anchors are left unchanged (known limitation).
    expect(full).toContain('[in-page anchor](#setup)');
    // No git context: external relative link left unchanged and counted.
    expect(full).toContain('[external page](../../outside/thing.md)');
    expect(warnings.some((w) => w.includes('unrewritten'))).toBe(true);
    expect(warnings.some((w) => w.includes('[nodef]'))).toBe(true);
  });

  it('pins out-of-pack links to a github blob url when git context is provided', async () => {
    const gitContext: GenerateSourceGitContext = {
      remoteUrl: 'git@github.com:acme/widget.git',
      commit: 'deadbeef',
      tags: ['v1.2.3'],
      dirty: false,
      sourceRootFromRepo: 'packages/docs',
    };
    const { full } = await generate({ gitContext, label: 'my-pack' });
    expect(full).toContain(
      '[external page](https://github.com/acme/widget/blob/deadbeef/packages/outside/thing.md)'
    );
  });
});

describe('formatter fidelity: fence info strings', () => {
  it('preserves bare fences and title info strings without injecting text', async () => {
    const { full } = await generate();
    expect(full).toContain('```ts title="vite.config.ts"');
    // Bare fence stays bare (not relabeled to ```text).
    expect(full).toContain('bare fence body with no info string');
    expect(full).toMatch(/^```\nbare fence body with no info string$/m);
  });
});

describe('formatter fidelity: code block byte identity (regression, prime directive)', () => {
  it('reproduces every source fenced code block byte-for-byte in the pack', async () => {
    const { full } = await generate();
    const files = [
      'guide/intro.md',
      'api/router.md',
      'overview.md',
      'no-frontmatter.md',
      'plain.md',
    ];
    const sourceBlocks: string[] = [];
    for (const file of files) {
      sourceBlocks.push(...extractFencedBlocks(await readFile(join(FIXTURE_DOCS, file), 'utf-8')));
    }
    expect(sourceBlocks.length).toBeGreaterThan(0);
    for (const block of sourceBlocks) {
      expect(full).toContain(block);
    }
  });
});

describe('formatter fidelity: table of contents', () => {
  it('emits a toc file with the heading tree and source markers', async () => {
    const { llmDir } = await generate();
    const toc = await readFile(join(llmDir, 'docs-toc-llms.txt'), 'utf-8');
    expect(toc).toContain('[source: guide/intro.md]');
    expect(toc).toContain('Table of Contents');
    expect(toc).toMatch(/^\s*[\d.]+\. Introduction \[source: guide\/intro\.md\]$/m);
  });

  it('removes owned outputs on regeneration but keeps an agent-authored index.md', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'llm-docs-fidelity-clean-'));
    tempDirs.push(outputDir);
    const options: GenerateSourceDocsOptions = {
      source: FIXTURE_DOCS,
      outputDir,
      format: 'markdown',
      generator: GENERATOR,
    };
    const first = await generateSourceDocs(options);
    await writeFile(join(first.llmDocsDir, 'index.md'), '# nav\n', 'utf-8');
    await generateSourceDocs({ ...options, splitBy: 'dirs' });
    const entries = (await readdir(first.llmDocsDir)).sort();
    expect(entries).toContain('index.md');
    expect(entries).toContain('docs-full-llms.txt');
    expect(entries).toContain('docs-toc-llms.txt');
  });
});

describe('formatter fidelity: split-by dirs', () => {
  it('creates one category file per top-level directory, root for root files', async () => {
    const { llmDir } = await generate({ splitBy: 'dirs' });
    const entries = (await readdir(llmDir)).sort();
    expect(entries).toContain('docs-guide-llms.txt');
    expect(entries).toContain('docs-api-llms.txt');
    expect(entries).toContain('docs-root-llms.txt');
    const rootFile = await readFile(join(llmDir, 'docs-root-llms.txt'), 'utf-8');
    expect(rootFile).toContain('[source: overview.md]');
    expect(rootFile).toContain('[source: plain.md]');
  });
});

describe('formatter fidelity: categories with fallback', () => {
  it('assigns by first-matching glob and warns about fallback files', async () => {
    const { llmDir, warnings } = await generate({
      categories: {
        categories: [
          { id: 'guide', title: 'Guide', include: ['guide/**'] },
          { id: 'api', title: 'API', include: ['api/**'] },
        ],
        fallback: 'misc',
      },
    });
    const entries = (await readdir(llmDir)).sort();
    expect(entries).toContain('docs-guide-llms.txt');
    expect(entries).toContain('docs-api-llms.txt');
    expect(entries).toContain('docs-misc-llms.txt');
    const fallbackWarning = warnings.find((w) => w.includes('fallback'));
    expect(fallbackWarning).toBeDefined();
    expect(fallbackWarning).toContain('overview.md');
    expect(fallbackWarning).toContain('plain.md');
  });
});

describe('formatter fidelity: system header stamp', () => {
  it('includes label and commit on the first line when provided', async () => {
    const gitContext: GenerateSourceGitContext = {
      remoteUrl: 'https://github.com/acme/widget',
      commit: 'cafe1234',
      tags: ['v2.0.0'],
      dirty: true,
      sourceRootFromRepo: 'docs',
    };
    const { full } = await generate({ gitContext, label: 'release-pack' });
    const firstLine = full.split('\n')[0] ?? '';
    expect(firstLine).toContain('<SYSTEM>');
    expect(firstLine).toContain('label: release-pack');
    expect(firstLine).toContain('cafe1234');
    expect(firstLine).toContain('https://github.com/acme/widget');
    expect(firstLine).toContain('tags: v2.0.0');
  });

  it('stamps the same provenance into every slice and the toc header (F2)', async () => {
    const gitContext: GenerateSourceGitContext = {
      remoteUrl: 'https://github.com/acme/widget',
      commit: 'cafe1234',
      tags: ['v2.0.0'],
      dirty: false,
      sourceRootFromRepo: 'docs',
    };
    const { llmDir } = await generate({ gitContext, label: 'release-pack', splitBy: 'dirs' });

    const sliceFirstLine = async (file: string): Promise<string> =>
      (await readFile(join(llmDir, file), 'utf-8')).split('\n')[0] ?? '';

    for (const slice of ['docs-guide-llms.txt', 'docs-api-llms.txt']) {
      const line = await sliceFirstLine(slice);
      expect(line).toContain('<SYSTEM>');
      expect(line).toContain('label: release-pack');
      expect(line).toContain('cafe1234');
      expect(line).toContain('https://github.com/acme/widget');
    }

    const tocLine = await sliceFirstLine('docs-toc-llms.txt');
    expect(tocLine).toContain('label: release-pack');
    expect(tocLine).toContain('cafe1234');
    // With slices present the toc must direct readers to the per-topic slice,
    // not to grepping the full pack, and warn against loading both.
    expect(tocLine).toContain('per-topic slice');
    expect(tocLine).toContain('never both');
    expect(tocLine).not.toContain('to grep in the full pack');
  });
});

describe('formatter fidelity: reserved-name collisions (split-by dirs)', () => {
  async function generateReservedCorpus() {
    const source = await mkdtemp(join(tmpdir(), 'llm-docs-reserved-src-'));
    tempDirs.push(source);
    const outputDir = await mkdtemp(join(tmpdir(), 'llm-docs-reserved-out-'));
    tempDirs.push(outputDir);

    // Source directories named exactly like the reserved artifacts: "toc"
    // collides with the generated table of contents, "full" with the combined
    // -full file.
    for (const [dir, body] of [
      ['toc', '# Toc Dir Page\n\ntoc dir body\n'],
      ['full', '# Full Dir Page\n\nfull dir body\n'],
      ['guide', '# Intro\n\nguide body\n'],
    ] as const) {
      await mkdir(join(source, dir), { recursive: true });
      await writeFile(join(source, dir, 'page.md'), body, 'utf-8');
    }
    await writeFile(join(source, 'readme.md'), '# Readme\n\nroot body\n', 'utf-8');

    return generateSourceDocs({
      source,
      outputDir,
      format: 'markdown',
      generator: GENERATOR,
      splitBy: 'dirs',
      output: { filenamePrefix: 'demo' },
    });
  }

  it('renames the colliding category slice and preserves both artifacts, with a warning', async () => {
    const result = await generateReservedCorpus();
    const llmDir = result.llmDocsDir;
    const entries = (await readdir(llmDir)).sort();

    // Reserved artifacts survive under their canonical names...
    expect(entries).toContain('demo-toc-llms.txt');
    expect(entries).toContain('demo-full-llms.txt');
    // ...and the colliding category slices survive under deduped names (no loss).
    expect(entries).toContain('demo-toc-2-llms.txt');
    expect(entries).toContain('demo-full-2-llms.txt');

    // The reserved names hold the real artifacts; the -2 names hold the slices.
    const toc = await readFile(join(llmDir, 'demo-toc-llms.txt'), 'utf-8');
    expect(toc).toContain('Table of Contents');
    const tocSlice = await readFile(join(llmDir, 'demo-toc-2-llms.txt'), 'utf-8');
    expect(tocSlice).toContain('[source: toc/page.md]');
    expect(tocSlice).not.toContain('Table of Contents');
    const fullSlice = await readFile(join(llmDir, 'demo-full-2-llms.txt'), 'utf-8');
    expect(fullSlice).toContain('[source: full/page.md]');

    // Each rename is recorded as a warning naming the reserved role and new name.
    const { warnings } = result.manifest;
    expect(warnings).toContain(
      'Category slice "demo-toc-llms.txt" collides with the reserved table-of-contents output; renamed to "demo-toc-2-llms.txt".'
    );
    expect(warnings).toContain(
      'Category slice "demo-full-llms.txt" collides with the reserved combined full-document output; renamed to "demo-full-2-llms.txt".'
    );
  });

  it('records no duplicate generatedOutputs paths (manifest invariant)', async () => {
    const result = await generateReservedCorpus();
    const paths = result.manifest.generatedOutputs.map((output) => output.path);
    expect(new Set(paths).size).toBe(paths.length);
    // The toc slice, the toc artifact, the full slice and the full artifact are
    // four distinct recorded paths.
    expect(paths).toContain('llm-docs/demo-toc-llms.txt');
    expect(paths).toContain('llm-docs/demo-toc-2-llms.txt');
    expect(paths).toContain('llm-docs/demo-full-llms.txt');
    expect(paths).toContain('llm-docs/demo-full-2-llms.txt');
  });
});
