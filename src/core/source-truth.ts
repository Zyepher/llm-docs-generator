import type { Dirent, Stats } from 'node:fs';
import { lstat, opendir, readFile } from 'node:fs/promises';
import { basename, extname, join, parse, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import { isRecord } from '../utils/guards.js';
import { sha256Hex } from '../utils/hash.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';

export const SOURCE_TRUTH_REPORT_SCHEMA_VERSION = '0.1.0';
export const SOURCE_TRUTH_INSPECTION_MODE = 'source-truth-local-evidence';
export const DEFAULT_SOURCE_TRUTH_MAX_DEPTH = 8;
export const DEFAULT_SOURCE_TRUTH_MAX_ENTRIES = 20000;
export const DEFAULT_SOURCE_TRUTH_MAX_FILES = 5000;
export const DEFAULT_SOURCE_TRUTH_MAX_FILE_BYTES = 262144;

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

const SUPPORTED_SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);

const PACKAGE_JSON_FILE_NAME = 'package.json';
const TSCONFIG_FILE_PATTERN = /^tsconfig(?:\..*)?\.json$/;
const PACKAGE_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundledDependencies',
  'bundleDependencies',
] as const;
const TSCONFIG_ARRAY_FIELDS = ['include', 'exclude', 'files'] as const;
const TEST_CONTEXT_PATH_SEGMENTS = ['__tests__', 'test', 'tests'] as const;
const EXAMPLE_CONTEXT_PATH_SEGMENTS = [
  'example',
  'examples',
  'demo',
  'demos',
  'sample',
  'samples',
] as const;
const MAX_SIGNATURE_TEXT_LENGTH = 500;
const MAX_SIGNATURE_DETAIL_TEXT_LENGTH = 240;
const MAX_SIGNATURE_NAME_LENGTH = 120;
const SIGNATURE_PRINTER = ts.createPrinter({ removeComments: true });

export type SourceTruthSourceType = 'file' | 'directory';
export type SourceTruthFileStatus = 'inspected' | 'skipped';
export type SourceTruthSkipReason = 'unsupported-extension' | 'oversized' | 'unreadable';
export type SourceTruthFactKind =
  | 'exported-symbol'
  | 're-exported-symbol'
  | 'export-all'
  | 'export-assignment';
export type SourceTruthSymbolKind =
  | 'class'
  | 'enum'
  | 'function'
  | 'interface'
  | 'type'
  | 'value'
  | 'unknown';
export type SourceTruthSignatureDeclarationKind =
  | 'class'
  | 'enum'
  | 'function'
  | 'interface'
  | 'type'
  | 'variable';
export type SourceTruthVariableDeclarationKind = 'const' | 'let' | 'var';
export type SourceTruthConfigFileKind = 'package-json' | 'tsconfig-json';
export type SourceTruthConfigLineRangeGranularity = 'field' | 'file';
export type SourceTruthContextFactKind = 'test-file' | 'example-file' | 'test-case';
export type SourceTruthContextLineRangeGranularity = 'file' | 'test-label';
export type SourceTruthTestCaseCall = 'describe' | 'it' | 'test';
export type SourceTruthTestCaseModifier = 'only' | 'skip';
export type SourceTruthConfigFactKind =
  | 'package-name'
  | 'package-version'
  | 'package-type'
  | 'package-manager'
  | 'package-bin-name'
  | 'package-export-key'
  | 'package-script-name'
  | 'package-dependency-name'
  | 'tsconfig-extends'
  | 'tsconfig-compiler-option'
  | 'tsconfig-array-count'
  | 'tsconfig-array-path';

export interface SourceTruthLineRange {
  start: number;
  end: number;
}

export interface SourceTruthProvenance {
  path: string;
  lineRange: SourceTruthLineRange;
}

export interface SourceTruthSignatureParameter {
  name: string;
  optional: boolean;
  rest: boolean;
  hasDefault: boolean;
  type?: string;
}

export interface SourceTruthSignatureVariable {
  name: string;
  type?: string;
}

export interface SourceTruthSignatureHeritage {
  extends?: string[];
  implements?: string[];
}

export interface SourceTruthSignatureEvidence {
  declarationKind: SourceTruthSignatureDeclarationKind;
  text: string;
  name?: string;
  parameters?: SourceTruthSignatureParameter[];
  returnType?: string;
  variableKind?: SourceTruthVariableDeclarationKind;
  variables?: SourceTruthSignatureVariable[];
  heritage?: SourceTruthSignatureHeritage;
  type?: string;
  memberCount?: number;
}

export interface SourceTruthFact {
  kind: SourceTruthFactKind;
  symbolKind: SourceTruthSymbolKind;
  name: string;
  exportedName: string;
  provenance: SourceTruthProvenance;
  order: number;
  moduleSpecifier?: string;
  signature?: SourceTruthSignatureEvidence;
}

export interface SourceTruthConfigFact {
  kind: SourceTruthConfigFactKind;
  configFileKind: SourceTruthConfigFileKind;
  fieldPath: string;
  name: string;
  value?: string | number;
  group?: string;
  provenance: SourceTruthProvenance;
  lineRangeGranularity: SourceTruthConfigLineRangeGranularity;
  order: number;
}

export interface SourceTruthBaseContextFact {
  kind: SourceTruthContextFactKind;
  path: string;
  provenance: SourceTruthProvenance;
  lineRangeGranularity: SourceTruthContextLineRangeGranularity;
  order: number;
}

export interface SourceTruthFileContextFact extends SourceTruthBaseContextFact {
  kind: 'test-file' | 'example-file';
  evidenceSignals: string[];
  byteSize: number;
  sha256: string;
  lineRangeGranularity: 'file';
}

export interface SourceTruthTestCaseContextFact extends SourceTruthBaseContextFact {
  kind: 'test-case';
  name: string;
  call: SourceTruthTestCaseCall;
  modifiers: SourceTruthTestCaseModifier[];
  lineRangeGranularity: 'test-label';
}

export type SourceTruthContextFact = SourceTruthFileContextFact | SourceTruthTestCaseContextFact;

export interface SourceTruthParseDiagnostic {
  code: number;
  category: string;
  message: string;
  lineRange?: SourceTruthLineRange;
}

export interface SourceTruthFileEvidence {
  path: string;
  resolvedPath: string;
  status: SourceTruthFileStatus;
  byteSize: number;
  sha256?: string;
  supported: boolean;
  facts: SourceTruthFact[];
  configFacts: SourceTruthConfigFact[];
  contextFacts: SourceTruthContextFact[];
  parseDiagnostics?: SourceTruthParseDiagnostic[];
  skipReason?: SourceTruthSkipReason;
}

export interface SourceTruthTraversalSettings {
  followSymlinks: false;
  maxDepth: number;
  maxEntries: number;
  maxFiles: number;
  maxFileBytes: number;
  skippedDirectoryNames: string[];
  visitedEntries: number;
  visitedFiles: number;
  inspectedFiles: number;
  skippedFiles: number;
  truncated: boolean;
}

export interface SourceTruthInspectionReport {
  schemaVersion: typeof SOURCE_TRUTH_REPORT_SCHEMA_VERSION;
  mode: typeof SOURCE_TRUTH_INSPECTION_MODE;
  source: {
    input: string;
    resolvedPath: string;
    type: SourceTruthSourceType;
  };
  traversal: SourceTruthTraversalSettings;
  files: SourceTruthFileEvidence[];
  facts: SourceTruthFact[];
  configFacts: SourceTruthConfigFact[];
  contextFacts: SourceTruthContextFact[];
  warnings: string[];
}

export interface InspectSourceTruthOptions {
  source: string;
  maxDepth?: number;
  maxEntries?: number;
  maxFiles?: number;
  maxFileBytes?: number;
}

