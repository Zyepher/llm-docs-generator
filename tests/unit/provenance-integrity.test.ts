import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureGitState } from '../../src/core/git-state.js';
import {
  generateSourceDocs,
  type GenerateSourceDocsOptions,
  type SourceDocsManifest,
} from '../../src/core/source-docs.js';
import { verifyGenerationManifest } from '../../src/core/manifest.js';
import { refreshGenerationManifest, RefreshManifestError } from '../../src/core/refresh.js';

const tempDirs: string[] = [];

const generator = { name: 'llm-docs-generator', version: '2.0.0', cliName: 'llm-docs' };

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  tempDirs.push(dir);

  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

async function initRepo(root: string): Promise<void> {
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
}

async function writeSourceFile(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(root, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

async function readManifest(manifestPath: string): Promise<SourceDocsManifest> {
  return JSON.parse(await readFile(manifestPath, 'utf-8')) as SourceDocsManifest;
}

async function generate(
  options: Omit<GenerateSourceDocsOptions, 'generator'> &
    Partial<Pick<GenerateSourceDocsOptions, 'generator'>>
): Promise<{ manifest: SourceDocsManifest; manifestPath: string }> {
  const result = await generateSourceDocs({
    generator,
    ...options,
  });

  return { manifest: result.manifest, manifestPath: result.manifestPath };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('captureGitState (git provenance capture)', () => {
  it('records the enclosing repo identity for a directory source', async () => {
    const repo = await makeTempDir('llm-docs-git-capture-');
    await initRepo(repo);
    await writeSourceFile(repo, 'docs/intro.md', '# Intro\n\nHello.\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);
    git(repo, ['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
    git(repo, ['tag', 'v1.0.0']);
    git(repo, ['tag', 'alpha']);
    const commit = git(repo, ['rev-parse', 'HEAD']);

    const state = await captureGitState(join(repo, 'docs'));

    expect(state).toEqual({
      remoteUrl: 'https://github.com/example/repo.git',
      commit,
      // Tags sorted deterministically by code unit.
      tags: ['alpha', 'v1.0.0'],
      dirty: false,
      sourceRootFromRepo: 'docs',
    });
  });

  it('records a null remote and the file name for a file source at repo root', async () => {
    const repo = await makeTempDir('llm-docs-git-file-');
    await initRepo(repo);
    await writeSourceFile(repo, 'guide.md', '# Guide\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);

    const state = await captureGitState(join(repo, 'guide.md'));

    expect(state?.remoteUrl).toBeNull();
    expect(state?.tags).toEqual([]);
    expect(state?.sourceRootFromRepo).toBe('guide.md');
  });

  it('scrubs embedded credentials from the origin remote', async () => {
    const repo = await makeTempDir('llm-docs-git-scrub-');
    await initRepo(repo);
    await writeSourceFile(repo, 'docs/a.md', '# A\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);
    git(repo, ['remote', 'add', 'origin', 'https://user:secret-token@github.com/example/repo.git']);

    const state = await captureGitState(join(repo, 'docs'));

    expect(state?.remoteUrl).toBe('https://github.com/example/repo.git');
    expect(state?.remoteUrl).not.toContain('secret-token');
  });

  it('reports dirty when the working tree has uncommitted changes', async () => {
    const repo = await makeTempDir('llm-docs-git-dirty-');
    await initRepo(repo);
    await writeSourceFile(repo, 'docs/a.md', '# A\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);
    await writeSourceFile(repo, 'docs/a.md', '# A changed\n');

    const state = await captureGitState(join(repo, 'docs'));

    expect(state?.dirty).toBe(true);
  });

  it('returns undefined for a non-git source (never an error)', async () => {
    const plain = await makeTempDir('llm-docs-git-none-');
    await writeSourceFile(plain, 'docs/a.md', '# A\n');

    expect(await captureGitState(join(plain, 'docs'))).toBeUndefined();
  });
});

describe('generate --source manifest.source.git (task 1)', () => {
  it('persists the captured git context into the manifest', async () => {
    const repo = await makeTempDir('llm-docs-manifest-git-');
    await initRepo(repo);
    await writeSourceFile(repo, 'docs/a.md', '# A\n');
    await writeSourceFile(repo, 'docs/b.md', '# B\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);
    const commit = git(repo, ['rev-parse', 'HEAD']);
    const outputDir = await makeTempDir('llm-docs-manifest-git-out-');
    const sourceDir = join(repo, 'docs');
    const gitContext = await captureGitState(sourceDir);
    expect(gitContext).toBeDefined();

    const { manifest } = await generate({
      source: sourceDir,
      outputDir,
      format: 'markdown',
      ...(gitContext === undefined ? {} : { gitContext }),
    });

    expect(manifest.source.git).toEqual({
      remoteUrl: null,
      commit,
      tags: [],
      dirty: false,
      sourceRootFromRepo: 'docs',
    });
  });

  it('omits source.git for a non-git source', async () => {
    const plain = await makeTempDir('llm-docs-manifest-nogit-');
    await writeSourceFile(plain, 'docs/a.md', '# A\n');
    const outputDir = await makeTempDir('llm-docs-manifest-nogit-out-');
    const gitContext = await captureGitState(join(plain, 'docs'));

    const { manifest } = await generate({
      source: join(plain, 'docs'),
      outputDir,
      format: 'markdown',
      ...(gitContext === undefined ? {} : { gitContext }),
    });

    expect(manifest.source.git).toBeUndefined();
  });
});

describe('generate --source --label (task 2)', () => {
  it('records the operator label verbatim', async () => {
    const source = await makeTempDir('llm-docs-label-');
    await writeSourceFile(source, 'a.md', '# A\n');
    const outputDir = await makeTempDir('llm-docs-label-out-');

    const { manifest } = await generate({
      source: join(source, 'a.md'),
      outputDir,
      format: 'markdown',
      label: '@tanstack/react-router@1.170.17',
    });

    expect(manifest.source.label).toBe('@tanstack/react-router@1.170.17');
  });

  it('omits label when none is provided', async () => {
    const source = await makeTempDir('llm-docs-nolabel-');
    await writeSourceFile(source, 'a.md', '# A\n');
    const outputDir = await makeTempDir('llm-docs-nolabel-out-');

    const { manifest } = await generate({ source: join(source, 'a.md'), outputDir, format: 'markdown' });

    expect(manifest.source.label).toBeUndefined();
  });
});

describe('generate --source --exclude (task 6)', () => {
  it('excludes files matching a ** glob and records them', async () => {
    const source = await makeTempDir('llm-docs-exclude-');
    await writeSourceFile(source, 'keep.md', '# Keep\n');
    await writeSourceFile(source, 'how-to/drafts/wip.md', '# WIP\n');
    await writeSourceFile(source, 'how-to/drafts/nested/more.md', '# More\n');
    await writeSourceFile(source, 'how-to/final.md', '# Final\n');
    const outputDir = await makeTempDir('llm-docs-exclude-out-');

    const { manifest } = await generate({
      source,
      outputDir,
      format: 'markdown',
      exclude: ['how-to/drafts/**'],
    });

    expect(manifest.source.excluded).toEqual([
      { path: 'how-to/drafts/nested/more.md', glob: 'how-to/drafts/**' },
      { path: 'how-to/drafts/wip.md', glob: 'how-to/drafts/**' },
    ]);
    expect(manifest.sourceFiles.map((file) => file.path).sort()).toEqual([
      'how-to/final.md',
      'keep.md',
    ]);
    expect(manifest.warnings.some((warning) => warning.includes('Excluded 2 file(s)'))).toBe(true);
  });

  it('supports single-segment * and ? wildcards', async () => {
    const source = await makeTempDir('llm-docs-exclude-star-');
    await writeSourceFile(source, 'a.tmp.md', '# tmp\n');
    await writeSourceFile(source, 'b.md', '# b\n');
    await writeSourceFile(source, 'note1.md', '# n1\n');
    const outputDir = await makeTempDir('llm-docs-exclude-star-out-');

    const { manifest } = await generate({
      source,
      outputDir,
      format: 'markdown',
      exclude: ['*.tmp.md', 'note?.md'],
    });

    expect(manifest.source.excluded?.map((entry) => entry.path).sort()).toEqual([
      'a.tmp.md',
      'note1.md',
    ]);
    expect(manifest.sourceFiles.map((file) => file.path)).toEqual(['b.md']);
  });

  it('omits source.excluded when no glob matches', async () => {
    const source = await makeTempDir('llm-docs-exclude-none-');
    await writeSourceFile(source, 'a.md', '# a\n');
    const outputDir = await makeTempDir('llm-docs-exclude-none-out-');

    const { manifest } = await generate({
      source,
      outputDir,
      format: 'markdown',
      exclude: ['does/not/match/**'],
    });

    expect(manifest.source.excluded).toBeUndefined();
  });
});

describe('generate --source skippedFiles (task 7)', () => {
  it('records non-markdown files skipped from a markdown pack', async () => {
    const source = await makeTempDir('llm-docs-skip-');
    await writeSourceFile(source, 'a.md', '# a\n');
    await writeSourceFile(source, 'config.json', '{"x":1}\n');
    await writeSourceFile(source, 'logo.png', 'PNGDATA');
    const outputDir = await makeTempDir('llm-docs-skip-out-');

    const { manifest } = await generate({ source, outputDir, format: 'markdown' });

    expect(manifest.source.fileCount).toBe(1);
    const skipped = manifest.source.skippedFiles ?? [];
    const byPath = new Map(skipped.map((entry) => [entry.path, entry.reason]));
    expect(byPath.get('logo.png')).toBe('unsupported-file-type');
    expect(byPath.get('config.json')).toContain('not selected');
    expect(manifest.warnings.some((warning) => warning.includes('Skipped 2 file(s)'))).toBe(true);
  });
});

describe('generate --source draft detection (task 8)', () => {
  it('warns about draft-like files without excluding them', async () => {
    const source = await makeTempDir('llm-docs-draft-');
    await writeSourceFile(source, 'clean.md', '# Clean\n\nbody\n');
    await writeSourceFile(source, 'payments.draft.md', '# Payments\n\nbody\n');
    await writeSourceFile(source, 'drafts/wip.md', '# WIP\n\nbody\n');
    await writeSourceFile(source, 'flagged.md', '# DRAFT Not ready\n\nbody\n');
    const outputDir = await makeTempDir('llm-docs-draft-out-');

    const { manifest } = await generate({ source, outputDir, format: 'markdown' });

    const draftWarning = manifest.warnings.find((warning) => warning.startsWith('Draft-like'));
    expect(draftWarning).toBeDefined();
    expect(draftWarning).toContain('drafts/wip.md');
    expect(draftWarning).toContain('payments.draft.md');
    expect(draftWarning).toContain('flagged.md');
    expect(draftWarning).not.toContain('clean.md');
    // Fact-reporting only: every draft file is still included as a source file.
    expect(manifest.sourceFiles).toHaveLength(4);
  });
});

describe('verify two-tier integrity (task 4)', () => {
  async function generatePack(): Promise<{ manifestPath: string; sourceDir: string }> {
    const source = await makeTempDir('llm-docs-verify-src-');
    await writeSourceFile(source, 'a.md', '# A\n\nbody\n');
    await writeSourceFile(source, 'b.md', '# B\n\nbody\n');
    const outputDir = await makeTempDir('llm-docs-verify-out-');
    const { manifestPath } = await generate({ source, outputDir, format: 'markdown' });

    return { manifestPath, sourceDir: source };
  }

  it('passes both tiers for an intact pack', async () => {
    const { manifestPath } = await generatePack();

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.outputs?.status).toBe('passed');
    expect(result.source?.status).toBe('passed');
    expect(result.failures).toHaveLength(0);
    expect(result.checkedFiles).toBeGreaterThan(0);
  });

  it('always hash-checks outputs and reports the source unavailable when the source is missing', async () => {
    const { manifestPath, sourceDir } = await generatePack();
    await rename(sourceDir, `${sourceDir}-relocated`);
    tempDirs.push(`${sourceDir}-relocated`);

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.outputs?.status).toBe('passed');
    expect(result.outputs?.checkedFiles).toBeGreaterThan(0);
    expect(result.source?.status).toBe('unavailable');
    // Regression guard: the generated outputs are still hash-checked, so the
    // legacy checkedFiles count is no longer zero when the source is missing.
    expect(result.checkedFiles).toBe(result.outputs?.checkedFiles);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it('marks the outputs tier failed when a generated output is tampered', async () => {
    const { manifestPath } = await generatePack();
    const manifest = await readManifest(manifestPath);
    const outputPath = join(dirname(manifestPath), manifest.generatedOutputs[0]!.path);
    await writeFile(outputPath, 'tampered content\n', 'utf-8');

    const result = await verifyGenerationManifest({ manifestPath });

    expect(result.outputs?.status).toBe('failed');
    expect(result.failures.some((failure) => failure.includes('hash mismatch'))).toBe(true);
  });
});

describe('refresh git-drift detection (task 5)', () => {
  async function generateGitPack(): Promise<{
    manifestPath: string;
    repo: string;
    sourceDir: string;
    firstCommit: string;
  }> {
    const repo = await makeTempDir('llm-docs-refresh-repo-');
    await initRepo(repo);
    await writeSourceFile(repo, 'docs/a.md', '# A\n\nbody\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'init']);
    git(repo, ['remote', 'add', 'origin', 'https://github.com/example/repo.git']);
    const firstCommit = git(repo, ['rev-parse', 'HEAD']);
    const outputDir = await makeTempDir('llm-docs-refresh-out-');
    const sourceDir = join(repo, 'docs');
    const gitContext = await captureGitState(sourceDir);
    const { manifestPath } = await generate({
      source: sourceDir,
      outputDir,
      format: 'markdown',
      label: 'v1',
      ...(gitContext === undefined ? {} : { gitContext }),
    });

    return { manifestPath, repo, sourceDir, firstCommit };
  }

  it('refreshes cleanly when the source HEAD matches the recorded commit', async () => {
    const { manifestPath, firstCommit } = await generateGitPack();

    const result = await refreshGenerationManifest({ manifestPath, generator });
    const manifest = await readManifest(manifestPath);

    expect(result.mode).toBe('local-source-docs');
    expect(manifest.source.git?.commit).toBe(firstCommit);
    expect(manifest.source.label).toBe('v1');
  });

  it('fails on git drift with both commits and the remote unless --accept-drift', async () => {
    const { manifestPath, repo, firstCommit } = await generateGitPack();
    await writeSourceFile(repo, 'docs/b.md', '# B\n\nbody\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'second']);
    const secondCommit = git(repo, ['rev-parse', 'HEAD']);

    await expect(refreshGenerationManifest({ manifestPath, generator })).rejects.toThrow(
      RefreshManifestError
    );
    await expect(refreshGenerationManifest({ manifestPath, generator })).rejects.toThrow(
      new RegExp(`${firstCommit}[\\s\\S]*${secondCommit}[\\s\\S]*example/repo`)
    );
  });

  it('records the new git state and preserves the label when --accept-drift is passed', async () => {
    const { manifestPath, repo } = await generateGitPack();
    await writeSourceFile(repo, 'docs/b.md', '# B\n\nbody\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'second']);
    const secondCommit = git(repo, ['rev-parse', 'HEAD']);

    await refreshGenerationManifest({ manifestPath, generator, acceptDrift: true });
    const manifest = await readManifest(manifestPath);

    expect(manifest.source.git?.commit).toBe(secondCommit);
    expect(manifest.source.label).toBe('v1');
  });

  it('includes the recorded git identity when the source path is missing', async () => {
    const { manifestPath, sourceDir, firstCommit } = await generateGitPack();
    await rename(sourceDir, `${sourceDir}-gone`);
    tempDirs.push(`${sourceDir}-gone`);

    await expect(refreshGenerationManifest({ manifestPath, generator })).rejects.toThrow(
      new RegExp(`not found[\\s\\S]*example/repo[\\s\\S]*${firstCommit}`)
    );
  });
});
