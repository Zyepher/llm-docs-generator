import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectLocalSource } from '../../src/core/discovery.js';
import { generateSourceDocs } from '../../src/core/source-docs.js';
import { verifyDocsAgainstSource } from '../../src/core/source-verification.js';
import {
  assertNoParentSymlinkComponents,
  directoryContainsMatchingFile,
  findFilesRecursively,
  resolveTraversalBound,
  walkBoundedDirectoryTree,
  type BoundedWalkCounters,
  type BoundedWalkOptions,
  type TraversalEvent,
} from '../../src/utils/traversal.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  tempDirs.push(dir);

  return dir;
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, ...relativePath.split('/'));
    await mkdir(join(absolutePath, '..'), { recursive: true });
    await writeFile(absolutePath, contents, 'utf-8');
  }
}

async function collectEvents(
  options: Omit<BoundedWalkOptions, 'skipDirectoryNames'> &
    Partial<Pick<BoundedWalkOptions, 'skipDirectoryNames'>>
): Promise<TraversalEvent[]> {
  const events: TraversalEvent[] = [];

  for await (const event of walkBoundedDirectoryTree({
    skipDirectoryNames: false,
    ...options,
  })) {
    events.push(event);
  }

  return events;
}

function relativePaths(events: TraversalEvent[], kind: TraversalEvent['kind']): string[] {
  return events
    .filter((event) => event.kind === kind && 'relativePath' in event)
    .map((event) => ('relativePath' in event ? event.relativePath.split(sep).join('/') : ''));
}