interface MutableTraversalState {
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

export async function inspectSourceTruth(
  options: InspectSourceTruthOptions
): Promise<SourceTruthInspectionReport> {
  validateSourceInput(options.source);

  const resolvedSourcePath = resolve(options.source);
  const sourceStats = await statSource(resolvedSourcePath);
  const sourceType: SourceTruthSourceType = sourceStats.isDirectory() ? 'directory' : 'file';
  const maxDepth = resolveTraversalBound(
    options.maxDepth,
    DEFAULT_SOURCE_TRUTH_MAX_DEPTH,
    'maxDepth',
    true
  );
  const maxEntries = resolveTraversalBound(
    options.maxEntries,
    DEFAULT_SOURCE_TRUTH_MAX_ENTRIES,
    'maxEntries',
    false
  );
  const maxFiles = resolveTraversalBound(
    options.maxFiles,
    DEFAULT_SOURCE_TRUTH_MAX_FILES,
    'maxFiles',
    false
  );
  const maxFileBytes = resolveTraversalBound(
    options.maxFileBytes,
    DEFAULT_SOURCE_TRUTH_MAX_FILE_BYTES,
    'maxFileBytes',
    false
  );
  const files: SourceTruthFileEvidence[] = [];
  const warnings: string[] = [];
  const state: MutableTraversalState = {
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

  if (sourceType === 'file') {
    await inspectFile({
      absolutePath: resolvedSourcePath,
      relativePath: basename(resolvedSourcePath),
      stats: sourceStats,
      files,
      warnings,
      state,
      maxFiles,
      maxFileBytes,
    });
  } else {
    await traverseDirectory({
      rootPath: resolvedSourcePath,
      directoryPath: resolvedSourcePath,
      depth: 0,
      files,
      warnings,
      state,
      maxDepth,
      maxEntries,
      maxFiles,
      maxFileBytes,
    });
  }

  sortFilesForReport(files);
  const facts = files.flatMap((file) => file.facts);
  facts.forEach((fact, index) => {
    fact.order = index + 1;
  });
  const configFacts = files.flatMap((file) => file.configFacts);
  configFacts.forEach((fact, index) => {
    fact.order = index + 1;
  });
  const contextFacts = files.flatMap((file) => file.contextFacts);
  contextFacts.forEach((fact, index) => {
    fact.order = index + 1;
  });

  return {
    schemaVersion: SOURCE_TRUTH_REPORT_SCHEMA_VERSION,
    mode: SOURCE_TRUTH_INSPECTION_MODE,
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
      maxFileBytes,
      skippedDirectoryNames: [...SKIPPED_DIRECTORY_NAMES],
      visitedEntries: state.visitedEntries,
      visitedFiles: state.visitedFiles,
      inspectedFiles: state.inspectedFiles,
      skippedFiles: state.skippedFiles,
      truncated: state.truncated || state.depthLimited,
    },
    files,
    facts,
    configFacts,
    contextFacts,
    warnings,
  };
}

function validateSourceInput(source: string): void {
  if (source.trim() === '') {
    throw new Error('Source path is required.');
  }

  if (URL_LIKE_SOURCE_PATTERNS.some((pattern) => pattern.test(source.trim()))) {
    throw new Error(
      'source-truth --source accepts local file or directory paths only; URL-like and git inputs are not supported'
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

    await assertNoParentSymlinkComponents(sourcePath);

    return sourceStats;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Source path must')) {
      throw error;
    }

    throw new Error(`source path not found or cannot be read: ${sourcePath}`);
  }
}

async function assertNoParentSymlinkComponents(sourcePath: string): Promise<void> {
  const parsedPath = parse(sourcePath);
  const parts = sourcePath.slice(parsedPath.root.length).split(sep).filter(Boolean);
  let currentPath = parsedPath.root;

  for (let index = 0; index < parts.length - 1; index++) {
    currentPath = join(currentPath, parts[index] as string);

    const componentStats = await lstat(currentPath);

    if (componentStats.isSymbolicLink()) {
      throw new Error(`Source path must not contain a symbolic link component: ${currentPath}`);
    }
  }
}

async function traverseDirectory(options: {
  rootPath: string;
  directoryPath: string;
  depth: number;
  files: SourceTruthFileEvidence[];
  warnings: string[];
  state: MutableTraversalState;
  maxDepth: number;
  maxEntries: number;
  maxFiles: number;
  maxFileBytes: number;
}): Promise<void> {
  const {
    rootPath,
    directoryPath,
    depth,
    files,
    warnings,
    state,
    maxDepth,
    maxEntries,
    maxFiles,
    maxFileBytes,
  } = options;

  if (state.truncated) {
    return;
  }

  const directoryEntries = await readDirectoryEntries({
    rootPath,
    directoryPath,
    warnings,
    state,
    maxEntries,
  });

  if (directoryEntries === undefined) {
    return;
  }

  for (const entry of directoryEntries.entries) {
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
        // Prune only this over-deep subtree; keep traversing siblings.
        state.depthLimited = true;
        if (!state.emittedMaxDepthWarning) {
          warnings.push(`Traversal pruned subtrees at max depth ${maxDepth} (first: ${relativePath})`);
          state.emittedMaxDepthWarning = true;
        }
        continue;
      }

      await traverseDirectory({
        rootPath,
        directoryPath: entryPath,
        depth: depth + 1,
        files,
        warnings,
        state,
        maxDepth,
        maxEntries,
        maxFiles,
        maxFileBytes,
      });
      continue;
    }

    if (entry.isFile()) {
      let stats: Stats;
      try {
        stats = await lstat(entryPath);
      } catch {
        // A file that became unreadable between readdir and lstat must not abort
        // the whole inspection; record it and continue.
        warnings.push(`Skipped unreadable file: ${normalizePathForReport(relativePath)}`);
        continue;
      }
      await inspectFile({
        absolutePath: entryPath,
        relativePath,
        stats,
        files,
        warnings,
        state,
        maxFiles,
        maxFileBytes,
      });
    }
  }

  if (directoryEntries.reachedLimit) {
    state.truncated = true;
  }
}

async function inspectFile(options: {
  absolutePath: string;
  relativePath: string;
  stats: Stats;
  files: SourceTruthFileEvidence[];
  warnings: string[];
  state: MutableTraversalState;
  maxFiles: number;
  maxFileBytes: number;
}): Promise<void> {
  const { absolutePath, relativePath, stats, files, warnings, state, maxFiles, maxFileBytes } =
    options;
  const pathForReport = normalizePathForReport(relativePath);

  if (state.visitedFiles >= maxFiles) {
    state.truncated = true;

    if (!state.emittedMaxFileWarning) {
      warnings.push(`Traversal maxFiles reached: ${maxFiles}`);
      state.emittedMaxFileWarning = true;
    }

    return;
  }

  state.visitedFiles++;

  if (!isSupportedInspectableFile(pathForReport)) {
    state.skippedFiles++;
    warnings.push(`Skipped unsupported file: ${pathForReport}`);
    files.push({
      path: pathForReport,
      resolvedPath: absolutePath,
      status: 'skipped',
      byteSize: stats.size,
      supported: false,
      facts: [],
      configFacts: [],
      contextFacts: [],
      skipReason: 'unsupported-extension',
    });
    return;
  }

  if (stats.size > maxFileBytes) {
    state.skippedFiles++;
    warnings.push(`Skipped oversized file: ${pathForReport} (${stats.size} bytes)`);
    files.push({
      path: pathForReport,
      resolvedPath: absolutePath,
      status: 'skipped',
      byteSize: stats.size,
      supported: true,
      facts: [],
      configFacts: [],
      contextFacts: [],
      skipReason: 'oversized',
    });
    return;
  }

  try {
    const contentBytes = await readFile(absolutePath);
    const content = contentBytes.toString('utf-8');
    const sha256 = sha256Hex(contentBytes);
    const extraction = isSupportedSourceFile(pathForReport)
      ? extractTypeScriptJavaScriptFacts(pathForReport, content)
      : { facts: [], parseDiagnostics: [] };
    const configExtraction = extractPackageConfigFacts(pathForReport, content);
    const contextFacts = extractSourceContextFacts({
      path: pathForReport,
      byteSize: stats.size,
      sha256,
      content,
    });
    const fileEvidence: SourceTruthFileEvidence = {
      path: pathForReport,
      resolvedPath: absolutePath,
      status: 'inspected',
      byteSize: stats.size,
      sha256,
      supported: true,
      facts: extraction.facts,
      configFacts: configExtraction.facts,
      contextFacts,
    };

    if (extraction.parseDiagnostics.length > 0) {
      fileEvidence.parseDiagnostics = extraction.parseDiagnostics;
      warnings.push(
        `Syntax diagnostics in file: ${pathForReport} (${extraction.parseDiagnostics.length})`
      );
    }

    for (const warning of configExtraction.warnings) {
      warnings.push(warning);
    }

    state.inspectedFiles++;
    files.push(fileEvidence);
  } catch {
    state.skippedFiles++;
    warnings.push(`Skipped unreadable file: ${pathForReport}`);
    files.push({
      path: pathForReport,
      resolvedPath: absolutePath,
      status: 'skipped',
      byteSize: stats.size,
      supported: true,
      facts: [],
      configFacts: [],
      contextFacts: [],
      skipReason: 'unreadable',
    });
  }
}

