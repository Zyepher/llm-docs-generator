import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { lstat, mkdir, opendir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';

import { describeGeneratedTextOutput } from './generated-output-metadata.js';
import {
  buildArtifactSummaryForManifest,
  buildInputProvenanceForManifest,
  buildManifestContract,
  type ArtifactSummary,
  type InputProvenance,
  type ManifestContract,
} from './manifest.js';
import {
  buildSourceVerificationFileEvidenceIndex,
  type SourceVerificationFileEvidenceIndex,
} from './source-verification-file-evidence-index.js';
import {
  inspectSourceTruth,
  type InspectSourceTruthOptions,
  type SourceTruthFact,
  type SourceTruthInspectionReport,
  type SourceTruthLineRange,
  type SourceTruthSourceType,
} from './source-truth.js';

export const SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION = '0.1.0';
export const SOURCE_VERIFICATION_MODE = 'source-verification-local-evidence';
export const SOURCE_VERIFICATION_FAILURE_MODE = 'source-verification-local-evidence-failure';
export const SOURCE_VERIFICATION_MANIFEST_SCHEMA_VERSION = '0.1.0';
export const SOURCE_VERIFICATION_REPORT_FILE = 'source-verification-report.json';
export const SOURCE_VERIFICATION_MANIFEST_FILE = 'manifest.json';
export const SOURCE_VERIFICATION_FAILURE_FILE = 'failure.json';
export const SOURCE_VERIFICATION_REPORT_OUTPUT_KIND = 'source-verification-report-json';
export const DEFAULT_SOURCE_VERIFICATION_DOCS_MAX_DEPTH = 8;
export const DEFAULT_SOURCE_VERIFICATION_DOCS_MAX_ENTRIES = 20000;
export const DEFAULT_SOURCE_VERIFICATION_DOCS_MAX_FILES = 5000;
export const DEFAULT_SOURCE_VERIFICATION_DOCS_MAX_FILE_BYTES = 262144;

const SKIPPED_DIRECTORY_NAMES = [
  '.cache',
  '.docusaurus',
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
] as const;

const URL_LIKE_INPUT_PATTERNS = [
  /^[a-z][a-z0-9+.-]*:\/\//i,
  /^git@[^:]+:/i,
  /^github:[^/]+\/[^/]+/i,
];

const SUPPORTED_DOCS_EXTENSIONS = new Set(['.md', '.mdx', '.markdown']);
const IDENTIFIER_PATTERN = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;
const CALL_IDENTIFIER_PATTERN = /^([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)\s*\(\s*\)$/u;

export type SourceVerificationInputType = SourceTruthSourceType;
export type SourceVerificationDocsFileStatus = 'inspected' | 'skipped';
export type SourceVerificationDocsSkipReason = 'unsupported-extension' | 'oversized' | 'unreadable';
export type SourceVerificationDocsReferenceKind =
  | 'inline-code-identifier'
  | 'inline-code-call-identifier';
export type SourceVerificationReferenceClassification =
  | 'exact-export-match'
  | 'unmatched-reference';
export type SourceVerificationFailureReason =
  | 'no-supported-docs-files'
  | 'no-doc-reference-evidence';

export interface SourceVerificationGeneratorMetadata {
  name: string;
  version: string;
  cliName?: string;
}

export interface SourceVerificationDocsReference {
  kind: SourceVerificationDocsReferenceKind;
  rawText: string;
  identifier: string;
  provenance: {
    path: string;
    lineRange: SourceTruthLineRange;
  };
  order: number;
}

export interface SourceVerificationDocsFileEvidence {
  path: string;
  resolvedPath: string;
  status: SourceVerificationDocsFileStatus;
  byteSize: number;
  sha256?: string;
  supported: boolean;
  references: SourceVerificationDocsReference[];
  referenceCount: number;
  skipReason?: SourceVerificationDocsSkipReason;
}

export interface SourceVerificationDocsTraversalSettings {
  followSymlinks: false;
  maxDepth: number;
  maxEntries: number;
  maxFiles: number;
  maxFileBytes: number;
  supportedExtensions: string[];
  skippedDirectoryNames: string[];
  visitedEntries: number;
  visitedFiles: number;
  inspectedFiles: number;
  skippedFiles: number;
  truncated: boolean;
}

export interface SourceVerificationDocsInspection {
  input: string;
  resolvedPath: string;
  type: SourceVerificationInputType;
  traversal: SourceVerificationDocsTraversalSettings;
  files: SourceVerificationDocsFileEvidence[];
  references: SourceVerificationDocsReference[];
  warnings: string[];
}

export interface SourceVerificationObservedExport {
  exportedName: string;
  factCount: number;
  facts: SourceVerificationSourceFactReference[];
}

export interface SourceVerificationSourceFactReference {
  kind: SourceTruthFact['kind'];
  symbolKind: SourceTruthFact['symbolKind'];
  name: string;
  exportedName: string;
  provenance: SourceTruthFact['provenance'];
  order: number;
  moduleSpecifier?: string;
}

export interface SourceVerificationReferenceMatch {
  classification: 'exact-export-match';
  reference: SourceVerificationDocsReference;
  sourceFacts: SourceVerificationSourceFactReference[];
}

export interface SourceVerificationUnmatchedReference {
  classification: 'unmatched-reference';
  reference: SourceVerificationDocsReference;
}

export interface SourceVerificationComparison {
  observedExports: SourceVerificationObservedExport[];
  matches: SourceVerificationReferenceMatch[];
  unmatchedReferences: SourceVerificationUnmatchedReference[];
}

export interface SourceVerificationSummary {
  sourceFileCount: number;
  sourceExportFactCount: number;
  observedExportedNameCount: number;
  docsFileCount: number;
  docsReferenceCount: number;
  exactMatchCount: number;
  unmatchedReferenceCount: number;
  warningCount: number;
}

export interface SourceVerificationReport {
  schemaVersion: typeof SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION;
  mode: typeof SOURCE_VERIFICATION_MODE;
  output: {
    reportPath: string;
  };
  source: {
    input: string;
    resolvedPath: string;
    type: SourceVerificationInputType;
  };
  docs: SourceVerificationDocsInspection;
  sourceInspection: SourceTruthInspectionReport;
  summary: SourceVerificationSummary;
  comparison: SourceVerificationComparison;
  limitations: string[];
  warnings: string[];
}

export interface SourceVerificationGeneratedOutput {
  path: string;
  kind: typeof SOURCE_VERIFICATION_REPORT_OUTPUT_KIND;
  byteSize: number;
  hash: string;
  lineCount: number;
  estimatedTokenCount: number;
}

export interface SourceVerificationManifest {
  schemaVersion: typeof SOURCE_VERIFICATION_MANIFEST_SCHEMA_VERSION;
  mode: typeof SOURCE_VERIFICATION_MODE;
  manifestContract: ManifestContract;
  inputProvenance: InputProvenance;
  artifactSummary: ArtifactSummary;
  generator: SourceVerificationGeneratorMetadata;
  sourceVerification: {
    reportPath: string;
    reportSchemaVersion: typeof SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION;
    reportMode: typeof SOURCE_VERIFICATION_MODE;
    source: {
      input: string;
      resolvedPath: string;
      type: SourceVerificationInputType;
    };
    docs: {
      input: string;
      resolvedPath: string;
      type: SourceVerificationInputType;
    };
    summary: SourceVerificationSummary;
    fileEvidenceIndex: SourceVerificationFileEvidenceIndex;
  };
  generatedOutputs: SourceVerificationGeneratedOutput[];
}

export interface SourceVerificationFailure {
  schemaVersion: typeof SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION;
  mode: typeof SOURCE_VERIFICATION_FAILURE_MODE;
  reason: SourceVerificationFailureReason;
  message: string;
  source: {
    input: string;
    resolvedPath: string;
    type: SourceVerificationInputType;
  };
  docs: {
    input: string;
    resolvedPath: string;
    type: SourceVerificationInputType;
  };
  evidenceReport: {
    path: string;
  };
}

export interface VerifyDocsAgainstSourceOptions extends InspectSourceTruthOptions {
  docs: string;
  outputDir: string;
  generator: SourceVerificationGeneratorMetadata;
  docsMaxDepth?: number;
  docsMaxEntries?: number;
  docsMaxFiles?: number;
  docsMaxFileBytes?: number;
}

export interface SourceVerificationResult {
  outputDir: string;
  reportPath: string;
  manifestPath: string;
  report: SourceVerificationReport;
  manifest: SourceVerificationManifest;
}

export class SourceVerificationNoDocsEvidenceError extends Error {
  readonly failurePath: string;
  readonly reportPath: string;
  readonly failure: SourceVerificationFailure;
  readonly report: SourceVerificationReport;

  constructor(options: {
    failurePath: string;
    reportPath: string;
    failure: SourceVerificationFailure;
    report: SourceVerificationReport;
  }) {
    super(options.failure.message);
    this.name = 'SourceVerificationNoDocsEvidenceError';
    this.failurePath = options.failurePath;
    this.reportPath = options.reportPath;
    this.failure = options.failure;
    this.report = options.report;
  }
}

interface ResolvedLocalInput {
  input: string;
  resolvedPath: string;
  type: SourceVerificationInputType;
  stats: Stats;
}

interface MutableDocsTraversalState {
  visitedEntries: number;
  visitedFiles: number;
  inspectedFiles: number;
  skippedFiles: number;
  // Global stop: a genuine budget (maxFiles/maxEntries) has been hit.
  truncated: boolean;
  // Per-subtree prune: a branch exceeded maxDepth. Does not abort sibling/
  // ancestor traversal; surfaced as traversal.truncated for honest coverage.
  depthLimited: boolean;
  emittedMaxEntryWarning: boolean;
  emittedMaxFileWarning: boolean;
  emittedMaxDepthWarning: boolean;
}

interface DirectoryEntriesResult {
  entries: Dirent[];
  reachedLimit: boolean;
}

interface FenceState {
  character: '`' | '~';
  length: number;
}

interface LineEntry {
  text: string;
  startOffset: number;
  lineNumber: number;
}

export async function verifyDocsAgainstSource(
  options: VerifyDocsAgainstSourceOptions
): Promise<SourceVerificationResult> {
  const outputDir = resolveOutputDir(options.outputDir);
  const reportPath = join(outputDir, SOURCE_VERIFICATION_REPORT_FILE);
  const manifestPath = join(outputDir, SOURCE_VERIFICATION_MANIFEST_FILE);
  const failurePath = join(outputDir, SOURCE_VERIFICATION_FAILURE_FILE);
  const sourceInputResolution = resolveExplicitLocalInput({
    label: 'source-truth verify-docs --source',
    input: options.source,
  });
  const docsInputResolution = resolveExplicitLocalInput({
    label: 'source-truth verify-docs --docs',
    input: options.docs,
  });
  const [sourceResolution, docsResolution] = await Promise.allSettled([
    sourceInputResolution,
    docsInputResolution,
  ]);

  if (sourceResolution.status === 'rejected') {
    await clearGeneratedArtifactsAfterInputFailure({
      outputDir,
      sourceInput: options.source,
      docsInput: options.docs,
    });

    throw sourceResolution.reason;
  }

  if (docsResolution.status === 'rejected') {
    await clearGeneratedArtifactsAfterInputFailure({
      outputDir,
      sourceInput: options.source,
      docsInput: options.docs,
    });

    throw docsResolution.reason;
  }

  const sourceInput = sourceResolution.value;
  const docsInput = docsResolution.value;

  await assertOutputDirOutsideInputs({
    outputDir,
    sourcePath: sourceInput.resolvedPath,
    docsPath: docsInput.resolvedPath,
  });
  await mkdir(outputDir, { recursive: true });
  await clearGeneratedArtifacts(outputDir);

  const [sourceInspection, docsInspection] = await Promise.all([
    inspectSourceTruth(options),
    inspectDocsReferences({
      input: options.docs,
      resolvedPath: docsInput.resolvedPath,
      type: docsInput.type,
      stats: docsInput.stats,
      maxDepth: resolveTraversalBound(
        options.docsMaxDepth,
        DEFAULT_SOURCE_VERIFICATION_DOCS_MAX_DEPTH,
        'docsMaxDepth',
        true
      ),
      maxEntries: resolveTraversalBound(
        options.docsMaxEntries,
        DEFAULT_SOURCE_VERIFICATION_DOCS_MAX_ENTRIES,
        'docsMaxEntries',
        false
      ),
      maxFiles: resolveTraversalBound(
        options.docsMaxFiles,
        DEFAULT_SOURCE_VERIFICATION_DOCS_MAX_FILES,
        'docsMaxFiles',
        false
      ),
      maxFileBytes: resolveTraversalBound(
        options.docsMaxFileBytes,
        DEFAULT_SOURCE_VERIFICATION_DOCS_MAX_FILE_BYTES,
        'docsMaxFileBytes',
        false
      ),
    }),
  ]);
  const report = buildSourceVerificationReport({
    reportPath: relativeOutputPath(outputDir, reportPath),
    sourceInspection,
    docsInspection,
  });

  await writeJsonFile(reportPath, report);

  const failureReason = noDocsEvidenceReason(report);
  if (failureReason !== undefined) {
    await rm(manifestPath, { force: true });
    const failure = buildFailure({
      report,
      reason: failureReason,
      evidenceReportPath: relativeOutputPath(outputDir, reportPath),
    });
    await writeJsonFile(failurePath, failure);

    throw new SourceVerificationNoDocsEvidenceError({
      failurePath,
      reportPath,
      failure,
      report,
    });
  }

  await rm(failurePath, { force: true });

  const generatedOutputs = await describeGeneratedOutputs(outputDir, [
    { path: reportPath, kind: SOURCE_VERIFICATION_REPORT_OUTPUT_KIND },
  ]);
  const manifest = buildManifest({
    generator: options.generator,
    report,
    generatedOutputs,
  });
  await writeJsonFile(manifestPath, manifest);

  return {
    outputDir,
    reportPath,
    manifestPath,
    report,
    manifest,
  };
}

async function inspectDocsReferences(options: {
  input: string;
  resolvedPath: string;
  type: SourceVerificationInputType;
  stats: Stats;
  maxDepth: number;
  maxEntries: number;
  maxFiles: number;
  maxFileBytes: number;
}): Promise<SourceVerificationDocsInspection> {
  const files: SourceVerificationDocsFileEvidence[] = [];
  const warnings: string[] = [];
  const state: MutableDocsTraversalState = {
    visitedEntries: 0,
    visitedFiles: 0,
    inspectedFiles: 0,
    skippedFiles: 0,
    truncated: false,
    depthLimited: false,
    emittedMaxEntryWarning: false,
    emittedMaxFileWarning: false,
    emittedMaxDepthWarning: false,
  };

  if (options.type === 'file') {
    await inspectDocsFile({
      absolutePath: options.resolvedPath,
      relativePath: basename(options.resolvedPath),
      stats: options.stats,
      files,
      warnings,
      state,
      maxFiles: options.maxFiles,
      maxFileBytes: options.maxFileBytes,
    });
  } else {
    await traverseDocsDirectory({
      rootPath: options.resolvedPath,
      directoryPath: options.resolvedPath,
      depth: 0,
      files,
      warnings,
      state,
      maxDepth: options.maxDepth,
      maxEntries: options.maxEntries,
      maxFiles: options.maxFiles,
      maxFileBytes: options.maxFileBytes,
    });
  }

  sortDocsFiles(files);
  const references = files.flatMap((file) => file.references);
  references.forEach((reference, index) => {
    reference.order = index + 1;
  });

  return {
    input: options.input,
    resolvedPath: options.resolvedPath,
    type: options.type,
    traversal: {
      followSymlinks: false,
      maxDepth: options.maxDepth,
      maxEntries: options.maxEntries,
      maxFiles: options.maxFiles,
      maxFileBytes: options.maxFileBytes,
      supportedExtensions: [...SUPPORTED_DOCS_EXTENSIONS].sort(compareStringsByCodeUnit),
      skippedDirectoryNames: [...SKIPPED_DIRECTORY_NAMES],
      visitedEntries: state.visitedEntries,
      visitedFiles: state.visitedFiles,
      inspectedFiles: state.inspectedFiles,
      skippedFiles: state.skippedFiles,
      truncated: state.truncated || state.depthLimited,
    },
    files,
    references,
    warnings,
  };
}

async function traverseDocsDirectory(options: {
  rootPath: string;
  directoryPath: string;
  depth: number;
  files: SourceVerificationDocsFileEvidence[];
  warnings: string[];
  state: MutableDocsTraversalState;
  maxDepth: number;
  maxEntries: number;
  maxFiles: number;
  maxFileBytes: number;
}): Promise<void> {
  if (options.state.truncated) {
    return;
  }

  const directoryEntries = await readDirectoryEntries({
    rootPath: options.rootPath,
    directoryPath: options.directoryPath,
    warnings: options.warnings,
    state: options.state,
    maxEntries: options.maxEntries,
  });

  if (directoryEntries === undefined) {
    return;
  }

  const entryBudgetExhausted =
    directoryEntries.reachedLimit && options.state.visitedEntries >= options.maxEntries;

  for (const entry of directoryEntries.entries) {
    if (options.state.truncated) {
      return;
    }

    const entryPath = join(options.directoryPath, entry.name);
    const relativePath = normalizePathForReport(relative(options.rootPath, entryPath));

    if (entry.isSymbolicLink()) {
      options.warnings.push(`Skipped symbolic link: ${relativePath}`);
      continue;
    }

    if (entry.isDirectory()) {
      if (
        SKIPPED_DIRECTORY_NAMES.includes(entry.name as (typeof SKIPPED_DIRECTORY_NAMES)[number])
      ) {
        options.warnings.push(`Skipped directory by default: ${relativePath}`);
        continue;
      }

      if (entryBudgetExhausted) {
        continue;
      }

      if (options.depth >= options.maxDepth) {
        // Prune only this over-deep subtree; keep traversing siblings.
        options.state.depthLimited = true;
        if (!options.state.emittedMaxDepthWarning) {
          options.warnings.push(
            `Docs traversal pruned subtrees at max depth ${options.maxDepth} (first: ${relativePath})`
          );
          options.state.emittedMaxDepthWarning = true;
        }
        continue;
      }

      await traverseDocsDirectory({
        ...options,
        directoryPath: entryPath,
        depth: options.depth + 1,
      });
      continue;
    }

    if (entry.isFile()) {
      const stats = await lstat(entryPath);
      await inspectDocsFile({
        absolutePath: entryPath,
        relativePath,
        stats,
        files: options.files,
        warnings: options.warnings,
        state: options.state,
        maxFiles: options.maxFiles,
        maxFileBytes: options.maxFileBytes,
      });
    }
  }

  if (directoryEntries.reachedLimit) {
    options.state.truncated = true;
  }
}

async function inspectDocsFile(options: {
  absolutePath: string;
  relativePath: string;
  stats: Stats;
  files: SourceVerificationDocsFileEvidence[];
  warnings: string[];
  state: MutableDocsTraversalState;
  maxFiles: number;
  maxFileBytes: number;
}): Promise<void> {
  const pathForReport = normalizePathForReport(options.relativePath);

  if (options.state.visitedFiles >= options.maxFiles) {
    options.state.truncated = true;

    if (!options.state.emittedMaxFileWarning) {
      options.warnings.push(`Docs traversal maxFiles reached: ${options.maxFiles}`);
      options.state.emittedMaxFileWarning = true;
    }

    return;
  }

  options.state.visitedFiles++;

  if (!isSupportedDocsFile(pathForReport)) {
    options.state.skippedFiles++;
    options.warnings.push(`Skipped unsupported docs file: ${pathForReport}`);
    options.files.push({
      path: pathForReport,
      resolvedPath: options.absolutePath,
      status: 'skipped',
      byteSize: options.stats.size,
      supported: false,
      references: [],
      referenceCount: 0,
      skipReason: 'unsupported-extension',
    });
    return;
  }

  if (options.stats.size > options.maxFileBytes) {
    options.state.skippedFiles++;
    options.warnings.push(
      `Skipped oversized docs file: ${pathForReport} (${options.stats.size} bytes)`
    );
    options.files.push({
      path: pathForReport,
      resolvedPath: options.absolutePath,
      status: 'skipped',
      byteSize: options.stats.size,
      supported: true,
      references: [],
      referenceCount: 0,
      skipReason: 'oversized',
    });
    return;
  }

  try {
    const contentBytes = await readFile(options.absolutePath);
    const content = contentBytes.toString('utf-8');
    const sha256 = createHash('sha256').update(contentBytes).digest('hex');
    const references = extractDocsReferences(pathForReport, content);

    options.state.inspectedFiles++;
    options.files.push({
      path: pathForReport,
      resolvedPath: options.absolutePath,
      status: 'inspected',
      byteSize: options.stats.size,
      sha256,
      supported: true,
      references,
      referenceCount: references.length,
    });
  } catch {
    options.state.skippedFiles++;
    options.warnings.push(`Skipped unreadable docs file: ${pathForReport}`);
    options.files.push({
      path: pathForReport,
      resolvedPath: options.absolutePath,
      status: 'skipped',
      byteSize: options.stats.size,
      supported: true,
      references: [],
      referenceCount: 0,
      skipReason: 'unreadable',
    });
  }
}

function extractDocsReferences(path: string, content: string): SourceVerificationDocsReference[] {
  const references: SourceVerificationDocsReference[] = [];
  let fenceState: FenceState | undefined;

  for (const line of linesWithOffsets(content)) {
    const fence = parseFenceMarker(line.text);

    if (fenceState !== undefined) {
      if (
        fence !== undefined &&
        fence.character === fenceState.character &&
        fence.length >= fenceState.length
      ) {
        fenceState = undefined;
      }

      continue;
    }

    if (fence !== undefined) {
      fenceState = fence;
      continue;
    }

    for (const codeSpan of inlineCodeSpans(line.text)) {
      const reference = parseInlineCodeReference(codeSpan.rawText);

      if (reference === undefined) {
        continue;
      }

      references.push({
        kind: reference.kind,
        rawText: codeSpan.rawText,
        identifier: reference.identifier,
        provenance: {
          path,
          lineRange: {
            start: line.lineNumber,
            end: line.lineNumber,
          },
        },
        order: 0,
      });
    }
  }

  return references;
}

function inlineCodeSpans(line: string): Array<{ rawText: string }> {
  const spans: Array<{ rawText: string }> = [];
  let index = 0;

  while (index < line.length) {
    if (line[index] !== '`') {
      index++;
      continue;
    }

    const runLength = countRun(line, index, '`');

    if (runLength >= 3) {
      index += runLength;
      continue;
    }

    const contentStart = index + runLength;
    const closingIndex = findBacktickRun(line, contentStart, runLength);

    if (closingIndex === -1) {
      break;
    }

    spans.push({
      rawText: line.slice(contentStart, closingIndex),
    });
    index = closingIndex + runLength;
  }

  return spans;
}

function parseInlineCodeReference(
  rawText: string
): { kind: SourceVerificationDocsReferenceKind; identifier: string } | undefined {
  const text = rawText.trim();

  if (IDENTIFIER_PATTERN.test(text)) {
    return {
      kind: 'inline-code-identifier',
      identifier: text,
    };
  }

  const callMatch = CALL_IDENTIFIER_PATTERN.exec(text);

  if (callMatch !== null && callMatch[1] !== undefined) {
    return {
      kind: 'inline-code-call-identifier',
      identifier: callMatch[1],
    };
  }

  return undefined;
}

function buildSourceVerificationReport(options: {
  reportPath: string;
  sourceInspection: SourceTruthInspectionReport;
  docsInspection: SourceVerificationDocsInspection;
}): SourceVerificationReport {
  const observedExports = observedExportsFromFacts(options.sourceInspection.facts);
  const factsByExportedName = new Map(
    observedExports.map((exportEntry) => [exportEntry.exportedName, exportEntry.facts])
  );
  const matches: SourceVerificationReferenceMatch[] = [];
  const unmatchedReferences: SourceVerificationUnmatchedReference[] = [];

  for (const reference of options.docsInspection.references) {
    const sourceFacts = factsByExportedName.get(reference.identifier);

    if (sourceFacts === undefined) {
      unmatchedReferences.push({
        classification: 'unmatched-reference',
        reference,
      });
      continue;
    }

    matches.push({
      classification: 'exact-export-match',
      reference,
      sourceFacts,
    });
  }

  const warnings = [
    ...options.sourceInspection.warnings.map((warning) => `Source inspection: ${warning}`),
    ...options.docsInspection.warnings.map((warning) => `Docs inspection: ${warning}`),
  ];
  const docsFileCount = options.docsInspection.files.filter(
    (file) => file.status === 'inspected'
  ).length;
  const summary: SourceVerificationSummary = {
    sourceFileCount: options.sourceInspection.files.length,
    sourceExportFactCount: options.sourceInspection.facts.length,
    observedExportedNameCount: observedExports.length,
    docsFileCount,
    docsReferenceCount: options.docsInspection.references.length,
    exactMatchCount: matches.length,
    unmatchedReferenceCount: unmatchedReferences.length,
    warningCount: warnings.length,
  };

  return {
    schemaVersion: SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION,
    mode: SOURCE_VERIFICATION_MODE,
    output: {
      reportPath: options.reportPath,
    },
    source: {
      input: options.sourceInspection.source.input,
      resolvedPath: options.sourceInspection.source.resolvedPath,
      type: options.sourceInspection.source.type,
    },
    docs: options.docsInspection,
    sourceInspection: options.sourceInspection,
    summary,
    comparison: {
      observedExports,
      matches,
      unmatchedReferences,
    },
    limitations: [
      'Exact matches are lexical exported-name evidence only.',
      'Unmatched references are observations only; they are not failures.',
      'No runtime, route, framework, completeness, task fit, or source selection inference is performed.',
      'Docs evidence is limited to inline Markdown/MDX code identifiers in explicit local text files.',
      'Source evidence is limited to the existing conservative source-truth inspector facts.',
    ],
    warnings,
  };
}

function observedExportsFromFacts(facts: SourceTruthFact[]): SourceVerificationObservedExport[] {
  const byExportedName = new Map<string, SourceVerificationSourceFactReference[]>();

  for (const fact of facts) {
    const references = byExportedName.get(fact.exportedName) ?? [];
    references.push({
      kind: fact.kind,
      symbolKind: fact.symbolKind,
      name: fact.name,
      exportedName: fact.exportedName,
      provenance: fact.provenance,
      order: fact.order,
      ...(fact.moduleSpecifier === undefined ? {} : { moduleSpecifier: fact.moduleSpecifier }),
    });
    byExportedName.set(fact.exportedName, references);
  }

  return [...byExportedName.entries()]
    .sort(([a], [b]) => compareStringsByCodeUnit(a, b))
    .map(([exportedName, sourceFacts]) => ({
      exportedName,
      factCount: sourceFacts.length,
      facts: sourceFacts.sort((a, b) => a.order - b.order),
    }));
}

function noDocsEvidenceReason(
  report: SourceVerificationReport
): SourceVerificationFailureReason | undefined {
  if (report.summary.docsFileCount === 0) {
    return 'no-supported-docs-files';
  }

  if (report.summary.docsReferenceCount === 0) {
    return 'no-doc-reference-evidence';
  }

  return undefined;
}

function buildFailure(options: {
  report: SourceVerificationReport;
  reason: SourceVerificationFailureReason;
  evidenceReportPath: string;
}): SourceVerificationFailure {
  return {
    schemaVersion: SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION,
    mode: SOURCE_VERIFICATION_FAILURE_MODE,
    reason: options.reason,
    message:
      options.reason === 'no-supported-docs-files'
        ? 'No supported local Markdown/MDX docs files were available for reference extraction.'
        : 'No inline-code identifier references were found in supported local Markdown/MDX docs files.',
    source: options.report.source,
    docs: {
      input: options.report.docs.input,
      resolvedPath: options.report.docs.resolvedPath,
      type: options.report.docs.type,
    },
    evidenceReport: {
      path: options.evidenceReportPath,
    },
  };
}

function buildManifest(options: {
  generator: SourceVerificationGeneratorMetadata;
  report: SourceVerificationReport;
  generatedOutputs: SourceVerificationGeneratedOutput[];
}): SourceVerificationManifest {
  const manifest = {
    schemaVersion: SOURCE_VERIFICATION_MANIFEST_SCHEMA_VERSION,
    mode: SOURCE_VERIFICATION_MODE,
    manifestContract: buildManifestContract(SOURCE_VERIFICATION_MODE),
    generator: options.generator,
    sourceVerification: {
      reportPath: options.report.output.reportPath,
      reportSchemaVersion: options.report.schemaVersion,
      reportMode: options.report.mode,
      source: options.report.source,
      docs: {
        input: options.report.docs.input,
        resolvedPath: options.report.docs.resolvedPath,
        type: options.report.docs.type,
      },
      summary: options.report.summary,
      fileEvidenceIndex: buildSourceVerificationFileEvidenceIndex(options.report),
    },
    generatedOutputs: options.generatedOutputs,
  } satisfies Omit<SourceVerificationManifest, 'inputProvenance' | 'artifactSummary'>;
  const manifestWithProvenance = {
    ...manifest,
    inputProvenance: buildInputProvenanceForManifest(manifest),
  };

  return {
    ...manifestWithProvenance,
    artifactSummary: buildArtifactSummaryForManifest(manifestWithProvenance),
  };
}

async function describeGeneratedOutputs(
  outputDir: string,
  outputs: Array<Pick<SourceVerificationGeneratedOutput, 'path' | 'kind'>>
): Promise<SourceVerificationGeneratedOutput[]> {
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

async function resolveExplicitLocalInput(options: {
  label: string;
  input: string;
}): Promise<ResolvedLocalInput> {
  const input = options.input.trim();

  if (input.length === 0) {
    throw new Error(`${options.label} path is required.`);
  }

  if (URL_LIKE_INPUT_PATTERNS.some((pattern) => pattern.test(input))) {
    throw new Error(
      `${options.label} accepts local file or directory paths only; URL-like and git inputs are not supported`
    );
  }

  const resolvedPath = resolve(input);

  try {
    const stats = await lstat(resolvedPath);

    if (stats.isSymbolicLink()) {
      throw new Error(`${options.label} path must not be a symbolic link: ${resolvedPath}`);
    }

    if (!stats.isFile() && !stats.isDirectory()) {
      throw new Error(`${options.label} path must be a local file or directory: ${resolvedPath}`);
    }

    await assertNoParentSymlinkComponents({
      label: options.label,
      path: resolvedPath,
    });

    return {
      input: options.input,
      resolvedPath,
      type: stats.isDirectory() ? 'directory' : 'file',
      stats,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(options.label)) {
      throw error;
    }

    throw new Error(`${options.label} path not found or cannot be read: ${resolvedPath}`);
  }
}

function resolveOutputDir(outputDirInput: string): string {
  const outputDir = outputDirInput.trim();

  if (outputDir.length === 0) {
    throw new Error('source-truth verify-docs --output-dir path is required.');
  }

  if (URL_LIKE_INPUT_PATTERNS.some((pattern) => pattern.test(outputDir))) {
    throw new Error(
      'source-truth verify-docs --output-dir accepts local directory paths only; URL-like and git inputs are not supported'
    );
  }

  return resolve(outputDir);
}

async function assertOutputDirOutsideInputs(options: {
  outputDir: string;
  sourcePath: string;
  docsPath: string;
}): Promise<void> {
  await assertNoExistingSymlinkPathComponents({
    label: 'source-truth verify-docs --output-dir',
    path: options.outputDir,
  });

  const effectiveOutputPath = await resolveEffectiveOutputPath(options.outputDir);

  for (const inputPath of [options.sourcePath, options.docsPath]) {
    const canonicalInputPath = await realpath(inputPath);

    if (
      isSameOrDescendant(inputPath, options.outputDir) ||
      isSameOrDescendant(canonicalInputPath, effectiveOutputPath)
    ) {
      throw new Error(
        'source-truth verify-docs --output-dir must not be the same as, or inside, the explicit --source or --docs path'
      );
    }
  }
}

async function assertNoParentSymlinkComponents(options: {
  label: string;
  path: string;
}): Promise<void> {
  const parsedPath = parse(options.path);
  const parts = options.path.slice(parsedPath.root.length).split(sep).filter(Boolean);
  let currentPath = parsedPath.root;

  for (let index = 0; index < parts.length - 1; index++) {
    currentPath = join(currentPath, parts[index] as string);

    const componentStats = await lstat(currentPath);

    if (componentStats.isSymbolicLink()) {
      throw new Error(
        `${options.label} path must not contain a symbolic link component: ${currentPath}`
      );
    }
  }
}

async function assertNoExistingSymlinkPathComponents(options: {
  label: string;
  path: string;
}): Promise<void> {
  const parsedPath = parse(options.path);
  const parts = options.path.slice(parsedPath.root.length).split(sep).filter(Boolean);
  let currentPath = parsedPath.root;

  for (const [index, part] of parts.entries()) {
    currentPath = join(currentPath, part);

    let stats: Stats;
    try {
      stats = await lstat(currentPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }

      throw error;
    }

    if (stats.isSymbolicLink()) {
      throw new Error(
        `${options.label} path must not contain a symbolic link component: ${currentPath}`
      );
    }

    if (index < parts.length - 1 && !stats.isDirectory()) {
      throw new Error(`${options.label} parent path must be a directory: ${currentPath}`);
    }

    if (index === parts.length - 1 && !stats.isDirectory()) {
      throw new Error(`${options.label} path exists and is not a directory: ${currentPath}`);
    }
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

async function readDirectoryEntries(options: {
  rootPath: string;
  directoryPath: string;
  warnings: string[];
  state: MutableDocsTraversalState;
  maxEntries: number;
}): Promise<DirectoryEntriesResult | undefined> {
  const remainingEntries = options.maxEntries - options.state.visitedEntries;
  const entries: Dirent[] = [];
  let reachedLimit = false;

  if (remainingEntries <= 0) {
    emitMaxEntryWarning(options.warnings, options.state, options.maxEntries);

    return { entries, reachedLimit: true };
  }

  const allEntries: Dirent[] = [];

  try {
    const directory = await opendir(options.directoryPath);

    try {
      for await (const entry of directory) {
        allEntries.push(entry);
      }
    } catch {
      options.warnings.push(
        `Skipped unreadable docs directory: ${normalizePathForReport(relative(options.rootPath, options.directoryPath))}`
      );
      return undefined;
    }
  } catch {
    options.warnings.push(
      `Skipped unreadable docs directory: ${normalizePathForReport(relative(options.rootPath, options.directoryPath))}`
    );
    return undefined;
  }

  // Sort BEFORE applying the entry budget so a truncated directory retains the
  // lexicographically-first N entries deterministically, rather than whichever
  // N the filesystem happened to return first (which made the resulting
  // fileEvidenceIndex.aggregateHash filesystem-order-dependent).
  allEntries.sort((a, b) => compareStringsByCodeUnit(a.name, b.name));

  if (allEntries.length > remainingEntries) {
    for (const entry of allEntries.slice(0, remainingEntries)) {
      entries.push(entry);
    }
    emitMaxEntryWarning(options.warnings, options.state, options.maxEntries);
    reachedLimit = true;
  } else {
    entries.push(...allEntries);
  }

  options.state.visitedEntries += entries.length;

  return { entries, reachedLimit };
}

function emitMaxEntryWarning(
  warnings: string[],
  state: MutableDocsTraversalState,
  maxEntries: number
): void {
  if (state.emittedMaxEntryWarning) {
    return;
  }

  warnings.push(`Docs traversal maxEntries reached: ${maxEntries}`);
  state.emittedMaxEntryWarning = true;
}

function resolveTraversalBound(
  value: number | undefined,
  defaultValue: number,
  label: string,
  allowZero: boolean
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.`);
  }

  return value;
}

function linesWithOffsets(content: string): LineEntry[] {
  const lines: LineEntry[] = [];
  let offset = 0;
  let lineNumber = 1;

  while (offset < content.length) {
    const newlineIndex = content.indexOf('\n', offset);
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex;
    const rawLine = content.slice(offset, lineEnd);
    const text = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    lines.push({
      text,
      startOffset: offset,
      lineNumber,
    });

    if (newlineIndex === -1) {
      break;
    }

    offset = newlineIndex + 1;
    lineNumber++;
  }

  if (content.length === 0) {
    lines.push({
      text: '',
      startOffset: 0,
      lineNumber: 1,
    });
  }

  return lines;
}

function parseFenceMarker(line: string): FenceState | undefined {
  const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);

  if (match === null || match[1] === undefined) {
    return undefined;
  }

  const marker = match[1];

  return {
    character: marker[0] as '`' | '~',
    length: marker.length,
  };
}

function countRun(value: string, start: number, character: string): number {
  let index = start;

  while (index < value.length && value[index] === character) {
    index++;
  }

  return index - start;
}

function findBacktickRun(line: string, start: number, runLength: number): number {
  let index = start;

  while (index < line.length) {
    if (line[index] !== '`') {
      index++;
      continue;
    }

    const foundRunLength = countRun(line, index, '`');

    if (foundRunLength === runLength) {
      return index;
    }

    index += foundRunLength;
  }

  return -1;
}

async function clearGeneratedArtifacts(outputDir: string): Promise<void> {
  await Promise.all(
    [
      SOURCE_VERIFICATION_REPORT_FILE,
      SOURCE_VERIFICATION_MANIFEST_FILE,
      SOURCE_VERIFICATION_FAILURE_FILE,
    ].map((path) => rm(join(outputDir, path), { force: true }))
  );
}

async function clearGeneratedArtifactsAfterInputFailure(options: {
  outputDir: string;
  sourceInput: string;
  docsInput: string;
}): Promise<void> {
  if (
    shouldPreserveOutputDirForInputSafety(options.outputDir, options.sourceInput) ||
    shouldPreserveOutputDirForInputSafety(options.outputDir, options.docsInput)
  ) {
    return;
  }

  await assertNoExistingSymlinkPathComponents({
    label: 'source-truth verify-docs --output-dir',
    path: options.outputDir,
  });
  await mkdir(options.outputDir, { recursive: true });
  await clearOwnedGeneratedArtifacts(options.outputDir);
}

async function clearOwnedGeneratedArtifacts(outputDir: string): Promise<void> {
  await Promise.all([
    removeOwnedJsonFile(
      join(outputDir, SOURCE_VERIFICATION_REPORT_FILE),
      isSourceVerificationReportArtifact
    ),
    removeOwnedJsonFile(
      join(outputDir, SOURCE_VERIFICATION_MANIFEST_FILE),
      isSourceVerificationManifestArtifact
    ),
    removeOwnedJsonFile(
      join(outputDir, SOURCE_VERIFICATION_FAILURE_FILE),
      isSourceVerificationFailureArtifact
    ),
  ]);
}

async function removeOwnedJsonFile(
  path: string,
  isOwnedArtifact: (value: unknown) => boolean
): Promise<void> {
  try {
    const stats = await lstat(path);

    if (!stats.isFile()) {
      return;
    }
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }

    throw error;
  }

  let content: unknown;

  try {
    content = JSON.parse(await readFile(path, 'utf-8')) as unknown;
  } catch {
    return;
  }

  if (!isOwnedArtifact(content)) {
    return;
  }

  await rm(path, { force: true });
}

function isSourceVerificationReportArtifact(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }

  const output = value.output;

  return (
    value.schemaVersion === SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION &&
    value.mode === SOURCE_VERIFICATION_MODE &&
    isObjectRecord(output) &&
    output.reportPath === SOURCE_VERIFICATION_REPORT_FILE
  );
}

function isSourceVerificationManifestArtifact(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }

  const sourceVerification = value.sourceVerification;
  const generatedOutputs = value.generatedOutputs;
  const firstOutput = Array.isArray(generatedOutputs) ? generatedOutputs[0] : undefined;

  return (
    value.schemaVersion === SOURCE_VERIFICATION_MANIFEST_SCHEMA_VERSION &&
    value.mode === SOURCE_VERIFICATION_MODE &&
    isObjectRecord(sourceVerification) &&
    sourceVerification.reportPath === SOURCE_VERIFICATION_REPORT_FILE &&
    sourceVerification.reportSchemaVersion === SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION &&
    sourceVerification.reportMode === SOURCE_VERIFICATION_MODE &&
    isObjectRecord(firstOutput) &&
    firstOutput.path === SOURCE_VERIFICATION_REPORT_FILE &&
    firstOutput.kind === SOURCE_VERIFICATION_REPORT_OUTPUT_KIND
  );
}

function isSourceVerificationFailureArtifact(value: unknown): boolean {
  if (!isObjectRecord(value)) {
    return false;
  }

  const evidenceReport = value.evidenceReport;

  return (
    value.schemaVersion === SOURCE_VERIFICATION_REPORT_SCHEMA_VERSION &&
    value.mode === SOURCE_VERIFICATION_FAILURE_MODE &&
    (value.reason === 'no-supported-docs-files' || value.reason === 'no-doc-reference-evidence') &&
    isObjectRecord(evidenceReport) &&
    evidenceReport.path === SOURCE_VERIFICATION_REPORT_FILE
  );
}

function shouldPreserveOutputDirForInputSafety(outputDir: string, input: string): boolean {
  const trimmedInput = input.trim();

  if (
    trimmedInput.length === 0 ||
    URL_LIKE_INPUT_PATTERNS.some((pattern) => pattern.test(trimmedInput))
  ) {
    return false;
  }

  return isSameOrDescendant(resolve(trimmedInput), outputDir);
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function isSupportedDocsFile(path: string): boolean {
  return SUPPORTED_DOCS_EXTENSIONS.has(extname(path).toLowerCase());
}

function sortDocsFiles(files: SourceVerificationDocsFileEvidence[]): void {
  files.sort((a, b) => compareStringsByCodeUnit(a.path, b.path));
}

function normalizePathForReport(path: string): string {
  return path.split(sep).join('/');
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

  return normalizePathForReport(relativePath);
}

function isSameOrDescendant(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(parentPath, candidatePath);

  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR')
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
