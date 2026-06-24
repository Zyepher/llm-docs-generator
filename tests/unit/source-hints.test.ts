/**
 * Static validation for the compatibility source hint catalog.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const implementedFormats = new Set(['openref', 'markdown']);
const unsupportedCurrentCliExamples = ['llm-docs generate --source'];

interface SourceHint {
  format?: unknown;
  hint?: unknown;
  status?: unknown;
  tested?: unknown;
  usage?: unknown;
}

interface SourceHintCatalog {
  sources?: SourceHint[];
}

async function readSourceHintCatalog(): Promise<SourceHintCatalog> {
  return JSON.parse(await readFile(join(repoRoot, 'config/known-sources.json'), 'utf-8')) as
    SourceHintCatalog;
}

describe('source hint catalog', () => {
  it('uses hint entries instead of unsupported usage commands', async () => {
    const catalog = await readSourceHintCatalog();

    expect(Array.isArray(catalog.sources)).toBe(true);
    expect(catalog.sources?.length).toBeGreaterThan(0);

    for (const source of catalog.sources ?? []) {
      expect(typeof source.hint).toBe('string');
      expect((source.hint as string).trim().length).toBeGreaterThan(0);
      for (const unsupportedExample of unsupportedCurrentCliExamples) {
        expect(source.hint as string).not.toContain(unsupportedExample);
      }
      expect(source).not.toHaveProperty('usage');
      expect(typeof source.tested).toBe('boolean');
    }
  });

  it('keeps planned formats untested until parser and CLI support exists', async () => {
    const catalog = await readSourceHintCatalog();
    const unimplementedFormatSources = (catalog.sources ?? []).filter(
      (source) => typeof source.format === 'string' && !implementedFormats.has(source.format)
    );

    expect(unimplementedFormatSources.length).toBeGreaterThan(0);

    for (const source of unimplementedFormatSources) {
      expect(source.status).toBe('planned');
      expect(source.tested).toBe(false);
    }
  });
});