const unbounded = { maxDepth: 64, maxEntries: 1_000_000, maxFiles: 1_000_000 };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('walkBoundedDirectoryTree', () => {
  it('keeps the lexicographically first entries when the entry budget truncates a directory', async () => {
    const root = await makeTempDir('llm-docs-walk-entries-');
    await writeTree(root, {
      'd.md': 'd',
      'b.md': 'b',
      'e.md': 'e',
      'a.md': 'a',
      'c.md': 'c',
    });

    const events = await collectEvents({ root, ...unbounded, maxEntries: 3 });

    expect(relativePaths(events, 'file')).toEqual(['a.md', 'b.md', 'c.md']);
    expect(events.filter((event) => event.kind === 'entries-exhausted')).toHaveLength(1);
    // The exhaustion event precedes the entries it truncated, so a caller that
    // records it still sees every entry the budget paid for.
    expect(events[0]?.kind).toBe('entries-exhausted');
  });

  it('stops the walk after the directory that consumed the entry budget and skips its subdirectories', async () => {
    const root = await makeTempDir('llm-docs-walk-entries-stop-');
    await writeTree(root, {
      'a-dir/nested.md': 'nested',
      'b.md': 'b',
      'z-dir/later.md': 'later',
    });

    const events = await collectEvents({ root, ...unbounded, maxEntries: 2 });

    // a-dir and b.md are listed, a-dir is not descended into because the budget
    // was already consumed, and z-dir never appears at all.
    expect(relativePaths(events, 'file')).toEqual(['b.md']);
    expect(events.some((event) => event.kind === 'depth-pruned')).toBe(false);
    expect(events.filter((event) => event.kind === 'entries-exhausted')).toHaveLength(1);
  });

  it('yields a symlink event and never follows the link', async () => {
    const root = await makeTempDir('llm-docs-walk-symlink-');
    await writeTree(root, { 'real/inside.md': 'inside', 'top.md': 'top' });
    await symlink(join(root, 'real'), join(root, 'link'), 'dir');

    const events = await collectEvents({ root, ...unbounded });

    expect(relativePaths(events, 'symlink')).toEqual(['link']);
    expect(relativePaths(events, 'file')).toEqual(['real/inside.md', 'top.md']);
  });

  it('applies the skip list only when skipDirectoryNames is enabled', async () => {
    const root = await makeTempDir('llm-docs-walk-skiplist-');
    await writeTree(root, { 'node_modules/dep.md': 'dep', 'keep.md': 'keep' });

    const skipped = await collectEvents({ root, ...unbounded, skipDirectoryNames: true });
    expect(relativePaths(skipped, 'skipped-directory')).toEqual(['node_modules']);
    expect(relativePaths(skipped, 'file')).toEqual(['keep.md']);

    const unskipped = await collectEvents({ root, ...unbounded, skipDirectoryNames: false });
    expect(relativePaths(unskipped, 'skipped-directory')).toEqual([]);
    expect(relativePaths(unskipped, 'file')).toEqual(['keep.md', 'node_modules/dep.md']);
  });

  it('prunes a directory entry once its depth exceeds maxDepth', async () => {
    const root = await makeTempDir('llm-docs-walk-depth-');
    await writeTree(root, { 'one/two/three/deep.md': 'deep', 'one/two/mid.md': 'mid' });

    const events = await collectEvents({ root, ...unbounded, maxDepth: 2 });

    // Entries at depth 1 and 2 are descended into; the depth-3 directory is pruned.
    expect(relativePaths(events, 'depth-pruned')).toEqual(['one/two/three']);
    expect(relativePaths(events, 'file')).toEqual(['one/two/mid.md']);
    expect(
      events.find((event) => event.kind === 'depth-pruned' && event.depth === 3)
    ).toBeDefined();
  });

  it('carries the original error on an unreadable directory and skips only that subtree', async () => {
    const root = await makeTempDir('llm-docs-walk-unreadable-');
    await writeTree(root, { 'blocked/hidden.md': 'hidden', 'zz.md': 'zz' });
    const blocked = join(root, 'blocked');
    await chmod(blocked, 0o000);

    try {
      const events = await collectEvents({ root, ...unbounded });
      const unreadable = events.find((event) => event.kind === 'unreadable-directory');

      expect(unreadable).toBeDefined();
      if (unreadable?.kind === 'unreadable-directory') {
        expect(unreadable.absolutePath).toBe(blocked);
        expect(unreadable.relativePath).toBe('blocked');
        expect(unreadable.error).toBeInstanceOf(Error);
        expect(String(unreadable.error)).toContain('EACCES');
      }

      // The sibling after the unreadable subtree is still visited.
      expect(relativePaths(events, 'file')).toEqual(['zz.md']);
    } finally {
      await chmod(blocked, 0o755);
    }
  });

  it('reports the readdir error object for a root that is not a directory', async () => {
    const root = await makeTempDir('llm-docs-walk-root-error-');
    const filePath = join(root, 'plain.txt');
    await writeFile(filePath, 'plain', 'utf-8');

    const events = await collectEvents({ root: filePath, ...unbounded });

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.kind).toBe('unreadable-directory');
    if (event?.kind === 'unreadable-directory') {
      expect(event.absolutePath).toBe(filePath);
      expect(event.relativePath).toBe('');
      expect(event.error).toBeInstanceOf(Error);
      expect(String(event.error)).toContain('ENOTDIR');
    }
  });

  it('fires files-exhausted once and keeps yielding file events afterwards', async () => {
    const root = await makeTempDir('llm-docs-walk-files-');
    await writeTree(root, { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c', 'd.md': 'd' });

    const counters: BoundedWalkCounters = { visitedEntries: 0, visitedFiles: 0 };
    const events = await collectEvents({ root, ...unbounded, maxFiles: 2, counters });

    expect(relativePaths(events, 'file')).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
    expect(events.filter((event) => event.kind === 'files-exhausted')).toHaveLength(1);
    expect(events.findIndex((event) => event.kind === 'files-exhausted')).toBe(2);
    expect(counters.visitedFiles).toBe(2);
  });

  it('tracks visited entries and files in the caller supplied counters', async () => {
    const root = await makeTempDir('llm-docs-walk-counters-');
    await writeTree(root, {
      'nested/one.md': 'one',
      'nested/two.md': 'two',
      'top.md': 'top',
    });
    await symlink(join(root, 'top.md'), join(root, 'link.md'), 'file');

    const counters: BoundedWalkCounters = { visitedEntries: 0, visitedFiles: 0 };
    await collectEvents({ root, ...unbounded, counters });

    // Root lists link.md, nested, top.md; nested lists one.md and two.md.
    expect(counters.visitedEntries).toBe(5);
    expect(counters.visitedFiles).toBe(3);
  });
});

describe('resolveTraversalBound', () => {
  it('returns the default for undefined and rejects unusable bounds with one shared message', () => {
    expect(resolveTraversalBound(undefined, 8, 'maxDepth', true)).toBe(8);
    expect(resolveTraversalBound(0, 8, 'maxDepth', true)).toBe(0);
    expect(() => resolveTraversalBound(0, 8, 'maxFiles', false)).toThrow(
      'maxFiles must be a positive safe integer'
    );
    expect(() => resolveTraversalBound(-1, 8, 'maxDepth', true)).toThrow(
      'maxDepth must be a non-negative safe integer'
    );
    expect(() => resolveTraversalBound(1.5, 8, 'maxEntries', false)).toThrow(
      'maxEntries must be a positive safe integer'
    );
  });
});

describe('assertNoParentSymlinkComponents', () => {
  it('rejects a path whose parent directory is a symbolic link', async () => {
    const root = await makeTempDir('llm-docs-walk-parent-symlink-');
    const realDir = join(root, 'real');
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, 'file.md'), 'file', 'utf-8');
    await symlink(realDir, join(root, 'link'), 'dir');

    await expect(
      assertNoParentSymlinkComponents({ label: 'Source', path: join(root, 'link', 'file.md') })
    ).rejects.toThrow('Source path must not contain a symbolic link component');

    await expect(
      assertNoParentSymlinkComponents({ label: 'Docs', path: join(realDir, 'file.md') })
    ).resolves.toBeUndefined();
  });
});

