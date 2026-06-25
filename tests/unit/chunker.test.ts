import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ContentBlockType,
  DocNodeType,
  chunkDocNode,
  createContentBlock,
  createDocNode,
  type DocNode,
} from '../../src/index.js';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('semantic DocNode chunker', () => {
  it('creates stable chunk IDs, order, metadata, and hashes from semantic node paths', () => {
    const root = createDocNode(DocNodeType.ROOT, 'docs', 'SDK Docs', {
      metadata: new Map<string, unknown>([
        ['format', 'markdown'],
        ['sourcePath', '/docs/sdk.md'],
      ]),
      children: [
        createDocNode(DocNodeType.CATEGORY, 'auth', 'Authentication', {
          content: [createContentBlock(ContentBlockType.PROSE, 'Use auth for sign-in workflows.')],
          children: [
            createDocNode(DocNodeType.OPERATION, 'sign-in', 'Sign In', {
              content: [
                createContentBlock(ContentBlockType.CODE, 'await client.signIn()', {
                  language: 'ts',
                }),
                createContentBlock(ContentBlockType.DATA, '{"ok": true}', {
                  annotations: new Map<string, unknown>([['type', 'json']]),
                }),
              ],
            }),
          ],
        }),
        createDocNode(DocNodeType.CATEGORY, 'storage', 'Storage', {
          content: [createContentBlock(ContentBlockType.PROSE, 'Store files in buckets.')],
        }),
      ],
    });

    const first = chunkDocNode(root);
    const second = chunkDocNode(root);

    expect(first).toEqual(second);
    expect(first.warnings).toEqual([]);
    expect(first.chunks.map((chunk) => chunk.id)).toEqual([
      'docs/auth',
      'docs/auth/sign-in',
      'docs/storage',
    ]);
    expect(first.chunks.map((chunk) => chunk.ordinal)).toEqual([1, 2, 3]);

    const authChunk = first.chunks[0];
    const signInChunk = first.chunks[1];
    const storageChunk = first.chunks[2];

    expect(authChunk).toBeDefined();
    expect(signInChunk).toBeDefined();
    expect(storageChunk).toBeDefined();
    expect(authChunk?.title).toBe('Authentication');
    expect(authChunk?.path).toEqual(['SDK Docs', 'Authentication']);
    expect(authChunk?.sourceFormat).toBe('markdown');
    expect(authChunk?.sourcePath).toBe('/docs/sdk.md');
    expect(authChunk?.content).toContain('# SDK Docs');
    expect(authChunk?.content).toContain('## Authentication');
    expect(authChunk?.content).toContain('Use auth for sign-in workflows.');
    expect(authChunk?.content).not.toContain('Store files in buckets.');
    expect(authChunk?.contentHash).toBe(sha256(authChunk?.content ?? ''));
    expect(authChunk?.characterCount).toBe(authChunk?.content.length);
    expect(authChunk?.estimatedTokenCount).toBe(Math.ceil((authChunk?.content.length ?? 0) / 4));

    expect(signInChunk?.content).toContain('### Sign In');
    expect(signInChunk?.content).toContain('```ts\nawait client.signIn()\n```');
    expect(signInChunk?.content).toContain('```json\n{"ok": true}\n```');
    expect(signInChunk?.metadata.blockTypes).toEqual([
      ContentBlockType.CODE,
      ContentBlockType.DATA,
    ]);
    expect(storageChunk?.content).toContain('Store files in buckets.');
  });

  it('disambiguates duplicate sibling node IDs deterministically', () => {
    const root = createDocNode(DocNodeType.ROOT, 'docs', 'Docs', {
      children: [
        createDocNode(DocNodeType.SECTION, 'topic', 'First Topic', {
          content: [createContentBlock(ContentBlockType.PROSE, 'First copy.')],
        }),
        createDocNode(DocNodeType.SECTION, 'topic', 'Second Topic', {
          content: [createContentBlock(ContentBlockType.PROSE, 'Second copy.')],
        }),
      ],
    });

    const result = chunkDocNode(root);

    expect(result.chunks.map((chunk) => chunk.id)).toEqual(['docs/topic', 'docs/topic~2']);
    expect(result.chunks.map((chunk) => chunk.title)).toEqual(['First Topic', 'Second Topic']);
    expect(result.warnings).toEqual([
      {
        code: 'duplicate_node_id',
        nodePath: ['docs', 'topic~2'],
        message: 'Duplicate sibling node id "topic" was disambiguated as "topic~2".',
      },
    ]);
  });

  it('preserves inherited OpenAPI sourcePath when operation metadata.path is a route', () => {
    const root = createDocNode(DocNodeType.ROOT, 'pet-api', 'Pet API', {
      metadata: new Map<string, unknown>([
        ['format', 'openapi'],
        ['sourcePath', '/tmp/openapi.yaml'],
      ]),
      children: [
        createDocNode(DocNodeType.CATEGORY, 'pets', 'Pets', {
          children: [
            createDocNode(DocNodeType.OPERATION, 'list-pets', 'List Pets', {
              content: [
                createContentBlock(ContentBlockType.PROSE, 'GET /pets returns visible pets.'),
              ],
              metadata: new Map<string, unknown>([
                ['method', 'get'],
                ['path', '/pets'],
              ]),
            }),
            createDocNode(DocNodeType.OPERATION, 'get-pets-json', 'Get Pets JSON', {
              content: [createContentBlock(ContentBlockType.PROSE, 'GET /pets.json returns JSON.')],
              metadata: new Map<string, unknown>([
                ['method', 'get'],
                ['path', '/pets.json'],
                ['sourceKind', 'openapi'],
              ]),
            }),
          ],
        }),
      ],
    });

    const result = chunkDocNode(root);
    const operationChunk = result.chunks.find((chunk) => chunk.id === 'pet-api/pets/list-pets');
    const fileLikeRouteChunk = result.chunks.find(
      (chunk) => chunk.id === 'pet-api/pets/get-pets-json'
    );

    expect(operationChunk).toBeDefined();
    expect(operationChunk?.sourceFormat).toBe('openapi');
    expect(operationChunk?.sourcePath).toBe('/tmp/openapi.yaml');
    expect(operationChunk?.path).toEqual(['Pet API', 'Pets', 'List Pets']);
    expect(operationChunk?.metadata.sectionPath).toBe('Pet API > Pets > List Pets');
    expect(operationChunk?.content).toContain('### List Pets');
    expect(operationChunk?.content).toContain('GET /pets returns visible pets.');
    expect(fileLikeRouteChunk?.sourceFormat).toBe('openapi');
    expect(fileLikeRouteChunk?.sourcePath).toBe('/tmp/openapi.yaml');
    expect(fileLikeRouteChunk?.path).toEqual(['Pet API', 'Pets', 'Get Pets JSON']);
    expect(fileLikeRouteChunk?.content).toContain('GET /pets.json returns JSON.');
  });

  it('uses Markdown-like file metadata.path as source provenance and inherits it when absent', () => {
    const root = createDocNode(DocNodeType.ROOT, 'docs', 'Docs', {
      metadata: new Map<string, unknown>([
        ['format', 'markdown'],
        ['path', '/tmp/docs/root.md'],
      ]),
      children: [
        createDocNode(DocNodeType.SECTION, 'guide', 'Guide', {
          content: [createContentBlock(ContentBlockType.PROSE, 'Guide content.')],
          metadata: new Map<string, unknown>([['path', '/tmp/docs/guide.mdx']]),
        }),
        createDocNode(DocNodeType.SECTION, 'overview', 'Overview', {
          content: [createContentBlock(ContentBlockType.PROSE, 'Overview content.')],
        }),
      ],
    });

    const result = chunkDocNode(root);
    const guideChunk = result.chunks.find((chunk) => chunk.id === 'docs/guide');
    const overviewChunk = result.chunks.find((chunk) => chunk.id === 'docs/overview');

    expect(guideChunk?.sourceFormat).toBe('markdown');
    expect(guideChunk?.sourcePath).toBe('/tmp/docs/guide.mdx');
    expect(guideChunk?.path).toEqual(['Docs', 'Guide']);
    expect(overviewChunk?.sourceFormat).toBe('markdown');
    expect(overviewChunk?.sourcePath).toBe('/tmp/docs/root.md');
    expect(overviewChunk?.path).toEqual(['Docs', 'Overview']);
  });

  it('splits oversized prose at safe boundaries without merging sibling sections', () => {
    const root = createDocNode(DocNodeType.ROOT, 'docs', 'Docs', {
      children: [
        createDocNode(DocNodeType.SECTION, 'big', 'Big Section', {
          content: [
            createContentBlock(
              ContentBlockType.PROSE,
              [
                'Alpha section sentence one. Alpha section sentence two.',
                '',
                'Beta section sentence one. Beta section sentence two.',
                '',
                'Gamma section sentence one. Gamma section sentence two.',
              ].join('\n')
            ),
          ],
        }),
        createDocNode(DocNodeType.SECTION, 'small', 'Small Section', {
          content: [createContentBlock(ContentBlockType.PROSE, 'Small sibling stays separate.')],
        }),
      ],
    });

    const result = chunkDocNode(root, { maxCharacters: 95 });
    const bigChunks = result.chunks.filter((chunk) => chunk.nodePath.join('/') === 'docs/big');

    expect(bigChunks.length).toBeGreaterThan(1);
    expect(bigChunks.map((chunk) => chunk.id)).toEqual([
      'docs/big/~chunk-1',
      'docs/big/~chunk-2',
      'docs/big/~chunk-3',
    ]);
    expect(bigChunks.every((chunk) => chunk.characterCount <= 95)).toBe(true);
    expect(bigChunks.every((chunk) => chunk.metadata.splitCount === 3)).toBe(true);
    expect(result.chunks.at(-1)?.id).toBe('docs/small');
    expect(result.chunks.at(-1)?.content).not.toContain('Gamma section sentence two.');
  });

  it('hard-splits no-boundary prose within size limits and attaches split warnings to chunks', () => {
    const root = createDocNode(DocNodeType.ROOT, 'docs', 'Docs', {
      children: [
        createDocNode(DocNodeType.SECTION, 'hard', 'Hard', {
          content: [createContentBlock(ContentBlockType.PROSE, 'x'.repeat(125))],
        }),
      ],
    });

    const result = chunkDocNode(root, { maxCharacters: 60 });

    expect(result.chunks.map((chunk) => chunk.id)).toEqual([
      'docs/hard/~chunk-1',
      'docs/hard/~chunk-2',
      'docs/hard/~chunk-3',
    ]);
    expect(result.chunks.every((chunk) => chunk.characterCount <= 60)).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'hard_text_split',
      'hard_text_split',
    ]);
    expect(result.warnings.every((warning) => warning.nodePath.join('/') === 'docs/hard')).toBe(
      true
    );
    expect(result.chunks[0]?.warnings.map((warning) => warning.chunkId)).toEqual([
      'docs/hard/~chunk-1',
    ]);
    expect(result.chunks[1]?.warnings.map((warning) => warning.chunkId)).toEqual([
      'docs/hard/~chunk-2',
    ]);
    expect(result.chunks[2]?.warnings).toEqual([]);
  });

  it('uses reserved split chunk segments that do not collide with real child paths', () => {
    const root = createDocNode(DocNodeType.ROOT, 'docs', 'Docs', {
      children: [
        createDocNode(DocNodeType.SECTION, 'big', 'Big', {
          content: [
            createContentBlock(
              ContentBlockType.PROSE,
              [
                'Alpha sentence one. Alpha sentence two.',
                'Beta sentence one. Beta sentence two.',
              ].join('\n\n')
            ),
          ],
          children: [
            createDocNode(DocNodeType.SECTION, 'chunk-1', 'Real Child', {
              content: [createContentBlock(ContentBlockType.PROSE, 'Real child content.')],
            }),
          ],
        }),
      ],
    });

    const result = chunkDocNode(root, { maxCharacters: 70 });
    const ids = result.chunks.map((chunk) => chunk.id);

    expect(ids).toEqual(['docs/big/~chunk-1', 'docs/big/~chunk-2', 'docs/big/chunk-1']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.chunks[2]?.content).toContain('Real child content.');
  });

  it('returns no chunks for an empty document', () => {
    const root = createDocNode(DocNodeType.ROOT, 'empty', 'Empty Docs');

    const result = chunkDocNode(root);

    expect(result).toEqual({
      chunks: [],
      warnings: [],
    });
  });

  it('keeps oversized indivisible code blocks intact and reports warnings on the chunk', () => {
    const code = 'const value = "'.concat('x'.repeat(140), '";');
    const fencedCodeLength = `\`\`\`ts\n${code}\n\`\`\``.length;
    const root = createDocNode(DocNodeType.ROOT, 'docs', 'Docs', {
      children: [
        createDocNode(DocNodeType.SECTION, 'example', 'Example', {
          content: [
            createContentBlock(ContentBlockType.CODE, code, {
              language: 'ts',
            }),
          ],
        }),
      ],
    });

    const result = chunkDocNode(root, { maxCharacters: 80 });
    const chunk = result.chunks[0];

    expect(chunk).toBeDefined();
    expect(chunk?.id).toBe('docs/example');
    expect(chunk?.content).toContain('```ts\nconst value = "');
    expect(chunk?.content).toContain('";\n```');
    expect(chunk?.characterCount).toBeGreaterThan(80);
    expect(chunk?.metadata.oversized).toBe(true);
    expect(chunk?.warnings).toEqual([
      {
        code: 'oversized_indivisible_block',
        nodePath: ['docs', 'example'],
        message: `code block is ${fencedCodeLength} characters before heading context and cannot be split safely.`,
        chunkId: 'docs/example',
      },
    ]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['oversized_indivisible_block']);
  });

  it('handles malformed and deeply nested trees deterministically without recursion', () => {
    const root = createDocNode(DocNodeType.ROOT, 'root', 'Root');
    let cursor = root;
    for (let index = 0; index < 300; index += 1) {
      const child = createDocNode(DocNodeType.SECTION, `level-${index}`, `Level ${index}`);
      cursor.children = [child];
      cursor = child;
    }
    cursor.content = [createContentBlock(ContentBlockType.PROSE, 'Deep content.')];
    cursor.children = 'not-an-array' as unknown as DocNode[];

    const result = chunkDocNode(root);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain('Deep content.');
    expect(result.warnings).toEqual([
      {
        code: 'malformed_children',
        nodePath: ['root', ...Array.from({ length: 300 }, (_, index) => `level-${index}`)],
        message: 'DocNode children must be an array; invalid children were skipped.',
      },
    ]);
  });
});
