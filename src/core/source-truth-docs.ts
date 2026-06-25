import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  inspectSourceTruth,
  type InspectSourceTruthOptions,
  type SourceTruthFileEvidence,
  type SourceTruthInspectionReport,
  type SourceTruthSourceType,
  type SourceTruthTraversalSettings,
} from './source-truth.js';

export const SOURCE_TRUTH_DOCS_SCHEMA_VERSION = '0.1.0';
export const SOURCE_TRUTH_DOCS_MODE = 'source-truth-local-docs';
export const SOURCE_TRUTH_DOCS_FAILURE_MODE = 'source-truth-local-docs-failure';

export interface GenerateSourceTruthDocsOptions extends InspectSourceTruthOptions {
  outputDir: string;
}

export interface SourceTruthGeneratedOutput {
  path: string;
  kind: SourceTruthGeneratedOutputKind;
  byteSize: number;
  hash: string;
}

export type SourceTruthGeneratedOutputKind = 'source-truth-report-json' | 'source-truth-markdown';

export interface SourceTruthManifestSourceFile {
  path: string;
  resolvedPath: string;
  byteSize: number;
  hash: string;
  factCount: number;
  exportFactCount: number;
  configFactCount: number;
  parseDiagnosticCount: number;
}

export interface SourceTruthDocsManifest {
  schemaVersion: typeof SOURCE_TRUTH_DOCS_SCHEMA_VERSION;
  mode: typeof SOURCE_TRUTH_DOCS_MODE;
  source: {
    input: string;
    resolvedPath: string;
    type: SourceTruthSourceType;
  };
  inspection: {
    schemaVersion: SourceTruthInspectionReport['schemaVersion'];
    mode: SourceTruthInspectionReport['mode'];
    traversal: SourceTruthTraversalSettings;
    warnings: string[];
  };
  sourceFiles: SourceTruthManifestSourceFile[];
  generatedOutputs: SourceTruthGeneratedOutput[];
}

export interface SourceTruthDocsGenerationResult {
  outputDir: string;
  reportPath: string;
  markdownPath: string;
  manifestPath: string;
  report: SourceTruthInspectionReport;
  manifest: SourceTruthDocsManifest;
}

export interface SourceTruthDocsFailure {
  schemaVersion: typeof SOURCE_TRUTH_DOCS_SCHEMA_VERSION;
  mode: typeof SOURCE_TRUTH_DOCS_FAILURE_MODE;
  reason: 'no-extractable-source-truth-facts';
  message: string;
  source: {
    input: string;
    resolvedPath: string;
    type: SourceTruthSourceType;
  };
  inspection: {
    schemaVersion: SourceTruthInspectionReport['schemaVersion'];
    mode: SourceTruthInspectionReport['mode'];
    traversal: SourceTruthTraversalSettings;
    warnings: string[];
  };
  evidenceReport: {
    path: string;
  };
}

export class SourceTruthDocsNoFactsError extends Error {
  readonly failurePath: string;
  readonly reportPath: string;
  readonly failure: SourceTruthDocsFailure;

  constructor(options: {
    failurePath: string;
    reportPath: string;
    failure: SourceTruthDocsFailure;
  }) {
    super(options.failure.message);
    this.name = 'SourceTruthDocsNoFactsError';
    this.failurePath = options.failurePath;
    this.reportPath = options.reportPath;
    this.failure = options.failure;
  }
}

export async function generateSourceTruthDocs(
  options: GenerateSourceTruthDocsOptions
): Promise<SourceTruthDocsGenerationResult> {
  const outputDir = resolve(options.outputDir);
  const reportPath = join(outputDir, 'source-truth-report.json');
  const markdownPath = join(outputDir, 'source-truth.md');
  const manifestPath = join(outputDir, 'manifest.json');
  const failurePath = join(outputDir, 'failure.json');

  await assertOutputDirOutsideSource({
    source: options.source,
    outputDir,
  });
  await mkdir(outputDir, { recursive: true });
  await clearGeneratedArtifacts(outputDir);

  const report = await inspectSourceTruth(options);

  await writeJsonFile(reportPath, report);

  if (report.facts.length === 0 && report.configFacts.length === 0) {
    await rm(markdownPath, { force: true });
    await rm(manifestPath, { force: true });
    const failure = buildFailure(report, relativeOutputPath(outputDir, reportPath));
    await writeJsonFile(failurePath, failure);

    throw new SourceTruthDocsNoFactsError({
      failurePath,
      reportPath,
      failure,
    });
  }

  await rm(failurePath, { force: true });
  const markdown = formatSourceTruthMarkdown(report);
  await writeFile(markdownPath, markdown, 'utf-8');

  const generatedOutputs = await describeGeneratedOutputs(outputDir, [
    { path: reportPath, kind: 'source-truth-report-json' },
    { path: markdownPath, kind: 'source-truth-markdown' },
  ]);
  const manifest = buildManifest(report, generatedOutputs);
  await writeJsonFile(manifestPath, manifest);

  return {
    outputDir,
    reportPath,
    markdownPath,
    manifestPath,
    report,
    manifest,
  };
}

