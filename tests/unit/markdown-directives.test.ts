import { describe, expect, it } from 'vitest';

import {
  applyMarkdownDirectives,
  MARKDOWN_DIRECTIVE_EXTENSIONS,
  tanstackTabsExtension,
} from '../../src/parsers/markdown/directives/index.js';

describe('markdown directive registry', () => {
  it('ships the TanStack tabs dialect as the first registered extension', () => {
    expect(MARKDOWN_DIRECTIVE_EXTENSIONS[0]).toBe(tanstackTabsExtension);
    expect(MARKDOWN_DIRECTIVE_EXTENSIONS[0]?.name).toBe('tanstack-tabs');
  });
});

describe('tanstack tabs: deterministic marker detection', () => {
  it('does not apply to a document without the exact start marker', () => {
    expect(tanstackTabsExtension.appliesTo('# Heading\n\nprose without markers\n')).toBe(false);
    // A stray end marker with no start marker is not an activation signal.
    expect(tanstackTabsExtension.appliesTo('<!-- ::end:tabs -->\n')).toBe(false);
  });

  it('applies only when the exact start-marker syntax is present', () => {
    expect(
      tanstackTabsExtension.appliesTo('<!-- ::start:framework -->\n# React\n<!-- ::end:framework -->\n')
    ).toBe(true);
    expect(
      tanstackTabsExtension.appliesTo('<!--   ::start:tabs variant="bundler"  -->\n')
    ).toBe(true);
  });
});

describe('applyMarkdownDirectives: no-op guarantee (structural)', () => {
  it('returns marker-free markdown byte-for-byte unchanged', () => {
    const plain = '# Title\n\nSome prose.\n\n## Section\n\n```ts\nconst x = 1;\n```\n\nMore text.\n';
    expect(applyMarkdownDirectives(plain)).toBe(plain);
  });

  it('leaves content whose only marker is inside a fenced code block unchanged', () => {
    const fenced = '# Title\n\n```md\n<!-- ::start:tabs -->\n# Item\n<!-- ::end:tabs -->\n```\n\nafter\n';
    // Activation fires (the literal marker is present), but the fence-aware
    // transform touches nothing inside the fence, so the round-trip is exact.
    expect(applyMarkdownDirectives(fenced)).toBe(fenced);
  });
});

describe('applyMarkdownDirectives: TanStack tabs transform', () => {
  it('appends the switch axis to item labels, demotes headings, and strips markers', () => {
    const input = [
      '## Install',
      '',
      '<!-- ::start:tabs variant="package-managers" -->',
      '# npm',
      '',
      'npm install foo',
      '',
      '# pnpm',
      '',
      'pnpm add foo',
      '<!-- ::end:tabs -->',
      '',
      '### After',
      '',
    ].join('\n');

    const output = applyMarkdownDirectives(input);

    // Item labels carry the axis and are demoted under the enclosing H2.
    expect(output).toContain('### npm (package-managers)');
    expect(output).toContain('### pnpm (package-managers)');
    // Directive comment markers are removed.
    expect(output).not.toContain('::start:tabs');
    expect(output).not.toContain('::end:tabs');
    // Content after the block returns to the enclosing section, unchanged.
    expect(output).toContain('### After');
    // No bare, undifferentiated item label survives.
    expect(output).not.toMatch(/^#{1,6} npm$/m);
  });

  it('uses the directive kind as the axis when no variant attribute is present', () => {
    const input = ['# React', '<!-- ::start:framework -->', '## Solid', '<!-- ::end:framework -->', ''].join(
      '\n'
    );
    const output = applyMarkdownDirectives(input);
    expect(output).toContain('Solid (framework)');
  });
});
