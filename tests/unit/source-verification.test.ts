import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { describeGeneratedTextOutput } from '../../src/core/generated-output-metadata.js';
import { verifyGenerationManifest } from '../../src/core/manifest.js';
import {
  SourceVerificationNoDocsEvidenceError,
  verifyDocsAgainstSource,
  type SourceVerificationFailure,
  type SourceVerificationManifest,
  type SourceVerificationReport,
} from '../../src/core/source-verification.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  tempDirs.push(dir);

  return dir;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
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

describe('source verification evidence', () => {
  it('writes deterministic local docs/source evidence with exact matches and unmatched references', async () => {
    const dir = await makeTempDir('llm-docs-source-verification-');
    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    const firstOutputDir = join(dir, 'out-a');
    const secondOutputDir = join(dir, 'out-b');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });

    const source = [
      'export function makeWidget(): Widget {',
      '  return {} as Widget;',
      '}',
      'export const KnownValue = 1;',
      '',
    ].join('\n');
    const docs = [
      '# Widget Docs',
      '',
      'Use `makeWidget()` before reading `MissingRef`.',
      '',
      '```ts',
      '`KnownValue` inside a fence is not inline docs evidence.',
      '```',
      '',
    ].join('\n');
    await writeFile(join(sourceDir, 'index.ts'), source, 'utf-8');
    await writeFile(join(docsDir, 'guide.md'), docs, 'utf-8');

    const first = await verifyDocsAgainstSource({
      source: sourceDir,
      docs: docsDir,
      outputDir: firstOutputDir,
      generator: {
        name: 'llm-docs-generator',
        version: '1.0.0',
        cliName: 'supabase-llm-docs',
      },
    });
    const second = await verifyDocsAgainstSource({
      source: sourceDir,
      docs: docsDir,
      outputDir: secondOutputDir,
      generator: {
        name: 'llm-docs-generator',
        version: '1.0.0',
        cliName: 'supabase-llm-docs',
      },
    });

    const firstReportText = await readFile(
      join(firstOutputDir, 'source-verification-report.json'),
      'utf-8'
    );
    const secondReportText = await readFile(
      join(secondOutputDir, 'source-verification-report.json'),
      'utf-8'
    );
    const manifest = JSON.parse(
      await readFile(join(firstOutputDir, 'manifest.json'), 'utf-8')
    ) as SourceVerificationManifest;
    const report = JSON.parse(firstReportText) as SourceVerificationReport;
    const manifestVerification = await verifyGenerationManifest({
      manifestPath: join(firstOutputDir, 'manifest.json'),
    });

    expect(firstReportText).toBe(secondReportText);
    expect(first.report).toEqual(second.report);
    expect(report).toMatchObject({
      schemaVersion: '0.1.0',
      mode: 'source-verification-local-evidence',
      source: {
        input: sourceDir,
        resolvedPath: sourceDir,
        type: 'directory',
      },
      summary: {
        sourceFileCount: 1,
        sourceExportFactCount: 2,
        observedExportedNameCount: 2,
        docsFileCount: 1,
        docsReferenceCount: 2,
        exactMatchCount: 1,
        unmatchedReferenceCount: 1,
        warningCount: 0,
      },
    });
    expect(report.docs.files).toMatchObject([
      {
        path: 'guide.md',
        resolvedPath: join(docsDir, 'guide.md'),
        status: 'inspected',
        byteSize: Buffer.byteLength(docs),
        sha256: sha256(docs),
        supported: true,
        referenceCount: 2,
      },
    ]);
    expect(
      report.docs.references.map(({ kind, rawText, identifier, provenance, order }) => ({
        kind,
        rawText,
        identifier,
        provenance,
        order,
      }))
    ).toEqual([
      {
        kind: 'inline-code-call-identifier',
        rawText: 'makeWidget()',
        identifier: 'makeWidget',
        provenance: { path: 'guide.md', lineRange: { start: 3, end: 3 } },
        order: 1,
      },
      {
        kind: 'inline-code-identifier',
        rawText: 'MissingRef',
        identifier: 'MissingRef',
        provenance: { path: 'guide.md', lineRange: { start: 3, end: 3 } },
        order: 2,
      },
    ]);
    expect(report.comparison.observedExports.map((entry) => entry.exportedName)).toEqual([
      'KnownValue',
      'makeWidget',
    ]);
    expect(report.comparison.matches).toMatchObject([
      {
        classification: 'exact-export-match',
        reference: {
          identifier: 'makeWidget',
        },
        sourceFacts: [
          {
            kind: 'exported-symbol',
            symbolKind: 'function',
            name: 'makeWidget',
            exportedName: 'makeWidget',
            provenance: {
              path: 'index.ts',
              lineRange: { start: 1, end: 3 },
            },
          },
        ],
      },
    ]);
    expect(report.comparison.unmatchedReferences).toMatchObject([
      {
        classification: 'unmatched-reference',
        reference: {
          identifier: 'MissingRef',
        },
      },
    ]);
    expect(manifest).toMatchObject({
      schemaVersion: '0.1.0',
      mode: 'source-verification-local-evidence',
      sourceVerification: {
        reportPath: 'source-verification-report.json',
        reportSchemaVersion: '0.1.0',
        reportMode: 'source-verification-local-evidence',
        summary: report.summary,
      },
      generatedOutputs: [
        {
          path: 'source-verification-report.json',
          kind: 'source-verification-report-json',
        },
      ],
    });
    expect(manifest.generatedOutputs[0]?.hash).toBe(`sha256:${sha256(firstReportText)}`);
    expect(manifestVerification.failures).toEqual([]);
    expect(manifestVerification.checkedFiles).toBe(1);

    const serializedReport = JSON.stringify(report).toLowerCase();
    expect(serializedReport).not.toMatch(/\bofficial\b/);
    expect(serializedReport).not.toMatch(/\bauthorit(?:y|ative)\b/);
    expect(serializedReport).not.toMatch(/\bcorrect(?:ness)?\b/);
    expect(serializedReport).not.toMatch(/\bverified\b/);
    expect(serializedReport).not.toMatch(/\bbehavior\b/);
  });

  it('fails with report and failure artifacts when supported docs contain no reference evidence', async () => {
    const dir = await makeTempDir('llm-docs-source-verification-empty-');
    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(docsDir, 'guide.md'), '# Guide\n\nNo inline code here.\n', 'utf-8');

    await expect(
      verifyDocsAgainstSource({
        source: sourceDir,
        docs: docsDir,
        outputDir,
        generator: {
          name: 'llm-docs-generator',
          version: '1.0.0',
          cliName: 'supabase-llm-docs',
        },
      })
    ).rejects.toBeInstanceOf(SourceVerificationNoDocsEvidenceError);

    const report = JSON.parse(
      await readFile(join(outputDir, 'source-verification-report.json'), 'utf-8')
    ) as SourceVerificationReport;
    const failure = JSON.parse(
      await readFile(join(outputDir, 'failure.json'), 'utf-8')
    ) as SourceVerificationFailure;

    expect(report.summary).toMatchObject({
      docsFileCount: 1,
      docsReferenceCount: 0,
      exactMatchCount: 0,
      unmatchedReferenceCount: 0,
    });
    expect(failure).toMatchObject({
      schemaVersion: '0.1.0',
      mode: 'source-verification-local-evidence-failure',
      reason: 'no-doc-reference-evidence',
      evidenceReport: {
        path: 'source-verification-report.json',
      },
    });
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(false);
  });

  it('clears stale owned success artifacts when input validation fails on a rerun', async () => {
    const dir = await makeTempDir('llm-docs-source-verification-stale-input-');
    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(docsDir, 'guide.md'), 'Use `value`.\n', 'utf-8');

    await verifyDocsAgainstSource({
      source: sourceDir,
      docs: docsDir,
      outputDir,
      generator: {
        name: 'llm-docs-generator',
        version: '1.0.0',
        cliName: 'supabase-llm-docs',
      },
    });
    await writeFile(join(outputDir, 'user-note.txt'), 'keep me\n', 'utf-8');

    await expect(
      verifyDocsAgainstSource({
        source: sourceDir,
        docs: join(dir, 'missing-docs'),
        outputDir,
        generator: {
          name: 'llm-docs-generator',
          version: '1.0.0',
          cliName: 'supabase-llm-docs',
        },
      })
    ).rejects.toThrow('source-truth verify-docs --docs path not found or cannot be read');

    expect(await pathExists(join(outputDir, 'source-verification-report.json'))).toBe(false);
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(false);
    expect(await pathExists(join(outputDir, 'failure.json'))).toBe(false);
    expect(await readFile(join(outputDir, 'user-note.txt'), 'utf-8')).toBe('keep me\n');
  });

  it('clears stale owned failure artifacts when input validation fails on a rerun', async () => {
    const dir = await makeTempDir('llm-docs-source-verification-stale-failure-input-');
    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(docsDir, 'guide.md'), '# Guide\n\nNo inline code here.\n', 'utf-8');

    await expect(
      verifyDocsAgainstSource({
        source: sourceDir,
        docs: docsDir,
        outputDir,
        generator: {
          name: 'llm-docs-generator',
          version: '1.0.0',
          cliName: 'supabase-llm-docs',
        },
      })
    ).rejects.toBeInstanceOf(SourceVerificationNoDocsEvidenceError);

    expect(await pathExists(join(outputDir, 'source-verification-report.json'))).toBe(true);
    expect(await pathExists(join(outputDir, 'failure.json'))).toBe(true);

    await expect(
      verifyDocsAgainstSource({
        source: sourceDir,
        docs: join(dir, 'missing-docs'),
        outputDir,
        generator: {
          name: 'llm-docs-generator',
          version: '1.0.0',
          cliName: 'supabase-llm-docs',
        },
      })
    ).rejects.toThrow('source-truth verify-docs --docs path not found or cannot be read');

    expect(await pathExists(join(outputDir, 'source-verification-report.json'))).toBe(false);
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(false);
    expect(await pathExists(join(outputDir, 'failure.json'))).toBe(false);
  });

  it('preserves non-source-verification files with known artifact names after input validation fails', async () => {
    const dir = await makeTempDir('llm-docs-source-verification-non-owned-input-');
    const sourceDir = join(dir, 'source');
    const outputDir = join(dir, 'out');
    const reportPath = join(outputDir, 'source-verification-report.json');
    const manifestPath = join(outputDir, 'manifest.json');
    const failurePath = join(outputDir, 'failure.json');
    const reportText = `${JSON.stringify({ note: 'user report' }, null, 2)}\n`;
    const manifestText = `${JSON.stringify(
      {
        schemaVersion: '0.1.0',
        mode: 'configured-sdk',
        source: {
          resolvedSpecPath: 'source.yml',
        },
      },
      null,
      2
    )}\n`;
    const failureText = `${JSON.stringify({ note: 'user failure' }, null, 2)}\n`;
    await mkdir(sourceDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(reportPath, reportText, 'utf-8');
    await writeFile(manifestPath, manifestText, 'utf-8');
    await writeFile(failurePath, failureText, 'utf-8');

    await expect(
      verifyDocsAgainstSource({
        source: sourceDir,
        docs: join(dir, 'missing-docs'),
        outputDir,
        generator: {
          name: 'llm-docs-generator',
          version: '1.0.0',
          cliName: 'supabase-llm-docs',
        },
      })
    ).rejects.toThrow('source-truth verify-docs --docs path not found or cannot be read');

    expect(await readFile(reportPath, 'utf-8')).toBe(reportText);
    expect(await readFile(manifestPath, 'utf-8')).toBe(manifestText);
    expect(await readFile(failurePath, 'utf-8')).toBe(failureText);
  });

  it('does not clear artifacts when rejecting an output directory inside source or docs', async () => {
    const dir = await makeTempDir('llm-docs-source-verification-output-safety-');
    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    const outputDir = join(sourceDir, 'out');
    await mkdir(outputDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(docsDir, 'guide.md'), 'Use `value`.\n', 'utf-8');
    await writeFile(join(outputDir, 'source-verification-report.json'), 'stale report\n', 'utf-8');
    await writeFile(join(outputDir, 'manifest.json'), 'stale manifest\n', 'utf-8');

    await expect(
      verifyDocsAgainstSource({
        source: sourceDir,
        docs: docsDir,
        outputDir,
        generator: {
          name: 'llm-docs-generator',
          version: '1.0.0',
          cliName: 'supabase-llm-docs',
        },
      })
    ).rejects.toThrow(
      'source-truth verify-docs --output-dir must not be the same as, or inside, the explicit --source or --docs path'
    );

    expect(await readFile(join(outputDir, 'source-verification-report.json'), 'utf-8')).toBe(
      'stale report\n'
    );
    expect(await readFile(join(outputDir, 'manifest.json'), 'utf-8')).toBe('stale manifest\n');
  });

  it('fails with report and failure artifacts when no supported docs files are available', async () => {
    const dir = await makeTempDir('llm-docs-source-verification-unsupported-');
    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(docsDir, 'guide.txt'), 'Use `value`.\n', 'utf-8');

    await expect(
      verifyDocsAgainstSource({
        source: sourceDir,
        docs: docsDir,
        outputDir,
        generator: {
          name: 'llm-docs-generator',
          version: '1.0.0',
          cliName: 'supabase-llm-docs',
        },
      })
    ).rejects.toBeInstanceOf(SourceVerificationNoDocsEvidenceError);

    const report = JSON.parse(
      await readFile(join(outputDir, 'source-verification-report.json'), 'utf-8')
    ) as SourceVerificationReport;
    const failure = JSON.parse(
      await readFile(join(outputDir, 'failure.json'), 'utf-8')
    ) as SourceVerificationFailure;

    expect(report.summary).toMatchObject({
      docsFileCount: 0,
      docsReferenceCount: 0,
      exactMatchCount: 0,
      unmatchedReferenceCount: 0,
      warningCount: 1,
    });
    expect(report.docs.traversal).toMatchObject({
      visitedFiles: 1,
      inspectedFiles: 0,
      skippedFiles: 1,
    });
    expect(report.docs.files).toMatchObject([
      {
        path: 'guide.txt',
        status: 'skipped',
        supported: false,
        referenceCount: 0,
        skipReason: 'unsupported-extension',
      },
    ]);
    expect(report.docs.references).toEqual([]);
    expect(failure).toMatchObject({
      schemaVersion: '0.1.0',
      mode: 'source-verification-local-evidence-failure',
      reason: 'no-supported-docs-files',
      evidenceReport: {
        path: 'source-verification-report.json',
      },
    });
    expect(await pathExists(join(outputDir, 'manifest.json'))).toBe(false);
  });

  it('keeps bounded partial docs evidence when maxEntries truncates a docs directory', async () => {
    const dir = await makeTempDir('llm-docs-source-verification-docs-budget-');
    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(docsDir, 'a.md'), 'Use `value` from the first page.\n', 'utf-8');
    await writeFile(join(docsDir, 'b.md'), 'Use `value` from the second page.\n', 'utf-8');

    const result = await verifyDocsAgainstSource({
      source: sourceDir,
      docs: docsDir,
      outputDir,
      docsMaxEntries: 1,
      generator: {
        name: 'llm-docs-generator',
        version: '1.0.0',
        cliName: 'supabase-llm-docs',
      },
    });

    expect(result.report.docs.traversal).toMatchObject({
      maxEntries: 1,
      visitedEntries: 1,
      inspectedFiles: 1,
      truncated: true,
    });
    expect(result.report.docs.files).toHaveLength(1);
    expect(result.report.summary).toMatchObject({
      docsFileCount: 1,
      docsReferenceCount: 1,
      exactMatchCount: 1,
      unmatchedReferenceCount: 0,
      warningCount: 1,
    });
    expect(result.report.docs.warnings).toContain('Docs traversal maxEntries reached: 1');
  });

  it('matches conservative Unicode exported identifiers from docs inline code', async () => {
    const dir = await makeTempDir('llm-docs-source-verification-unicode-');
    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      join(sourceDir, 'index.ts'),
      ['export const café = 1;', 'export function Δelta() {', '  return café;', '}', ''].join('\n'),
      'utf-8'
    );
    await writeFile(
      join(docsDir, 'guide.md'),
      [
        '# Unicode identifiers',
        '',
        'Use `café` before `Δelta()`.',
        'Do not extract `café.value`, `Δelta(1)`, or `spaced identifier`.',
        '',
      ].join('\n'),
      'utf-8'
    );

    const result = await verifyDocsAgainstSource({
      source: sourceDir,
      docs: docsDir,
      outputDir,
      generator: {
        name: 'llm-docs-generator',
        version: '1.0.0',
        cliName: 'supabase-llm-docs',
      },
    });

    expect(
      result.report.docs.references.map(({ kind, rawText, identifier }) => ({
        kind,
        rawText,
        identifier,
      }))
    ).toEqual([
      {
        kind: 'inline-code-identifier',
        rawText: 'café',
        identifier: 'café',
      },
      {
        kind: 'inline-code-call-identifier',
        rawText: 'Δelta()',
        identifier: 'Δelta',
      },
    ]);
    expect(result.report.summary).toMatchObject({
      docsReferenceCount: 2,
      exactMatchCount: 2,
      unmatchedReferenceCount: 0,
    });
  });

  it('rejects source-verification reports with stale internal summary counts after metadata refresh', async () => {
    const dir = await makeTempDir('llm-docs-source-verification-report-stale-summary-');
    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(docsDir, 'guide.md'), 'Use `value`.\n', 'utf-8');

    await verifyDocsAgainstSource({
      source: sourceDir,
      docs: docsDir,
      outputDir,
      generator: {
        name: 'llm-docs-generator',
        version: '1.0.0',
        cliName: 'supabase-llm-docs',
      },
    });

    const manifestPath = join(outputDir, 'manifest.json');
    const reportPath = join(outputDir, 'source-verification-report.json');
    const report = JSON.parse(await readFile(reportPath, 'utf-8')) as SourceVerificationReport;
    report.summary.docsReferenceCount = 99;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf-8')
    ) as SourceVerificationManifest;
    const refreshedReportMetadata = await describeGeneratedTextOutput(reportPath);
    manifest.sourceVerification.summary = report.summary;
    manifest.generatedOutputs[0] = {
      ...manifest.generatedOutputs[0]!,
      ...refreshedReportMetadata,
    };
    delete manifest.artifactSummary;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const verification = await verifyGenerationManifest({ manifestPath });

    expect(verification.checkedFiles).toBe(1);
    expect(verification.failures).toContain(
      'source-verification report: summary.docsReferenceCount inconsistent with report body (expected 1, actual 99)'
    );
    expect(verification.failures.join('\n')).not.toContain('summary.docsReferenceCount mismatch');
    expect(verification.failures.join('\n')).not.toContain('hash mismatch');
  });

  it('rejects source-verification manifests with stale report summary metadata', async () => {
    const dir = await makeTempDir('llm-docs-source-verification-manifest-stale-');
    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(docsDir, 'guide.md'), 'Use `value`.\n', 'utf-8');

    await verifyDocsAgainstSource({
      source: sourceDir,
      docs: docsDir,
      outputDir,
      generator: {
        name: 'llm-docs-generator',
        version: '1.0.0',
        cliName: 'supabase-llm-docs',
      },
    });

    const manifestPath = join(outputDir, 'manifest.json');
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf-8')
    ) as SourceVerificationManifest;
    manifest.sourceVerification.summary.docsReferenceCount = 99;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const verification = await verifyGenerationManifest({ manifestPath });

    expect(verification.checkedFiles).toBe(1);
    expect(verification.failures).toContain(
      'source-verification report: summary.docsReferenceCount mismatch (expected 99, actual 1)'
    );
    expect(verification.failures.join('\n')).not.toContain('hash mismatch');
  });

  it('rejects source-verification manifests with stale source or docs provenance metadata', async () => {
    const dir = await makeTempDir('llm-docs-source-verification-manifest-provenance-');
    const sourceDir = join(dir, 'source');
    const docsDir = join(dir, 'docs');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });
    await writeFile(join(sourceDir, 'index.ts'), 'export const value = 1;\n', 'utf-8');
    await writeFile(join(docsDir, 'guide.md'), 'Use `value`.\n', 'utf-8');

    await verifyDocsAgainstSource({
      source: sourceDir,
      docs: docsDir,
      outputDir,
      generator: {
        name: 'llm-docs-generator',
        version: '1.0.0',
        cliName: 'supabase-llm-docs',
      },
    });

    const manifestPath = join(outputDir, 'manifest.json');
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf-8')
    ) as SourceVerificationManifest;
    manifest.sourceVerification.source.resolvedPath = join(dir, 'other-source');
    manifest.sourceVerification.docs.resolvedPath = join(dir, 'other-docs');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    const verification = await verifyGenerationManifest({ manifestPath });

    expect(verification.checkedFiles).toBe(1);
    expect(verification.failures).toContain(
      `source-verification report: source.resolvedPath mismatch (expected ${join(
        dir,
        'other-source'
      )}, actual ${sourceDir})`
    );
    expect(verification.failures).toContain(
      `source-verification report: docs.resolvedPath mismatch (expected ${join(
        dir,
        'other-docs'
      )}, actual ${docsDir})`
    );
    expect(verification.failures.join('\n')).not.toContain('hash mismatch');
  });
});