export function formatSourceTruthMarkdown(report: SourceTruthInspectionReport): string {
  const lines: string[] = [
    '# Observed Local Source Evidence',
    '',
    'Generated from one explicit local source inspection. This file contains only observed TypeScript/JavaScript top-level export facts and package/config facts reported by the inspector.',
    '',
    '## Source',
    '',
    `- Input: \`${escapeMarkdownCode(report.source.input)}\``,
    `- Resolved path: \`${escapeMarkdownCode(report.source.resolvedPath)}\``,
    `- Type: \`${report.source.type}\``,
    '',
    '## Inspection Limits',
    '',
    `- Follow symlinks: \`${String(report.traversal.followSymlinks)}\``,
    `- Max depth: \`${report.traversal.maxDepth}\``,
    `- Max entries: \`${report.traversal.maxEntries}\``,
    `- Max files: \`${report.traversal.maxFiles}\``,
    `- Max file bytes: \`${report.traversal.maxFileBytes}\``,
    `- Visited files: \`${report.traversal.visitedFiles}\``,
    `- Inspected files: \`${report.traversal.inspectedFiles}\``,
    `- Skipped files: \`${report.traversal.skippedFiles}\``,
    `- Truncated: \`${String(report.traversal.truncated)}\``,
    '',
    '## Warnings And Limitations',
    '',
    '- No runtime behavior is inferred.',
    '- No framework identity, routes, task fit, or source selection is inferred.',
    '- Re-export targets and export-all targets are not resolved.',
    '- Package/config facts are reported only from explicit `package.json` and `tsconfig*.json` files within the inspection limits.',
    '- Config line ranges are field-level when the inspector can locate a JSON property or array item; otherwise they use the file line range and say so.',
    '- Only supported TypeScript/JavaScript, package manifest, and tsconfig files within the inspection limits can contribute facts.',
  ];

  if (report.warnings.length > 0) {
    for (const warning of report.warnings) {
      lines.push(`- Inspector warning: ${escapeMarkdownText(warning)}`);
    }
  } else {
    lines.push('- Inspector warnings: none.');
  }

  lines.push('', '## Export Facts', '');

  const exportFiles = filesWithExportFacts(report.files);

  if (exportFiles.length === 0) {
    lines.push('No TypeScript/JavaScript export facts were observed.', '');
  }

  for (const file of exportFiles) {
    lines.push(`### \`${escapeMarkdownCode(file.path)}\``, '');

    for (const fact of file.facts) {
      lines.push(`- \`${escapeMarkdownCode(fact.exportedName)}\``);
      lines.push(`  - Fact kind: \`${fact.kind}\``);
      lines.push(`  - Symbol kind: \`${fact.symbolKind}\``);

      if (fact.name !== fact.exportedName) {
        lines.push(`  - Original name: \`${escapeMarkdownCode(fact.name)}\``);
      }

      if (fact.moduleSpecifier !== undefined) {
        lines.push(`  - Module specifier: \`${escapeMarkdownCode(fact.moduleSpecifier)}\``);
      }

      lines.push(
        `  - Lines: \`${fact.provenance.lineRange.start}-${fact.provenance.lineRange.end}\``
      );
    }

    lines.push('');
  }

  lines.push('## Package And Config Facts', '');

  const configFiles = filesWithConfigFacts(report.files);

  if (configFiles.length === 0) {
    lines.push('No package or config facts were observed.', '');
  }

  for (const file of configFiles) {
    lines.push(`### \`${escapeMarkdownCode(file.path)}\``, '');

    for (const fact of file.configFacts) {
      lines.push(`- \`${escapeMarkdownCode(fact.name)}\``);
      lines.push(`  - Fact kind: \`${fact.kind}\``);
      lines.push(`  - Config file kind: \`${fact.configFileKind}\``);
      lines.push(`  - Field path: \`${escapeMarkdownCode(fact.fieldPath)}\``);

      if (fact.group !== undefined) {
        lines.push(`  - Group: \`${escapeMarkdownCode(fact.group)}\``);
      }

      if (fact.value !== undefined) {
        lines.push(`  - Value: \`${escapeMarkdownCode(String(fact.value))}\``);
      }

      lines.push(
        `  - Lines: \`${fact.provenance.lineRange.start}-${fact.provenance.lineRange.end}\``
      );
      lines.push(`  - Line range granularity: \`${fact.lineRangeGranularity}\``);
    }

    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function buildManifest(
  report: SourceTruthInspectionReport,
  generatedOutputs: SourceTruthGeneratedOutput[]
): SourceTruthDocsManifest {
  return {
    schemaVersion: SOURCE_TRUTH_DOCS_SCHEMA_VERSION,
    mode: SOURCE_TRUTH_DOCS_MODE,
    source: {
      input: report.source.input,
      resolvedPath: report.source.resolvedPath,
      type: report.source.type,
    },
    inspection: {
      schemaVersion: report.schemaVersion,
      mode: report.mode,
      traversal: report.traversal,
      warnings: report.warnings,
    },
    sourceFiles: filesWithAnyFacts(report.files).map((file) => ({
      path: file.path,
      resolvedPath: file.resolvedPath,
      byteSize: file.byteSize,
      hash: formatHash(file.sha256 ?? ''),
      factCount: file.facts.length + file.configFacts.length,
      exportFactCount: file.facts.length,
      configFactCount: file.configFacts.length,
      parseDiagnosticCount: file.parseDiagnostics?.length ?? 0,
    })),
    generatedOutputs,
  };
}

function buildFailure(
  report: SourceTruthInspectionReport,
  evidenceReportPath: string
): SourceTruthDocsFailure {
  return {
    schemaVersion: SOURCE_TRUTH_DOCS_SCHEMA_VERSION,
    mode: SOURCE_TRUTH_DOCS_FAILURE_MODE,
    reason: 'no-extractable-source-truth-facts',
    message:
      'No extractable source-truth export or package/config facts were found for the explicit local source path.',
    source: {
      input: report.source.input,
      resolvedPath: report.source.resolvedPath,
      type: report.source.type,
    },
    inspection: {
      schemaVersion: report.schemaVersion,
      mode: report.mode,
      traversal: report.traversal,
      warnings: report.warnings,
    },
    evidenceReport: {
      path: evidenceReportPath,
    },
  };
}

function filesWithExportFacts(files: SourceTruthFileEvidence[]): SourceTruthFileEvidence[] {
  return files.filter((file) => file.facts.length > 0);
}

function filesWithConfigFacts(files: SourceTruthFileEvidence[]): SourceTruthFileEvidence[] {
  return files.filter((file) => file.configFacts.length > 0);
}

function filesWithAnyFacts(files: SourceTruthFileEvidence[]): SourceTruthFileEvidence[] {
  return files.filter((file) => file.facts.length > 0 || file.configFacts.length > 0);
}

async function clearGeneratedArtifacts(outputDir: string): Promise<void> {
  await Promise.all(
    ['source-truth-report.json', 'source-truth.md', 'manifest.json', 'failure.json'].map((path) =>
      rm(join(outputDir, path), { force: true })
    )
  );
}

async function assertOutputDirOutsideSource(options: {
  source: string;
  outputDir: string;
}): Promise<void> {
  if (options.source.trim() === '') {
    return;
  }

  const sourcePath = resolve(options.source);
  const canonicalSourcePath = await realpathIfExists(sourcePath);
  const effectiveOutputPath = await resolveEffectiveOutputPath(options.outputDir);

  if (
    (canonicalSourcePath !== undefined &&
      isSameOrDescendant(canonicalSourcePath, effectiveOutputPath)) ||
    isSameOrDescendant(sourcePath, options.outputDir)
  ) {
    throw new Error(
      'source-truth generate --output-dir must not be the same as, or inside, the explicit --source path'
    );
  }
}

async function realpathIfExists(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function resolveEffectiveOutputPath(outputDir: string): Promise<string> {
  const resolvedOutputDir = resolve(outputDir);
  const missingSegments: string[] = [];
  let currentPath = resolvedOutputDir;

  while (true) {
    try {
      const canonicalExistingPath = await realpath(currentPath);

      return missingSegments.length === 0
        ? canonicalExistingPath
        : join(canonicalExistingPath, ...missingSegments.reverse());
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    const parentPath = dirname(currentPath);

    if (parentPath === currentPath) {
      return resolvedOutputDir;
    }

    missingSegments.push(basename(currentPath));
    currentPath = parentPath;
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isSameOrDescendant(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(parentPath, candidatePath);

  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function relativeOutputPath(outputDir: string, outputPath: string): string {
  const relativePath = relative(outputDir, outputPath);

  if (
    relativePath === '' ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === '..' ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Generated output is outside output directory: ${outputPath}`);
  }

  return relativePath.split(sep).join('/');
}

async function describeGeneratedOutputs(
  outputDir: string,
  outputs: Array<Pick<SourceTruthGeneratedOutput, 'path' | 'kind'>>
): Promise<SourceTruthGeneratedOutput[]> {
  const describedOutputs = await Promise.all(
    outputs.map(async (output) => {
      const file = await describeFile(output.path);

      return {
        path: relativeOutputPath(outputDir, output.path),
        kind: output.kind,
        byteSize: file.byteSize,
        hash: file.hash,
      };
    })
  );

  return describedOutputs.sort((a, b) => compareStringsByCodeUnit(a.path, b.path));
}

async function describeFile(path: string): Promise<{ byteSize: number; hash: string }> {
  const [stats, bytes] = await Promise.all([stat(path), readFile(path)]);

  return {
    byteSize: stats.size,
    hash: formatHash(createHash('sha256').update(bytes).digest('hex')),
  };
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function formatHash(hash: string): string {
  return `sha256:${hash}`;
}

function escapeMarkdownCode(value: string): string {
  return value.replace(/`/g, '\\`');
}

function escapeMarkdownText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function compareStringsByCodeUnit(a: string, b: string): number {
  const length = Math.min(a.length, b.length);

  for (let index = 0; index < length; index++) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);

    if (difference !== 0) {
      return difference;
    }
  }

  return a.length - b.length;
}
