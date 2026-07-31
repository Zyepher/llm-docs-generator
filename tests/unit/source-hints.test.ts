/**
 * Static validation for the compatibility source hint catalog.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const unverifiedDirectGenerationExamples = ['llm-docs generate --source'];

interface SourceHint {
  id?: unknown;
  format?: unknown;
  hint?: unknown;
  note?: unknown;
  status?: unknown;
  tested?: unknown;
  usage?: unknown;
}

interface SourceHintCatalog {
  sources?: SourceHint[];
}

async function readSourceHintCatalog(): Promise<SourceHintCatalog> {
  return JSON.parse(
    await readFile(join(repoRoot, 'config/known-sources.json'), 'utf-8')
  ) as SourceHintCatalog;
}

describe('source hint catalog', () => {
  it('uses hint entries instead of unverified direct generation commands', async () => {
    const catalog = await readSourceHintCatalog();

    expect(Array.isArray(catalog.sources)).toBe(true);
    expect(catalog.sources?.length).toBeGreaterThan(0);

    for (const source of catalog.sources ?? []) {
      expect(typeof source.hint).toBe('string');
      expect((source.hint as string).trim().length).toBeGreaterThan(0);
      for (const directGenerationExample of unverifiedDirectGenerationExamples) {
        expect(source.hint as string).not.toContain(directGenerationExample);
      }
      expect(source).not.toHaveProperty('usage');
      expect(typeof source.tested).toBe('boolean');
    }
  });

  it('keeps planned source hints untested until the source path and workflow are validated', async () => {
    const catalog = await readSourceHintCatalog();
    const plannedSources = (catalog.sources ?? []).filter((source) => source.status === 'planned');

    expect(plannedSources.length).toBeGreaterThan(0);

    for (const source of plannedSources) {
      expect(source.tested).toBe(false);
      expect(typeof source.note).toBe('string');
      expect((source.note as string).trim().length).toBeGreaterThan(0);
    }
  });

  it('marks the Python RST hint as unvalidated for current explicit local source generation', async () => {
    const catalog = await readSourceHintCatalog();
    const pythonSource = (catalog.sources ?? []).find((source) => source.id === 'python-docs');

    expect(pythonSource).toMatchObject({
      format: 'restructuredtext',
      tested: false,
      status: 'planned',
    });
    expect(pythonSource?.hint).toContain(
      'has not been validated with the current explicit local source generation workflow'
    );
    expect(pythonSource?.note).toContain('agent verification of repository, path, version');
  });
});
