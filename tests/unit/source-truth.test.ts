import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectSourceTruth } from '../../src/core/source-truth.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  tempDirs.push(dir);

  return dir;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('source-truth inspection', () => {
  it('extracts conservative TypeScript and JavaScript export facts with source provenance', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    const alphaSource = [
      'const privateValue = 1;',
      'export const alpha = 1;',
      'export function makeAlpha() {',
      '  return alpha;',
      '}',
      'export interface Options {',
      '  value: string;',
      '}',
      'export type Alias = Options;',
      "export { makeAlpha as renamedAlpha };",
      "export * from './beta';",
      '',
    ].join('\n');
    const betaSource = [
      'export class Beta {}',
      'export default function defaultBeta() {}',
      '',
    ].join('\n');

    await writeFile(join(sourceDir, 'beta.ts'), betaSource, 'utf-8');
    await writeFile(join(sourceDir, 'alpha.ts'), alphaSource, 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });

    expect(report).toMatchObject({
      schemaVersion: '0.1.0',
      mode: 'source-truth-local-evidence',
      source: {
        input: sourceDir,
        resolvedPath: sourceDir,
        type: 'directory',
      },
      traversal: {
        followSymlinks: false,
        maxDepth: 8,
        maxEntries: 20000,
        maxFiles: 5000,
        maxFileBytes: 262144,
        inspectedFiles: 2,
        skippedFiles: 0,
        truncated: false,
      },
      warnings: [],
    });
    expect(report.files.map((file) => file.path)).toEqual(['alpha.ts', 'beta.ts']);
    expect(report.files[0]).toMatchObject({
      path: 'alpha.ts',
      status: 'inspected',
      supported: true,
      byteSize: Buffer.byteLength(alphaSource),
      sha256: sha256(alphaSource),
    });
    expect(report.files[1]).toMatchObject({
      path: 'beta.ts',
      status: 'inspected',
      supported: true,
      byteSize: Buffer.byteLength(betaSource),
      sha256: sha256(betaSource),
    });
    expect(report.facts.map(({ kind, symbolKind, name, exportedName, moduleSpecifier }) => ({
      kind,
      symbolKind,
      name,
      exportedName,
      moduleSpecifier,
    }))).toEqual([
      {
        kind: 'exported-symbol',
        symbolKind: 'value',
        name: 'alpha',
        exportedName: 'alpha',
        moduleSpecifier: undefined,
      },
      {
        kind: 'exported-symbol',
        symbolKind: 'function',
        name: 'makeAlpha',
        exportedName: 'makeAlpha',
        moduleSpecifier: undefined,
      },
      {
        kind: 'exported-symbol',
        symbolKind: 'interface',
        name: 'Options',
        exportedName: 'Options',
        moduleSpecifier: undefined,
      },
      {
        kind: 'exported-symbol',
        symbolKind: 'type',
        name: 'Alias',
        exportedName: 'Alias',
        moduleSpecifier: undefined,
      },
      {
        kind: 're-exported-symbol',
        symbolKind: 'unknown',
        name: 'makeAlpha',
        exportedName: 'renamedAlpha',
        moduleSpecifier: undefined,
      },
      {
        kind: 'export-all',
        symbolKind: 'unknown',
        name: '*',
        exportedName: '*',
        moduleSpecifier: './beta',
      },
      {
        kind: 'exported-symbol',
        symbolKind: 'class',
        name: 'Beta',
        exportedName: 'Beta',
        moduleSpecifier: undefined,
      },
      {
        kind: 'exported-symbol',
        symbolKind: 'function',
        name: 'defaultBeta',
        exportedName: 'default',
        moduleSpecifier: undefined,
      },
    ]);
    expect(report.facts.map((fact) => fact.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(report.facts.map((fact) => fact.provenance)).toEqual([
      { path: 'alpha.ts', lineRange: { start: 2, end: 2 } },
      { path: 'alpha.ts', lineRange: { start: 3, end: 5 } },
      { path: 'alpha.ts', lineRange: { start: 6, end: 8 } },
      { path: 'alpha.ts', lineRange: { start: 9, end: 9 } },
      { path: 'alpha.ts', lineRange: { start: 10, end: 10 } },
      { path: 'alpha.ts', lineRange: { start: 11, end: 11 } },
      { path: 'beta.ts', lineRange: { start: 1, end: 1 } },
      { path: 'beta.ts', lineRange: { start: 2, end: 2 } },
    ]);
  });

  it('reports unsupported and oversized files without extracting facts', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-skips-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'notes.md'), '# Notes\n', 'utf-8');
    await writeFile(join(sourceDir, 'large.ts'), 'export const tooLarge = true;\n', 'utf-8');
    await writeFile(join(sourceDir, 'small.js'), 'export const small = true;\n', 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir, maxFileBytes: 20 });

    expect(report.files.map((file) => ({
      path: file.path,
      status: file.status,
      supported: file.supported,
      skipReason: file.skipReason,
      facts: file.facts.length,
    }))).toEqual([
      {
        path: 'large.ts',
        status: 'skipped',
        supported: true,
        skipReason: 'oversized',
        facts: 0,
      },
      {
        path: 'notes.md',
        status: 'skipped',
        supported: false,
        skipReason: 'unsupported-extension',
        facts: 0,
      },
      {
        path: 'small.js',
        status: 'skipped',
        supported: true,
        skipReason: 'oversized',
        facts: 0,
      },
    ]);
    expect(report.facts).toEqual([]);
    expect(report.traversal).toMatchObject({
      inspectedFiles: 0,
      skippedFiles: 3,
      truncated: false,
    });
    expect(report.warnings).toEqual([
      'Skipped oversized file: large.ts (30 bytes)',
      'Skipped unsupported file: notes.md',
      'Skipped oversized file: small.js (27 bytes)',
    ]);
    expect(report.files.every((file) => file.sha256 === undefined)).toBe(true);
  });

  it('hashes supported files from raw bytes before UTF-8 decoding for parsing', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-raw-hash-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    const sourceBytes = Buffer.concat([
      Buffer.from('export const value = "', 'utf-8'),
      Buffer.from([0xff]),
      Buffer.from('";\n', 'utf-8'),
    ]);
    await writeFile(join(sourceDir, 'raw.js'), sourceBytes);

    const report = await inspectSourceTruth({ source: sourceDir });
    const decodedHash = sha256(sourceBytes.toString('utf-8'));
    const rawHash = createHash('sha256').update(sourceBytes).digest('hex');

    expect(decodedHash).not.toBe(rawHash);
    expect(report.files[0]).toMatchObject({
      path: 'raw.js',
      status: 'inspected',
      sha256: rawHash,
    });
    expect(report.facts.map((fact) => fact.name)).toEqual(['value']);
  });

  it('reports syntax diagnostics for malformed TypeScript while keeping observed facts', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-diagnostics-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, 'broken.ts'),
      ['export const broken = ;', 'export const after = true;', ''].join('\n'),
      'utf-8'
    );

    const report = await inspectSourceTruth({ source: sourceDir });

    expect(report.warnings).toEqual(['Syntax diagnostics in file: broken.ts (1)']);
    expect(report.files[0]?.parseDiagnostics).toEqual([
      {
        code: expect.any(Number),
        category: 'error',
        message: expect.any(String),
        lineRange: { start: 1, end: 1 },
      },
    ]);
    expect(report.facts.map((fact) => fact.name)).toEqual(['broken', 'after']);
  });

  it('keeps traversal bounded, skips generated directories, and never follows symlinks', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-bounds-');
    const sourceDir = join(dir, 'source');
    await mkdir(join(sourceDir, 'z-nested'), { recursive: true });
    await mkdir(join(sourceDir, 'node_modules/pkg'), { recursive: true });
    await writeFile(join(sourceDir, 'root.ts'), 'export const root = true;\n', 'utf-8');
    await writeFile(join(sourceDir, 'z-nested/deep.ts'), 'export const deep = true;\n', 'utf-8');
    await writeFile(
      join(sourceDir, 'node_modules/pkg/ignored.ts'),
      'export const ignored = true;\n',
      'utf-8'
    );
    await symlink(join(sourceDir, 'z-nested/deep.ts'), join(sourceDir, 'linked.ts'));

    const depthReport = await inspectSourceTruth({ source: sourceDir, maxDepth: 0 });

    expect(depthReport.files.map((file) => file.path)).toEqual(['root.ts']);
    expect(depthReport.facts.map((fact) => fact.name)).toEqual(['root']);
    expect(depthReport.traversal.truncated).toBe(true);
    expect(depthReport.warnings).toContain('Skipped symbolic link: linked.ts');
    expect(depthReport.warnings).toContain('Traversal stopped at max depth 0: z-nested');

    const fullReport = await inspectSourceTruth({ source: sourceDir });

    expect(fullReport.files.map((file) => file.path)).toEqual(['root.ts', 'z-nested/deep.ts']);
    expect(fullReport.facts.map((fact) => fact.name)).toEqual(['root', 'deep']);
    expect(fullReport.warnings).toContain('Skipped symbolic link: linked.ts');
    expect(fullReport.warnings).toContain('Skipped directory by default: node_modules');
    expect(fullReport.files.some((file) => file.path.includes('ignored'))).toBe(false);
  });

  it('rejects explicit source paths that traverse an intermediate symlink component', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-source-symlink-');
    const realSourceDir = join(dir, 'real-source');
    const linkedSourceDir = join(dir, 'linked-source');
    await mkdir(join(realSourceDir, 'src'), { recursive: true });
    await writeFile(join(realSourceDir, 'src/index.ts'), 'export const value = true;\n', 'utf-8');
    await symlink(realSourceDir, linkedSourceDir, 'dir');

    await expect(
      inspectSourceTruth({ source: join(linkedSourceDir, 'src/index.ts') })
    ).rejects.toThrow(`Source path must not contain a symbolic link component: ${linkedSourceDir}`);
  });

  it('reports maxFiles truncation deterministically', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-maxfiles-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'a.ts'), 'export const a = true;\n', 'utf-8');
    await writeFile(join(sourceDir, 'b.ts'), 'export const b = true;\n', 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir, maxFiles: 1 });

    expect(report.files.map((file) => file.path)).toEqual(['a.ts']);
    expect(report.facts.map((fact) => fact.name)).toEqual(['a']);
    expect(report.traversal).toMatchObject({
      visitedFiles: 1,
      inspectedFiles: 1,
      truncated: true,
    });
    expect(report.warnings).toEqual(['Traversal maxFiles reached: 1']);
  });

  it('fails closed for over-wide directories instead of choosing nondeterministic entries', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-maxentries-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'zeta.ts'), 'export const zeta = true;\n', 'utf-8');
    await writeFile(join(sourceDir, 'delta.ts'), 'export const delta = true;\n', 'utf-8');
    await writeFile(join(sourceDir, 'beta.ts'), 'export const beta = true;\n', 'utf-8');
    await writeFile(join(sourceDir, 'alpha.ts'), 'export const alpha = true;\n', 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir, maxEntries: 2 });
    const secondReport = await inspectSourceTruth({ source: sourceDir, maxEntries: 2 });

    expect(report.files).toEqual([]);
    expect(secondReport.files).toEqual([]);
    expect(report.facts).toEqual([]);
    expect(report.traversal).toMatchObject({
      maxEntries: 2,
      visitedEntries: 0,
      visitedFiles: 0,
      inspectedFiles: 0,
      truncated: true,
    });
    expect(report.warnings).toEqual(['Traversal maxEntries reached: 2']);
  });

  it('processes directories that fit within maxEntries in sorted deterministic order', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-maxentries-fit-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'zeta.ts'), 'export const zeta = true;\n', 'utf-8');
    await writeFile(join(sourceDir, 'alpha.ts'), 'export const alpha = true;\n', 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir, maxEntries: 2 });

    expect(report.files.map((file) => file.path)).toEqual(['alpha.ts', 'zeta.ts']);
    expect(report.facts.map((fact) => fact.name)).toEqual(['alpha', 'zeta']);
    expect(report.traversal).toMatchObject({
      maxEntries: 2,
      visitedEntries: 2,
      visitedFiles: 2,
      inspectedFiles: 2,
      truncated: false,
    });
    expect(report.warnings).toEqual([]);
  });
});