async function readDirectoryEntries(options: {
  rootPath: string;
  directoryPath: string;
  warnings: string[];
  state: MutableTraversalState;
  maxEntries: number;
}): Promise<DirectoryEntriesResult | undefined> {
  const { rootPath, directoryPath, warnings, state, maxEntries } = options;
  const remainingEntries = maxEntries - state.visitedEntries;
  const entries: Dirent[] = [];

  if (remainingEntries <= 0) {
    emitMaxEntryWarning(warnings, state, maxEntries);

    return { entries, reachedLimit: true };
  }

  try {
    const directory = await opendir(directoryPath);

    try {
      for await (const entry of directory) {
        entries.push(entry);

        if (entries.length > remainingEntries) {
          emitMaxEntryWarning(warnings, state, maxEntries);
          return { entries: [], reachedLimit: true };
        }
      }
    } catch {
      warnings.push(`Skipped unreadable directory: ${toRelativePath(rootPath, directoryPath)}`);
      return undefined;
    }
  } catch {
    warnings.push(`Skipped unreadable directory: ${toRelativePath(rootPath, directoryPath)}`);
    return undefined;
  }

  entries.sort((a, b) => compareStringsByCodeUnit(a.name, b.name));
  state.visitedEntries += entries.length;

  return { entries, reachedLimit: false };
}

function emitMaxEntryWarning(
  warnings: string[],
  state: MutableTraversalState,
  maxEntries: number
): void {
  if (state.emittedMaxEntryWarning) {
    return;
  }

  warnings.push(`Traversal maxEntries reached: ${maxEntries}`);
  state.emittedMaxEntryWarning = true;
}

function extractTypeScriptJavaScriptFacts(
  path: string,
  content: string
): {
  facts: SourceTruthFact[];
  parseDiagnostics: SourceTruthParseDiagnostic[];
} {
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(path)
  );
  const facts: SourceTruthFact[] = [];
  const sourceFileWithDiagnostics = sourceFile as ts.SourceFile & {
    parseDiagnostics?: readonly ts.Diagnostic[];
  };
  const parseDiagnostics = (sourceFileWithDiagnostics.parseDiagnostics ?? []).map(
    (diagnostic: ts.Diagnostic) => buildParseDiagnostic(sourceFile, diagnostic)
  );

  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      if (!hasExportModifier(statement)) {
        continue;
      }

      for (const declaration of statement.declarationList.declarations) {
        const name = bindingNameToText(declaration.name, sourceFile);

        facts.push(
          buildFact({
            kind: 'exported-symbol',
            symbolKind: 'value',
            name,
            exportedName: hasDefaultModifier(statement) ? 'default' : name,
            sourceFile,
            node: declaration,
            signature: buildVariableSignature(statement, declaration, sourceFile),
          })
        );
      }

      continue;
    }

    if (ts.isFunctionDeclaration(statement)) {
      if (!hasExportModifier(statement)) {
        continue;
      }

      const name = statement.name?.text ?? 'default';
      facts.push(
        buildFact({
          kind: 'exported-symbol',
          symbolKind: 'function',
          name,
          exportedName: hasDefaultModifier(statement) ? 'default' : name,
          sourceFile,
          node: statement,
          signature: buildFunctionSignature(statement, sourceFile),
        })
      );
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      if (!hasExportModifier(statement)) {
        continue;
      }

      const name = statement.name?.text ?? 'default';
      facts.push(
        buildFact({
          kind: 'exported-symbol',
          symbolKind: 'class',
          name,
          exportedName: hasDefaultModifier(statement) ? 'default' : name,
          sourceFile,
          node: statement,
          signature: buildClassSignature(statement, sourceFile),
        })
      );
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      if (!hasExportModifier(statement)) {
        continue;
      }

      facts.push(
        buildFact({
          kind: 'exported-symbol',
          symbolKind: 'interface',
          name: statement.name.text,
          exportedName: statement.name.text,
          sourceFile,
          node: statement,
          signature: buildInterfaceSignature(statement, sourceFile),
        })
      );
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      if (!hasExportModifier(statement)) {
        continue;
      }

      facts.push(
        buildFact({
          kind: 'exported-symbol',
          symbolKind: 'type',
          name: statement.name.text,
          exportedName: statement.name.text,
          sourceFile,
          node: statement,
          signature: buildTypeAliasSignature(statement, sourceFile),
        })
      );
      continue;
    }

    if (ts.isEnumDeclaration(statement)) {
      if (!hasExportModifier(statement)) {
        continue;
      }

      facts.push(
        buildFact({
          kind: 'exported-symbol',
          symbolKind: 'enum',
          name: statement.name.text,
          exportedName: statement.name.text,
          sourceFile,
          node: statement,
          signature: buildEnumSignature(statement),
        })
      );
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      const moduleSpecifier = stringLiteralText(statement.moduleSpecifier);

      if (statement.exportClause === undefined) {
        facts.push(
          buildFact({
            kind: 'export-all',
            symbolKind: 'unknown',
            name: '*',
            exportedName: '*',
            sourceFile,
            node: statement,
            moduleSpecifier,
          })
        );
        continue;
      }

      if (!ts.isNamedExports(statement.exportClause)) {
        continue;
      }

      for (const element of statement.exportClause.elements) {
        const name = element.propertyName?.text ?? element.name.text;
        const exportedName = element.name.text;
        facts.push(
          buildFact({
            kind: 're-exported-symbol',
            symbolKind: 'unknown',
            name,
            exportedName,
            sourceFile,
            node: element,
            moduleSpecifier,
          })
        );
      }

      continue;
    }

    if (ts.isExportAssignment(statement)) {
      facts.push(
        buildFact({
          kind: 'export-assignment',
          symbolKind: 'unknown',
          name: statement.isExportEquals === true ? 'export=' : 'default',
          exportedName: statement.isExportEquals === true ? 'export=' : 'default',
          sourceFile,
          node: statement,
        })
      );
    }
  }

  return { facts, parseDiagnostics };
}

function extractPackageConfigFacts(
  path: string,
  content: string
): {
  facts: SourceTruthConfigFact[];
  warnings: string[];
} {
  if (isPackageJsonFile(path)) {
    return extractPackageJsonFacts(path, content);
  }

  if (isTsConfigJsonFile(path)) {
    return extractTsConfigJsonFacts(path, content);
  }

  return { facts: [], warnings: [] };
}

