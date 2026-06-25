import { createHash } from 'node:crypto';
import type { Dirent, Stats } from 'node:fs';
import { lstat, opendir, readFile } from 'node:fs/promises';
import { basename, extname, join, parse, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

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

export interface SourceTruthLineRange {
  start: number;
  end: number;
}

export interface SourceTruthProvenance {
  path: string;
  lineRange: SourceTruthLineRange;
}

export interface SourceTruthFact {
  kind: SourceTruthFactKind;
  symbolKind: SourceTruthSymbolKind;
  name: string;
  exportedName: string;
  provenance: SourceTruthProvenance;
  order: number;
  moduleSpecifier?: string;
}

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
  truncated: boolean;
  emittedMaxEntryWarning: boolean;
  emittedMaxFileWarning: boolean;
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
    emittedMaxEntryWarning: false,
    emittedMaxFileWarning: false,
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
      truncated: state.truncated,
    },
    files,
    facts,
    warnings,
  };
}

function validateSourceInput(source: string): void {
  if (source.trim() === '') {
    throw new Error('Source path is required.');
  }

  if (URL_LIKE_SOURCE_PATTERNS.some((pattern) => pattern.test(source.trim()))) {
    throw new Error(
      'source-truth inspect --source accepts local file or directory paths only; URL-like and git inputs are not supported'
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
        state.truncated = true;
        warnings.push(`Traversal stopped at max depth ${maxDepth}: ${relativePath}`);
        return;
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
      const stats = await lstat(entryPath);
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

  if (!isSupportedSourceFile(pathForReport)) {
    state.skippedFiles++;
    warnings.push(`Skipped unsupported file: ${pathForReport}`);
    files.push({
      path: pathForReport,
      resolvedPath: absolutePath,
      status: 'skipped',
      byteSize: stats.size,
      supported: false,
      facts: [],
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
      skipReason: 'oversized',
    });
    return;
  }

  try {
    const contentBytes = await readFile(absolutePath);
    const content = contentBytes.toString('utf-8');
    const sha256 = createHash('sha256').update(contentBytes).digest('hex');
    const extraction = extractTypeScriptJavaScriptFacts(pathForReport, content);
    const fileEvidence: SourceTruthFileEvidence = {
      path: pathForReport,
      resolvedPath: absolutePath,
      status: 'inspected',
      byteSize: stats.size,
      sha256,
      supported: true,
      facts: extraction.facts,
    };

    if (extraction.parseDiagnostics.length > 0) {
      fileEvidence.parseDiagnostics = extraction.parseDiagnostics;
      warnings.push(
        `Syntax diagnostics in file: ${pathForReport} (${extraction.parseDiagnostics.length})`
      );
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

function extractTypeScriptJavaScriptFacts(path: string, content: string): {
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
        const name = bindingNameToText(declaration.name);

        facts.push(
          buildFact({
            kind: 'exported-symbol',
            symbolKind: 'value',
            name,
            exportedName: hasDefaultModifier(statement) ? 'default' : name,
            sourceFile,
            node: declaration,
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

function buildFact(options: {
  kind: SourceTruthFactKind;
  symbolKind: SourceTruthSymbolKind;
  name: string;
  exportedName: string;
  sourceFile: ts.SourceFile;
  node: ts.Node;
  moduleSpecifier?: string | undefined;
}): SourceTruthFact {
  const { kind, symbolKind, name, exportedName, sourceFile, node, moduleSpecifier } = options;
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

  return fact;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false)
  );
}

function hasDefaultModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ??
      false)
  );
}

function bindingNameToText(name: ts.BindingName): string {
  if (ts.isIdentifier(name)) {
    return name.text;
  }

  return name.getText();
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
