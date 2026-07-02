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
      'export { makeAlpha as renamedAlpha };',
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
    expect(
      report.facts.map(({ kind, symbolKind, name, exportedName, moduleSpecifier }) => ({
        kind,
        symbolKind,
        name,
        exportedName,
        moduleSpecifier,
      }))
    ).toEqual([
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

  it('adds bounded AST signature evidence for direct exported declarations only', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-signatures-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    const declarationsSource = [
      'export function makeResult(',
      '  input: string,',
      '  count?: number,',
      "  mode: 'fast' | 'slow' = 'fast',",
      '  ...flags: string[]',
      '): Promise<Result> {',
      '  return Promise.resolve({ input, count, mode, flags });',
      '}',
      'export const typedValue: number = 123;',
      'export let implicitValue = compute();',
      'export interface Options extends BaseOptions {',
      '  enabled: boolean;',
      '  label?: string;',
      '}',
      'export type Result = { input: string; count?: number };',
      'export enum Mode {',
      '  Fast,',
      '  Slow,',
      '}',
      'export class Service extends BaseService implements Runnable, Disposable {',
      '  start(): void {}',
      '  stop(): void {}',
      '}',
      'export { makeResult as renamedResult };',
      "export * from './other';",
      'export default makeResult;',
      '',
    ].join('\n');
    const defaultFunctionSource = [
      'export default function namedDefault(input: string): void {',
      '  console.log(input);',
      '}',
      '',
    ].join('\n');
    const defaultClassSource = ['export default class {', '  run(): void {}', '}', ''].join('\n');

    await writeFile(join(sourceDir, 'declarations.ts'), declarationsSource, 'utf-8');
    await writeFile(join(sourceDir, 'default-class.ts'), defaultClassSource, 'utf-8');
    await writeFile(join(sourceDir, 'default-function.ts'), defaultFunctionSource, 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });

    const makeResult = report.facts.find((fact) => fact.name === 'makeResult');
    expect(makeResult?.signature).toEqual({
      declarationKind: 'function',
      text: "export function makeResult(input: string, count?: number, mode: 'fast' | 'slow', ...flags: string[]): Promise<Result>",
      name: 'makeResult',
      parameters: [
        {
          name: 'input',
          type: 'string',
          optional: false,
          rest: false,
          hasDefault: false,
        },
        {
          name: 'count',
          type: 'number',
          optional: true,
          rest: false,
          hasDefault: false,
        },
        {
          name: 'mode',
          type: "'fast' | 'slow'",
          optional: true,
          rest: false,
          hasDefault: true,
        },
        {
          name: 'flags',
          type: 'string[]',
          optional: false,
          rest: true,
          hasDefault: false,
        },
      ],
      returnType: 'Promise<Result>',
    });
    expect(makeResult?.signature?.text).not.toContain('return');
    expect(makeResult?.signature?.text).not.toContain("= 'fast'");

    const typedValue = report.facts.find((fact) => fact.name === 'typedValue');
    expect(typedValue?.signature).toEqual({
      declarationKind: 'variable',
      text: 'export const typedValue: number',
      variableKind: 'const',
      variables: [{ name: 'typedValue', type: 'number' }],
    });
    expect(typedValue?.signature?.text).not.toContain('123');

    const implicitValue = report.facts.find((fact) => fact.name === 'implicitValue');
    expect(implicitValue?.signature).toEqual({
      declarationKind: 'variable',
      text: 'export let implicitValue',
      variableKind: 'let',
      variables: [{ name: 'implicitValue' }],
    });
    expect(implicitValue?.signature?.text).not.toContain('compute');

    const options = report.facts.find((fact) => fact.name === 'Options');
    expect(options?.signature).toEqual({
      declarationKind: 'interface',
      text: 'export interface Options extends BaseOptions',
      name: 'Options',
      memberCount: 2,
      heritage: {
        extends: ['BaseOptions'],
      },
    });

    const result = report.facts.find((fact) => fact.name === 'Result');
    expect(result?.signature).toEqual({
      declarationKind: 'type',
      text: 'export type Result = { input: string; count?: number; }',
      name: 'Result',
      type: '{ input: string; count?: number; }',
      memberCount: 2,
    });

    const mode = report.facts.find((fact) => fact.name === 'Mode');
    expect(mode?.signature).toEqual({
      declarationKind: 'enum',
      text: 'export enum Mode',
      name: 'Mode',
      memberCount: 2,
    });

    const service = report.facts.find((fact) => fact.name === 'Service');
    expect(service?.signature).toEqual({
      declarationKind: 'class',
      text: 'export class Service extends BaseService implements Runnable, Disposable',
      name: 'Service',
      memberCount: 2,
      heritage: {
        extends: ['BaseService'],
        implements: ['Runnable', 'Disposable'],
      },
    });
    expect(service?.signature?.text).not.toContain('start');

    const defaultFunction = report.facts.find(
      (fact) => fact.name === 'namedDefault' && fact.exportedName === 'default'
    );
    expect(defaultFunction?.signature).toEqual({
      declarationKind: 'function',
      text: 'export default function namedDefault(input: string): void',
      name: 'namedDefault',
      parameters: [
        {
          name: 'input',
          type: 'string',
          optional: false,
          rest: false,
          hasDefault: false,
        },
      ],
      returnType: 'void',
    });

    const defaultClass = report.facts.find(
      (fact) => fact.symbolKind === 'class' && fact.exportedName === 'default'
    );
    expect(defaultClass).toMatchObject({
      name: 'default',
      exportedName: 'default',
    });
    expect(defaultClass?.signature).toEqual({
      declarationKind: 'class',
      text: 'export default class',
      memberCount: 1,
    });

    expect(
      report.facts
        .filter((fact) => fact.kind !== 'exported-symbol')
        .map(({ kind, exportedName, signature }) => ({ kind, exportedName, signature }))
    ).toEqual([
      {
        kind: 're-exported-symbol',
        exportedName: 'renamedResult',
        signature: undefined,
      },
      {
        kind: 'export-all',
        exportedName: '*',
        signature: undefined,
      },
      {
        kind: 'export-assignment',
        exportedName: 'default',
        signature: undefined,
      },
    ]);
  });

  it('sanitizes destructuring defaults from signature evidence', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-destructuring-signatures-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    await writeFile(
      join(sourceDir, 'index.ts'),
      [
        'export function fromInput({ token = getSecret(), nested: { id = makeId() }, ...rest }: Options, [first = getFirst(), second]: string[], plain = getPlain()): void {}',
        'export const { value = getValue(), alias: renamed = getRenamed(), nested: { deep = getDeep() } }: Shape = loadShape();',
        'export const [first = getArrayFirst(), second]: Items = loadItems();',
        '',
      ].join('\n'),
      'utf-8'
    );

    const report = await inspectSourceTruth({ source: sourceDir });
    const functionFact = report.facts.find((fact) => fact.name === 'fromInput');
    const objectVariableFact = report.facts.find((fact) => fact.name.startsWith('{ value'));
    const arrayVariableFact = report.facts.find((fact) => fact.name.startsWith('[first'));

    expect(functionFact?.signature).toEqual({
      declarationKind: 'function',
      text: 'export function fromInput({ token, nested: { id }, ...rest }: Options, [first, second]: string[], plain): void',
      name: 'fromInput',
      parameters: [
        {
          name: '{ token, nested: { id }, ...rest }',
          type: 'Options',
          optional: false,
          rest: false,
          hasDefault: true,
        },
        {
          name: '[first, second]',
          type: 'string[]',
          optional: false,
          rest: false,
          hasDefault: true,
        },
        {
          name: 'plain',
          optional: true,
          rest: false,
          hasDefault: true,
        },
      ],
      returnType: 'void',
    });
    expect(objectVariableFact).toMatchObject({
      name: '{ value, alias: renamed, nested: { deep } }',
      signature: {
        declarationKind: 'variable',
        text: 'export const { value, alias: renamed, nested: { deep } }: Shape',
        variableKind: 'const',
        variables: [{ name: '{ value, alias: renamed, nested: { deep } }', type: 'Shape' }],
      },
    });
    expect(arrayVariableFact).toMatchObject({
      name: '[first, second]',
      signature: {
        declarationKind: 'variable',
        text: 'export const [first, second]: Items',
        variableKind: 'const',
        variables: [{ name: '[first, second]', type: 'Items' }],
      },
    });

    const serializedFacts = JSON.stringify(report.facts);
    expect(serializedFacts).not.toContain('getSecret');
    expect(serializedFacts).not.toContain('makeId');
    expect(serializedFacts).not.toContain('getFirst');
    expect(serializedFacts).not.toContain('getPlain');
    expect(serializedFacts).not.toContain('getValue');
    expect(serializedFacts).not.toContain('getRenamed');
    expect(serializedFacts).not.toContain('getDeep');
    expect(serializedFacts).not.toContain('loadShape');
    expect(serializedFacts).not.toContain('getArrayFirst');
    expect(serializedFacts).not.toContain('loadItems');
  });

  it('strips inline comments from signature type evidence', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-commented-signatures-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    await writeFile(
      join(sourceDir, 'index.ts'),
      [
        'export type CommentedAlias = {',
        '  /** field docs */',
        '  value: /* value type */ string;',
        '};',
        'export function commented(input: /* parameter type */ Input</* parameter generic */ Item>): /* return type */ Output</* return generic */ Item> {',
        '  return input as unknown as Output<Item>;',
        '}',
        'export interface CommentedInterface extends /* heritage comment */ BaseInterface</* heritage generic */ Item> {',
        '  value: string;',
        '}',
        'export class CommentedClass extends /* base comment */ BaseClass</* base generic */ Item> implements /* implement comment */ Runnable</* implement generic */ Item> {',
        '  run(): void {}',
        '}',
        '',
      ].join('\n'),
      'utf-8'
    );

    const report = await inspectSourceTruth({ source: sourceDir });
    const alias = report.facts.find((fact) => fact.name === 'CommentedAlias');
    const fn = report.facts.find((fact) => fact.name === 'commented');
    const iface = report.facts.find((fact) => fact.name === 'CommentedInterface');
    const cls = report.facts.find((fact) => fact.name === 'CommentedClass');

    expect(alias?.signature?.text).toContain('export type CommentedAlias =');
    expect(alias?.signature?.type).toContain('value: string');
    expect(fn?.signature?.parameters?.[0]).toMatchObject({
      name: 'input',
      type: 'Input<Item>',
    });
    expect(fn?.signature?.returnType).toBe('Output<Item>');
    expect(fn?.signature?.text).toBe('export function commented(input: Input<Item>): Output<Item>');
    expect(iface?.signature?.heritage).toEqual({
      extends: ['BaseInterface<Item>'],
    });
    expect(cls?.signature?.heritage).toEqual({
      extends: ['BaseClass<Item>'],
      implements: ['Runnable<Item>'],
    });

    const serializedSignatures = JSON.stringify(report.facts.map((fact) => fact.signature));
    expect(serializedSignatures).not.toContain('field docs');
    expect(serializedSignatures).not.toContain('value type');
    expect(serializedSignatures).not.toContain('parameter type');
    expect(serializedSignatures).not.toContain('parameter generic');
    expect(serializedSignatures).not.toContain('return type');
    expect(serializedSignatures).not.toContain('return generic');
    expect(serializedSignatures).not.toContain('heritage comment');
    expect(serializedSignatures).not.toContain('heritage generic');
    expect(serializedSignatures).not.toContain('base comment');
    expect(serializedSignatures).not.toContain('base generic');
    expect(serializedSignatures).not.toContain('implement comment');
    expect(serializedSignatures).not.toContain('implement generic');
  });

  it('preserves repeated whitespace inside literal tokens in signature evidence', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-literal-whitespace-signatures-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    await writeFile(
      join(sourceDir, 'index.ts'),
      [
        'export type StringLiteral = "alpha  beta";',
        'export type TemplateLiteral = `alpha  ${string}  beta`;',
        'export function literalFunction(input: "left  right"): `done  ${string}` {',
        '  return "" as `done  ${string}`;',
        '}',
        'export const { "quoted  key": quotedValue }: Shape = loadShape();',
        '',
      ].join('\n'),
      'utf-8'
    );

    const report = await inspectSourceTruth({ source: sourceDir });
    const stringLiteral = report.facts.find((fact) => fact.name === 'StringLiteral');
    const templateLiteral = report.facts.find((fact) => fact.name === 'TemplateLiteral');
    const literalFunction = report.facts.find((fact) => fact.name === 'literalFunction');
    const quotedBinding = report.facts.find((fact) => fact.name.includes('quoted  key'));

    expect(stringLiteral?.signature).toMatchObject({
      text: 'export type StringLiteral = "alpha  beta"',
      type: '"alpha  beta"',
    });
    expect(templateLiteral?.signature).toMatchObject({
      text: 'export type TemplateLiteral = `alpha  ${string}  beta`',
      type: '`alpha  ${string}  beta`',
    });
    expect(literalFunction?.signature).toMatchObject({
      text: 'export function literalFunction(input: "left  right"): `done  ${string}`',
      parameters: [
        {
          name: 'input',
          type: '"left  right"',
          optional: false,
          rest: false,
          hasDefault: false,
        },
      ],
      returnType: '`done  ${string}`',
    });
    expect(quotedBinding).toMatchObject({
      name: '{ "quoted  key": quotedValue }',
      signature: {
        text: 'export const { "quoted  key": quotedValue }: Shape',
        variables: [{ name: '{ "quoted  key": quotedValue }', type: 'Shape' }],
      },
    });

    const serializedSignatures = JSON.stringify(report.facts.map((fact) => fact.signature));
    expect(serializedSignatures).toContain('alpha  beta');
    expect(serializedSignatures).toContain('alpha  ${string}  beta');
    expect(serializedSignatures).toContain('left  right');
    expect(serializedSignatures).toContain('done  ${string}');
    expect(serializedSignatures).toContain('quoted  key');
    expect(serializedSignatures).not.toContain('alpha beta');
    expect(serializedSignatures).not.toContain('left right');
    expect(serializedSignatures).not.toContain('done ${string}');
    expect(serializedSignatures).not.toContain('quoted key');
  });

  it('reports unsupported and oversized files without extracting facts', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-skips-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'notes.md'), '# Notes\n', 'utf-8');
    await writeFile(join(sourceDir, 'large.ts'), 'export const tooLarge = true;\n', 'utf-8');
    await writeFile(join(sourceDir, 'small.js'), 'export const small = true;\n', 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir, maxFileBytes: 20 });

    expect(
      report.files.map((file) => ({
        path: file.path,
        status: file.status,
        supported: file.supported,
        skipReason: file.skipReason,
        facts: file.facts.length,
        contextFacts: file.contextFacts.length,
      }))
    ).toEqual([
      {
        path: 'large.ts',
        status: 'skipped',
        supported: true,
        skipReason: 'oversized',
        facts: 0,
        contextFacts: 0,
      },
      {
        path: 'notes.md',
        status: 'skipped',
        supported: false,
        skipReason: 'unsupported-extension',
        facts: 0,
        contextFacts: 0,
      },
      {
        path: 'small.js',
        status: 'skipped',
        supported: true,
        skipReason: 'oversized',
        facts: 0,
        contextFacts: 0,
      },
    ]);
    expect(report.facts).toEqual([]);
    expect(report.contextFacts).toEqual([]);
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

  it('reports path-based test and example context facts without behavior inference', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-context-');
    const sourceDir = join(dir, 'source');
    await mkdir(join(sourceDir, 'tests'), { recursive: true });
    await mkdir(join(sourceDir, 'docs/examples'), { recursive: true });
    await mkdir(join(sourceDir, 'samples'), { recursive: true });
    await mkdir(join(sourceDir, 'src'), { recursive: true });

    const testSource = ['describe("widget", () => {', '  expect(true).toBe(true);', '});', ''].join(
      '\n'
    );
    const docsExampleSource = ['const docsExample = true;', ''].join('\n');
    const sampleSource = ['const sample = true;', ''].join('\n');
    const plainSource = ['const plain = true;', ''].join('\n');
    await writeFile(join(sourceDir, 'tests/widget.test.ts'), testSource, 'utf-8');
    await writeFile(join(sourceDir, 'docs/examples/usage.ts'), docsExampleSource, 'utf-8');
    await writeFile(join(sourceDir, 'samples/widget.ts'), sampleSource, 'utf-8');
    await writeFile(join(sourceDir, 'src/plain.ts'), plainSource, 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });

    expect(report.facts).toEqual([]);
    expect(report.configFacts).toEqual([]);
    expect(report.contextFacts.map((fact) => fact.path)).toEqual([
      'docs/examples/usage.ts',
      'samples/widget.ts',
      'tests/widget.test.ts',
      'tests/widget.test.ts',
    ]);
    expect(
      report.contextFacts.map((fact) =>
        fact.kind === 'test-case'
          ? {
              kind: fact.kind,
              path: fact.path,
              name: fact.name,
              call: fact.call,
              modifiers: fact.modifiers,
              provenance: fact.provenance,
              lineRangeGranularity: fact.lineRangeGranularity,
              order: fact.order,
            }
          : {
              kind: fact.kind,
              path: fact.path,
              evidenceSignals: fact.evidenceSignals,
              byteSize: fact.byteSize,
              sha256: fact.sha256,
              provenance: fact.provenance,
              lineRangeGranularity: fact.lineRangeGranularity,
              order: fact.order,
            }
      )
    ).toEqual([
      {
        kind: 'example-file',
        path: 'docs/examples/usage.ts',
        evidenceSignals: ['path-segment:examples', 'path-segment:docs/examples'],
        byteSize: Buffer.byteLength(docsExampleSource),
        sha256: sha256(docsExampleSource),
        provenance: {
          path: 'docs/examples/usage.ts',
          lineRange: { start: 1, end: 1 },
        },
        lineRangeGranularity: 'file',
        order: 1,
      },
      {
        kind: 'example-file',
        path: 'samples/widget.ts',
        evidenceSignals: ['path-segment:samples'],
        byteSize: Buffer.byteLength(sampleSource),
        sha256: sha256(sampleSource),
        provenance: {
          path: 'samples/widget.ts',
          lineRange: { start: 1, end: 1 },
        },
        lineRangeGranularity: 'file',
        order: 2,
      },
      {
        kind: 'test-file',
        path: 'tests/widget.test.ts',
        evidenceSignals: ['filename-pattern:*.test.*', 'path-segment:tests'],
        byteSize: Buffer.byteLength(testSource),
        sha256: sha256(testSource),
        provenance: {
          path: 'tests/widget.test.ts',
          lineRange: { start: 1, end: 3 },
        },
        lineRangeGranularity: 'file',
        order: 3,
      },
      {
        kind: 'test-case',
        path: 'tests/widget.test.ts',
        name: 'widget',
        call: 'describe',
        modifiers: [],
        provenance: {
          path: 'tests/widget.test.ts',
          lineRange: { start: 1, end: 1 },
        },
        lineRangeGranularity: 'test-label',
        order: 4,
      },
    ]);
    expect(report.files.find((file) => file.path === 'src/plain.ts')?.contextFacts).toEqual([]);

    const serializedContextFacts = JSON.stringify(report.contextFacts);
    expect(serializedContextFacts).not.toContain('expect');
    expect(serializedContextFacts).not.toContain('toBe');
    expect(serializedContextFacts).not.toMatch(/\bframework\b/i);
    expect(serializedContextFacts).not.toMatch(/\broutes?\b/i);
    expect(serializedContextFacts).not.toMatch(/\bbehavior\b/i);
    expect(serializedContextFacts).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(serializedContextFacts).not.toMatch(/\bcorrect(?:ness)?\b/i);
    expect(serializedContextFacts).not.toMatch(/\bverified\b/i);
  });

  it('preserves all matched factual context signals on mixed test/example paths', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-mixed-context-');
    const sourceDir = join(dir, 'source');
    await mkdir(join(sourceDir, 'examples'), { recursive: true });

    const source = ['test("mixed path", () => {', '  expect(true).toBe(true);', '});', ''].join(
      '\n'
    );
    await writeFile(join(sourceDir, 'examples/widget.test.ts'), source, 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });

    expect(report.facts).toEqual([]);
    expect(report.configFacts).toEqual([]);
    expect(report.contextFacts).toHaveLength(2);
    expect(report.contextFacts[0]).toMatchObject({
      kind: 'test-file',
      path: 'examples/widget.test.ts',
      evidenceSignals: ['filename-pattern:*.test.*', 'path-segment:examples'],
      byteSize: Buffer.byteLength(source),
      sha256: sha256(source),
      provenance: {
        path: 'examples/widget.test.ts',
        lineRange: { start: 1, end: 3 },
      },
      lineRangeGranularity: 'file',
      order: 1,
    });
    expect(report.contextFacts[1]).toEqual({
      kind: 'test-case',
      path: 'examples/widget.test.ts',
      name: 'mixed path',
      call: 'test',
      modifiers: [],
      provenance: {
        path: 'examples/widget.test.ts',
        lineRange: { start: 1, end: 1 },
      },
      lineRangeGranularity: 'test-label',
      order: 2,
    });

    const serializedContextFacts = JSON.stringify(report.contextFacts);
    expect(serializedContextFacts).not.toContain('expect(true)');
    expect(serializedContextFacts).not.toMatch(/\bframework\b/i);
    expect(serializedContextFacts).not.toMatch(/\broutes?\b/i);
    expect(serializedContextFacts).not.toMatch(/\bbehavior\b/i);
    expect(serializedContextFacts).not.toMatch(/\bauthorit(?:y|ative)\b/i);
    expect(serializedContextFacts).not.toMatch(/\bcorrect(?:ness)?\b/i);
    expect(serializedContextFacts).not.toMatch(/\bverified\b/i);
  });

  it('extracts conservative AST test-case labels with stable order and redacted bodies', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-test-cases-');
    const sourceDir = join(dir, 'source');
    await mkdir(join(sourceDir, 'tests'), { recursive: true });
    await mkdir(join(sourceDir, 'src'), { recursive: true });

    const testSource = [
      "describe('outer suite', () => {",
      "  it('runs direct test', () => {",
      "    expect(readSecret()).toEqual('do not serialize');",
      '  });',
      '  test.only(`template literal label`, () => {});',
      "  describe.skip('skipped suite', () => {",
      "    it.skip('skipped test', () => {});",
      '    test(`nested no substitution`, () => {});',
      '  });',
      '  it(nameFromFactory(), () => {});',
      "  test.each([])('parameterized %s', () => {});",
      "  describe.only('focused suite', () => {});",
      '  describe.only(dynamicName, () => {});',
      '});',
      '',
    ].join('\n');
    const plainSource = ["describe('ignored outside test file', () => {});", ''].join('\n');

    await writeFile(join(sourceDir, 'tests/cases.test.ts'), testSource, 'utf-8');
    await writeFile(join(sourceDir, 'src/plain.ts'), plainSource, 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });
    const testFile = report.files.find((file) => file.path === 'tests/cases.test.ts');
    const plainFile = report.files.find((file) => file.path === 'src/plain.ts');
    const testCaseFacts = report.contextFacts.filter((fact) => fact.kind === 'test-case');

    expect(plainFile?.contextFacts).toEqual([]);
    expect(testFile?.contextFacts.map((fact) => fact.kind)).toEqual([
      'test-file',
      'test-case',
      'test-case',
      'test-case',
      'test-case',
      'test-case',
      'test-case',
      'test-case',
    ]);
    expect(
      testCaseFacts.map(({ name, call, modifiers, provenance, lineRangeGranularity, order }) => ({
        name,
        call,
        modifiers,
        provenance,
        lineRangeGranularity,
        order,
      }))
    ).toEqual([
      {
        name: 'outer suite',
        call: 'describe',
        modifiers: [],
        provenance: { path: 'tests/cases.test.ts', lineRange: { start: 1, end: 1 } },
        lineRangeGranularity: 'test-label',
        order: 2,
      },
      {
        name: 'runs direct test',
        call: 'it',
        modifiers: [],
        provenance: { path: 'tests/cases.test.ts', lineRange: { start: 2, end: 2 } },
        lineRangeGranularity: 'test-label',
        order: 3,
      },
      {
        name: 'template literal label',
        call: 'test',
        modifiers: ['only'],
        provenance: { path: 'tests/cases.test.ts', lineRange: { start: 5, end: 5 } },
        lineRangeGranularity: 'test-label',
        order: 4,
      },
      {
        name: 'skipped suite',
        call: 'describe',
        modifiers: ['skip'],
        provenance: { path: 'tests/cases.test.ts', lineRange: { start: 6, end: 6 } },
        lineRangeGranularity: 'test-label',
        order: 5,
      },
      {
        name: 'skipped test',
        call: 'it',
        modifiers: ['skip'],
        provenance: { path: 'tests/cases.test.ts', lineRange: { start: 7, end: 7 } },
        lineRangeGranularity: 'test-label',
        order: 6,
      },
      {
        name: 'nested no substitution',
        call: 'test',
        modifiers: [],
        provenance: { path: 'tests/cases.test.ts', lineRange: { start: 8, end: 8 } },
        lineRangeGranularity: 'test-label',
        order: 7,
      },
      {
        name: 'focused suite',
        call: 'describe',
        modifiers: ['only'],
        provenance: { path: 'tests/cases.test.ts', lineRange: { start: 12, end: 12 } },
        lineRangeGranularity: 'test-label',
        order: 8,
      },
    ]);

    const serializedContextFacts = JSON.stringify(report.contextFacts);
    expect(serializedContextFacts).not.toContain('readSecret');
    expect(serializedContextFacts).not.toContain('do not serialize');
    expect(serializedContextFacts).not.toContain('parameterized %s');
    expect(serializedContextFacts).not.toContain('nameFromFactory');
    expect(serializedContextFacts).not.toContain('dynamicName');
    expect(serializedContextFacts).not.toContain('ignored outside test file');
    expect(serializedContextFacts).not.toContain('expect(');
    expect(serializedContextFacts).not.toMatch(/\bruntime\b/i);
    expect(serializedContextFacts).not.toMatch(/\bverified\b/i);
  });

  it('ignores describe it and test call text inside comments and string literals', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-test-case-noise-');
    const sourceDir = join(dir, 'source');
    await mkdir(join(sourceDir, 'tests'), { recursive: true });

    const source = [
      "// describe('commented suite', () => {})",
      '/*',
      "it('block comment test', () => {})",
      '*/',
      'const stringText = "test(\'inside string\', () => {})";',
      "const templateText = `describe('inside template literal', () => {})`;",
      'const arrayText = ["it.only(\'inside array\', () => {})"];',
      '',
    ].join('\n');
    await writeFile(join(sourceDir, 'tests/noise.test.ts'), source, 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });

    expect(report.contextFacts.filter((fact) => fact.kind === 'test-case')).toEqual([]);
    expect(report.contextFacts).toEqual([
      {
        kind: 'test-file',
        path: 'tests/noise.test.ts',
        evidenceSignals: ['filename-pattern:*.test.*', 'path-segment:tests'],
        byteSize: Buffer.byteLength(source),
        sha256: sha256(source),
        provenance: {
          path: 'tests/noise.test.ts',
          lineRange: { start: 1, end: 7 },
        },
        lineRangeGranularity: 'file',
        order: 1,
      },
    ]);
  });

  it('keeps file-level test context for empty test files without bogus test cases', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-empty-test-file-');
    const sourceDir = join(dir, 'source');
    await mkdir(join(sourceDir, 'tests'), { recursive: true });

    const source = '';
    await writeFile(join(sourceDir, 'tests/empty.test.ts'), source, 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });

    expect(report.files).toHaveLength(1);
    expect(report.files[0]).toMatchObject({
      path: 'tests/empty.test.ts',
      status: 'inspected',
      supported: true,
      byteSize: 0,
      sha256: sha256(source),
      facts: [],
      configFacts: [],
    });
    expect(report.files[0]?.parseDiagnostics).toBeUndefined();
    expect(report.contextFacts).toEqual([
      {
        kind: 'test-file',
        path: 'tests/empty.test.ts',
        evidenceSignals: ['filename-pattern:*.test.*', 'path-segment:tests'],
        byteSize: 0,
        sha256: sha256(source),
        provenance: {
          path: 'tests/empty.test.ts',
          lineRange: { start: 1, end: 1 },
        },
        lineRangeGranularity: 'file',
        order: 1,
      },
    ]);
  });

  it('reports syntax diagnostics while exposing recoverable literal test labels', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-malformed-test-labels-');
    const sourceDir = join(dir, 'source');
    await mkdir(join(sourceDir, 'tests'), { recursive: true });

    const source = [
      "describe('recoverable suite', () => {",
      "  it('recoverable test', () => {",
      '    expect(secret).toBe(true);',
      '  }',
      "  test('after missing punctuation', () => {});",
      '});',
      '',
    ].join('\n');
    await writeFile(join(sourceDir, 'tests/recoverable.test.ts'), source, 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });
    const file = report.files.find((candidate) => candidate.path === 'tests/recoverable.test.ts');
    const testCaseFacts = report.contextFacts.filter((fact) => fact.kind === 'test-case');

    expect(file?.parseDiagnostics).toEqual([
      {
        code: 1005,
        category: 'error',
        message: "',' expected.",
        lineRange: { start: 5, end: 5 },
      },
      {
        code: 1005,
        category: 'error',
        message: "')' expected.",
        lineRange: { start: 5, end: 5 },
      },
    ]);
    expect(report.warnings).toEqual(['Syntax diagnostics in file: tests/recoverable.test.ts (2)']);
    expect(
      testCaseFacts.map(({ name, call, modifiers, provenance, lineRangeGranularity, order }) => ({
        name,
        call,
        modifiers,
        provenance,
        lineRangeGranularity,
        order,
      }))
    ).toEqual([
      {
        name: 'recoverable suite',
        call: 'describe',
        modifiers: [],
        provenance: { path: 'tests/recoverable.test.ts', lineRange: { start: 1, end: 1 } },
        lineRangeGranularity: 'test-label',
        order: 2,
      },
      {
        name: 'recoverable test',
        call: 'it',
        modifiers: [],
        provenance: { path: 'tests/recoverable.test.ts', lineRange: { start: 2, end: 2 } },
        lineRangeGranularity: 'test-label',
        order: 3,
      },
      {
        name: 'after missing punctuation',
        call: 'test',
        modifiers: [],
        provenance: { path: 'tests/recoverable.test.ts', lineRange: { start: 5, end: 5 } },
        lineRangeGranularity: 'test-label',
        order: 4,
      },
    ]);

    const serializedContextFacts = JSON.stringify(report.contextFacts);
    expect(serializedContextFacts).not.toContain('secret');
    expect(serializedContextFacts).not.toContain('toBe');
  });

  it('keeps many literal test labels deterministic without serializing bodies', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-many-test-labels-');
    const sourceDir = join(dir, 'source');
    await mkdir(join(sourceDir, 'tests'), { recursive: true });

    const labelCount = 75;
    const source = [
      "describe('stress suite', () => {",
      ...Array.from({ length: labelCount }, (_, index) => {
        const label = `case ${String(index).padStart(3, '0')}`;

        return `  it('${label}', () => { expect('body-${index}').toBe('hidden'); });`;
      }),
      '});',
      '',
    ].join('\n');
    await writeFile(join(sourceDir, 'tests/many.test.ts'), source, 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });
    const secondReport = await inspectSourceTruth({ source: sourceDir });
    const testCaseFacts = report.contextFacts.filter((fact) => fact.kind === 'test-case');

    expect(report.contextFacts).toEqual(secondReport.contextFacts);
    expect(testCaseFacts).toHaveLength(labelCount + 1);
    expect(testCaseFacts[0]).toMatchObject({
      name: 'stress suite',
      call: 'describe',
      order: 2,
      provenance: { path: 'tests/many.test.ts', lineRange: { start: 1, end: 1 } },
    });
    expect(testCaseFacts[1]).toMatchObject({
      name: 'case 000',
      call: 'it',
      order: 3,
      provenance: { path: 'tests/many.test.ts', lineRange: { start: 2, end: 2 } },
    });
    expect(testCaseFacts[testCaseFacts.length - 1]).toMatchObject({
      name: 'case 074',
      call: 'it',
      order: 77,
      provenance: { path: 'tests/many.test.ts', lineRange: { start: 76, end: 76 } },
    });
    expect(JSON.stringify(report.contextFacts).length).toBeLessThan(40000);

    const serializedContextFacts = JSON.stringify(report.contextFacts);
    expect(serializedContextFacts).not.toContain('body-');
    expect(serializedContextFacts).not.toContain('hidden');
    expect(serializedContextFacts).not.toContain('expect(');
  });

  it('extracts conservative package manifest evidence with field provenance', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-package-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    const packageJson = [
      '{',
      '  "name": "@scope/example",',
      '  "version": "1.2.3",',
      '  "type": "module",',
      '  "packageManager": "npm@10.0.0",',
      '  "bin": {',
      '    "example": "./dist/cli.js",',
      '    "z-tool": "./dist/z.js"',
      '  },',
      '  "exports": {',
      '    ".": "./dist/index.js",',
      '    "./cli": "./dist/cli.js"',
      '  },',
      '  "scripts": {',
      '    "build": "tsc",',
      '    "test": "vitest"',
      '  },',
      '  "dependencies": {',
      '    "react": "^18.0.0"',
      '  },',
      '  "devDependencies": {',
      '    "typescript": "^5.0.0"',
      '  }',
      '}',
      '',
    ].join('\n');
    await writeFile(join(sourceDir, 'package.json'), packageJson, 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });

    expect(report.files.map((file) => file.path)).toEqual(['package.json']);
    expect(report.files[0]).toMatchObject({
      path: 'package.json',
      status: 'inspected',
      supported: true,
      facts: [],
      configFacts: expect.any(Array),
      sha256: sha256(packageJson),
    });
    expect(
      report.configFacts.map(({ kind, name, value, group, fieldPath, lineRangeGranularity }) => ({
        kind,
        name,
        value,
        group,
        fieldPath,
        lineRangeGranularity,
      }))
    ).toEqual([
      {
        kind: 'package-name',
        name: 'name',
        value: '@scope/example',
        group: undefined,
        fieldPath: 'name',
        lineRangeGranularity: 'field',
      },
      {
        kind: 'package-version',
        name: 'version',
        value: '1.2.3',
        group: undefined,
        fieldPath: 'version',
        lineRangeGranularity: 'field',
      },
      {
        kind: 'package-type',
        name: 'type',
        value: 'module',
        group: undefined,
        fieldPath: 'type',
        lineRangeGranularity: 'field',
      },
      {
        kind: 'package-manager',
        name: 'packageManager',
        value: 'npm@10.0.0',
        group: undefined,
        fieldPath: 'packageManager',
        lineRangeGranularity: 'field',
      },
      {
        kind: 'package-bin-name',
        name: 'example',
        value: undefined,
        group: undefined,
        fieldPath: 'bin.example',
        lineRangeGranularity: 'field',
      },
      {
        kind: 'package-bin-name',
        name: 'z-tool',
        value: undefined,
        group: undefined,
        fieldPath: 'bin["z-tool"]',
        lineRangeGranularity: 'field',
      },
      {
        kind: 'package-export-key',
        name: '.',
        value: undefined,
        group: undefined,
        fieldPath: 'exports["."]',
        lineRangeGranularity: 'field',
      },
      {
        kind: 'package-export-key',
        name: './cli',
        value: undefined,
        group: undefined,
        fieldPath: 'exports["./cli"]',
        lineRangeGranularity: 'field',
      },
      {
        kind: 'package-script-name',
        name: 'build',
        value: undefined,
        group: undefined,
        fieldPath: 'scripts.build',
        lineRangeGranularity: 'field',
      },
      {
        kind: 'package-script-name',
        name: 'test',
        value: undefined,
        group: undefined,
        fieldPath: 'scripts.test',
        lineRangeGranularity: 'field',
      },
      {
        kind: 'package-dependency-name',
        name: 'react',
        value: undefined,
        group: 'dependencies',
        fieldPath: 'dependencies.react',
        lineRangeGranularity: 'field',
      },
      {
        kind: 'package-dependency-name',
        name: 'typescript',
        value: undefined,
        group: 'devDependencies',
        fieldPath: 'devDependencies.typescript',
        lineRangeGranularity: 'field',
      },
    ]);
    expect(report.configFacts.map((fact) => fact.order)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(report.configFacts.every((fact) => fact.provenance.path === 'package.json')).toBe(true);
    expect(report.configFacts[0]?.provenance.lineRange).toEqual({ start: 2, end: 2 });
  });

  it('does not derive a bin name from string-form package bin', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-package-string-bin-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    const packageJson = [
      '{',
      '  "name": "string-bin-package",',
      '  "version": "1.0.0",',
      '  "bin": "./dist/cli.js"',
      '}',
      '',
    ].join('\n');
    await writeFile(join(sourceDir, 'package.json'), packageJson, 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });

    expect(report.configFacts.map((fact) => fact.kind)).toEqual([
      'package-name',
      'package-version',
    ]);
    expect(report.configFacts.some((fact) => fact.kind === 'package-bin-name')).toBe(false);
  });

  it('emits package object keys even when sibling values are non-string or nested', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-package-mixed-objects-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    const packageJson = [
      '{',
      '  "bin": {',
      '    "cli": "./dist/cli.js",',
      '    "nested": { "target": "./dist/nested.js" }',
      '  },',
      '  "scripts": {',
      '    "build": "tsc",',
      '    "metadata": { "command": "not a script string" }',
      '  },',
      '  "dependencies": {',
      '    "actual": "^1.0.0",',
      '    "workspace": { "path": "../workspace" }',
      '  },',
      '  "devDependencies": {',
      '    "typed": false',
      '  }',
      '}',
      '',
    ].join('\n');
    await writeFile(join(sourceDir, 'package.json'), packageJson, 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });

    expect(
      report.configFacts.map(({ kind, name, group, fieldPath, provenance }) => ({
        kind,
        name,
        group,
        fieldPath,
        lineRange: provenance.lineRange,
      }))
    ).toEqual([
      {
        kind: 'package-bin-name',
        name: 'cli',
        group: undefined,
        fieldPath: 'bin.cli',
        lineRange: { start: 3, end: 3 },
      },
      {
        kind: 'package-bin-name',
        name: 'nested',
        group: undefined,
        fieldPath: 'bin.nested',
        lineRange: { start: 4, end: 4 },
      },
      {
        kind: 'package-script-name',
        name: 'build',
        group: undefined,
        fieldPath: 'scripts.build',
        lineRange: { start: 7, end: 7 },
      },
      {
        kind: 'package-script-name',
        name: 'metadata',
        group: undefined,
        fieldPath: 'scripts.metadata',
        lineRange: { start: 8, end: 8 },
      },
      {
        kind: 'package-dependency-name',
        name: 'actual',
        group: 'dependencies',
        fieldPath: 'dependencies.actual',
        lineRange: { start: 11, end: 11 },
      },
      {
        kind: 'package-dependency-name',
        name: 'workspace',
        group: 'dependencies',
        fieldPath: 'dependencies.workspace',
        lineRange: { start: 12, end: 12 },
      },
      {
        kind: 'package-dependency-name',
        name: 'typed',
        group: 'devDependencies',
        fieldPath: 'devDependencies.typed',
        lineRange: { start: 15, end: 15 },
      },
    ]);
  });

  it('uses later duplicate JSON keys for effective config fact provenance', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-config-duplicate-keys-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    const packageJson = [
      '{',
      '  "name": "early-name",',
      '  "name": "late-name",',
      '  "scripts": { "build": "early" },',
      '  "scripts": { "build": "late" }',
      '}',
      '',
    ].join('\n');
    await writeFile(join(sourceDir, 'package.json'), packageJson, 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });
    const nameFact = report.configFacts.find((fact) => fact.kind === 'package-name');
    const buildFact = report.configFacts.find((fact) => fact.kind === 'package-script-name');

    expect(nameFact).toMatchObject({
      value: 'late-name',
      provenance: {
        lineRange: { start: 3, end: 3 },
      },
      lineRangeGranularity: 'field',
    });
    expect(buildFact).toMatchObject({
      name: 'build',
      provenance: {
        lineRange: { start: 5, end: 5 },
      },
      lineRangeGranularity: 'field',
    });
  });

  it('extracts tsconfig evidence without inferring runtime or framework behavior', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-tsconfig-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    const tsconfigJson = [
      '{',
      '  // JSONC comments are accepted by TypeScript config parsing.',
      '  "extends": "./tsconfig.base.json",',
      '  "compilerOptions": {',
      '    "module": "NodeNext",',
      '    "strict": true',
      '  },',
      '  "include": [',
      '    "src/**/*.ts",',
      '    "tests/**/*.ts"',
      '  ],',
      '  "exclude": ["dist"],',
      '  "files": ["src/index.ts"]',
      '}',
      '',
    ].join('\n');
    await writeFile(join(sourceDir, 'tsconfig.build.json'), tsconfigJson, 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });

    expect(report.facts).toEqual([]);
    expect(
      report.configFacts.map(({ kind, name, value, group, fieldPath }) => ({
        kind,
        name,
        value,
        group,
        fieldPath,
      }))
    ).toEqual([
      {
        kind: 'tsconfig-extends',
        name: 'extends',
        value: './tsconfig.base.json',
        group: undefined,
        fieldPath: 'extends',
      },
      {
        kind: 'tsconfig-compiler-option',
        name: 'module',
        value: undefined,
        group: undefined,
        fieldPath: 'compilerOptions.module',
      },
      {
        kind: 'tsconfig-compiler-option',
        name: 'strict',
        value: undefined,
        group: undefined,
        fieldPath: 'compilerOptions.strict',
      },
      {
        kind: 'tsconfig-array-count',
        name: 'include',
        value: 2,
        group: 'include',
        fieldPath: 'include',
      },
      {
        kind: 'tsconfig-array-path',
        name: 'src/**/*.ts',
        value: 'src/**/*.ts',
        group: 'include',
        fieldPath: 'include',
      },
      {
        kind: 'tsconfig-array-path',
        name: 'tests/**/*.ts',
        value: 'tests/**/*.ts',
        group: 'include',
        fieldPath: 'include',
      },
      {
        kind: 'tsconfig-array-count',
        name: 'exclude',
        value: 1,
        group: 'exclude',
        fieldPath: 'exclude',
      },
      {
        kind: 'tsconfig-array-path',
        name: 'dist',
        value: 'dist',
        group: 'exclude',
        fieldPath: 'exclude',
      },
      {
        kind: 'tsconfig-array-count',
        name: 'files',
        value: 1,
        group: 'files',
        fieldPath: 'files',
      },
      {
        kind: 'tsconfig-array-path',
        name: 'src/index.ts',
        value: 'src/index.ts',
        group: 'files',
        fieldPath: 'files',
      },
    ]);
    expect(report.configFacts.every((fact) => fact.configFileKind === 'tsconfig-json')).toBe(true);
    expect(report.configFacts.every((fact) => fact.lineRangeGranularity === 'field')).toBe(true);
    expect(
      report.configFacts.find((fact) => fact.fieldPath === 'compilerOptions.module')?.provenance
        .lineRange
    ).toEqual({ start: 5, end: 5 });
    expect(
      report.configFacts.find((fact) => fact.fieldPath === 'compilerOptions.strict')?.provenance
        .lineRange
    ).toEqual({ start: 6, end: 6 });
    expect(report.configFacts[4]?.provenance.lineRange).toEqual({ start: 9, end: 9 });
  });

  it('emits string tsconfig array paths from mixed arrays while keeping full array counts', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-tsconfig-mixed-arrays-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });

    const tsconfigJson = [
      '{',
      '  "include": [',
      '    "src/**/*.ts",',
      '    false,',
      '    "tests/**/*.ts"',
      '  ],',
      '  "files": [',
      '    1,',
      '    "src/index.ts"',
      '  ]',
      '}',
      '',
    ].join('\n');
    await writeFile(join(sourceDir, 'tsconfig.json'), tsconfigJson, 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });

    expect(
      report.configFacts.map(({ kind, name, value, group, provenance }) => ({
        kind,
        name,
        value,
        group,
        lineRange: provenance.lineRange,
      }))
    ).toEqual([
      {
        kind: 'tsconfig-array-count',
        name: 'include',
        value: 3,
        group: 'include',
        lineRange: { start: 2, end: 6 },
      },
      {
        kind: 'tsconfig-array-path',
        name: 'src/**/*.ts',
        value: 'src/**/*.ts',
        group: 'include',
        lineRange: { start: 3, end: 3 },
      },
      {
        kind: 'tsconfig-array-path',
        name: 'tests/**/*.ts',
        value: 'tests/**/*.ts',
        group: 'include',
        lineRange: { start: 5, end: 5 },
      },
      {
        kind: 'tsconfig-array-count',
        name: 'files',
        value: 2,
        group: 'files',
        lineRange: { start: 7, end: 10 },
      },
      {
        kind: 'tsconfig-array-path',
        name: 'src/index.ts',
        value: 'src/index.ts',
        group: 'files',
        lineRange: { start: 9, end: 9 },
      },
    ]);
  });

  it('handles malformed and unsupported config files without hidden guesses', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-config-errors-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'package.json'), '{ "name": ', 'utf-8');
    await writeFile(join(sourceDir, 'tsconfig.json'), '{ "compilerOptions": ', 'utf-8');
    await writeFile(join(sourceDir, 'package-lock.json'), '{}\n', 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir });

    expect(
      report.files.map((file) => ({
        path: file.path,
        status: file.status,
        supported: file.supported,
        configFacts: file.configFacts.length,
        skipReason: file.skipReason,
      }))
    ).toEqual([
      {
        path: 'package-lock.json',
        status: 'skipped',
        supported: false,
        configFacts: 0,
        skipReason: 'unsupported-extension',
      },
      {
        path: 'package.json',
        status: 'inspected',
        supported: true,
        configFacts: 0,
        skipReason: undefined,
      },
      {
        path: 'tsconfig.json',
        status: 'inspected',
        supported: true,
        configFacts: 0,
        skipReason: undefined,
      },
    ]);
    expect(report.configFacts).toEqual([]);
    expect(report.warnings).toEqual([
      'Skipped unsupported file: package-lock.json',
      'Could not parse package config evidence in file: package.json',
      'Could not parse tsconfig evidence in file: tsconfig.json',
    ]);
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
    expect(depthReport.warnings).toContain(
      'Traversal pruned subtrees at max depth 0 (first: z-nested)'
    );

    const fullReport = await inspectSourceTruth({ source: sourceDir });

    expect(fullReport.files.map((file) => file.path)).toEqual(['root.ts', 'z-nested/deep.ts']);
    expect(fullReport.facts.map((fact) => fact.name)).toEqual(['root', 'deep']);
    expect(fullReport.warnings).toContain('Skipped symbolic link: linked.ts');
    expect(fullReport.warnings).toContain('Skipped directory by default: node_modules');
    expect(fullReport.files.some((file) => file.path.includes('ignored'))).toBe(false);
  });

  it('prunes only the over-deep subtree and still traverses later siblings (regression)', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-depth-prune-');
    const sourceDir = join(dir, 'source');
    // 'a-deep' sorts before 'b-shallow', so the old global-abort behavior would
    // drop 'b-shallow/found.ts' the moment 'a-deep/nested' exceeded maxDepth.
    await mkdir(join(sourceDir, 'a-deep/nested'), { recursive: true });
    await mkdir(join(sourceDir, 'b-shallow'), { recursive: true });
    await writeFile(join(sourceDir, 'a-deep/shallow.ts'), 'export const shallow = true;\n', 'utf-8');
    await writeFile(join(sourceDir, 'a-deep/nested/deep.ts'), 'export const deep = true;\n', 'utf-8');
    await writeFile(join(sourceDir, 'b-shallow/found.ts'), 'export const found = true;\n', 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir, maxDepth: 1 });

    expect(report.files.map((file) => file.path)).toEqual([
      'a-deep/shallow.ts',
      'b-shallow/found.ts',
    ]);
    expect(report.facts.map((fact) => fact.name)).toEqual(['shallow', 'found']);
    expect(report.traversal.truncated).toBe(true);
    expect(report.warnings).toContain(
      'Traversal pruned subtrees at max depth 1 (first: a-deep/nested)'
    );
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

  it('keeps lexicographically-first entries when maxEntries truncates a directory', async () => {
    const dir = await makeTempDir('llm-docs-source-truth-maxentries-');
    const sourceDir = join(dir, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'zeta.ts'), 'export const zeta = true;\n', 'utf-8');
    await writeFile(join(sourceDir, 'delta.ts'), 'export const delta = true;\n', 'utf-8');
    await writeFile(join(sourceDir, 'beta.ts'), 'export const beta = true;\n', 'utf-8');
    await writeFile(join(sourceDir, 'alpha.ts'), 'export const alpha = true;\n', 'utf-8');

    const report = await inspectSourceTruth({ source: sourceDir, maxEntries: 2 });
    const secondReport = await inspectSourceTruth({ source: sourceDir, maxEntries: 2 });

    expect(report.files.map((file) => file.path)).toEqual(['alpha.ts', 'beta.ts']);
    expect(secondReport.files.map((file) => file.path)).toEqual(['alpha.ts', 'beta.ts']);
    expect(report.facts.map((fact) => fact.name)).toEqual(['alpha', 'beta']);
    expect(report.traversal).toMatchObject({
      maxEntries: 2,
      visitedEntries: 2,
      visitedFiles: 2,
      inspectedFiles: 2,
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
