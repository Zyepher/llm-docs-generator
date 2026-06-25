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
});
