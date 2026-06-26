import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { lstat, mkdir, opendir } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import { writeTextFileSafely } from '../utils/safe-write.js';

export const DISCOVERY_REPORT_SCHEMA_VERSION = '0.2.0';
export const LOCAL_BOUNDED_INSPECTION_MODE = 'local-bounded-inspection';
export const DEFAULT_DISCOVERY_MAX_DEPTH = 8;
export const DEFAULT_DISCOVERY_MAX_FILES = 5000;
export const DEFAULT_DISCOVERY_MAX_ENTRIES = 20000;
const CONTENT_PREFIX_BYTES = 8192;
const SKIPPED_DIRECTORY_NAMES = [
  '.cache',
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

const URL_LIKE_SOURCE_PATTERNS = [
  /^[a-z][a-z0-9+.-]*:\/\//i,
  /^git@[^:]+:/i,
  /^github:[^/]+\/[^/]+/i,
];
const CANDIDATE_FILE_EXTENSIONS = new Set([
  '.htm',
  '.html',
  '.json',
  '.md',
  '.mdx',
  '.rst',
  '.yaml',
  '.yml',
]);

export type DiscoverySourceType = 'file' | 'directory';
export type DiscoveryCandidateKind =
  | 'docc'
  | 'html'
  | 'json'
  | 'markdown'
  | 'mdx'
  | 'openapi-json'
  | 'openapi-yaml'
  | 'openref-yaml'
  | 'rst'
  | 'yaml'
  | 'unknown';
export type DiscoveryEvidenceCategory =
  | 'machine-readable-spec'
  | 'structured-doc-source'
  | 'rendered-html'
  | 'generic-data'
  | 'unknown';

export interface DiscoveryCandidateEvidence {
  category: DiscoveryEvidenceCategory;
  signals: string[];
}

export interface DiscoveryTraversalSettings {
  followSymlinks: false;
  maxDepth: number;
  maxEntries: number;
  maxFiles: number;
  skippedDirectoryNames: string[];
  visitedEntries: number;
  visitedFiles: number;
  candidateCount: number;
  truncated: boolean;
}

export interface DiscoveryCandidate {
  path: string;
  resolvedPath: string;
  kind: DiscoveryCandidateKind;
  format: string;
  hints: string[];
  formatHints: string[];
  evidence: DiscoveryCandidateEvidence;
  order: number;
  byteSize: number;
  sha256: string;
}

export interface DiscoveryReport {
  schemaVersion: typeof DISCOVERY_REPORT_SCHEMA_VERSION;
  mode: typeof LOCAL_BOUNDED_INSPECTION_MODE;
  generatedAt: string;
  source: {
    input: string;
    resolvedPath: string;
    type: DiscoverySourceType;
  };
  output: {
    reportPath: string;
  };
  traversal: DiscoveryTraversalSettings;
  candidates: DiscoveryCandidate[];
  warnings: string[];
}

export interface DiscoveryInspection {
  source: {
    input: string;
    resolvedPath: string;
    type: DiscoverySourceType;
  };
  traversal: DiscoveryTraversalSettings;
  candidates: DiscoveryCandidate[];
  warnings: string[];
}

export interface DiscoverLocalSourcesOptions {
  source: string;
  outputDir?: string;
  maxDepth?: number;
  maxEntries?: number;
  maxFiles?: number;
}

export interface DiscoverLocalSourcesResult {
  report: DiscoveryReport;
  reportPath: string;
}

export type DiscoverLocalSourceOptions = DiscoverLocalSourcesOptions;

interface MutableTraversalState {
  visitedFiles: number;
  visitedEntries: number;
  truncated: boolean;
  emittedMaxFileWarning: boolean;
  emittedMaxEntryWarning: boolean;
}

interface CandidateHint {
  kind: DiscoveryCandidateKind;
  format: string;
  formatHints: string[];
  evidenceSignals: string[];
}

const DISCOVERY_EVIDENCE_CATEGORY_ORDER: Record<DiscoveryEvidenceCategory, number> = {
  'machine-readable-spec': 0,
  'structured-doc-source': 1,
  'rendered-html': 2,
  'generic-data': 3,
  unknown: 4,
};

export async function discoverLocalSources(
  options: DiscoverLocalSourcesOptions
): Promise<DiscoverLocalSourcesResult> {
  const inspection = await inspectLocalSource(options);
  const outputDir =
    options.outputDir === undefined
      ? defaultOutputDirForSource(inspection.source.resolvedPath)
      : resolve(options.outputDir);
  const reportPath = join(outputDir, 'discovery-report.json');

  const report: DiscoveryReport = {
    schemaVersion: DISCOVERY_REPORT_SCHEMA_VERSION,
    mode: LOCAL_BOUNDED_INSPECTION_MODE,
    generatedAt: new Date().toISOString(),
    source: inspection.source,
    output: {
      reportPath,
    },
    traversal: inspection.traversal,
    candidates: inspection.candidates,
    warnings: inspection.warnings,
  };

  await mkdir(outputDir, { recursive: true });
  await writeTextFileSafely(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  return { report, reportPath };
}

export async function inspectLocalSource(
  options: Omit<DiscoverLocalSourcesOptions, 'outputDir'>
): Promise<DiscoveryInspection> {
  validateSourceInput(options.source);

  const resolvedSourcePath = resolve(options.source);
  const sourceStats = await statSource(resolvedSourcePath);
  const sourceType: DiscoverySourceType = sourceStats.isDirectory() ? 'directory' : 'file';
  const maxDepth = resolveTraversalBound(
    options.maxDepth,
    DEFAULT_DISCOVERY_MAX_DEPTH,
    'maxDepth',
    true
  );
  const maxEntries = resolveTraversalBound(
    options.maxEntries,
    DEFAULT_DISCOVERY_MAX_ENTRIES,
    'maxEntries',
    false
  );
  const maxFiles = resolveTraversalBound(
    options.maxFiles,
    DEFAULT_DISCOVERY_MAX_FILES,
    'maxFiles',
    false
  );
  const candidates: DiscoveryCandidate[] = [];
  const warnings: string[] = [];
  const state: MutableTraversalState = {
    visitedFiles: 0,
    visitedEntries: 0,
    truncated: false,
    emittedMaxFileWarning: false,
    emittedMaxEntryWarning: false,
  };

  if (sourceType === 'file') {
    await inspectFile({
      absolutePath: resolvedSourcePath,
      relativePath: basename(resolvedSourcePath),
      candidates,
      warnings,
      state,
      maxFiles,
      includeUnknown: true,
    });
  } else {
    await traverseDirectory({
      rootPath: resolvedSourcePath,
      directoryPath: resolvedSourcePath,
      depth: 0,
      candidates,
      warnings,
      state,
      maxDepth,
      maxEntries,
      maxFiles,
    });
  }

  sortCandidatesForReport(candidates);

  return {
    source: {
      input: options.source,
      resolvedPath: resolvedSourcePath,
      type: sourceType,
    },
    traversal: {
      followSymlinks: false,
      maxDepth,
      maxEntries,
      maxFiles,
      skippedDirectoryNames: [...SKIPPED_DIRECTORY_NAMES],
      visitedEntries: state.visitedEntries,
      visitedFiles: state.visitedFiles,
      candidateCount: candidates.length,
      truncated: state.truncated,
    },
    candidates,
    warnings,
  };
}

export async function discoverLocalSource(
  options: DiscoverLocalSourceOptions
): Promise<DiscoveryReport> {
  const result = await discoverLocalSources(options);

  return result.report;
}

export function isUrlLikeInput(input: string): boolean {
  return URL_LIKE_SOURCE_PATTERNS.some((pattern) => pattern.test(input));
}

function validateSourceInput(source: string): void {
  if (source.trim() === '') {
    throw new Error('Source path is required.');
  }

  if (isUrlLikeInput(source.trim())) {
    throw new Error(
      'discover --source accepts local file or directory paths only; URL-like and git inputs are not supported'
    );
  }
}

async function statSource(sourcePath: string): Promise<Stats> {
  try {
    const sourceStats = await lstat(sourcePath);

    if (sourceStats.isSymbolicLink()) {
      throw new Error(`Source path must not be a symbolic link: ${sourcePath}`);
    }

    if (!sourceStats.isFile() && !sourceStats.isDirectory()) {
      throw new Error(`Source path must be a local file or directory: ${sourcePath}`);
    }

    return sourceStats;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Source path must')) {
      throw error;
    }

    throw new Error(`source path not found or cannot be read: ${sourcePath}`);
  }
}

function defaultOutputDirForSource(sourcePath: string): string {
  return join(dirname(sourcePath), `${basename(sourcePath)}-discovery`);
}

async function traverseDirectory(options: {
  rootPath: string;
  directoryPath: string;
  depth: number;
  candidates: DiscoveryCandidate[];
  warnings: string[];
  state: MutableTraversalState;
  maxDepth: number;
  maxEntries: number;
  maxFiles: number;
}): Promise<void> {
  const {
    rootPath,
    directoryPath,
    depth,
    candidates,
    warnings,
    state,
    maxDepth,
    maxEntries,
    maxFiles,
  } = options;

  if (state.truncated) {
    return;
  }

  const entries = await readDirectoryEntries({
    rootPath,
    directoryPath,
    warnings,
    state,
    maxEntries,
  });

  if (entries === undefined) {
    return;
  }

  entries.sort((a, b) => compareStringsByCodeUnit(a.name, b.name));

  for (const entry of entries) {
    if (state.truncated) {
      return;
    }

    const entryPath = join(directoryPath, entry.name);
    const relativePath = toRelativePath(rootPath, entryPath);

    if (entry.isSymbolicLink()) {
      warnings.push(`Skipped symbolic link: ${relativePath}`);
      continue;
    }

    if (entry.isDirectory()) {
      if (
        SKIPPED_DIRECTORY_NAMES.includes(entry.name as (typeof SKIPPED_DIRECTORY_NAMES)[number])
      ) {
        warnings.push(`Skipped directory by default: ${relativePath}`);
        continue;
      }

      if (depth >= maxDepth) {
        state.truncated = true;
        warnings.push(`Traversal stopped at max depth ${maxDepth}: ${relativePath}`);
        return;
      }

      await traverseDirectory({
        rootPath,
        directoryPath: entryPath,
        depth: depth + 1,
        candidates,
        warnings,
        state,
        maxDepth,
        maxEntries,
        maxFiles,
      });

      continue;
    }

    if (entry.isFile()) {
      await inspectFile({
        absolutePath: entryPath,
        relativePath,
        candidates,
        warnings,
        state,
        maxFiles,
        includeUnknown: false,
      });
    }
  }
}

async function inspectFile(options: {
  absolutePath: string;
  relativePath: string;
  candidates: DiscoveryCandidate[];
  warnings: string[];
  state: MutableTraversalState;
  maxFiles: number;
  includeUnknown: boolean;
}): Promise<void> {
  const { absolutePath, relativePath, candidates, warnings, state, maxFiles, includeUnknown } =
    options;

  if (state.visitedFiles >= maxFiles) {
    state.truncated = true;

    if (!state.emittedMaxFileWarning) {
      warnings.push(`Traversal maxFiles reached: ${maxFiles}`);
      state.emittedMaxFileWarning = true;
    }

    return;
  }

  state.visitedFiles++;

  if (!includeUnknown && !hasCandidateFileExtension(relativePath)) {
    return;
  }

  try {
    const fileInfo = await readFileInfo(absolutePath);
    const hint = inferCandidateHint(relativePath, fileInfo.contentPrefix);

    if (hint === undefined && !includeUnknown) {
      return;
    }

    const hints = hint?.formatHints ?? [];
    const pathForReport = normalizePathForReport(relativePath);
    const kind = hint?.kind ?? 'unknown';
    const format = hint?.format ?? 'unknown';

    candidates.push({
      path: pathForReport,
      resolvedPath: absolutePath,
      kind,
      format,
      hints,
      formatHints: hints,
      evidence: buildCandidateEvidence({
        path: pathForReport,
        kind,
        format,
        formatHints: hints,
        detectionSignals: hint?.evidenceSignals ?? [],
      }),
      order: 0,
      byteSize: fileInfo.byteSize,
      sha256: fileInfo.sha256,
    });
  } catch {
    warnings.push(`Skipped unreadable file: ${normalizePathForReport(relativePath)}`);
  }
}

async function readDirectoryEntries(options: {
  rootPath: string;
  directoryPath: string;
  warnings: string[];
  state: MutableTraversalState;
  maxEntries: number;
}): Promise<Dirent[] | undefined> {
  const { rootPath, directoryPath, warnings, state, maxEntries } = options;
  const entries: Dirent[] = [];

  try {
    const directory = await opendir(directoryPath);

    try {
      for await (const entry of directory) {
        if (state.visitedEntries >= maxEntries) {
          state.truncated = true;

          if (!state.emittedMaxEntryWarning) {
            warnings.push(`Traversal maxEntries reached: ${maxEntries}`);
            state.emittedMaxEntryWarning = true;
          }

          return undefined;
        }

        state.visitedEntries++;
        entries.push(entry);
      }
    } catch {
      warnings.push(`Skipped unreadable directory: ${toRelativePath(rootPath, directoryPath)}`);
      return undefined;
    }
  } catch {
    warnings.push(`Skipped unreadable directory: ${toRelativePath(rootPath, directoryPath)}`);
    return undefined;
  }

  return entries;
}

function hasCandidateFileExtension(relativePath: string): boolean {
  return CANDIDATE_FILE_EXTENSIONS.has(extname(relativePath).toLowerCase());
}

async function readFileInfo(absolutePath: string): Promise<{
  byteSize: number;
  contentPrefix: string;
  sha256: string;
}> {
  const hash = createHash('sha256');
  const prefixChunks: Buffer[] = [];
  let byteSize = 0;
  let prefixLength = 0;

  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(absolutePath);

    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteSize += buffer.byteLength;
      hash.update(buffer);

      if (prefixLength < CONTENT_PREFIX_BYTES) {
        const slice = buffer.subarray(0, CONTENT_PREFIX_BYTES - prefixLength);
        prefixChunks.push(slice);
        prefixLength += slice.byteLength;
      }
    });
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });

  return {
    byteSize,
    contentPrefix: Buffer.concat(prefixChunks, prefixLength).toString('utf-8'),
    sha256: hash.digest('hex'),
  };
}