describe('parser directory helpers', () => {
  it('walks unbounded, ignores the skip list, and orders each directory by code unit', async () => {
    const root = await makeTempDir('llm-docs-walk-parser-');
    await writeTree(root, {
      'Zed.md': 'zed',
      'apple.md': 'apple',
      'node_modules/vendored.md': 'vendored',
      'a/b/c/d/e/f/g/h/i/j/deep.md': 'deep',
      'skip.txt': 'skip',
    });
    await symlink(join(root, 'apple.md'), join(root, 'link.md'), 'file');

    const matchesMarkdown = (fileName: string): boolean => fileName.endsWith('.md');
    const found = await findFilesRecursively(root, matchesMarkdown);

    expect(
      found.map((path) =>
        path
          .slice(root.length + 1)
          .split(sep)
          .join('/')
      )
    ).toEqual(['Zed.md', 'a/b/c/d/e/f/g/h/i/j/deep.md', 'apple.md', 'node_modules/vendored.md']);
    // Uppercase sorts before lowercase under code-unit ordering, unlike localeCompare.
    expect(found[0]?.endsWith('Zed.md')).toBe(true);

    await expect(directoryContainsMatchingFile(root, matchesMarkdown)).resolves.toBe(true);
    await expect(
      directoryContainsMatchingFile(root, (fileName) => fileName.endsWith('.rst'))
    ).resolves.toBe(false);
  });
});

