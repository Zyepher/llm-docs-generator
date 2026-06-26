import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { describeGeneratedTextOutput } from './generated-output-metadata.js';
import {
  inspectSourceTruth,
  type InspectSourceTruthOptions,
  type SourceTruthFileEvidence,
  type SourceTruthInspectionReport,
  type SourceTruthSignatureEvidence,
  type SourceTruthSignatureParameter,
  type SourceTruthSignatureVariable,
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
  lineCount: number;
  estimatedTokenCount: number;
}

export type SourceTruthGeneratedOutputKind = 'source-truth-report-json' | 'source-truth-markdown';

export interface SourceTruthManifestSourceFile {
  path: string;
  resolvedPath: string;
  byteSize: number;
  hash: string;
  factCount: number;
  exportFactCount: number;
  signatureFactCount?: number;
  configFactCount: number;
  contextFactCount: number;
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

  if (
    report.facts.length === 0 &&
    report.configFacts.length === 0 &&
    report.contextFacts.length === 0
  ) {
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
    'Generated from one explicit local source inspection. This file contains only observed TypeScript/JavaScript top-level export facts, package/config facts, path-based test/example file context facts, and AST-observed test-case label facts reported by the inspector.',
    '',
    '## Source',
    '',
    `- Input: ${formatMarkdownCodeSpan(report.source.input)}`,
    `- Resolved path: ${formatMarkdownCodeSpan(report.source.resolvedPath)}`,
    `- Type: ${formatMarkdownCodeSpan(report.source.type)}`,
    '',
    '## Inspection Limits',
    '',
    `- Follow symlinks: ${formatMarkdownCodeSpan(String(report.traversal.followSymlinks))}`,
    `- Max depth: ${formatMarkdownCodeSpan(String(report.traversal.maxDepth))}`,
    `- Max entries: ${formatMarkdownCodeSpan(String(report.traversal.maxEntries))}`,
    `- Max files: ${formatMarkdownCodeSpan(String(report.traversal.maxFiles))}`,
    `- Max file bytes: ${formatMarkdownCodeSpan(String(report.traversal.maxFileBytes))}`,
    `- Visited files: ${formatMarkdownCodeSpan(String(report.traversal.visitedFiles))}`,
    `- Inspected files: ${formatMarkdownCodeSpan(String(report.traversal.inspectedFiles))}`,
    `- Skipped files: ${formatMarkdownCodeSpan(String(report.traversal.skippedFiles))}`,
    `- Truncated: ${formatMarkdownCodeSpan(String(report.traversal.truncated))}`,
    '',
    '## Warnings And Limitations',
    '',
    '- No runtime behavior is inferred.',
    '- No framework identity, routes, task fit, or source selection is inferred.',
    '- Re-export targets and export-all targets are not resolved.',
    '- Package/config facts are reported only from explicit `package.json` and `tsconfig*.json` files within the inspection limits.',
    '- Config line ranges are field-level when the inspector can locate a JSON property or array item; otherwise they use the file line range and say so.',
    '- Test/example context facts are path/filename-level evidence only; context line ranges cover the whole file.',
    '- Test-case facts are observed `describe`, `it`, and `test` labels only; they omit test bodies, assertion text, expected values, closures, and runtime-derived names, and they are not proof of behavior or correctness.',
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
    lines.push(`### ${formatMarkdownCodeSpan(file.path)}`, '');

    for (const fact of file.facts) {
      lines.push(`- ${formatMarkdownCodeSpan(fact.exportedName)}`);
      lines.push(`  - Fact kind: ${formatMarkdownCodeSpan(fact.kind)}`);
      lines.push(`  - Symbol kind: ${formatMarkdownCodeSpan(fact.symbolKind)}`);

      if (fact.name !== fact.exportedName) {
        lines.push(`  - Original name: ${formatMarkdownCodeSpan(fact.name)}`);
      }

      if (fact.moduleSpecifier !== undefined) {
        lines.push(`  - Module specifier: ${formatMarkdownCodeSpan(fact.moduleSpecifier)}`);
      }

      if (fact.signature !== undefined) {
        appendSignatureEvidence(lines, fact.signature);
      }

      lines.push(
        `  - Lines: ${formatLineRange(
          fact.provenance.lineRange.start,
          fact.provenance.lineRange.end
        )}`
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
    lines.push(`### ${formatMarkdownCodeSpan(file.path)}`, '');

    for (const fact of file.configFacts) {
      lines.push(`- ${formatMarkdownCodeSpan(fact.name)}`);
      lines.push(`  - Fact kind: ${formatMarkdownCodeSpan(fact.kind)}`);
      lines.push(`  - Config file kind: ${formatMarkdownCodeSpan(fact.configFileKind)}`);
      lines.push(`  - Field path: ${formatMarkdownCodeSpan(fact.fieldPath)}`);

      if (fact.group !== undefined) {
        lines.push(`  - Group: ${formatMarkdownCodeSpan(fact.group)}`);
      }

      if (fact.value !== undefined) {
        lines.push(`  - Value: ${formatMarkdownCodeSpan(String(fact.value))}`);
      }

      lines.push(
        `  - Lines: ${formatLineRange(
          fact.provenance.lineRange.start,
          fact.provenance.lineRange.end
        )}`
      );
      lines.push(
        `  - Line range granularity: ${formatMarkdownCodeSpan(fact.lineRangeGranularity)}`
      );
    }

    lines.push('');
  }

  lines.push('## Test And Example Context Facts', '');

  const contextFiles = filesWithContextFacts(report.files);

  if (contextFiles.length === 0) {
    lines.push('No test/example context facts were observed.', '');
  }

  for (const file of contextFiles) {
    lines.push(`### ${formatMarkdownCodeSpan(file.path)}`, '');

    for (const fact of file.contextFacts) {
      lines.push(`- ${formatMarkdownCodeSpan(fact.kind)}`);
      lines.push(`  - Path: ${formatMarkdownCodeSpan(fact.path)}`);

      if (fact.kind === 'test-case') {
        lines.push(`  - Name: ${formatMarkdownCodeSpan(fact.name)}`);
        lines.push(`  - Call: ${formatMarkdownCodeSpan(fact.call)}`);
        lines.push(`  - Modifiers: ${formatTestCaseModifiers(fact.modifiers)}`);
      } else {
        lines.push(`  - Evidence signals: ${formatEvidenceSignals(fact.evidenceSignals)}`);
        lines.push(`  - Byte size: ${formatMarkdownCodeSpan(String(fact.byteSize))}`);
        lines.push(`  - SHA-256: ${formatMarkdownCodeSpan(fact.sha256)}`);
      }

      lines.push(
        `  - Lines: ${formatLineRange(
          fact.provenance.lineRange.start,
          fact.provenance.lineRange.end
        )}`
      );
      lines.push(
        `  - Line range granularity: ${formatMarkdownCodeSpan(fact.lineRangeGranularity)}`
      );
    }

    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function appendSignatureEvidence(lines: string[], signature: SourceTruthSignatureEvidence): void {
  lines.push('  - Signature evidence:');
  lines.push(`    - Declaration kind: ${formatMarkdownCodeSpan(signature.declarationKind)}`);
  lines.push(`    - Text: ${formatMarkdownCodeSpan(signature.text)}`);

  if (signature.name !== undefined) {
    lines.push(`    - Name: ${formatMarkdownCodeSpan(signature.name)}`);
  }

  if (signature.parameters !== undefined) {
    lines.push(`    - Parameters: ${formatSignatureParameters(signature.parameters)}`);
  }

  if (signature.returnType !== undefined) {
    lines.push(`    - Return type: ${formatMarkdownCodeSpan(signature.returnType)}`);
  }

  if (signature.variableKind !== undefined) {
    lines.push(`    - Variable kind: ${formatMarkdownCodeSpan(signature.variableKind)}`);
  }

  if (signature.variables !== undefined) {
    lines.push(`    - Variables: ${formatSignatureVariables(signature.variables)}`);
  }

  if (signature.heritage !== undefined) {
    if (signature.heritage.extends !== undefined) {
      lines.push(
        `    - Extends: ${signature.heritage.extends
          .map((value) => formatMarkdownCodeSpan(value))
          .join('; ')}`
      );
    }

    if (signature.heritage.implements !== undefined) {
      lines.push(
        `    - Implements: ${signature.heritage.implements
          .map((value) => formatMarkdownCodeSpan(value))
          .join('; ')}`
      );
    }
  }

  if (signature.type !== undefined) {
    lines.push(`    - Type: ${formatMarkdownCodeSpan(signature.type)}`);
  }

  if (signature.memberCount !== undefined) {
    lines.push(`    - Member count: ${formatMarkdownCodeSpan(String(signature.memberCount))}`);
  }
}

function formatSignatureParameters(parameters: SourceTruthSignatureParameter[]): string {
  if (parameters.length === 0) {
    return formatMarkdownCodeSpan('none');
  }

  return parameters.map((parameter) => formatSignatureParameter(parameter)).join('; ');
}

function formatSignatureParameter(parameter: SourceTruthSignatureParameter): string {
  const text = `${parameter.rest ? '...' : ''}${parameter.name}${
    parameter.type ? `: ${parameter.type}` : ''
  }`;

  return `${formatMarkdownCodeSpan(text)} (optional: ${formatMarkdownCodeSpan(
    String(parameter.optional)
  )}, rest: ${formatMarkdownCodeSpan(String(parameter.rest))}, default: ${formatMarkdownCodeSpan(
    String(parameter.hasDefault)
  )})`;
}

function formatSignatureVariables(variables: SourceTruthSignatureVariable[]): string {
  if (variables.length === 0) {
    return formatMarkdownCodeSpan('none');
  }

  return variables
    .map((variable) =>
      variable.type
        ? formatMarkdownCodeSpan(`${variable.name}: ${variable.type}`)
        : formatMarkdownCodeSpan(variable.name)
    )
    .join('; ');
}

function formatEvidenceSignals(evidenceSignals: string[]): string {
  if (evidenceSignals.length === 0) {
    return formatMarkdownCodeSpan('none');
  }

  return evidenceSignals.map((signal) => formatMarkdownCodeSpan(signal)).join('; ');
}

function formatTestCaseModifiers(modifiers: string[]): string {
  if (modifiers.length === 0) {
    return formatMarkdownCodeSpan('none');
  }

  return modifiers.map((modifier) => formatMarkdownCodeSpan(modifier)).join('; ');
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
      factCount: file.facts.length + file.configFacts.length + file.contextFacts.length,
      exportFactCount: file.facts.length,
      signatureFactCount: file.facts.filter((fact) => fact.signature !== undefined).length,
      configFactCount: file.configFacts.length,
      contextFactCount: file.contextFacts.length,
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
      'No extractable source-truth export, package/config, or context facts were found for the explicit local source path.',
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

function filesWithContextFacts(files: SourceTruthFileEvidence[]): SourceTruthFileEvidence[] {
  return files.filter((file) => file.contextFacts.length > 0);
}

function filesWithAnyFacts(files: SourceTruthFileEvidence[]): SourceTruthFileEvidence[] {
  return files.filter(
    (file) => file.facts.length > 0 || file.configFacts.length > 0 || file.contextFacts.length > 0
  );
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
      const file = await describeGeneratedTextOutput(output.path);

      return {
        path: relativeOutputPath(outputDir, output.path),
        kind: output.kind,
        byteSize: file.byteSize,
        hash: file.hash,
        lineCount: file.lineCount,
        estimatedTokenCount: file.estimatedTokenCount,
      };
    })
  );

  return describedOutputs.sort((a, b) => compareStringsByCodeUnit(a.path, b.path));
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function formatHash(hash: string): string {
  return `sha256:${hash}`;
}

function formatLineRange(start: number, end: number): string {
  return formatMarkdownCodeSpan(`${start}-${end}`);
}

function formatMarkdownCodeSpan(value: string): string {
  const longestBacktickRun = longestRun(value, '`');
  const delimiter = '`'.repeat(longestBacktickRun + 1);
  const needsPadding = value.includes('`') || /^\s|\s$/.test(value);
  const content = needsPadding ? ` ${value} ` : value;

  return `${delimiter}${content}${delimiter}`;
}

function longestRun(value: string, character: string): number {
  let longest = 0;
  let current = 0;

  for (const valueCharacter of value) {
    if (valueCharacter === character) {
      current++;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }

  return longest;
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
