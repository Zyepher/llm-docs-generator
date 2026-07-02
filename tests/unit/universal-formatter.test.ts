import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ContentBlockType,
  DocNodeType,
  createContentBlock,
  createDocNode,
} from '../../src/core/models.js';
import { formatDocNode } from '../../src/core/universal-formatter.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('UniversalFormatter', () => {
  it('does not print an empty-number heading for top-level section documents', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'llm-docs-formatter-root-section-'));
    tempDirs.push(outputDir);

    const root = createDocNode(DocNodeType.SECTION, 'single-file', 'Single File Docs', {
      content: [createContentBlock(ContentBlockType.PROSE, 'Document-level overview.')],
      children: [
        createDocNode(DocNodeType.SECTION, 'child', 'Child Section', {
          content: [createContentBlock(ContentBlockType.PROSE, 'Child content.')],
        }),
      ],
    });

    await formatDocNode(root, {
      outputDir,
      filenamePrefix: 'single',
      includeMetadata: false,
    });
    const output = await readFile(join(outputDir, 'single-full-llms.txt'), 'utf-8');

    expect(output).not.toContain('# . ');
    expect(output).toContain('# Single File Docs');
    expect(output).toContain('Document-level overview.');
    expect(output).toContain('## 1. Child Section');
    expect(output).toContain('Child content.');
  });

  it('does not print an empty-number heading for modular category files', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'llm-docs-formatter-category-heading-'));
    tempDirs.push(outputDir);

    const root = createDocNode(DocNodeType.ROOT, 'root', 'Category Docs', {
      children: [
        createDocNode(DocNodeType.CATEGORY, 'guide', 'Guide', {
          content: [createContentBlock(ContentBlockType.PROSE, 'Category overview.')],
          children: [
            createDocNode(DocNodeType.SECTION, 'details', 'Details', {
              content: [createContentBlock(ContentBlockType.PROSE, 'Detailed content.')],
            }),
          ],
        }),
      ],
    });

    await formatDocNode(root, {
      outputDir,
      filenamePrefix: 'docs',
      includeMetadata: false,
    });
    const categoryOutput = await readFile(join(outputDir, 'docs-guide-llms.txt'), 'utf-8');

    expect(categoryOutput).not.toContain('# . ');
    expect(categoryOutput).toContain('# Category Docs Guide Documentation');
    expect(categoryOutput).toContain('Category overview.');
    expect(categoryOutput).toContain('## 1. Details');
    expect(categoryOutput).toContain('Detailed content.');
  });

  it('generates deterministic unique modular filenames after sanitization collisions', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'llm-docs-formatter-collision-'));
    tempDirs.push(outputDir);

    const root = createDocNode(DocNodeType.ROOT, 'root', 'Collision Docs', {
      children: [
        createDocNode(DocNodeType.CATEGORY, 'full', 'Full Category', {
          content: [createContentBlock(ContentBlockType.PROSE, 'Must not overwrite full docs.')],
        }),
        createDocNode(DocNodeType.CATEGORY, 'api auth', 'API Auth', {
          content: [createContentBlock(ContentBlockType.PROSE, 'First auth category.')],
        }),
        createDocNode(DocNodeType.CATEGORY, 'api/auth', 'API/Auth', {
          content: [createContentBlock(ContentBlockType.PROSE, 'Second auth category.')],
        }),
      ],
    });

    const outputPaths = await formatDocNode(root, {
      outputDir,
      filenamePrefix: 'docs',
      includeMetadata: false,
    });
    const filenames = (await readdir(outputDir)).sort();

    expect(outputPaths.map((path) => path.split('/').at(-1)).sort()).toEqual(filenames);
    expect(filenames).toEqual([
      'docs-api-auth-2-llms.txt',
      'docs-api-auth-llms.txt',
      'docs-full-2-llms.txt',
      'docs-full-llms.txt',
    ]);
    expect(await readFile(join(outputDir, 'docs-full-llms.txt'), 'utf-8')).toContain(
      '# Collision Docs'
    );
    expect(await readFile(join(outputDir, 'docs-full-2-llms.txt'), 'utf-8')).toContain(
      'Must not overwrite full docs.'
    );
  });

  it('fences code containing triple backticks with a longer fence (regression)', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'llm-docs-formatter-fence-'));
    tempDirs.push(outputDir);

    const codeWithFence = ['```js', 'const x = 1;', '```'].join('\n');
    const root = createDocNode(DocNodeType.ROOT, 'root', 'Fence Docs', {
      children: [
        createDocNode(DocNodeType.CATEGORY, 'guide', 'Guide', {
          content: [
            createContentBlock(ContentBlockType.CODE, codeWithFence, { language: 'markdown' }),
          ],
        }),
      ],
    });

    await formatDocNode(root, { outputDir, filenamePrefix: 'docs', includeMetadata: false });
    const output = await readFile(join(outputDir, 'docs-full-llms.txt'), 'utf-8');

    // The outer fence must be longer than the inner ``` run so the block is not
    // closed prematurely, and the embedded fence content is preserved verbatim.
    expect(output).toContain('````markdown');
    expect(output).toContain('```js');
    expect(output).toContain('const x = 1;');
  });
});