describe('bounded walk callers', () => {
  it('truncates discovery deterministically at the entry budget', async () => {
    const root = await makeTempDir('llm-docs-walk-discovery-');
    await writeTree(root, {
      'd.md': 'd',
      'b.md': 'b',
      'e.md': 'e',
      'a.md': 'a',
      'c.md': 'c',
    });

    const inspection = await inspectLocalSource({ source: root, maxEntries: 3 });

    expect(inspection.candidates.map((candidate) => candidate.path)).toEqual([
      'a.md',
      'b.md',
      'c.md',
    ]);
    expect(inspection.traversal.visitedEntries).toBe(3);
    expect(inspection.traversal.truncated).toBe(true);
    expect(inspection.warnings).toContain('Traversal maxEntries reached: 3');
  });

  it('ends a discovery walk once the file budget is consumed instead of continue-scanning', async () => {
    const root = await makeTempDir('llm-docs-walk-discovery-files-');
    await writeTree(root, {
      'a.md': 'a',
      'b.md': 'b',
      'c.md': 'c',
      'z/late.md': 'late',
    });

    const inspection = await inspectLocalSource({ source: root, maxFiles: 2 });

    expect(inspection.candidates.map((candidate) => candidate.path)).toEqual(['a.md', 'b.md']);
    expect(inspection.traversal.visitedFiles).toBe(2);
    expect(inspection.traversal.truncated).toBe(true);
    expect(inspection.warnings).toContain('Traversal maxFiles reached: 2');
    // The walk stops at the budget: the z/ subtree is never entered, so no
    // entries beyond the root listing are counted.
    expect(inspection.traversal.visitedEntries).toBe(4);
  });

  it('rejects an unusable docs traversal bound with the shared bound message', async () => {
    const root = await makeTempDir('llm-docs-walk-verify-bound-');
    const sourceDir = join(root, 'source');
    const docsDir = join(root, 'docs');
    await writeTree(sourceDir, { 'index.ts': 'export function widget(): void {}\n' });
    await writeTree(docsDir, { 'guide.md': 'Call `widget()`.\n' });

    await expect(
      verifyDocsAgainstSource({
        source: sourceDir,
        docs: docsDir,
        outputDir: join(root, 'out'),
        generator: { name: 'llm-docs-generator', version: '0.0.0-test' },
        docsMaxEntries: 0,
      })
    ).rejects.toThrow('docsMaxEntries must be a positive safe integer');
  });

  it('records skipped symlink and vendored directory warnings for parser plugin directories', async () => {
    const root = await makeTempDir('llm-docs-walk-plugin-');
    const sourceDir = join(root, 'source');
    await writeTree(sourceDir, {
      'guide.fixture': 'guide payload',
      'node_modules/vendored.fixture': 'vendored payload',
    });
    await symlink(join(sourceDir, 'guide.fixture'), join(sourceDir, 'link.fixture'), 'file');

    const modulePath = join(root, 'plugin.mjs');
    await writeFile(
      modulePath,
      [
        'export const parser = {',
        "  name: 'Fixture Parser',",
        "  format: 'custom-doc',",
        '  async detect() {',
        '    return true;',
        '  },',
        '  async parse(sourcePath) {',
        '    return {',
        "      type: 'root',",
        "      id: 'fixture-root',",
        "      title: 'Fixture Docs',",
        "      description: '',",
        '      content: [],',
        '      children: [',
        '        {',
        "          type: 'section',",
        "          id: 'fixture-section',",
        "          title: 'Payload',",
        "          description: '',",
        "          content: [{ type: 'prose', content: 'Parsed ' + sourcePath }],",
        '          children: [],',
        "          metadata: new Map([['format', 'custom-doc']]),",
        '        },',
        '      ],',
        "      metadata: new Map([['format', 'custom-doc']]),",
        '    };',
        '  },',
        '};',
        'export default parser;',
        '',
      ].join('\n'),
      'utf-8'
    );

    const manifestPath = join(root, 'parser-plugin.json');
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: '0.1.0',
          kind: 'parser-plugin',
          name: 'fixture-parser-plugin',
          version: '1.2.3',
          module: 'plugin.mjs',
          formats: [
            {
              id: 'custom-doc',
              displayName: 'Fixture Custom Format',
              extensions: ['fixture'],
              mediaTypes: ['text/x-fixture'],
              directorySupport: true,
            },
          ],
        },
        null,
        2
      )}\n`,
      'utf-8'
    );

    const result = await generateSourceDocs({
      source: sourceDir,
      outputDir: join(root, 'out'),
      format: 'custom-doc',
      parserPluginManifest: manifestPath,
      generator: { name: 'llm-docs-generator', version: '0.0.0-test' },
    });

    expect(result.manifest.warnings).toContain('Skipped symlinked source entry: link.fixture');
    expect(result.manifest.warnings).toContain('Skipped vendored or build directory: node_modules');
    expect(result.manifest.sourceFiles.map((file) => file.path)).toEqual(['guide.fixture']);
  });
});
