import { describe, expect, it } from 'vitest';

import { globToRegExp, matchesAnyGlob, matchesGlob } from '../../src/core/category-globs.js';

describe('category glob matching', () => {
  it('** spans path separators, * does not', () => {
    expect(matchesGlob('api/router/routeType.md', 'api/**')).toBe(true);
    expect(matchesGlob('api/router.md', 'api/*')).toBe(true);
    expect(matchesGlob('api/router/routeType.md', 'api/*')).toBe(false);
  });

  it('? matches a single non-separator character', () => {
    expect(matchesGlob('a.md', '?.md')).toBe(true);
    expect(matchesGlob('ab.md', '?.md')).toBe(false);
  });

  it('anchors the whole relpath', () => {
    expect(matchesGlob('guide/intro.md', 'guide/intro.md')).toBe(true);
    expect(matchesGlob('x/guide/intro.md', 'guide/**')).toBe(false);
  });

  it('escapes regex metacharacters in literals', () => {
    expect(globToRegExp('a+b.md').test('a+b.md')).toBe(true);
    expect(globToRegExp('a+b.md').test('axb.md')).toBe(false);
  });

  it('matchesAnyGlob is first-or-any across a list', () => {
    expect(matchesAnyGlob('start/react/x.md', ['guide/**', 'start/**'])).toBe(true);
    expect(matchesAnyGlob('router/x.md', ['guide/**', 'start/**'])).toBe(false);
  });
});