function extractSourceContextFacts(options: {
  path: string;
  byteSize: number;
  sha256: string;
  content: string;
}): SourceTruthContextFact[] {
  const pathContextFacts = extractPathContextFacts(options);
  const isTestFile = pathContextFacts.some((fact) => fact.kind === 'test-file');

  if (!isTestFile || !isSupportedSourceFile(options.path)) {
    return pathContextFacts;
  }

  return [...pathContextFacts, ...extractTestCaseContextFacts(options.path, options.content)];
}

function extractPathContextFacts(options: {
  path: string;
  byteSize: number;
  sha256: string;
  content: string;
}): SourceTruthFileContextFact[] {
  const testSignals = contextTestEvidenceSignals(options.path);
  const exampleSignals = contextExampleEvidenceSignals(options.path);
  const kind: SourceTruthContextFactKind | undefined =
    testSignals.length > 0 ? 'test-file' : exampleSignals.length > 0 ? 'example-file' : undefined;

  if (kind === undefined) {
    return [];
  }

  const evidenceSignals =
    kind === 'test-file' ? [...testSignals, ...exampleSignals] : exampleSignals;

  return [
    {
      kind,
      path: options.path,
      evidenceSignals,
      byteSize: options.byteSize,
      sha256: options.sha256,
      provenance: {
        path: options.path,
        lineRange: lineRangeForSpan(buildLineStarts(options.content), 0, options.content.length),
      },
      lineRangeGranularity: 'file',
      order: 0,
    },
  ];
}

function extractTestCaseContextFacts(
  path: string,
  content: string
): SourceTruthTestCaseContextFact[] {
  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(path)
  );
  const facts: SourceTruthTestCaseContextFact[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const invocation = testCaseInvocationForExpression(node.expression);
      const name = stringLiteralLikeText(node.arguments[0]);

      if (invocation !== undefined && name !== undefined) {
        facts.push(
          buildTestCaseContextFact({
            path,
            sourceFile,
            labelNode: node.arguments[0] as ts.Expression,
            name,
            call: invocation.call,
            modifiers: invocation.modifiers,
          })
        );
      }
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);

  return facts;
}

function testCaseInvocationForExpression(expression: ts.Expression):
  | {
      call: SourceTruthTestCaseCall;
      modifiers: SourceTruthTestCaseModifier[];
    }
  | undefined {
  if (ts.isIdentifier(expression) && isSourceTruthTestCaseCall(expression.text)) {
    return {
      call: expression.text,
      modifiers: [],
    };
  }

  if (!ts.isPropertyAccessExpression(expression)) {
    return undefined;
  }

  const modifier = expression.name.text;

  if (!isSourceTruthTestCaseModifier(modifier)) {
    return undefined;
  }

  if (
    !ts.isIdentifier(expression.expression) ||
    !isSourceTruthTestCaseCall(expression.expression.text)
  ) {
    return undefined;
  }

  return {
    call: expression.expression.text,
    modifiers: [modifier],
  };
}

function isSourceTruthTestCaseCall(value: string): value is SourceTruthTestCaseCall {
  return value === 'describe' || value === 'it' || value === 'test';
}

function isSourceTruthTestCaseModifier(value: string): value is SourceTruthTestCaseModifier {
  return value === 'only' || value === 'skip';
}

function stringLiteralLikeText(node: ts.Node | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }

  return undefined;
}

function buildTestCaseContextFact(options: {
  path: string;
  sourceFile: ts.SourceFile;
  labelNode: ts.Expression;
  name: string;
  call: SourceTruthTestCaseCall;
  modifiers: SourceTruthTestCaseModifier[];
}): SourceTruthTestCaseContextFact {
  const start = options.sourceFile.getLineAndCharacterOfPosition(
    options.labelNode.getStart(options.sourceFile)
  );
  const end = options.sourceFile.getLineAndCharacterOfPosition(options.labelNode.getEnd());

  return {
    kind: 'test-case',
    path: options.path,
    name: options.name,
    call: options.call,
    modifiers: [...options.modifiers],
    provenance: {
      path: options.path,
      lineRange: {
        start: start.line + 1,
        end: end.line + 1,
      },
    },
    lineRangeGranularity: 'test-label',
    order: 0,
  };
}

function contextTestEvidenceSignals(path: string): string[] {
  const normalizedPath = path.toLowerCase();
  const segments = normalizedPath.split('/');
  const filename = segments[segments.length - 1] ?? normalizedPath;
  const signals: string[] = [];

  if (filename.includes('.test.')) {
    signals.push('filename-pattern:*.test.*');
  }

  if (filename.includes('.spec.')) {
    signals.push('filename-pattern:*.spec.*');
  }

  for (const segment of TEST_CONTEXT_PATH_SEGMENTS) {
    if (segments.includes(segment)) {
      signals.push(`path-segment:${segment}`);
    }
  }

  return signals;
}

function contextExampleEvidenceSignals(path: string): string[] {
  const segments = path.toLowerCase().split('/');
  const signals: string[] = [];

  for (const segment of EXAMPLE_CONTEXT_PATH_SEGMENTS) {
    if (segments.includes(segment)) {
      signals.push(`path-segment:${segment}`);
    }
  }

  if (hasAdjacentPathSegments(segments, 'docs', 'examples')) {
    signals.push('path-segment:docs/examples');
  }

  return signals;
}

function hasAdjacentPathSegments(segments: string[], first: string, second: string): boolean {
  for (let index = 0; index < segments.length - 1; index++) {
    if (segments[index] === first && segments[index + 1] === second) {
      return true;
    }
  }

  return false;
}

function extractPackageJsonFacts(
  path: string,
  content: string
): {
  facts: SourceTruthConfigFact[];
  warnings: string[];
} {
  const parsed = parseStrictJsonObject(content);

  if (parsed === undefined) {
    return {
      facts: [],
      warnings: [`Could not parse package config evidence in file: ${path}`],
    };
  }

  const facts: SourceTruthConfigFact[] = [];
  const locator = createJsonLocator(content);

  addStringFieldFact(facts, {
    kind: 'package-name',
    configFileKind: 'package-json',
    locator,
    sourcePath: path,
    object: parsed,
    fieldPath: ['name'],
    name: 'name',
  });
  addStringFieldFact(facts, {
    kind: 'package-version',
    configFileKind: 'package-json',
    locator,
    sourcePath: path,
    object: parsed,
    fieldPath: ['version'],
    name: 'version',
  });
  addStringFieldFact(facts, {
    kind: 'package-type',
    configFileKind: 'package-json',
    locator,
    sourcePath: path,
    object: parsed,
    fieldPath: ['type'],
    name: 'type',
  });
  addStringFieldFact(facts, {
    kind: 'package-manager',
    configFileKind: 'package-json',
    locator,
    sourcePath: path,
    object: parsed,
    fieldPath: ['packageManager'],
    name: 'packageManager',
  });

  const binValue = parsed.bin;

  if (isRecord(binValue)) {
    for (const binName of sortedKeys(binValue)) {
      facts.push(
        buildConfigFact({
          kind: 'package-bin-name',
          configFileKind: 'package-json',
          fieldPath: ['bin', binName],
          name: binName,
          locator,
          sourcePath: path,
        })
      );
    }
  }

  if (isRecord(parsed.exports)) {
    for (const exportKey of sortedKeys(parsed.exports)) {
      facts.push(
        buildConfigFact({
          kind: 'package-export-key',
          configFileKind: 'package-json',
          fieldPath: ['exports', exportKey],
          name: exportKey,
          locator,
          sourcePath: path,
        })
      );
    }
  }

  if (isRecord(parsed.scripts)) {
    for (const scriptName of sortedKeys(parsed.scripts)) {
      facts.push(
        buildConfigFact({
          kind: 'package-script-name',
          configFileKind: 'package-json',
          fieldPath: ['scripts', scriptName],
          name: scriptName,
          locator,
          sourcePath: path,
        })
      );
    }
  }

  for (const dependencyField of PACKAGE_DEPENDENCY_FIELDS) {
    const dependencyValue = parsed[dependencyField];

    if (isRecord(dependencyValue)) {
      for (const dependencyName of sortedKeys(dependencyValue)) {
        facts.push(
          buildConfigFact({
            kind: 'package-dependency-name',
            configFileKind: 'package-json',
            fieldPath: [dependencyField, dependencyName],
            name: dependencyName,
            group: dependencyField,
            locator,
            sourcePath: path,
          })
        );
      }
    } else if (Array.isArray(dependencyValue)) {
      dependencyValue.forEach((dependencyName, index) => {
        if (typeof dependencyName === 'string') {
          facts.push(
            buildConfigFact({
              kind: 'package-dependency-name',
              configFileKind: 'package-json',
              fieldPath: [dependencyField],
              name: dependencyName,
              group: dependencyField,
              value: dependencyName,
              arrayStringIndex: index,
              locator,
              sourcePath: path,
            })
          );
        }
      });
    }
  }

  return { facts, warnings: [] };
}