function inferCandidateHint(
  relativePath: string,
  contentPrefix: string
): CandidateHint | undefined {
  const normalizedPath = normalizePathForReport(relativePath).toLowerCase();
  const extension = extname(normalizedPath);
  const fileName = basename(normalizedPath);
  const isDoccPath = normalizedPath.split('/').some((part) => part.endsWith('.docc'));
  const looksOpenApi = fileName.includes('openapi') || fileName.includes('swagger');

  if (extension === '.md' && isDoccPath) {
    return {
      kind: 'docc',
      format: 'markdown',
      formatHints: ['docc-marker', 'markdown'],
      evidenceSignals: ['path:docc-container'],
    };
  }

  if (extension === '.md') {
    return {
      kind: 'markdown',
      format: 'markdown',
      formatHints: ['markdown'],
      evidenceSignals: [],
    };
  }

  if (extension === '.mdx') {
    return { kind: 'mdx', format: 'mdx', formatHints: ['mdx'], evidenceSignals: [] };
  }

  if (extension === '.rst') {
    return { kind: 'rst', format: 'rst', formatHints: ['rst'], evidenceSignals: [] };
  }

  if (extension === '.html' || extension === '.htm') {
    return { kind: 'html', format: 'html', formatHints: ['html'], evidenceSignals: [] };
  }

  if (extension === '.yaml' || extension === '.yml') {
    const hasOpenApiMarker = /^openapi\s*:/m.test(contentPrefix);
    const hasSwaggerMarker = /^swagger\s*:/m.test(contentPrefix);

    if (looksOpenApi || hasOpenApiMarker || hasSwaggerMarker) {
      return {
        kind: 'openapi-yaml',
        format: 'yaml',
        formatHints: ['openapi-yaml', 'yaml'],
        evidenceSignals: [
          ...(looksOpenApi ? ['path:openapi-or-swagger-name'] : []),
          ...(hasOpenApiMarker ? ['content:openapi-field'] : []),
          ...(hasSwaggerMarker ? ['content:swagger-field'] : []),
        ],
      };
    }

    const hasOpenRefName = fileName.includes('openref');
    const hasInfoField = /^info\s*:/m.test(contentPrefix);
    const hasFunctionsField = /^functions\s*:/m.test(contentPrefix);

    if (hasOpenRefName || (hasInfoField && hasFunctionsField)) {
      return {
        kind: 'openref-yaml',
        format: 'yaml',
        formatHints: ['openref-yaml', 'yaml'],
        evidenceSignals: [
          ...(hasOpenRefName ? ['path:openref-name'] : []),
          ...(hasInfoField ? ['content:info-field'] : []),
          ...(hasFunctionsField ? ['content:functions-field'] : []),
        ],
      };
    }

    return { kind: 'yaml', format: 'yaml', formatHints: ['yaml'], evidenceSignals: [] };
  }

  if (extension === '.json') {
    const hasOpenApiMarker = /"openapi"\s*:/.test(contentPrefix);
    const hasSwaggerMarker = /"swagger"\s*:/.test(contentPrefix);

    if (looksOpenApi || hasOpenApiMarker || hasSwaggerMarker) {
      return {
        kind: 'openapi-json',
        format: 'json',
        formatHints: ['json', 'openapi-json'],
        evidenceSignals: [
          ...(looksOpenApi ? ['path:openapi-or-swagger-name'] : []),
          ...(hasOpenApiMarker ? ['content:openapi-field'] : []),
          ...(hasSwaggerMarker ? ['content:swagger-field'] : []),
        ],
      };
    }

    return { kind: 'json', format: 'json', formatHints: ['json'], evidenceSignals: [] };
  }

  return undefined;
}

