/**
 * Focused coverage for MDX cleanup in the Markdown parser path.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FormatDetector } from '../../src/core/detector.js';
import { ContentBlockType, type DocNode } from '../../src/core/models.js';
import { FormatType } from '../../src/parsers/base.js';
import { MarkdownFormatParser } from '../../src/parsers/markdown/index.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-mdx-'));
  tempDirs.push(dir);
  return dir;
}

function collectText(node: DocNode): string {
  const ownContent = node.content.map((block) => block.content).join('\n');
  const childContent = node.children.map((child) => collectText(child)).join('\n');
  return [node.title, ownContent, childContent].filter(Boolean).join('\n');
}

function collectNonCodeText(node: DocNode): string {
  const ownContent = node.content
    .filter((block) => block.type !== ContentBlockType.CODE)
    .map((block) => block.content)
    .join('\n');
  const childContent = node.children.map((child) => collectNonCodeText(child)).join('\n');
  return [node.title, ownContent, childContent].filter(Boolean).join('\n');
}

function collectCodeBlocks(node: DocNode): string[] {
  const ownBlocks = node.content
    .filter((block) => block.type === ContentBlockType.CODE)
    .map((block) => block.content);
  const childBlocks = node.children.flatMap((child) => collectCodeBlocks(child));
  return [...ownBlocks, ...childBlocks];
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Markdown parser MDX cleanup', () => {
  it('detects and parses explicit MDX files with deterministic cleanup outside code fences', async () => {
    const tempDir = await createTempDir();
    const sourcePath = join(tempDir, 'components.mdx');

    await writeFile(
      sourcePath,
      [
        '---',
        'title: Components Guide',
        'description: Component docs',
        '...',
        '',
        "import Tabs from './tabs';",
        'import {',
        '  Tab,',
        '  TabItem,',
        "} from './tabs';",
        '',
        'export const metadata = {',
        '  hidden: true,',
        '};',
        '',
        '# Components',
        '',
        'export {',
        '  Button,',
        "} from './button'",
        'Following prose survives.',
        '',
        '{/* remove this JSX comment */}',
        '',
        '<Tabs>',
        '<TabItem value="js" label="JavaScript">',
        'Use the JavaScript client.',
        '</TabItem>',
        '<Tab title="TypeScript">',
        'Use the TypeScript client.',
        '</Tab>',
        '</Tabs>',
        '',
        '<Steps>',
        '<Step title="Install">',
        'Run the installer.',
        '</Step>',
        '</Steps>',
        '',
        '<Cards>',
        '<Card title="Reference">',
        'Read the reference page.',
        '</Card>',
        '</Cards>',
        '',
        '<Warning title="Careful">',
        'Do not leak tokens.',
        '</Warning>',
        '',
        '{runtimeOnlyExpression}',
        '{items.map((item) => (',
        '  <Card title={item.title}>{item.body}</Card>',
        '))}',
        '',
        '<Icon',
        '  name="bolt"',
        '/>',
        '',
        '```tsx',
        "import Tabs from './tabs';",
        '',
        '',
        'export const sample = { enabled: true };',
        '{/* keep this JSX comment */}',
        '<TabItem value="example" />',
        '```',
        '',
      ].join('\n'),
      'utf-8'
    );

    const parser = new MarkdownFormatParser();
    const detector = new FormatDetector();

    expect(await parser.detect(sourcePath)).toBe(true);
    expect(await detector.detect(sourcePath)).toBe(FormatType.MARKDOWN);

    const docNode = await parser.parse(sourcePath);
    const parsedText = collectNonCodeText(docNode);
    const codeBlocks = collectCodeBlocks(docNode);

    expect(docNode.metadata.get('format')).toBe('markdown');
    expect(docNode.metadata.get('sourceSyntax')).toBe('mdx');
    expect(docNode.metadata.get('path')).toBe(sourcePath);
    expect(docNode.metadata.get('title')).toBe('Components Guide');
    expect(docNode.metadata.get('description')).toBe('Component docs');

    expect(parsedText).toContain('Components');
    expect(parsedText).toContain('Following prose survives.');
    expect(parsedText).toContain('JavaScript');
    expect(parsedText).toContain('Use the JavaScript client.');
    expect(parsedText).toContain('TypeScript');
    expect(parsedText).toContain('Use the TypeScript client.');
    expect(parsedText).toContain('Install');
    expect(parsedText).toContain('Run the installer.');
    expect(parsedText).toContain('Reference');
    expect(parsedText).toContain('Read the reference page.');
    expect(parsedText).toContain('Careful');
    expect(parsedText).toContain('Do not leak tokens.');

    expect(parsedText).not.toContain('title: Components Guide');
    expect(parsedText).not.toContain('description: Component docs');
    expect(parsedText).not.toContain("import Tabs from './tabs';");
    expect(parsedText).not.toContain('export const metadata');
    expect(parsedText).not.toContain('Button');
    expect(parsedText).not.toContain("from './button'");
    expect(parsedText).not.toContain('remove this JSX comment');
    expect(parsedText).not.toContain('runtimeOnlyExpression');
    expect(parsedText).not.toContain('items.map');
    expect(parsedText).not.toContain('<Tabs>');
    expect(parsedText).not.toContain('<TabItem');
    expect(parsedText).not.toContain('<Step');
    expect(parsedText).not.toContain('<Card');
    expect(parsedText).not.toContain('<Warning');
    expect(parsedText).not.toContain('bolt');

    expect(codeBlocks).toEqual([
      [
        "import Tabs from './tabs';",
        '',
        '',
        'export const sample = { enabled: true };',
        '{/* keep this JSX comment */}',
        '<TabItem value="example" />',
      ].join('\n'),
    ]);
  });

  it('accepts directories that contain only nested MDX files', async () => {
    const tempDir = await createTempDir();
    const sourceDir = join(tempDir, 'docs');
    const nestedDir = join(sourceDir, 'components');
    const sourcePath = join(nestedDir, 'intro.mdx');

    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      sourcePath,
      '# Components\n\n<Note title="Heads up">Use MDX.</Note>\n',
      'utf-8'
    );

    const parser = new MarkdownFormatParser();

    expect(await parser.detect(sourceDir)).toBe(true);

    const docNode = await parser.parse(sourceDir);
    const parsedText = collectText(docNode);

    expect(docNode.metadata.get('format')).toBe('markdown');
    expect(docNode.metadata.get('sourceSyntax')).toBe('mdx');
    expect(docNode.children[0]?.metadata.get('sourceSyntax')).toBe('mdx');
    expect(parsedText).toContain('Components');
    expect(parsedText).toContain('Heads up');
    expect(parsedText).toContain('Use MDX.');
  });

  it('accepts .markdown files and directories that contain nested .markdown files', async () => {
    const tempDir = await createTempDir();
    const sourceDir = join(tempDir, 'docs');
    const nestedDir = join(sourceDir, 'guide');
    const sourcePath = join(nestedDir, 'intro.markdown');

    await mkdir(nestedDir, { recursive: true });
    await writeFile(sourcePath, '# Intro\n\nUse standard Markdown.\n', 'utf-8');

    const parser = new MarkdownFormatParser();
    const detector = new FormatDetector();

    expect(await parser.detect(sourcePath)).toBe(true);
    expect(await detector.detect(sourcePath)).toBe(FormatType.MARKDOWN);
    expect(await parser.detect(sourceDir)).toBe(true);

    const fileDocNode = await parser.parse(sourcePath);
    const directoryDocNode = await parser.parse(sourceDir);

    expect(fileDocNode.title).toBe('Intro');
    expect(fileDocNode.metadata.get('format')).toBe('markdown');
    expect(fileDocNode.metadata.get('sourceSyntax')).toBe('markdown');
    expect(directoryDocNode.metadata.get('sourceSyntax')).toBe('markdown');
    expect(collectText(directoryDocNode)).toContain('Use standard Markdown.');
  });

  it('preserves prose after semicolonless MDX declarations with TypeScript suffixes', async () => {
    const tempDir = await createTempDir();
    const sourcePath = join(tempDir, 'declarations.mdx');

    await writeFile(
      sourcePath,
      [
        "import { Something } from './thing' // trailing comment",
        "import data from './data.json' assert { type: 'json' } // trailing comment",
        "import './side-effect.json' with { type: 'json' } /* trailing comment */",
        "import data from './data.json' with {",
        "  type: 'json',",
        '}',
        '',
        'export const metadata = {',
        "  title: 'Edge Declarations',",
        '} satisfies Metadata',
        '',
        'export const config = {',
        "  runtime: 'edge',",
        '} as const',
        '',
        '# Edge Declarations',
        '',
        'Prose after import attributes survives.',
        'Body prose survives.',
      ].join('\n'),
      'utf-8'
    );

    const parser = new MarkdownFormatParser();
    const docNode = await parser.parse(sourcePath);
    const parsedText = collectNonCodeText(docNode);

    expect(parsedText).toContain('Edge Declarations');
    expect(parsedText).toContain('Prose after import attributes survives.');
    expect(parsedText).toContain('Body prose survives.');
    expect(parsedText).not.toContain('Something');
    expect(parsedText).not.toContain('data.json');
    expect(parsedText).not.toContain('side-effect.json');
    expect(parsedText).not.toContain('metadata');
    expect(parsedText).not.toContain('runtime');
  });

  it('unwraps compact nested common components without leaking raw JSX', async () => {
    const tempDir = await createTempDir();
    const sourcePath = join(tempDir, 'compact-components.mdx');

    await writeFile(
      sourcePath,
      [
        '# Compact Components',
        '',
        '<Cards><Card title="Reference">Read the reference.</Card></Cards>',
        '<Tabs><TabItem value="js" label="JavaScript">Use JS.</TabItem></Tabs>',
        '<Steps><Step title="One">Do one.</Step><Step title="Two">Do two.</Step></Steps>',
        '<Accordion><AccordionItem title="FAQ">Answer.</AccordionItem></Accordion>',
      ].join('\n'),
      'utf-8'
    );

    const parser = new MarkdownFormatParser();
    const docNode = await parser.parse(sourcePath);
    const parsedText = collectNonCodeText(docNode);

    expect(parsedText).toContain('Compact Components');
    expect(parsedText).toContain('Reference');
    expect(parsedText).toContain('Read the reference.');
    expect(parsedText).toContain('JavaScript');
    expect(parsedText).toContain('Use JS.');
    expect(parsedText).toContain('One');
    expect(parsedText).toContain('Do one.');
    expect(parsedText).toContain('Two');
    expect(parsedText).toContain('Do two.');
    expect(parsedText).toContain('FAQ');
    expect(parsedText).toContain('Answer.');
    expect(parsedText).not.toContain('<Cards>');
    expect(parsedText).not.toContain('<Card');
    expect(parsedText).not.toContain('<Tabs>');
    expect(parsedText).not.toContain('<TabItem');
    expect(parsedText).not.toContain('<Steps>');
    expect(parsedText).not.toContain('<Step');
    expect(parsedText).not.toContain('</Step>');
    expect(parsedText).not.toContain('<Accordion>');
    expect(parsedText).not.toContain('<AccordionItem');
  });
});
