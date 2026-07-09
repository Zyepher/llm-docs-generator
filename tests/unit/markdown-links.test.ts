import { describe, expect, it } from 'vitest';

import {
  joinPosix,
  rewriteProseLinks,
  rewriteRelativeMarkdownUrl,
  type LinkRewriteContext,
  type MarkdownLinkGitContext,
} from '../../src/core/markdown-links.js';

interface Spies {
  unresolved: string[];
  unrewritten: number;
  nonGithub: number;
}

function makeContext(overrides: Partial<LinkRewriteContext> & { spies?: Spies } = {}): {
  context: LinkRewriteContext;
  spies: Spies;
} {
  const spies: Spies = overrides.spies ?? { unresolved: [], unrewritten: 0, nonGithub: 0 };
  const context: LinkRewriteContext = {
    currentRelpath: overrides.currentRelpath ?? 'guide/intro.md',
    packRelpaths: overrides.packRelpaths ?? new Set(['guide/intro.md', 'api/router.md']),
    linkDefinitions: overrides.linkDefinitions ?? new Map([['site', 'https://example.com/site']]),
    ...(overrides.gitContext === undefined ? {} : { gitContext: overrides.gitContext }),
    onUnresolvedReference: (label) => spies.unresolved.push(label),
    onUnrewrittenRelativeLink: () => {
      spies.unrewritten += 1;
    },
    onNonGithubRemote: () => {
      spies.nonGithub += 1;
    },
  };
  return { context, spies };
}

describe('rewriteProseLinks reference definitions', () => {
  it('inlines a full reference use', () => {
    const { context } = makeContext();
    expect(rewriteProseLinks('see [the site][site] now', context)).toBe(
      'see [the site](https://example.com/site) now'
    );
  });

  it('inlines a collapsed reference use', () => {
    const { context } = makeContext();
    expect(rewriteProseLinks('see [site][] now', context)).toBe(
      'see [site](https://example.com/site) now'
    );
  });

  it('inlines a shortcut reference use', () => {
    const { context } = makeContext();
    expect(rewriteProseLinks('see [site] now', context)).toBe(
      'see [site](https://example.com/site) now'
    );
  });

  it('warns on an unresolved full reference and leaves it unchanged', () => {
    const { context, spies } = makeContext();
    expect(rewriteProseLinks('see [x][missing] now', context)).toBe('see [x][missing] now');
    expect(spies.unresolved).toEqual(['missing']);
  });

  it('leaves a shortcut with no definition silently unchanged', () => {
    const { context, spies } = makeContext();
    expect(rewriteProseLinks('this is [not a link] here', context)).toBe(
      'this is [not a link] here'
    );
    expect(spies.unresolved).toEqual([]);
  });

  it('never rewrites links inside inline code spans', () => {
    const { context } = makeContext();
    const input = 'literal `[site]` and `[a](../api/router.md)` stay';
    expect(rewriteProseLinks(input, context)).toBe(input);
  });
});

describe('rewriteProseLinks relative links', () => {
  it('rewrites an in-pack relative .md link to a pack: link with fragment', () => {
    const { context } = makeContext();
    expect(rewriteProseLinks('go to [router](../api/router.md#usage)', context)).toBe(
      'go to [router](pack:api/router.md#usage)'
    );
  });

  it('leaves an out-of-pack relative link unchanged and counts it without git context', () => {
    const { context, spies } = makeContext();
    expect(rewriteProseLinks('see [x](../../outside/thing.md)', context)).toBe(
      'see [x](../../outside/thing.md)'
    );
    expect(spies.unrewritten).toBe(1);
  });

  it('leaves an in-page anchor unchanged', () => {
    const { context } = makeContext();
    expect(rewriteProseLinks('jump to [setup](#setup)', context)).toBe('jump to [setup](#setup)');
  });

  it('does not rewrite image links', () => {
    const { context } = makeContext();
    expect(rewriteProseLinks('![alt](../api/router.md)', context)).toBe('![alt](../api/router.md)');
  });
});

describe('rewriteRelativeMarkdownUrl external targets', () => {
  const git = (remoteUrl: string | null): MarkdownLinkGitContext => ({
    remoteUrl,
    commit: 'abc123',
    sourceRootFromRepo: 'docs',
  });

  it('pins an out-of-pack target to a github blob url from an ssh remote', () => {
    const { context } = makeContext({ gitContext: git('git@github.com:acme/widget.git') });
    expect(rewriteRelativeMarkdownUrl('../../outside/thing.md#a', context)).toBe(
      'https://github.com/acme/widget/blob/abc123/outside/thing.md#a'
    );
  });

  it('pins an out-of-pack target to a github blob url from an https remote', () => {
    const { context } = makeContext({ gitContext: git('https://github.com/acme/widget') });
    expect(rewriteRelativeMarkdownUrl('../../outside/thing.md', context)).toBe(
      'https://github.com/acme/widget/blob/abc123/outside/thing.md'
    );
  });

  it('leaves a non-github remote unchanged and reports it', () => {
    const { context, spies } = makeContext({ gitContext: git('git@gitlab.com:acme/widget.git') });
    expect(rewriteRelativeMarkdownUrl('../../outside/thing.md', context)).toBeUndefined();
    expect(spies.nonGithub).toBe(1);
  });

  it('leaves absolute and non-markdown targets alone', () => {
    const { context } = makeContext();
    expect(rewriteRelativeMarkdownUrl('https://x.example/y.md', context)).toBeUndefined();
    expect(rewriteRelativeMarkdownUrl('../assets/logo.png', context)).toBeUndefined();
  });
});

describe('joinPosix', () => {
  it('resolves . and .. segments', () => {
    expect(joinPosix('guide', '../api/router.md')).toBe('api/router.md');
    expect(joinPosix('guide/sub', './x.md')).toBe('guide/sub/x.md');
    expect(joinPosix('guide', '../../outside/thing.md')).toBe('../outside/thing.md');
    expect(joinPosix('', 'top.md')).toBe('top.md');
  });
});