function extractTsConfigJsonFacts(
  path: string,
  content: string
): {
  facts: SourceTruthConfigFact[];
  warnings: string[];
} {
  const parsed = ts.parseConfigFileTextToJson(path, content);

  if (parsed.error !== undefined || !isRecord(parsed.config)) {
    return {
      facts: [],
      warnings: [`Could not parse tsconfig evidence in file: ${path}`],
    };
  }

  const config = parsed.config;
  const facts: SourceTruthConfigFact[] = [];
  const locator = createJsonLocator(content);

  addStringFieldFact(facts, {
    kind: 'tsconfig-extends',
    configFileKind: 'tsconfig-json',
    locator,
    sourcePath: path,
    object: config,
    fieldPath: ['extends'],
    name: 'extends',
  });

  if (isRecord(config.compilerOptions)) {
    for (const compilerOptionKey of sortedKeys(config.compilerOptions)) {
      facts.push(
        buildConfigFact({
          kind: 'tsconfig-compiler-option',
          configFileKind: 'tsconfig-json',
          fieldPath: ['compilerOptions', compilerOptionKey],
          name: compilerOptionKey,
          locator,
          sourcePath: path,
        })
      );
    }
  }

  for (const arrayField of TSCONFIG_ARRAY_FIELDS) {
    const value = config[arrayField];

    if (!Array.isArray(value)) {
      continue;
    }

    facts.push(
      buildConfigFact({
        kind: 'tsconfig-array-count',
        configFileKind: 'tsconfig-json',
        fieldPath: [arrayField],
        name: arrayField,
        value: value.length,
        group: arrayField,
        locator,
        sourcePath: path,
      })
    );

    value.forEach((item, index) => {
      if (typeof item === 'string') {
        facts.push(
          buildConfigFact({
            kind: 'tsconfig-array-path',
            configFileKind: 'tsconfig-json',
            fieldPath: [arrayField],
            name: item,
            value: item,
            group: arrayField,
            arrayStringIndex: index,
            locator,
            sourcePath: path,
          })
        );
      }
    });
  }

  return { facts, warnings: [] };
}

function addStringFieldFact(
  facts: SourceTruthConfigFact[],
  options: {
    kind: SourceTruthConfigFactKind;
    configFileKind: SourceTruthConfigFileKind;
    locator: JsonLocator;
    sourcePath: string;
    object: Record<string, unknown>;
    fieldPath: string[];
    name: string;
  }
): void {
  const value = valueAtPath(options.object, options.fieldPath);

  if (typeof value !== 'string') {
    return;
  }

  facts.push(
    buildConfigFact({
      kind: options.kind,
      configFileKind: options.configFileKind,
      fieldPath: options.fieldPath,
      name: options.name,
      value,
      locator: options.locator,
      sourcePath: options.sourcePath,
    })
  );
}

function buildConfigFact(options: {
  kind: SourceTruthConfigFactKind;
  configFileKind: SourceTruthConfigFileKind;
  fieldPath: string[];
  name: string;
  locator: JsonLocator;
  sourcePath: string;
  value?: string | number;
  group?: string;
  arrayStringIndex?: number;
}): SourceTruthConfigFact {
  const propertyLineRange =
    options.arrayStringIndex === undefined
      ? options.locator.findPropertyLineRange(options.fieldPath)
      : options.locator.findArrayStringLineRange(
          options.fieldPath,
          options.name,
          options.arrayStringIndex
        );
  const lineRange = propertyLineRange ?? options.locator.fileLineRange;
  const fact: SourceTruthConfigFact = {
    kind: options.kind,
    configFileKind: options.configFileKind,
    fieldPath: formatJsonFieldPath(options.fieldPath),
    name: options.name,
    provenance: {
      path: options.sourcePath,
      lineRange,
    },
    lineRangeGranularity: propertyLineRange === undefined ? 'file' : 'field',
    order: 0,
  };

  if (options.value !== undefined) {
    fact.value = options.value;
  }

  if (options.group !== undefined) {
    fact.group = options.group;
  }

  return fact;
}

function parseStrictJsonObject(content: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;

    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function valueAtPath(object: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = object;

  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort(compareStringsByCodeUnit);
}

function formatJsonFieldPath(path: string[]): string {
  return path
    .map((segment, index) => {
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
        return index === 0 ? segment : `.${segment}`;
      }

      return `[${JSON.stringify(segment)}]`;
    })
    .join('');
}

type JsonTokenKind = '{' | '}' | '[' | ']' | ':' | ',' | 'string' | 'primitive';

interface JsonToken {
  kind: JsonTokenKind;
  start: number;
  end: number;
  value?: string;
}

interface JsonLocator {
  readonly fileLineRange: SourceTruthLineRange;
  findPropertyLineRange(propertyPath: string[]): SourceTruthLineRange | undefined;
  findArrayStringLineRange(
    propertyPath: string[],
    value: string,
    arrayStringIndex: number
  ): SourceTruthLineRange | undefined;
}

function createJsonLocator(content: string): JsonLocator {
  const tokens = tokenizeJsonLike(content);
  const lineStarts = buildLineStarts(content);
  const fileLineRange = lineRangeForSpan(lineStarts, 0, content.length);

  return {
    fileLineRange,
    findPropertyLineRange(propertyPath: string[]): SourceTruthLineRange | undefined {
      const tokenMatch = findJsonPropertyToken(tokens, propertyPath);

      return tokenMatch === undefined
        ? undefined
        : lineRangeForSpan(lineStarts, tokenMatch.propertyStart, tokenMatch.valueEnd);
    },
    findArrayStringLineRange(
      propertyPath: string[],
      value: string,
      arrayStringIndex: number
    ): SourceTruthLineRange | undefined {
      const tokenMatch = findJsonPropertyToken(tokens, propertyPath);

      if (tokenMatch === undefined || tokenMatch.valueToken.kind !== '[') {
        return undefined;
      }

      let arrayValueIndex = 0;

      for (let index = tokenMatch.valueTokenIndex + 1; index < tokens.length; ) {
        const token = tokens[index] as JsonToken;

        if (token.kind === ',') {
          index++;
          continue;
        }

        if (token.kind === ']') {
          return undefined;
        }

        if (arrayValueIndex === arrayStringIndex) {
          if (token.kind === 'string' && token.value === value) {
            return lineRangeForSpan(lineStarts, token.start, token.end);
          }

          return undefined;
        }

        index = skipJsonValue(tokens, index) + 1;
        arrayValueIndex++;
      }

      return undefined;
    },
  };
}

