/**
 * Coverage for markdown structure fidelity (blockquotes, single-H1 hoisting,
 * Unicode slugs) and DocC block-directive handling, including the .docc
 * fixture bundle.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ContentBlockType,
  DocNodeType,
  chunkDocNode,
  createContentBlock,
  createDocNode,
} from '../../src/index.js';
import { formatDocNode } from '../../src/core/universal-formatter.js';
import { MarkdownFormatParser } from '../../src/parsers/markdown/index.js';
import { slugifyText } from '../../src/utils/slug.js';

const DOCC_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../fixtures/docc/SamplePack.docc'
);

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-docc-'));
  tempDirs.push(dir);
  return dir;
}

async function parseMarkdown(content: string, filename = 'guide.md') {
  const dir = await createTempDir();
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return await new MarkdownFormatParser().parse(path);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('blockquote formatting', () => {
  it('renders blockquote-annotated prose with a "> " prefix on every line', async () => {
    const docNode = await parseMarkdown(
      ['## Notes', '', '> [!NOTE]', '> First line.', '> Second line.', ''].join('\n')
    );

    const outputDir = join(await createTempDir(), 'out');
    await formatDocNode(docNode, { outputDir, filenamePrefix: 'quote', title: docNode.title });
    const full = await readFile(join(outputDir, 'quote-full-llms.txt'), 'utf-8');

    expect(full).toContain('> [!NOTE]\n> First line.\n> Second line.');
  });

  it('leaves ordinary prose without a blockquote prefix', async () => {
    const docNode = await parseMarkdown(['## Notes', '', 'Plain paragraph.', ''].join('\n'));

    const outputDir = join(await createTempDir(), 'out');
    await formatDocNode(docNode, { outputDir, filenamePrefix: 'plain', title: docNode.title });
    const full = await readFile(join(outputDir, 'plain-full-llms.txt'), 'utf-8');

    expect(full).toContain('\nPlain paragraph.\n');
    expect(full).not.toContain('> Plain paragraph.');
  });
});

describe('single-H1 hoisting', () => {
  it('does not re-nest the H1 that already became the document title', async () => {
    const docNode = await parseMarkdown(
      ['# My Library', '', 'Intro paragraph.', '', '## Setup', 'Install it.', ''].join('\n')
    );

    expect(docNode.title).toBe('My Library');
    expect(docNode.content.map((block) => block.content)).toContain('Intro paragraph.');
    expect(docNode.children.map((child) => child.title)).toEqual(['Setup']);
  });

  it('keeps nesting when a later H1 exists', async () => {
    const docNode = await parseMarkdown(
      ['# My Library', '', '## Setup', '', '# Appendix', 'Extra.', ''].join('\n')
    );

    expect(docNode.title).toBe('My Library');
    expect(docNode.children.map((child) => child.title)).toEqual(['My Library', 'Appendix']);
  });

  it('keeps nesting when the H1 does not match the frontmatter title', async () => {
    const docNode = await parseMarkdown(
      ['---', 'title: Authored Title', '---', '', '# Different Heading', '', '## Setup', ''].join(
        '\n'
      )
    );

    expect(docNode.title).toBe('Authored Title');
    expect(docNode.children.map((child) => child.title)).toEqual(['Different Heading']);
  });
});

describe('Unicode slugs', () => {
  it('keeps pure-ASCII slugs byte-identical to the old behavior', () => {
    expect(slugifyText('Sign in with OTP')).toBe('sign-in-with-otp');
    expect(slugifyText('  Weird -- Spacing!  ')).toBe('weird-spacing');
    expect(slugifyText('???')).toBe('section');
  });

  it('preserves non-Latin letters instead of collapsing to the fallback', () => {
    expect(slugifyText('快速入门')).toBe('快速入门');
    expect(slugifyText('Émigré Café')).toBe('émigré-café');
    expect(slugifyText('시작 하기')).toBe('시작-하기');
  });

  it('gives all-CJK markdown headings a real section id', async () => {
    const docNode = await parseMarkdown(['## 快速入门', '', '内容。', ''].join('\n'));
    expect(docNode.children[0]?.id).toBe('快速入门');
  });

  it('keeps semantic chunk segments for non-Latin node titles', () => {
    const root = createDocNode(DocNodeType.ROOT, 'docs', '文档', {
      metadata: new Map<string, unknown>([['format', 'markdown']]),
      children: [
        createDocNode(DocNodeType.CATEGORY, '快速入门', '快速入门', {
          content: [createContentBlock(ContentBlockType.PROSE, '内容。')],
        }),
      ],
    });

    const result = chunkDocNode(root);
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(['docs/快速入门']);
  });
});

describe('DocC block directives', () => {
  it('handles the .docc fixture bundle end to end', async () => {
    const parser = new MarkdownFormatParser();
    expect(await parser.detect(DOCC_FIXTURE)).toBe(true);

    const docNode = await parser.parse(DOCC_FIXTURE);
    const guide = docNode.children[0];
    expect(guide?.title).toBe('Getting Started');
    // The lone H1 is hoisted: the H2 sections are the guide's children.
    expect(guide?.children.map((child) => child.title)).toEqual(['Install', 'Layout', '快速入门']);
    expect(guide?.children[2]?.id).toBe('快速入门');

    const outputDir = join(await createTempDir(), 'out');
    await formatDocNode(docNode, { outputDir, filenamePrefix: 'sample', title: 'SamplePack' });
    const full = await readFile(join(outputDir, 'sample-full-llms.txt'), 'utf-8');

    // Layout containers unwrap: content survives, directives do not.
    expect(full).toContain('The left column explains requests.');
    expect(full).toContain('The right column explains responses.');
    expect(full).toContain('Swift Package Manager');
    expect(full).toContain('Add the dependency to `Package.swift`.');
    expect(full).toContain('.package(url: "https://example.com/sample.git", from: "1.0.0")');
    expect(full).toContain("Add `pod 'Sample'` to your Podfile.");

    // Media and snippet placeholders are deterministic single lines.
    expect(full).toContain('![Sample architecture diagram](hero.png)');
    expect(full).toContain('[Video: Getting started tour](intro.mov)');
    expect(full).toContain('`Sample/Snippets/hello#setup`');

    // Comment and metadata blocks are gone, including nested braces.
    expect(full).not.toContain('Internal note');
    expect(full).not.toContain('@Metadata');
    expect(full).not.toContain('@DisplayName');
    expect(full).not.toContain('@PageColor');
    expect(full).not.toMatch(/@(?:Comment|Row|Column|TabNavigator|Tab|Image|Video|Snippet)\b/);

    // The DocC callout renders as a blockquote.
    expect(full).toContain('> Important: Always pin an explicit version.');
    expect(full).toContain('> The pack records provenance for every file.');
  });

  it('drops a single-line @Metadata block and keeps surrounding prose', async () => {
    const docNode = await parseMarkdown(
      ['## Guide', '', '@Metadata { @PageColor(purple) }', '', 'Real prose.', ''].join('\n')
    );

    const texts = docNode.children[0]?.content.map((block) => block.content) ?? [];
    expect(texts).toContain('Real prose.');
    expect(texts.join('\n')).not.toContain('@Metadata');
    expect(texts.join('\n')).not.toContain('PageColor');
  });

  it('drops an @Image placeholder without a source and any trailing block', async () => {
    const docNode = await parseMarkdown(
      [
        '## Guide',
        '',
        '@Image(alt: "No source") {',
        '  Accessibility text.',
        '}',
        '',
        'After.',
        '',
      ].join('\n')
    );

    const texts = docNode.children[0]?.content.map((block) => block.content).join('\n') ?? '';
    expect(texts).toContain('After.');
    expect(texts).not.toContain('Accessibility text.');
    expect(texts).not.toContain('@Image');
  });
});
