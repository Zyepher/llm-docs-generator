import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  generateSourceDocs,
  type GenerateSourceDocsOptions,
  type GenerateSourceGitContext,
} from '../../src/core/source-docs.js';

const GENERATOR = { name: 'llm-docs', version: '0.0.0-test', cliName: 'llm-docs' } as const;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Build a repo whose docs pack uses TanStack-style extension-less cross-links,
 * plus one on-disk file that lives OUTSIDE the pack (under the repo root but not
 * the source root) to exercise the disk-existence oracle.
 */
async function buildRepo(): Promise<{ repo: string; docs: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'llm-docs-extless-'));
  tempDirs.push(repo);
  const docs = join(repo, 'docs');

  await mkdir(join(docs, 'guide'), { recursive: true });
  await mkdir(join(docs, 'installation'), { recursive: true });
  await mkdir(join(docs, 'api'), { recursive: true });
  await mkdir(join(repo, 'shared'), { recursive: true });

  await writeFile(
    join(docs, 'guide', 'seo.md'),
    [
      '# SEO',
      '',
      'Set up a [server route](./server-routes) and read the',
      '[Installation with Vite](../installation/with-vite) guide. See the',
      '[API](../api/router#createlink) for details, plus a [shared helper](../../shared/util).',
      'A [dead link](./does-not-exist) and a',
      '[site route](/router/latest/docs/guide/preloading) stay unrewritten.',
      '',
    ].join('\n'),
    'utf-8'
  );
  await writeFile(
    join(docs, 'guide', 'server-routes.md'),
    '# Server Routes\n\nServer route docs.\n',
    'utf-8'
  );
  await writeFile(
    join(docs, 'installation', 'with-vite.md'),
    '# With Vite\n\nVite install docs.\n',
    'utf-8'
  );
  await writeFile(join(docs, 'api', 'router.md'), '# Router API\n\nRouter API docs.\n', 'utf-8');
  await writeFile(join(repo, 'shared', 'util.md'), '# Util\n\nShared util.\n', 'utf-8');

  return { repo, docs };
}

async function generate(
  docs: string,
  extra: Partial<GenerateSourceDocsOptions> = {}
): Promise<{ full: string; warnings: string[] }> {
  const outputDir = await mkdtemp(join(tmpdir(), 'llm-docs-extless-out-'));
  tempDirs.push(outputDir);
  const result = await generateSourceDocs({
    source: docs,
    outputDir,
    format: 'markdown',
    generator: GENERATOR,
    output: { filenamePrefix: 'pack' },
    ...extra,
  });
  const full = await readFile(join(result.llmDocsDir, 'pack-full-llms.txt'), 'utf-8');
  return { full, warnings: result.manifest.warnings };
}

describe('extension-less link rewriting (integration)', () => {
  it('rewrites in-pack route-style links to pack: targets, preserving fragments', async () => {
    const { docs } = await buildRepo();
    const { full } = await generate(docs);

    expect(full).toContain('[server route](pack:guide/server-routes.md)');
    expect(full).toContain('[Installation with Vite](pack:installation/with-vite.md)');
    expect(full).toContain('[API](pack:api/router.md#createlink)');
  });

  it('pins an on-disk out-of-pack extension-less target to a github blob url', async () => {
    const { docs } = await buildRepo();
    const gitContext: GenerateSourceGitContext = {
      remoteUrl: 'git@github.com:acme/widget.git',
      commit: 'deadbeef',
      tags: [],
      dirty: false,
      sourceRootFromRepo: 'docs',
    };
    const { full } = await generate(docs, { gitContext });

    expect(full).toContain(
      '[shared helper](https://github.com/acme/widget/blob/deadbeef/shared/util.md)'
    );
  });

  it('counts every unrewritten doc cross-reference with an honest per-class breakdown', async () => {
    const { docs } = await buildRepo();
    const gitContext: GenerateSourceGitContext = {
      remoteUrl: 'git@github.com:acme/widget.git',
      commit: 'deadbeef',
      tags: [],
      dirty: false,
      sourceRootFromRepo: 'docs',
    };
    const { warnings } = await generate(docs, { gitContext });

    // Only two links stay unrewritten: the /router/latest site route and the
    // ./does-not-exist dead relative. The warning must count BOTH, by class.
    const warning = warnings.find((w) => w.includes('unrewritten'));
    expect(warning).toBeDefined();
    expect(warning).toContain('Left 2 doc cross-reference(s) unrewritten');
    expect(warning).toContain('1 site-absolute');
    expect(warning).toContain('1 unresolvable relative');
  });

  it('leaves the site-absolute and dead relative links unrewritten in the body', async () => {
    const { docs } = await buildRepo();
    const { full } = await generate(docs);

    expect(full).toContain('[dead link](./does-not-exist)');
    expect(full).toContain('[site route](/router/latest/docs/guide/preloading)');
  });
});