function findJsonPropertyToken(
  tokens: JsonToken[],
  propertyPath: string[]
):
  | {
      propertyStart: number;
      valueEnd: number;
      valueToken: JsonToken;
      valueTokenIndex: number;
    }
  | undefined {
  const rootIndex = tokens.findIndex((token) => token.kind === '{');

  if (rootIndex === -1) {
    return undefined;
  }

  return findPropertyInObject(tokens, rootIndex + 1, propertyPath, 0);
}

function findPropertyInObject(
  tokens: JsonToken[],
  startIndex: number,
  propertyPath: string[],
  pathIndex: number
):
  | {
      propertyStart: number;
      valueEnd: number;
      valueToken: JsonToken;
      valueTokenIndex: number;
    }
  | undefined {
  let index = startIndex;
  let lastMatch:
    | {
        propertyStart: number;
        valueEnd: number;
        valueToken: JsonToken;
        valueTokenIndex: number;
      }
    | undefined;

  while (index < tokens.length) {
    const token = tokens[index] as JsonToken;

    if (token.kind === '}') {
      return lastMatch;
    }

    if (token.kind !== 'string') {
      index++;
      continue;
    }

    const colonIndex = nextNonCommaTokenIndex(tokens, index + 1);

    if (colonIndex === undefined || tokens[colonIndex]?.kind !== ':') {
      index++;
      continue;
    }

    const valueTokenIndex = nextTokenIndex(tokens, colonIndex + 1);

    if (valueTokenIndex === undefined) {
      return undefined;
    }

    const valueToken = tokens[valueTokenIndex] as JsonToken;
    const valueEndIndex = skipJsonValue(tokens, valueTokenIndex);
    const valueEnd = tokens[valueEndIndex]?.end ?? valueToken.end;

    if (token.value === propertyPath[pathIndex]) {
      if (pathIndex === propertyPath.length - 1) {
        lastMatch = {
          propertyStart: token.start,
          valueEnd,
          valueToken,
          valueTokenIndex,
        };
      } else if (valueToken.kind === '{') {
        const nestedMatch = findPropertyInObject(
          tokens,
          valueTokenIndex + 1,
          propertyPath,
          pathIndex + 1
        );

        if (nestedMatch !== undefined) {
          lastMatch = nestedMatch;
        }
      } else {
        lastMatch = undefined;
      }
    }

    index = valueEndIndex + 1;
  }

  return lastMatch;
}

function skipJsonValue(tokens: JsonToken[], valueTokenIndex: number): number {
  const firstToken = tokens[valueTokenIndex] as JsonToken;

  if (firstToken.kind !== '{' && firstToken.kind !== '[') {
    return valueTokenIndex;
  }

  const openKind = firstToken.kind;
  const closeKind = openKind === '{' ? '}' : ']';
  let depth = 0;

  for (let index = valueTokenIndex; index < tokens.length; index++) {
    const token = tokens[index] as JsonToken;

    if (token.kind === openKind) {
      depth++;
      continue;
    }

    if (token.kind === closeKind) {
      depth--;

      if (depth === 0) {
        return index;
      }
    }
  }

  return valueTokenIndex;
}

function nextTokenIndex(tokens: JsonToken[], startIndex: number): number | undefined {
  return startIndex < tokens.length ? startIndex : undefined;
}

function nextNonCommaTokenIndex(tokens: JsonToken[], startIndex: number): number | undefined {
  for (let index = startIndex; index < tokens.length; index++) {
    if (tokens[index]?.kind !== ',') {
      return index;
    }
  }

  return undefined;
}

function tokenizeJsonLike(content: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let index = 0;

  while (index < content.length) {
    const char = content[index] as string;
    const nextChar = content[index + 1];

    if (/\s/.test(char)) {
      index++;
      continue;
    }

    if (char === '/' && nextChar === '/') {
      index += 2;

      while (index < content.length && content[index] !== '\n') {
        index++;
      }

      continue;
    }

    if (char === '/' && nextChar === '*') {
      index += 2;

      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) {
        index++;
      }

      index += 2;
      continue;
    }

    if (char === '"') {
      const stringToken = readJsonStringToken(content, index);
      tokens.push(stringToken);
      index = stringToken.end;
      continue;
    }

    if (
      char === '{' ||
      char === '}' ||
      char === '[' ||
      char === ']' ||
      char === ':' ||
      char === ','
    ) {
      tokens.push({ kind: char, start: index, end: index + 1 });
      index++;
      continue;
    }

    const primitiveToken = readJsonPrimitiveToken(content, index);

    if (primitiveToken !== undefined) {
      tokens.push(primitiveToken);
      index = primitiveToken.end;
      continue;
    }

    index++;
  }

  return tokens;
}

function readJsonStringToken(content: string, start: number): JsonToken {
  let index = start + 1;
  let rawValue = '';

  while (index < content.length) {
    const char = content[index] as string;

    if (char === '\\') {
      rawValue += char;
      index++;

      if (index < content.length) {
        rawValue += content[index] as string;
        index++;
      }

      continue;
    }

    if (char === '"') {
      return {
        kind: 'string',
        start,
        end: index + 1,
        value: decodeJsonStringValue(rawValue),
      };
    }

    rawValue += char;
    index++;
  }

  return {
    kind: 'string',
    start,
    end: content.length,
    value: decodeJsonStringValue(rawValue),
  };
}

function readJsonPrimitiveToken(content: string, start: number): JsonToken | undefined {
  const remaining = content.slice(start);
  const literalMatch = /^(?:true|false|null)\b/.exec(remaining);

  if (literalMatch !== null) {
    const [literal] = literalMatch;

    return {
      kind: 'primitive',
      start,
      end: start + literal.length,
      value: literal,
    };
  }

  const numberMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remaining);

  if (numberMatch !== null) {
    const [literal] = numberMatch;

    return {
      kind: 'primitive',
      start,
      end: start + literal.length,
      value: literal,
    };
  }

  return undefined;
}

function decodeJsonStringValue(rawValue: string): string {
  try {
    return JSON.parse(`"${rawValue}"`) as string;
  } catch {
    return rawValue;
  }
}

