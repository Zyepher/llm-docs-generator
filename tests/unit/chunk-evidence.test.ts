/**
 * Citation-grade semantic chunk evidence: markdown source line ranges located
 * in the original file, root-relative chunk source paths, pack-consistent link
 * rewriting in chunk content, and the JSONL index validation of it all.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ContentBlockType,
  DocNodeType,
  chunkDocNode,
  createContentBlock,
  createDocNode,
  estimateTokenCount,
} from '../../src/index.js';
import { MarkdownParser } from '../../src/parsers/markdown/parser.js';
import { buildSemanticChunkJsonlManifestIndex } from '../../src/core/semantic-chunk-index.js';
import { generateSourceDocs, type SourceDocsManifest } from '../../src/core/source-docs.js';
import { sha256Hex } from '../../src/utils/hash.js';

const GENERATOR = { name: 'llm-docs-generator', version: '2.0.0', cliName: 'llm-docs' } as const;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function parseMarkdown(lines: string[], fileName = 'doc.md') {
  const dir = await tempDir('llm-docs-chunk-evidence-md-');
  const filePath = join(dir, fileName);
  await writeFile(filePath, lines.join('\n'), 'utf-8');
  return await new MarkdownParser(filePath).parse();
}

describe('markdown parser source line ranges', () => {
  it('assigns heading-line ranges from the original file, skipping frontmatter and fenced code', async () => {
    const doc = await parseMarkdown([
      '---', // 1
      'title: Guide', // 2
      '---', // 3
      '', // 4
      'Intro paragraph.', // 5
      '', // 6
      '## Setup', // 7
      '', // 8
      'Setup prose.', // 9
      '', // 10
      '```bash', // 11
      '# not a heading', // 12
      '```', // 13
      '', // 14
      '### Deep', // 15
      '', // 16
      'Deep prose.', // 17
      '', // 18
      '## Usage', // 19
      '', // 20
      'Usage prose.', // 21
      '',
    ]);

    expect(doc.sourceLines).toEqual({ start: 1, end: 6 });
    const setup = doc.sections[0];
    const usage = doc.sections[1];
    expect(setup?.title).toBe('Setup');
    expect(setup?.sourceLines).toEqual({ start: 7, end: 14 });
    expect(setup?.children[0]?.sourceLines).toEqual({ start: 15, end: 18 });
    expect(usage?.sourceLines).toEqual({ start: 19, end: 21 });
  });

  it('keeps hoisted single-H1 children on their real heading lines and extends the document range over the H1 body', async () => {
    const doc = await parseMarkdown([
      '# Title', // 1
      '', // 2
      'Lead paragraph.', // 3
      '', // 4
      '## First', // 5
      '', // 6
      'First body.', // 7
      '',
    ]);

    // Single H1 equal to the title is hoisted: its content becomes document
    // content, so the document range covers lines 1-4 (H1 own extent).
    expect(doc.title).toBe('Title');
    expect(doc.sourceLines).toEqual({ start: 1, end: 4 });
    expect(doc.sections[0]?.title).toBe('First');
    expect(doc.sections[0]?.sourceLines).toEqual({ start: 5, end: 7 });
  });

  it('locates setext headings and covers a headingless document as a whole-file range', async () => {
    const setext = await parseMarkdown([
      'Overview', // 1
      '========', // 2
      '', // 3
      'Body.', // 4
      '',
    ]);
    // The setext H1 equals the title, so it hoists; the document range covers
    // the whole H1 extent starting at its heading line.
    expect(setext.sourceLines).toEqual({ start: 1, end: 4 });

    const headingless = await parseMarkdown(['Just prose.', '', 'More prose.', '']);
    expect(headingless.sections).toEqual([]);
    expect(headingless.sourceLines).toEqual({ start: 1, end: 3 });
  });

  it('disambiguates duplicate heading titles by document order', async () => {
    const doc = await parseMarkdown([
      '## Options', // 1
      '', // 2
      'First options.', // 3
      '', // 4
      '## Options', // 5
      '', // 6
      'Second options.', // 7
      '',
    ]);

    expect(doc.sections[0]?.sourceLines).toEqual({ start: 1, end: 4 });
    expect(doc.sections[1]?.sourceLines).toEqual({ start: 5, end: 7 });
  });

  it('omits the range for a heading synthesized by cleaning instead of guessing', async () => {
    const doc = await parseMarkdown([
      '## Real', // 1
      '', // 2
      '@TabNavigator {', // 3
      '   @Tab("Synthesized") {', // 4
      '      Tab body.', // 5
      '   }', // 6
      '}', // 7
      '',
    ]);

    const real = doc.sections[0];
    expect(real?.sourceLines).toEqual({ start: 1, end: 7 });
    // The @Tab title becomes a synthesized H3 with no original heading line.
    const synthesized = real?.children[0];
    expect(synthesized?.title).toBe('Synthesized');
    expect(synthesized?.sourceLines).toBeUndefined();
  });
});

describe('chunker source evidence', () => {
  it('prefers root-relative sourceRelPath metadata over absolute sourcePath', () => {
    const root = createDocNode(DocNodeType.ROOT, 'docs', 'Docs', {
      metadata: new Map<string, unknown>([
        ['format', 'markdown'],
        ['sourcePath', '/machine/local/docs'],
      ]),
      children: [
        createDocNode(DocNodeType.SECTION, 'guide', 'Guide', {
          metadata: new Map<string, unknown>([
            ['path', '/machine/local/docs/guide.md'],
            ['sourceRelPath', 'guide.md'],
          ]),
          content: [createContentBlock(ContentBlockType.PROSE, 'Guide prose.')],
          children: [
            createDocNode(DocNodeType.OPERATION, 'child', 'Child', {
              content: [createContentBlock(ContentBlockType.PROSE, 'Child prose.')],
            }),
          ],
        }),
      ],
    });

    const result = chunkDocNode(root);

    expect(result.chunks.map((chunk) => chunk.sourcePath)).toEqual(['guide.md', 'guide.md']);
  });

  it('carries validated per-node sourceLines without inheriting them to children', () => {
    const root = createDocNode(DocNodeType.ROOT, 'docs', 'Docs', {
      children: [
        createDocNode(DocNodeType.SECTION, 'located', 'Located', {
          metadata: new Map<string, unknown>([['sourceLines', { start: 3, end: 9 }]]),
          content: [createContentBlock(ContentBlockType.PROSE, 'Located prose.')],
          children: [
            createDocNode(DocNodeType.OPERATION, 'unlocated', 'Unlocated', {
              content: [createContentBlock(ContentBlockType.PROSE, 'Unlocated prose.')],
            }),
          ],
        }),
        createDocNode(DocNodeType.SECTION, 'malformed', 'Malformed', {
          metadata: new Map<string, unknown>([['sourceLines', { start: 9, end: 3 }]]),
          content: [createContentBlock(ContentBlockType.PROSE, 'Malformed prose.')],
        }),
        createDocNode(DocNodeType.SECTION, 'fractional', 'Fractional', {
          metadata: new Map<string, unknown>([['sourceLines', { start: 1.5, end: 3 }]]),
          content: [createContentBlock(ContentBlockType.PROSE, 'Fractional prose.')],
        }),
      ],
    });

    const result = chunkDocNode(root);

    expect(result.chunks[0]?.sourceLines).toEqual({ start: 3, end: 9 });
    expect(result.chunks[1]?.sourceLines).toBeUndefined();
    expect(result.chunks[2]?.sourceLines).toBeUndefined();
    expect(result.chunks[3]?.sourceLines).toBeUndefined();
  });
});

describe('semantic chunk JSONL index sourceLines validation', () => {
  function jsonlRecord(overrides: Record<string, unknown> = {}): string {
    const content = '# Doc\n\nBody prose.';
    return `${JSON.stringify({
      id: 'doc',
      ordinal: 1,
      title: 'Doc',
      path: ['Doc'],
      nodePath: ['doc'],
      content,
      contentHash: sha256Hex(content),
      characterCount: content.length,
      estimatedTokenCount: estimateTokenCount(content),
      warnings: [],
      metadata: {},
      ...overrides,
    })}\n`;
  }

  async function writeJsonl(jsonl: string): Promise<{ manifestDir: string; outputPath: string }> {
    const manifestDir = await tempDir('llm-docs-chunk-evidence-jsonl-');
    const outputPath = 'chunks/semantic-chunks.jsonl';
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(manifestDir, 'chunks'), { recursive: true });
    await writeFile(join(manifestDir, outputPath), jsonl, 'utf-8');
    return { manifestDir, outputPath };
  }

  it('accepts old-style records with an absolute sourcePath and no sourceLines', async () => {
    const { manifestDir, outputPath } = await writeJsonl(
      jsonlRecord({ sourceFormat: 'markdown', sourcePath: '/old/machine/doc.md' })
    );

    const index = await buildSemanticChunkJsonlManifestIndex({ manifestDir, outputPath });

    expect(index.chunks[0]?.sourcePath).toBe('/old/machine/doc.md');
    expect(index.chunks[0]?.sourceLines).toBeUndefined();
  });

  it('accepts and indexes a well-formed sourceLines range', async () => {
    const { manifestDir, outputPath } = await writeJsonl(
      jsonlRecord({ sourcePath: 'doc.md', sourceLines: { start: 1, end: 12 } })
    );

    const index = await buildSemanticChunkJsonlManifestIndex({ manifestDir, outputPath });

    expect(index.chunks[0]?.sourceLines).toEqual({ start: 1, end: 12 });
  });

  it.each([
    { sourceLines: { start: 0, end: 4 } },
    { sourceLines: { start: 5, end: 4 } },
    { sourceLines: { start: 1.5, end: 4 } },
    { sourceLines: { start: 1 } },
    { sourceLines: 'lines 1-4' },
    { sourceLines: null },
  ])('rejects malformed sourceLines %j', async (overrides) => {
    const { manifestDir, outputPath } = await writeJsonl(jsonlRecord(overrides));

    await expect(buildSemanticChunkJsonlManifestIndex({ manifestDir, outputPath })).rejects.toThrow(
      /sourceLines must be an object with 1-indexed integer start <= end/
    );
  });
});

describe('generateSourceDocs chunk export evidence', () => {
  it('emits root-relative source paths, pack-rewritten links, and original-file line ranges', async () => {
    const source = await tempDir('llm-docs-chunk-evidence-src-');
    const outputDir = await tempDir('llm-docs-chunk-evidence-out-');
    await writeFile(
      join(source, 'a.md'),
      [
        '# Alpha', // 1
        '', // 2
        'See [Beta](./b.md) for details.', // 3
        '', // 4
        '## Alpha Usage', // 5
        '', // 6
        'Use alpha with [Beta](./b.md).', // 7
        '',
      ].join('\n'),
      'utf-8'
    );
    await writeFile(join(source, 'b.md'), ['# Beta', '', 'Beta body.', ''].join('\n'), 'utf-8');

    const result = await generateSourceDocs({
      source,
      outputDir,
      format: 'markdown',
      chunks: 'jsonl',
      generator: GENERATOR,
    });

    const jsonl = await readFile(join(outputDir, 'chunks', 'semantic-chunks.jsonl'), 'utf-8');
    const records = jsonl
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    // Root-relative source paths only: no chunk leaks the machine layout.
    const sourcePaths = records.map((record) => record.sourcePath);
    expect(new Set(sourcePaths)).toEqual(new Set(['a.md', 'b.md']));
    for (const path of sourcePaths) {
      expect(typeof path).toBe('string');
      expect((path as string).startsWith('/')).toBe(false);
    }

    // Chunk prose agrees with the pack: relative doc links are rewritten.
    const usageChunk = records.find((record) => record.title === 'Alpha Usage');
    expect(usageChunk?.content).toContain('[Beta](pack:b.md)');
    expect(JSON.stringify(records)).not.toContain('](./b.md)');

    // The pack itself carries the identical rewritten link.
    const packText = await readFile(
      join(result.llmDocsDir, `${result.manifest.output.filenamePrefix}-full-llms.txt`),
      'utf-8'
    );
    expect(packText).toContain('[Beta](pack:b.md)');

    // Line ranges point into the ORIGINAL files (1-indexed, inclusive).
    expect(usageChunk?.sourceLines).toEqual({ start: 5, end: 7 });
    const alphaDocChunk = records.find(
      (record) => record.sourcePath === 'a.md' && record.title === 'Alpha'
    );
    expect(alphaDocChunk?.sourceLines).toEqual({ start: 1, end: 4 });

    // Manifest index mirrors the records and its hash re-derives from bytes.
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf-8')) as SourceDocsManifest;
    const manifestIndex = manifest.semanticChunkIndexes?.[0];
    expect(manifestIndex).toBeDefined();
    const manifestUsage = manifestIndex?.chunks.find((chunk) => chunk.title === 'Alpha Usage');
    expect(manifestUsage?.sourcePath).toBe('a.md');
    expect(manifestUsage?.sourceLines).toEqual({ start: 5, end: 7 });

    const rederived = await buildSemanticChunkJsonlManifestIndex({
      manifestDir: outputDir,
      outputPath: 'chunks/semantic-chunks.jsonl',
    });
    expect(rederived.aggregateHash).toBe(manifestIndex?.aggregateHash);
  });
});
