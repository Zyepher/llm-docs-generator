import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SourceTruthDocsNoFactsError,
  formatSourceTruthMarkdown,
  generateSourceTruthDocs,
  type SourceTruthDocsFailure,
  type SourceTruthDocsManifest,
} from '../../src/core/source-truth-docs.js';
import {
  inspectSourceTruth,
  type SourceTruthInspectionReport,
} from '../../src/core/source-truth.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  tempDirs.push(dir);

  return dir;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('source-truth docs generation', () => {
  it('writes deterministic evidence-bound Markdown, raw report, and manifest files', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-docs-');
    const sourceDir = join(dir, 'source');
    const firstOutputDir = join(dir, 'out-a');
    const secondOutputDir = join(dir, 'out-b');
    await mkdir(sourceDir, { recursive: true });

    const alphaSource = [
      'export const alpha = 1;',
      'export function makeAlpha() {',
      '  return alpha;',
      '}',
      'export { alpha as renamedAlpha };',
      "export * from './zeta';",
      '',
    ].join('\n');
    const zetaSource = ['export class Zeta {}', 'export default Zeta;', ''].join('\n');
    await writeFile(join(sourceDir, 'zeta.ts'), zetaSource, 'utf-8');
    await writeFile(join(sourceDir, 'alpha.ts'), alphaSource, 'utf-8');

    const firstResult = await generateSourceTruthDocs({
      source: sourceDir,
      outputDir: firstOutputDir,
    });
    const secondResult = await generateSourceTruthDocs({
      source: sourceDir,
      outputDir: secondOutputDir,
    });

    expect((await readdir(firstOutputDir)).sort()).toEqual([
      'manifest.json',
      'source-truth-report.json',
      'source-truth.md',
    ]);

    const report = await readJson<SourceTruthInspectionReport>(
      join(firstOutputDir, 'source-truth-report.json')
    );
    const manifest = await readJson<SourceTruthDocsManifest>(join(firstOutputDir, 'manifest.json'));
    const markdown = await readFile(join(firstOutputDir, 'source-truth.md'), 'utf-8');
    const secondManifestText = await readFile(join(secondOutputDir, 'manifest.json'), 'utf-8');
    const secondMarkdown = await readFile(join(secondOutputDir, 'source-truth.md'), 'utf-8');
    const secondReportText = await readFile(
      join(secondOutputDir, 'source-truth-report.json'),
      'utf-8'
    );

    expect(report).toEqual(firstResult.report);
    expect(JSON.stringify(report, null, 2) + '\n').toEqual(secondReportText);
    expect(markdown).toEqual(secondMarkdown);
    expect(JSON.stringify(manifest, null, 2) + '\n').toEqual(secondManifestText);
    expect(firstResult.outputDir).toBe(firstOutputDir);
    expect(secondResult.outputDir).toBe(secondOutputDir);

    expect(markdown).toContain('### `alpha.ts`');
    expect(markdown.indexOf('### `alpha.ts`')).toBeLessThan(markdown.indexOf('### `zeta.ts`'));
    expect(markdown).toContain('- `renamedAlpha`');
    expect(markdown).toContain('  - Fact kind: `re-exported-symbol`');
    expect(markdown).toContain('  - Symbol kind: `unknown`');
    expect(markdown).toContain('  - Original name: `alpha`');
    expect(markdown).toContain('  - Module specifier: `./zeta`');
    expect(markdown).toContain('  - Lines: `6-6`');
    expect(markdown).toContain('- No runtime behavior is inferred.');
    expect(markdown).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(markdown).not.toMatch(/\bofficial\b/i);
    expect(markdown).not.toMatch(/\bcorrect(?:ness)?\b/i);
    expect(markdown).not.toMatch(/\bverified\b/i);

    expect(manifest).toMatchObject({
      schemaVersion: '0.1.0',
      mode: 'source-truth-local-docs',
      source: {
        input: sourceDir,
        resolvedPath: sourceDir,
        type: 'directory',
      },
      inspection: {
        schemaVersion: '0.1.0',
        mode: 'source-truth-local-evidence',
        warnings: [],
      },
    });
    expect(manifest.sourceFiles).toEqual([
      {
        path: 'alpha.ts',
        resolvedPath: join(sourceDir, 'alpha.ts'),
        byteSize: Buffer.byteLength(alphaSource),
        hash: `sha256:${sha256(alphaSource)}`,
        factCount: 4,
        exportFactCount: 4,
        signatureFactCount: 2,
        configFactCount: 0,
        contextFactCount: 0,
        parseDiagnosticCount: 0,
      },
      {
        path: 'zeta.ts',
        resolvedPath: join(sourceDir, 'zeta.ts'),
        byteSize: Buffer.byteLength(zetaSource),
        hash: `sha256:${sha256(zetaSource)}`,
        factCount: 2,
        exportFactCount: 2,
        signatureFactCount: 1,
        configFactCount: 0,
        contextFactCount: 0,
        parseDiagnosticCount: 0,
      },
    ]);
    expect(manifest.generatedOutputs.map((output) => output.path)).toEqual([
      'source-truth-report.json',
      'source-truth.md',
    ]);

    for (const output of manifest.generatedOutputs) {
      const bytes = await readFile(join(firstOutputDir, output.path));

      expect(output.byteSize).toBe(bytes.byteLength);
      expect(output.hash).toBe(`sha256:${sha256(bytes)}`);
    }
  });

  it('renders signature evidence in Markdown without adding body text or unresolved export signatures', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-docs-signatures-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    await writeFile(
      join(sourceDir, 'index.ts'),
      [
        'export const typedValue: number = 123;',
        "export function makeValue(input: string = 'fallback'): number {",
        '  return typedValue;',
        '}',
        'export interface Options {',
        '  label: string;',
        '}',
        'export { makeValue as renamedValue };',
        "export * from './other';",
        '',
      ].join('\n'),
      'utf-8'
    );

    const report = await inspectSourceTruth({ source: sourceDir });
    const markdown = formatSourceTruthMarkdown(report);

    expect(markdown).toContain('  - Signature evidence:');
    expect(markdown).toContain('    - Declaration kind: `function`');
    expect(markdown).toContain(
      "    - Text: `export function makeValue(input: string): number`"
    );
    expect(markdown).toContain(
      '    - Parameters: `input: string` (optional: `true`, rest: `false`, default: `true`)'
    );
    expect(markdown).toContain('    - Return type: `number`');
    expect(markdown).toContain('    - Variables: `typedValue: number`');
    expect(markdown).toContain('    - Member count: `1`');
    expect(markdown).not.toContain('return typedValue');
    expect(markdown).not.toContain('123');
    expect(markdown).not.toContain('fallback');

    const renamedBlockStart = markdown.indexOf('- `renamedValue`');
    const renamedBlockEnd = markdown.indexOf('\n\n', renamedBlockStart);
    const renamedBlock = markdown.slice(renamedBlockStart, renamedBlockEnd);
    expect(renamedBlock).toContain('  - Fact kind: `re-exported-symbol`');
    expect(renamedBlock).not.toContain('Signature evidence');

    const exportAllBlockStart = markdown.indexOf('- `*`');
    const exportAllBlockEnd = markdown.indexOf('\n\n', exportAllBlockStart);
    const exportAllBlock = markdown.slice(exportAllBlockStart, exportAllBlockEnd);
    expect(exportAllBlock).toContain('  - Fact kind: `export-all`');
    expect(exportAllBlock).not.toContain('Signature evidence');
    expect(markdown).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(markdown).not.toMatch(/\bofficial\b/i);
    expect(markdown).not.toMatch(/\bcorrect(?:ness)?\b/i);
    expect(markdown).not.toMatch(/\bverified\b/i);
  });

  it('renders signature evidence containing backticks with valid Markdown code spans', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-docs-template-signature-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    await writeFile(
      join(sourceDir, 'index.ts'),
      ['export type Route = `/api/${string}`;', ''].join('\n'),
      'utf-8'
    );

    const report = await inspectSourceTruth({ source: sourceDir });
    const markdown = formatSourceTruthMarkdown(report);

    expect(markdown).toContain('    - Text: `` export type Route = `/api/${string}` ``');
    expect(markdown).toContain('    - Type: `` `/api/${string}` ``');
    expect(markdown).not.toContain('\\`/api/${string}\\`');
    expect(markdown).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(markdown).not.toMatch(/\bofficial\b/i);
    expect(markdown).not.toMatch(/\bcorrect(?:ness)?\b/i);
    expect(markdown).not.toMatch(/\bverified\b/i);
  });

  it('renders non-signature values containing backticks with valid Markdown code spans', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-docs-backtick-values-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    await writeFile(
      join(sourceDir, 'tick`file.ts'),
      [
        'export const value = true;',
        "export { value as renamedValue } from './mod`name';",
        '',
      ].join('\n'),
      'utf-8'
    );
    await writeFile(
      join(sourceDir, 'package.json'),
      [
        '{',
        '  "name": "pkg`name",',
        '  "dependencies": {',
        '    "dep`name": "^1.0.0"',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    const report = await inspectSourceTruth({ source: sourceDir });
    const markdown = formatSourceTruthMarkdown(report);

    expect(markdown).toContain('### `` tick`file.ts ``');
    expect(markdown).toContain('  - Module specifier: `` ./mod`name ``');
    expect(markdown).toContain('  - Value: `` pkg`name ``');
    expect(markdown).toContain('- `` dep`name ``');
    expect(markdown).toContain('  - Field path: `` dependencies["dep`name"] ``');
    expect(markdown).not.toContain('\\`file');
    expect(markdown).not.toContain('\\`name');
    expect(markdown).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(markdown).not.toMatch(/\bofficial\b/i);
    expect(markdown).not.toMatch(/\bcorrect(?:ness)?\b/i);
    expect(markdown).not.toMatch(/\bverified\b/i);
  });

  it('generates Markdown and manifest provenance for config-only source evidence', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-docs-config-');
    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });

    const packageJson = [
      '{',
      '  "name": "config-only",',
      '  "version": "0.0.1",',
      '  "scripts": {',
      '    "build": "tsc"',
      '  },',
      '  "dependencies": {',
      '    "commander": "^12.0.0"',
      '  }',
      '}',
      '',
    ].join('\n');
    const tsconfigJson = [
      '{',
      '  "extends": "./base.json",',
      '  "compilerOptions": {',
      '    "strict": true',
      '  },',
      '  "include": ["src/**/*.ts"]',
      '}',
      '',
    ].join('\n');
    await writeFile(join(sourceDir, 'package.json'), packageJson, 'utf-8');
    await writeFile(join(sourceDir, 'tsconfig.json'), tsconfigJson, 'utf-8');

    const result = await generateSourceTruthDocs({ source: sourceDir, outputDir });
    const markdown = await readFile(join(outputDir, 'source-truth.md'), 'utf-8');
    const manifest = await readJson<SourceTruthDocsManifest>(join(outputDir, 'manifest.json'));

    expect(result.report.facts).toEqual([]);
    expect(result.report.configFacts.length).toBeGreaterThan(0);
    expect(markdown).toContain('# Observed Local Source Evidence');
    expect(markdown).not.toContain('# Source-Truth Export Facts');
    expect(markdown).toContain('## Package And Config Facts');
    expect(markdown).toContain('No TypeScript/JavaScript export facts were observed.');
    expect(markdown).toContain('### `package.json`');
    expect(markdown).toContain('### `tsconfig.json`');
    expect(markdown).toContain('- `commander`');
    expect(markdown).toContain('  - Group: `dependencies`');
    expect(markdown).toContain('- `strict`');
    expect(markdown).toContain('  - Line range granularity: `field`');
    expect(markdown).toContain(
      '- No framework identity, routes, task fit, or source selection is inferred.'
    );
    expect(markdown).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(markdown).not.toMatch(/\bofficial\b/i);
    expect(markdown).not.toMatch(/\bcorrect(?:ness)?\b/i);
    expect(markdown).not.toMatch(/\bverified\b/i);

    expect(
      manifest.sourceFiles.map((file) => ({
        path: file.path,
        factCount: file.factCount,
        exportFactCount: file.exportFactCount,
        signatureFactCount: file.signatureFactCount,
        configFactCount: file.configFactCount,
        contextFactCount: file.contextFactCount,
        hash: file.hash,
      }))
    ).toEqual([
      {
        path: 'package.json',
        factCount: 4,
        exportFactCount: 0,
        signatureFactCount: 0,
        configFactCount: 4,
        contextFactCount: 0,
        hash: `sha256:${sha256(packageJson)}`,
      },
      {
        path: 'tsconfig.json',
        factCount: 4,
        exportFactCount: 0,
        signatureFactCount: 0,
        configFactCount: 4,
        contextFactCount: 0,
        hash: `sha256:${sha256(tsconfigJson)}`,
      },
    ]);
  });

  it('generates Markdown and manifest provenance for context-only source evidence', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-docs-context-');
    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'out');
    await mkdir(join(sourceDir, 'examples'), { recursive: true });

    const exampleSource = ['const localExample = true;', ''].join('\n');
    await writeFile(join(sourceDir, 'examples/usage.ts'), exampleSource, 'utf-8');

    const result = await generateSourceTruthDocs({ source: sourceDir, outputDir });
    const markdown = await readFile(join(outputDir, 'source-truth.md'), 'utf-8');
    const manifest = await readJson<SourceTruthDocsManifest>(join(outputDir, 'manifest.json'));

    expect(result.report.facts).toEqual([]);
    expect(result.report.configFacts).toEqual([]);
    expect(result.report.contextFacts.map((fact) => fact.kind)).toEqual(['example-file']);
    expect(result.report.contextFacts[0]).toMatchObject({
      path: 'examples/usage.ts',
      evidenceSignals: ['path-segment:examples'],
      byteSize: Buffer.byteLength(exampleSource),
      sha256: sha256(exampleSource),
      provenance: {
        path: 'examples/usage.ts',
        lineRange: { start: 1, end: 1 },
      },
      lineRangeGranularity: 'file',
      order: 1,
    });
    expect(markdown).toContain('No TypeScript/JavaScript export facts were observed.');
    expect(markdown).toContain('No package or config facts were observed.');
    expect(markdown).toContain('## Test And Example Context Facts');
    expect(markdown).toContain('### `examples/usage.ts`');
    expect(markdown).toContain('- `example-file`');
    expect(markdown).toContain('  - Path: `examples/usage.ts`');
    expect(markdown).toContain('  - Evidence signals: `path-segment:examples`');
    expect(markdown).toContain(`  - SHA-256: \`${sha256(exampleSource)}\``);
    expect(markdown).toContain('  - Line range granularity: `file`');
    expect(markdown).toContain(
      '- Test/example context facts are path/filename-level evidence only; context line ranges cover the whole file.'
    );
    expect(markdown).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(markdown).not.toMatch(/\bofficial\b/i);
    expect(markdown).not.toMatch(/\bcorrect(?:ness)?\b/i);
    expect(markdown).not.toMatch(/\bverified\b/i);
    expect(markdown).not.toMatch(/\bbehavior summary\b/i);

    expect(manifest.sourceFiles).toEqual([
      {
        path: 'examples/usage.ts',
        resolvedPath: join(sourceDir, 'examples/usage.ts'),
        byteSize: Buffer.byteLength(exampleSource),
        hash: `sha256:${sha256(exampleSource)}`,
        factCount: 1,
        exportFactCount: 0,
        signatureFactCount: 0,
        configFactCount: 0,
        contextFactCount: 1,
        parseDiagnosticCount: 0,
      },
    ]);
    expect(manifest.generatedOutputs.map((output) => output.path)).toEqual([
      'source-truth-report.json',
      'source-truth.md',
    ]);
  });

  it('includes inspector warnings and syntax limitations without adding behavior claims', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-docs-warnings-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, 'broken.ts'),
      ['export const broken = ;', 'export const after = true;', ''].join('\n'),
      'utf-8'
    );

    const report = await inspectSourceTruth({ source: sourceDir });
    const markdown = formatSourceTruthMarkdown(report);

    expect(report.warnings).toEqual(['Syntax diagnostics in file: broken.ts (1)']);
    expect(markdown).toContain('- Inspector warning: Syntax diagnostics in file: broken.ts (1)');
    expect(markdown).toContain('- Re-export targets and export-all targets are not resolved.');
    expect(markdown).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(markdown).not.toMatch(/\bofficial\b/i);
    expect(markdown).not.toMatch(/\bverified\b/i);
  });

  it('fails honestly and writes failure details when no extractable facts are found', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-docs-empty-');
    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'notes.md'), '# Notes\n', 'utf-8');

    let thrown: unknown;

    try {
      await generateSourceTruthDocs({ source: sourceDir, outputDir });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SourceTruthDocsNoFactsError);
    expect(await pathExists(join(outputDir, 'source-truth.md'))).toBe(false);
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(false);
    expect(await pathExists(join(outputDir, 'source-truth-report.json'))).toBe(true);

    const failure = await readJson<SourceTruthDocsFailure>(join(outputDir, 'failure.json'));

    expect(failure).toMatchObject({
      schemaVersion: '0.1.0',
      mode: 'source-truth-local-docs-failure',
      reason: 'no-extractable-source-truth-facts',
      message:
        'No extractable source-truth export, package/config, or context facts were found for the explicit local source path.',
      source: {
        input: sourceDir,
        resolvedPath: sourceDir,
        type: 'directory',
      },
      evidenceReport: {
        path: 'source-truth-report.json',
      },
    });
    expect('files' in failure.evidenceReport).toBe(false);
    const report = await readJson<SourceTruthInspectionReport>(
      join(outputDir, failure.evidenceReport.path)
    );
    expect(report.facts).toEqual([]);
    expect(report.configFacts).toEqual([]);
    expect(report.contextFacts).toEqual([]);
    expect(report.warnings).toEqual(['Skipped unsupported file: notes.md']);
  });

  it('rejects an output directory inside the source before writing artifacts', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-docs-overlap-');
    const sourceDir = join(dir, 'source');
    const outputDir = join(sourceDir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = true;\n', 'utf-8');

    await expect(generateSourceTruthDocs({ source: sourceDir, outputDir })).rejects.toThrow(
      'source-truth generate --output-dir must not be the same as, or inside, the explicit --source path'
    );
    expect(await pathExists(outputDir)).toBe(false);
  });

  it('rejects an existing output symlink that resolves inside the source before writing artifacts', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-docs-output-symlink-');
    const sourceDir = join(dir, 'source');
    const sourceOutputTarget = join(sourceDir, 'generated');
    const outputDir = join(dir, 'output-link');
    await mkdir(sourceOutputTarget, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = true;\n', 'utf-8');
    await symlink(sourceOutputTarget, outputDir, 'dir');

    await expect(generateSourceTruthDocs({ source: sourceDir, outputDir })).rejects.toThrow(
      'source-truth generate --output-dir must not be the same as, or inside, the explicit --source path'
    );
    expect(await pathExists(join(sourceOutputTarget, 'source-truth-report.json'))).toBe(false);
    expect(await pathExists(join(sourceOutputTarget, 'source-truth.md'))).toBe(false);
    expect(await pathExists(join(sourceOutputTarget, 'manifest.json'))).toBe(false);
    expect(await pathExists(join(sourceOutputTarget, 'failure.json'))).toBe(false);
  });

  it('rejects an output path below a symlinked parent that resolves inside the source', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-docs-output-parent-symlink-');
    const sourceDir = join(dir, 'source');
    const sourceOutputParent = join(sourceDir, 'generated-parent');
    const outputParent = join(dir, 'output-parent-link');
    const outputDir = join(outputParent, 'nested');
    await mkdir(sourceOutputParent, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = true;\n', 'utf-8');
    await symlink(sourceOutputParent, outputParent, 'dir');

    await expect(generateSourceTruthDocs({ source: sourceDir, outputDir })).rejects.toThrow(
      'source-truth generate --output-dir must not be the same as, or inside, the explicit --source path'
    );
    expect(await pathExists(join(sourceOutputParent, 'nested'))).toBe(false);
    expect(await pathExists(join(sourceOutputParent, 'source-truth-report.json'))).toBe(false);
    expect(await pathExists(join(sourceOutputParent, 'source-truth.md'))).toBe(false);
    expect(await pathExists(join(sourceOutputParent, 'manifest.json'))).toBe(false);
    expect(await pathExists(join(sourceOutputParent, 'failure.json'))).toBe(false);
  });

  it('clears stale generated artifacts when switching from success to no-facts failure', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-docs-success-failure-');
    const sourceDir = join(dir, 'source');
    const emptySourceDir = join(dir, 'empty-source');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(emptySourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = true;\n', 'utf-8');
    await writeFile(join(emptySourceDir, 'notes.md'), '# Notes\n', 'utf-8');

    await generateSourceTruthDocs({ source: sourceDir, outputDir });
    expect(await pathExists(join(outputDir, 'source-truth.md'))).toBe(true);
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(true);

    await expect(generateSourceTruthDocs({ source: emptySourceDir, outputDir })).rejects.toThrow(
      SourceTruthDocsNoFactsError
    );

    expect(await pathExists(join(outputDir, 'source-truth.md'))).toBe(false);
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(false);
    expect(await pathExists(join(outputDir, 'failure.json'))).toBe(true);
    const report = await readJson<SourceTruthInspectionReport>(
      join(outputDir, 'source-truth-report.json')
    );
    expect(report.source.resolvedPath).toBe(emptySourceDir);
    expect(report.facts).toEqual([]);
  });

  it('clears stale failure artifacts when switching from no-facts failure to success', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-docs-failure-success-');
    const sourceDir = join(dir, 'source');
    const emptySourceDir = join(dir, 'empty-source');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(emptySourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = true;\n', 'utf-8');
    await writeFile(join(emptySourceDir, 'notes.md'), '# Notes\n', 'utf-8');

    await expect(generateSourceTruthDocs({ source: emptySourceDir, outputDir })).rejects.toThrow(
      SourceTruthDocsNoFactsError
    );
    expect(await pathExists(join(outputDir, 'failure.json'))).toBe(true);

    await generateSourceTruthDocs({ source: sourceDir, outputDir });

    expect(await pathExists(join(outputDir, 'failure.json'))).toBe(false);
    expect(await pathExists(join(outputDir, 'source-truth.md'))).toBe(true);
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(true);
    const report = await readJson<SourceTruthInspectionReport>(
      join(outputDir, 'source-truth-report.json')
    );
    expect(report.source.resolvedPath).toBe(sourceDir);
    expect(report.facts.map((fact) => fact.exportedName)).toEqual(['value']);
  });
});