function buildLineStarts(content: string): number[] {
  const lineStarts = [0];

  for (let index = 0; index < content.length; index++) {
    if (content[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

function lineRangeForSpan(lineStarts: number[], start: number, end: number): SourceTruthLineRange {
  return {
    start: lineNumberForOffset(lineStarts, start),
    end: lineNumberForOffset(lineStarts, Math.max(start, end - 1)),
  };
}

function lineNumberForOffset(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  let matchedIndex = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const lineStart = lineStarts[middle] as number;

    if (lineStart <= offset) {
      matchedIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return matchedIndex + 1;
}

function buildParseDiagnostic(
  sourceFile: ts.SourceFile,
  diagnostic: ts.Diagnostic
): SourceTruthParseDiagnostic {
  const parseDiagnostic: SourceTruthParseDiagnostic = {
    code: diagnostic.code,
    category: ts.DiagnosticCategory[diagnostic.category].toLowerCase(),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  };

  if (diagnostic.start !== undefined) {
    const start = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
    const end = sourceFile.getLineAndCharacterOfPosition(
      diagnostic.start + (diagnostic.length ?? 0)
    );

    parseDiagnostic.lineRange = {
      start: start.line + 1,
      end: end.line + 1,
    };
  }

  return parseDiagnostic;
}

function buildFunctionSignature(
  node: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile
): SourceTruthSignatureEvidence {
  const parameters = node.parameters.map((parameter) =>
    buildParameterSignature(parameter, sourceFile)
  );
  const returnType = node.type
    ? compactNodeText(node.type, sourceFile, MAX_SIGNATURE_DETAIL_TEXT_LENGTH)
    : undefined;
  const name = node.name?.text;
  const functionKeyword = node.asteriskToken ? 'function*' : 'function';
  const text = compactSignatureText(
    `${modifierPrefix(node, ['export', 'default', 'declare', 'async'])}${functionKeyword}${
      name ? ` ${name}` : ''
    }${typeParametersText(node.typeParameters, sourceFile)}(${node.parameters
      .map((parameter) => parameterText(parameter, sourceFile))
      .join(', ')})${returnType ? `: ${returnType}` : ''}`
  );
  const signature: SourceTruthSignatureEvidence = {
    declarationKind: 'function',
    text,
    parameters,
  };

  if (name !== undefined) {
    signature.name = name;
  }

  if (returnType !== undefined) {
    signature.returnType = returnType;
  }

  return signature;
}

function buildVariableSignature(
  statement: ts.VariableStatement,
  declaration: ts.VariableDeclaration,
  sourceFile: ts.SourceFile
): SourceTruthSignatureEvidence {
  const variableKind = variableDeclarationKind(statement.declarationList);
  const variable = buildVariableSignatureDetail(declaration, sourceFile);
  const text = compactSignatureText(
    `${modifierPrefix(statement, ['export', 'declare'])}${variableKind} ${variableText(
      declaration,
      sourceFile
    )}`
  );

  return {
    declarationKind: 'variable',
    text,
    variableKind,
    variables: [variable],
  };
}

function buildClassSignature(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile
): SourceTruthSignatureEvidence {
  const name = node.name?.text;
  const heritage = buildHeritageEvidence(node.heritageClauses, sourceFile);
  const signature: SourceTruthSignatureEvidence = {
    declarationKind: 'class',
    text: compactSignatureText(
      `${modifierPrefix(node, ['export', 'default', 'declare', 'abstract'])}class${
        name ? ` ${name}` : ''
      }${typeParametersText(node.typeParameters, sourceFile)}${heritageText(heritage)}`
    ),
    memberCount: node.members.length,
  };

  if (name !== undefined) {
    signature.name = name;
  }

  if (heritage !== undefined) {
    signature.heritage = heritage;
  }

  return signature;
}

function buildInterfaceSignature(
  node: ts.InterfaceDeclaration,
  sourceFile: ts.SourceFile
): SourceTruthSignatureEvidence {
  const heritage = buildHeritageEvidence(node.heritageClauses, sourceFile);
  const signature: SourceTruthSignatureEvidence = {
    declarationKind: 'interface',
    text: compactSignatureText(
      `${modifierPrefix(node, ['export', 'declare'])}interface ${
        node.name.text
      }${typeParametersText(node.typeParameters, sourceFile)}${heritageText(heritage)}`
    ),
    name: node.name.text,
    memberCount: node.members.length,
  };

  if (heritage !== undefined) {
    signature.heritage = heritage;
  }

  return signature;
}

function buildTypeAliasSignature(
  node: ts.TypeAliasDeclaration,
  sourceFile: ts.SourceFile
): SourceTruthSignatureEvidence {
  const typeText = compactNodeText(node.type, sourceFile, MAX_SIGNATURE_DETAIL_TEXT_LENGTH);
  const signature: SourceTruthSignatureEvidence = {
    declarationKind: 'type',
    text: compactSignatureText(
      `${modifierPrefix(node, ['export', 'declare'])}type ${
        node.name.text
      }${typeParametersText(node.typeParameters, sourceFile)} = ${typeText}`
    ),
    name: node.name.text,
    type: typeText,
  };

  if (ts.isTypeLiteralNode(node.type)) {
    signature.memberCount = node.type.members.length;
  }

  return signature;
}

function buildEnumSignature(node: ts.EnumDeclaration): SourceTruthSignatureEvidence {
  return {
    declarationKind: 'enum',
    text: compactSignatureText(
      `${modifierPrefix(node, ['export', 'declare', 'const'])}enum ${node.name.text}`
    ),
    name: node.name.text,
    memberCount: node.members.length,
  };
}

function buildParameterSignature(
  parameter: ts.ParameterDeclaration,
  sourceFile: ts.SourceFile
): SourceTruthSignatureParameter {
  const name = bindingNameToText(parameter.name, sourceFile);
  const type = parameter.type
    ? compactNodeText(parameter.type, sourceFile, MAX_SIGNATURE_DETAIL_TEXT_LENGTH)
    : undefined;
  const optional = parameter.questionToken !== undefined || parameter.initializer !== undefined;
  const rest = parameter.dotDotDotToken !== undefined;
  const hasDefault = parameter.initializer !== undefined || bindingNameHasDefault(parameter.name);

  if (type !== undefined) {
    return { name, type, optional, rest, hasDefault };
  }

  return { name, optional, rest, hasDefault };
}

function buildVariableSignatureDetail(
  declaration: ts.VariableDeclaration,
  sourceFile: ts.SourceFile
): SourceTruthSignatureVariable {
  const name = bindingNameToText(declaration.name, sourceFile);
  const type = declaration.type
    ? compactNodeText(declaration.type, sourceFile, MAX_SIGNATURE_DETAIL_TEXT_LENGTH)
    : undefined;

  if (type !== undefined) {
    return { name, type };
  }

  return { name };
}

function buildHeritageEvidence(
  clauses: readonly ts.HeritageClause[] | undefined,
  sourceFile: ts.SourceFile
): SourceTruthSignatureHeritage | undefined {
  if (clauses === undefined || clauses.length === 0) {
    return undefined;
  }

  const heritage: SourceTruthSignatureHeritage = {};

  for (const clause of clauses) {
    const types = clause.types.map((type) =>
      compactNodeText(type, sourceFile, MAX_SIGNATURE_DETAIL_TEXT_LENGTH)
    );

    if (types.length === 0) {
      continue;
    }

    if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
      heritage.extends = [...(heritage.extends ?? []), ...types];
    }

    if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
      heritage.implements = [...(heritage.implements ?? []), ...types];
    }
  }

  if (heritage.extends === undefined && heritage.implements === undefined) {
    return undefined;
  }

  return heritage;
}

function parameterText(parameter: ts.ParameterDeclaration, sourceFile: ts.SourceFile): string {
  const name = bindingNameToText(parameter.name, sourceFile);
  const type = parameter.type
    ? compactNodeText(parameter.type, sourceFile, MAX_SIGNATURE_DETAIL_TEXT_LENGTH)
    : undefined;
  const rest = parameter.dotDotDotToken ? '...' : '';
  const optional = parameter.questionToken ? '?' : '';

  return `${rest}${name}${optional}${type ? `: ${type}` : ''}`;
}

function variableText(declaration: ts.VariableDeclaration, sourceFile: ts.SourceFile): string {
  const name = bindingNameToText(declaration.name, sourceFile);
  const type = declaration.type
    ? compactNodeText(declaration.type, sourceFile, MAX_SIGNATURE_DETAIL_TEXT_LENGTH)
    : undefined;

  return `${name}${type ? `: ${type}` : ''}`;
}

function typeParametersText(
  typeParameters: readonly ts.TypeParameterDeclaration[] | undefined,
  sourceFile: ts.SourceFile
): string {
  if (typeParameters === undefined || typeParameters.length === 0) {
    return '';
  }

  return `<${typeParameters
    .map((typeParameter) =>
      compactNodeText(typeParameter, sourceFile, MAX_SIGNATURE_DETAIL_TEXT_LENGTH)
    )
    .join(', ')}>`;
}

function heritageText(heritage: SourceTruthSignatureHeritage | undefined): string {
  if (heritage === undefined) {
    return '';
  }

  const parts: string[] = [];

  if (heritage.extends !== undefined && heritage.extends.length > 0) {
    parts.push(`extends ${heritage.extends.join(', ')}`);
  }

  if (heritage.implements !== undefined && heritage.implements.length > 0) {
    parts.push(`implements ${heritage.implements.join(', ')}`);
  }

  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function variableDeclarationKind(
  declarationList: ts.VariableDeclarationList
): SourceTruthVariableDeclarationKind {
  if ((declarationList.flags & ts.NodeFlags.Const) !== 0) {
    return 'const';
  }

  if ((declarationList.flags & ts.NodeFlags.Let) !== 0) {
    return 'let';
  }

  return 'var';
}

function modifierPrefix(
  node: ts.Node,
  modifiers: readonly ('abstract' | 'async' | 'const' | 'declare' | 'default' | 'export')[]
): string {
  const words = modifiers.filter((modifier) => hasModifier(node, modifierSyntaxKind(modifier)));

  return words.length > 0 ? `${words.join(' ')} ` : '';
}

function modifierSyntaxKind(
  modifier: 'abstract' | 'async' | 'const' | 'declare' | 'default' | 'export'
): ts.SyntaxKind {
  switch (modifier) {
    case 'abstract':
      return ts.SyntaxKind.AbstractKeyword;
    case 'async':
      return ts.SyntaxKind.AsyncKeyword;
    case 'const':
      return ts.SyntaxKind.ConstKeyword;
    case 'declare':
      return ts.SyntaxKind.DeclareKeyword;
    case 'default':
      return ts.SyntaxKind.DefaultKeyword;
    case 'export':
      return ts.SyntaxKind.ExportKeyword;
  }
}

function compactNodeText(node: ts.Node, sourceFile: ts.SourceFile, maxLength: number): string {
  return compactText(
    SIGNATURE_PRINTER.printNode(ts.EmitHint.Unspecified, node, sourceFile),
    maxLength
  );
}

function compactSignatureText(text: string): string {
  return compactText(text, MAX_SIGNATURE_TEXT_LENGTH);
}

function compactText(text: string, maxLength: number): string {
  const compacted = compactWhitespaceOutsideLiterals(text);

  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactWhitespaceOutsideLiterals(text: string): string {
  let compacted = '';
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  let pendingSpace = false;

  for (const character of text) {
    if (quote !== undefined) {
      compacted += character;

      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }

      continue;
    }

    if (character === '"' || character === "'" || character === '`') {
      if (pendingSpace && compacted.length > 0) {
        compacted += ' ';
      }

      pendingSpace = false;
      quote = character;
      compacted += character;
      continue;
    }

    if (isSignatureWhitespace(character)) {
      if (compacted.length > 0) {
        pendingSpace = true;
      }

      continue;
    }

    if (pendingSpace && compacted.length > 0) {
      compacted += ' ';
    }

    pendingSpace = false;
    compacted += character;
  }

  return compacted;
}

function isSignatureWhitespace(character: string): boolean {
  return (
    character === ' ' ||
    character === '\n' ||
    character === '\r' ||
    character === '\t' ||
    character === '\f' ||
    character === '\v'
  );
}

function buildFact(options: {
  kind: SourceTruthFactKind;
  symbolKind: SourceTruthSymbolKind;
  name: string;
  exportedName: string;
  sourceFile: ts.SourceFile;
  node: ts.Node;
  moduleSpecifier?: string | undefined;
  signature?: SourceTruthSignatureEvidence | undefined;
}): SourceTruthFact {
  const { kind, symbolKind, name, exportedName, sourceFile, node, moduleSpecifier, signature } =
    options;
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  const fact: SourceTruthFact = {
    kind,
    symbolKind,
    name,
    exportedName,
    provenance: {
      path: sourceFile.fileName,
      lineRange: {
        start: start.line + 1,
        end: end.line + 1,
      },
    },
    order: 0,
  };

  if (moduleSpecifier !== undefined) {
    fact.moduleSpecifier = moduleSpecifier;
  }

  if (signature !== undefined) {
    fact.signature = signature;
  }

  return fact;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function hasDefaultModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.DefaultKeyword);
}

function bindingNameToText(name: ts.BindingName, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(name)) {
    return name.text;
  }

  return compactText(sanitizedBindingPatternText(name, sourceFile), MAX_SIGNATURE_NAME_LENGTH);
}

function sanitizedBindingPatternText(
  pattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern,
  sourceFile: ts.SourceFile
): string {
  if (ts.isObjectBindingPattern(pattern)) {
    return `{ ${pattern.elements
      .map((element) => bindingElementToText(element, sourceFile))
      .join(', ')} }`;
  }

  return `[${pattern.elements
    .map((element) => {
      if (ts.isOmittedExpression(element)) {
        return '';
      }

      return bindingElementToText(element, sourceFile);
    })
    .join(', ')}]`;
}

function bindingElementToText(element: ts.BindingElement, sourceFile: ts.SourceFile): string {
  const restPrefix = element.dotDotDotToken ? '...' : '';
  const name = ts.isIdentifier(element.name)
    ? element.name.text
    : sanitizedBindingPatternText(element.name, sourceFile);

  if (element.propertyName === undefined) {
    return `${restPrefix}${name}`;
  }

  return `${restPrefix}${propertyNameToText(element.propertyName, sourceFile)}: ${name}`;
}

function propertyNameToText(name: ts.PropertyName, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(name)) {
    return name.text;
  }

  if (ts.isStringLiteral(name)) {
    return JSON.stringify(name.text);
  }

  if (ts.isNumericLiteral(name)) {
    return name.text;
  }

  if (ts.isNoSubstitutionTemplateLiteral(name)) {
    return JSON.stringify(name.text);
  }

  if (ts.isComputedPropertyName(name)) {
    return '[computed]';
  }

  return compactNodeText(name, sourceFile, MAX_SIGNATURE_NAME_LENGTH);
}

function bindingNameHasDefault(name: ts.BindingName): boolean {
  if (ts.isIdentifier(name)) {
    return false;
  }

  return bindingPatternHasDefault(name);
}

function bindingPatternHasDefault(
  pattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern
): boolean {
  if (ts.isObjectBindingPattern(pattern)) {
    return pattern.elements.some((element) => bindingElementHasDefault(element));
  }

  return pattern.elements.some((element) => {
    if (ts.isOmittedExpression(element)) {
      return false;
    }

    return bindingElementHasDefault(element);
  });
}

function bindingElementHasDefault(element: ts.BindingElement): boolean {
  if (element.initializer !== undefined) {
    return true;
  }

  if (ts.isIdentifier(element.name)) {
    return false;
  }

  return bindingPatternHasDefault(element.name);
}

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }

  if (ts.isStringLiteral(node)) {
    return node.text;
  }

  return undefined;
}

function isSupportedSourceFile(path: string): boolean {
  return SUPPORTED_SOURCE_EXTENSIONS.has(extname(path).toLowerCase());
}

function isSupportedInspectableFile(path: string): boolean {
  return isSupportedSourceFile(path) || isPackageJsonFile(path) || isTsConfigJsonFile(path);
}

function isPackageJsonFile(path: string): boolean {
  return basename(path) === PACKAGE_JSON_FILE_NAME;
}

function isTsConfigJsonFile(path: string): boolean {
  return TSCONFIG_FILE_PATTERN.test(basename(path));
}

function scriptKindForPath(path: string): ts.ScriptKind {
  const extension = extname(path).toLowerCase();

  switch (extension) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.ts':
    case '.mts':
    case '.cts':
      return ts.ScriptKind.TS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

function sortFilesForReport(files: SourceTruthFileEvidence[]): void {
  files.sort((a, b) => compareStringsByCodeUnit(a.path, b.path));
}

function toRelativePath(rootPath: string, targetPath: string): string {
  const relativePath = relative(rootPath, targetPath);
  return relativePath === '' ? '.' : normalizePathForReport(relativePath);
}

function normalizePathForReport(path: string): string {
  return path.split(sep).join('/');
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