function buildCandidateEvidence(options: {
  path: string;
  kind: DiscoveryCandidateKind;
  format: string;
  formatHints: string[];
  detectionSignals: string[];
}): DiscoveryCandidateEvidence {
  const { path, kind, format, formatHints, detectionSignals } = options;
  const extension = extname(path).toLowerCase();
  const category = evidenceCategoryForKind(kind);
  const signals = new Set<string>();

  signals.add(`kind:${kind}`);
  signals.add(`format:${format}`);

  if (extension !== '') {
    signals.add(`extension:${extension}`);
  }

  for (const formatHint of formatHints) {
    signals.add(`format-hint:${formatHint}`);
  }

  for (const signal of detectionSignals) {
    signals.add(signal);
  }

  return {
    category,
    signals: [...signals].sort(compareStringsByCodeUnit),
  };
}

function evidenceCategoryForKind(kind: DiscoveryCandidateKind): DiscoveryEvidenceCategory {
  switch (kind) {
    case 'openapi-json':
    case 'openapi-yaml':
    case 'openref-yaml':
      return 'machine-readable-spec';
    case 'docc':
    case 'markdown':
    case 'mdx':
    case 'rst':
      return 'structured-doc-source';
    case 'html':
      return 'rendered-html';
    case 'json':
    case 'yaml':
      return 'generic-data';
    case 'unknown':
      return 'unknown';
  }
}

function sortCandidatesForReport(candidates: DiscoveryCandidate[]): void {
  candidates.sort((a, b) => {
    const categoryDifference =
      DISCOVERY_EVIDENCE_CATEGORY_ORDER[a.evidence.category] -
      DISCOVERY_EVIDENCE_CATEGORY_ORDER[b.evidence.category];

    if (categoryDifference !== 0) {
      return categoryDifference;
    }

    return compareStringsByCodeUnit(a.path, b.path);
  });

  candidates.forEach((candidate, index) => {
    candidate.order = index + 1;
  });
}

function toRelativePath(rootPath: string, targetPath: string): string {
  const relativePath = relative(rootPath, targetPath);
  return relativePath === '' ? '.' : normalizePathForReport(relativePath);
}

function normalizePathForReport(path: string): string {
  return path.split(sep).join('/');
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

function resolveTraversalBound(
  value: number | undefined,
  defaultValue: number,
  name: string,
  allowZero: boolean
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    const lowerBound = allowZero ? 'non-negative' : 'positive';
    throw new Error(`${name} must be a ${lowerBound} safe integer`);
  }

  return value;
}
