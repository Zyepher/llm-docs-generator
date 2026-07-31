import { describe, expect, it } from 'vitest';

import {
  joinPosix,
  rewriteProseLinks,
  rewriteRelativeMarkdownUrl,
  type LinkRewriteContext,
  type MarkdownLinkGitContext,
  type UnrewrittenLinkClass,
} from '../../src/core/markdown-links.js';

interface Spies {
  unresolved: string[];
  unrewritten: UnrewrittenLinkClass[];
  nonGithub: number;
}

function makeContext(overrides: Partial<LinkRewriteContext> & { spies?: Spies } = {}): {
  context: LinkRewriteContext;
  spies: Spies;
} {
  const spies: Spies = overrides.spies ?? { unresolved: [], unrewritten: [], nonGithub: 0 };
  const context: LinkRewriteContext = {
    currentRelpath: overrides.currentRelpath ?? 'guide/intro.md',
    packRelpaths: overrides.packRelpaths ?? new Set(['guide/intro.md', 'api/router.md']),
    linkDefinitions: overrides.linkDefinitions ?? new Map([['site', 'https://example.com/site']]),
    ...(overrides.gitContext === undefined ? {} : { gitContext: overrides.gitContext }),
    ...(overrides.fileExistsInRepo === undefined
      ? {}
      : { fileExistsInRepo: overrides.fileExistsInRepo }),
    onUnresolvedReference: (label) => spies.unresolved.push(label),
    onUnrewrittenLink: (kind) => {
      spies.unrewritten.push(kind);
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

describe('rewriteProseLinks opaque link text (F1)', () => {
  const backtickContext = () =>
    makeContext({
      currentRelpath: 'api/router/FileRouteClass.md',
      packRelpaths: new Set(['api/router/FileRouteClass.md', 'api/router/RouteOptionsType.md']),
      linkDefinitions: new Map(),
    });

  it('rewrites an inline link whose text is an inline code span (FileRouteClass case)', () => {
    const { context } = backtickContext();
    expect(rewriteProseLinks('- [`RouteOptions`](./RouteOptionsType.md)', context)).toBe(
      '- [`RouteOptions`](pack:api/router/RouteOptionsType.md)'
    );
  });

  it('rewrites plain-text and backtick-text links to the same target identically', () => {
    const { context: plain } = backtickContext();
    const { context: coded } = backtickContext();
    expect(rewriteProseLinks('[RouteOptions](./RouteOptionsType.md)', plain)).toBe(
      '[RouteOptions](pack:api/router/RouteOptionsType.md)'
    );
    expect(rewriteProseLinks('[`RouteOptions`](./RouteOptionsType.md)', coded)).toBe(
      '[`RouteOptions`](pack:api/router/RouteOptionsType.md)'
    );
  });

  it('preserves an inline code span in link text while rewriting the target', () => {
    const { context } = backtickContext();
    expect(
      rewriteProseLinks('see [the `RouteOptions` type](./RouteOptionsType.md) here', context)
    ).toBe('see [the `RouteOptions` type](pack:api/router/RouteOptionsType.md) here');
  });

  it('does not let a stray code span outside a link swallow the link', () => {
    const { context } = backtickContext();
    expect(rewriteProseLinks('`code` then [`RouteOptions`](./RouteOptionsType.md)', context)).toBe(
      '`code` then [`RouteOptions`](pack:api/router/RouteOptionsType.md)'
    );
  });
});

describe('rewriteProseLinks nested badge constructs (F3)', () => {
  const badgeDefs = () =>
    new Map([
      ['stars-router', 'https://img.shields.io/github/stars/tanstack/router'],
      ['gh-router', 'https://github.com/tanstack/router'],
    ]);

  it('inlines the outer link ref around an already-inlined image ref', () => {
    const { context } = makeContext({ linkDefinitions: badgeDefs() });
    expect(rewriteProseLinks('[![][stars-router]][gh-router]', context)).toBe(
      '[![](https://img.shields.io/github/stars/tanstack/router)](https://github.com/tanstack/router)'
    );
  });

  it('leaves no dangling ][ref] when both defs resolve', () => {
    const { context } = makeContext({ linkDefinitions: badgeDefs() });
    const out = rewriteProseLinks('| [![][stars-router]][gh-router] |', context);
    expect(out).not.toContain('][gh-router]');
    expect(out).not.toContain('[stars-router]');
  });

  it('warns and leaves the whole construct raw when the outer ref is missing', () => {
    const { context, spies } = makeContext({
      linkDefinitions: new Map([['stars-router', 'https://img.shields.io/x']]),
    });
    // The outer full-reference `[...][gh-router]` is unresolved: the construct is
    // atomic, so it is emitted verbatim (inner not separately inlined) and warned.
    expect(rewriteProseLinks('[![][stars-router]][gh-router]', context)).toBe(
      '[![][stars-router]][gh-router]'
    );
    expect(spies.unresolved).toEqual(['gh-router']);
  });
});

describe('rewriteProseLinks bare relative targets', () => {
  it('rewrites a bare (no ./ prefix) in-pack relative link', () => {
    const { context } = makeContext({
      currentRelpath: 'api/functions/injectQuery.md',
      packRelpaths: new Set(['api/functions/injectQuery.md', 'api/functions/createQuery.md']),
      linkDefinitions: new Map(),
    });
    expect(rewriteProseLinks('[q](createQuery.md)', context)).toBe(
      '[q](pack:api/functions/createQuery.md)'
    );
  });
});

describe('rewriteProseLinks site-absolute targets (F4)', () => {
  it('leaves a site-absolute .md link unchanged even with git context', () => {
    const { context } = makeContext({
      gitContext: {
        remoteUrl: 'https://github.com/acme/widget',
        commit: 'abc123',
        sourceRootFromRepo: 'docs',
      },
    });
    const input =
      'see the [How-to Guides](/router/latest/docs/framework/react/how-to/README.md#authentication)';
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

  it('counts an out-of-pack relative .md link as unresolvable when no probe exists', () => {
    // No fileExistsInRepo oracle: the target is unprovable, so it is counted
    // (not pinned, whether or not git context is present).
    const { context, spies } = makeContext();
    expect(rewriteProseLinks('see [x](../../outside/thing.md)', context)).toBe(
      'see [x](../../outside/thing.md)'
    );
    expect(spies.unrewritten).toEqual(['unresolvable-relative']);
  });

  it('counts an on-disk out-of-pack .md link as no-git-context when git is absent', () => {
    const { context, spies } = makeContext({
      fileExistsInRepo: (relpath) => relpath === '../outside/thing.md',
    });
    expect(rewriteProseLinks('see [x](../../outside/thing.md)', context)).toBe(
      'see [x](../../outside/thing.md)'
    );
    expect(spies.unrewritten).toEqual(['no-git-context']);
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

describe('rewriteRelativeMarkdownUrl extension-less in-pack resolution', () => {
  // TanStack/VitePress/Docusaurus/MkDocs default: route-style links with no
  // `.md` extension. These MUST resolve deterministically against the file set.
  const startPack = () =>
    makeContext({
      currentRelpath: 'framework/react/guide/seo.md',
      packRelpaths: new Set([
        'framework/react/guide/seo.md',
        'framework/react/guide/server-routes.md',
        'framework/react/installation/with-vite.md',
        'framework/react/api/router.md',
      ]),
      linkDefinitions: new Map(),
    });

  it('rewrites a sibling extension-less route (./server-routes) to a pack link', () => {
    const { context, spies } = startPack();
    expect(rewriteRelativeMarkdownUrl('./server-routes', context)).toBe(
      'pack:framework/react/guide/server-routes.md'
    );
    expect(spies.unrewritten).toEqual([]);
  });

  it('rewrites a bare (no ./) extension-less sibling route', () => {
    const { context } = startPack();
    expect(rewriteRelativeMarkdownUrl('server-routes', context)).toBe(
      'pack:framework/react/guide/server-routes.md'
    );
  });

  it('rewrites an ancestor extension-less route (../installation/with-vite)', () => {
    const { context } = startPack();
    expect(rewriteRelativeMarkdownUrl('../installation/with-vite', context)).toBe(
      'pack:framework/react/installation/with-vite.md'
    );
  });

  it('preserves the #fragment on an extension-less route (../api/router#createlink)', () => {
    const { context } = startPack();
    expect(rewriteRelativeMarkdownUrl('../api/router#createlink', context)).toBe(
      'pack:framework/react/api/router.md#createlink'
    );
  });

  it('resolves an .mdx candidate', () => {
    const { context } = makeContext({
      currentRelpath: 'guide/intro.md',
      packRelpaths: new Set(['guide/intro.md', 'guide/deep-dive.mdx']),
      linkDefinitions: new Map(),
    });
    expect(rewriteRelativeMarkdownUrl('./deep-dive', context)).toBe('pack:guide/deep-dive.mdx');
  });

  it('resolves a directory reference to its index file', () => {
    const { context } = makeContext({
      currentRelpath: 'guide/intro.md',
      packRelpaths: new Set(['guide/intro.md', 'guide/advanced/index.md']),
      linkDefinitions: new Map(),
    });
    expect(rewriteRelativeMarkdownUrl('./advanced', context)).toBe('pack:guide/advanced/index.md');
    expect(rewriteRelativeMarkdownUrl('./advanced/', context)).toBe('pack:guide/advanced/index.md');
  });

  it('prefers the file candidate over a directory index for a plain route', () => {
    const { context } = makeContext({
      currentRelpath: 'guide/intro.md',
      packRelpaths: new Set(['guide/intro.md', 'guide/topic.md', 'guide/topic/index.md']),
      linkDefinitions: new Map(),
    });
    expect(rewriteRelativeMarkdownUrl('./topic', context)).toBe('pack:guide/topic.md');
  });

  it('prefers the directory index for a trailing-slash route', () => {
    const { context } = makeContext({
      currentRelpath: 'guide/intro.md',
      packRelpaths: new Set(['guide/intro.md', 'guide/topic.md', 'guide/topic/index.md']),
      linkDefinitions: new Map(),
    });
    expect(rewriteRelativeMarkdownUrl('./topic/', context)).toBe('pack:guide/topic/index.md');
  });
});

describe('rewriteRelativeMarkdownUrl extension-less unresolvable + on-disk', () => {
  it('counts an unresolvable extension-less relative target and leaves it unchanged', () => {
    const { context, spies } = makeContext({ linkDefinitions: new Map() });
    expect(rewriteRelativeMarkdownUrl('./does-not-exist', context)).toBeUndefined();
    expect(spies.unrewritten).toEqual(['unresolvable-relative']);
  });

  it('does not probe disk for an extension-less target that resolves in-pack', () => {
    let probed = false;
    const { context } = makeContext({
      currentRelpath: 'guide/intro.md',
      packRelpaths: new Set(['guide/intro.md', 'guide/seo.md']),
      linkDefinitions: new Map(),
      fileExistsInRepo: () => {
        probed = true;
        return true;
      },
    });
    expect(rewriteRelativeMarkdownUrl('./seo', context)).toBe('pack:guide/seo.md');
    expect(probed).toBe(false);
  });

  it('pins an out-of-pack extension-less target that exists on disk to a github blob url', () => {
    const seen: string[] = [];
    const { context, spies } = makeContext({
      currentRelpath: 'guide/intro.md',
      packRelpaths: new Set(['guide/intro.md']),
      linkDefinitions: new Map(),
      gitContext: {
        remoteUrl: 'git@github.com:acme/widget.git',
        commit: 'c0ffee',
        sourceRootFromRepo: 'docs',
      },
      fileExistsInRepo: (relpath) => {
        seen.push(relpath);
        return relpath === '../shared/util.md';
      },
    });
    expect(rewriteRelativeMarkdownUrl('../../shared/util', context)).toBe(
      'https://github.com/acme/widget/blob/c0ffee/shared/util.md'
    );
    expect(spies.unrewritten).toEqual([]);
    // The .md candidate is probed first, in order.
    expect(seen[0]).toBe('../shared/util.md');
  });

  it('counts an on-disk extension-less target as no-git-context when git is absent', () => {
    const { context, spies } = makeContext({
      currentRelpath: 'guide/intro.md',
      packRelpaths: new Set(['guide/intro.md']),
      linkDefinitions: new Map(),
      fileExistsInRepo: (relpath) => relpath === '../shared/util.md',
    });
    expect(rewriteRelativeMarkdownUrl('../../shared/util', context)).toBeUndefined();
    expect(spies.unrewritten).toEqual(['no-git-context']);
  });

  it('reports a non-github remote for an on-disk extension-less out-of-pack target', () => {
    const { context, spies } = makeContext({
      currentRelpath: 'guide/intro.md',
      packRelpaths: new Set(['guide/intro.md']),
      linkDefinitions: new Map(),
      gitContext: {
        remoteUrl: 'git@gitlab.com:acme/widget.git',
        commit: 'c0ffee',
        sourceRootFromRepo: 'docs',
      },
      fileExistsInRepo: (relpath) => relpath === '../shared/util.md',
    });
    expect(rewriteRelativeMarkdownUrl('../../shared/util', context)).toBeUndefined();
    expect(spies.nonGithub).toBe(1);
    expect(spies.unrewritten).toEqual([]);
  });
});

describe('rewriteRelativeMarkdownUrl non-doc and asset targets', () => {
  it('leaves a relative non-doc asset untouched and does not count it', () => {
    const { context, spies } = makeContext({ linkDefinitions: new Map() });
    expect(rewriteRelativeMarkdownUrl('../assets/logo.png', context)).toBeUndefined();
    expect(rewriteRelativeMarkdownUrl('./data.json', context)).toBeUndefined();
    expect(spies.unrewritten).toEqual([]);
  });

  it('does not rewrite an extension-less image target', () => {
    const { context } = makeContext({
      currentRelpath: 'guide/intro.md',
      packRelpaths: new Set(['guide/intro.md', 'guide/seo.md']),
      linkDefinitions: new Map(),
    });
    // Images never have their destination rewritten, even when it would resolve.
    expect(rewriteProseLinks('![diagram](./seo)', context)).toBe('![diagram](./seo)');
  });
});

describe('rewriteRelativeMarkdownUrl external targets', () => {
  const git = (remoteUrl: string | null): MarkdownLinkGitContext => ({
    remoteUrl,
    commit: 'abc123',
    sourceRootFromRepo: 'docs',
  });
  const outsideExists = (relpath: string) => relpath === '../outside/thing.md';

  it('pins an on-disk out-of-pack target to a github blob url from an ssh remote', () => {
    const { context } = makeContext({
      gitContext: git('git@github.com:acme/widget.git'),
      fileExistsInRepo: outsideExists,
    });
    expect(rewriteRelativeMarkdownUrl('../../outside/thing.md#a', context)).toBe(
      'https://github.com/acme/widget/blob/abc123/outside/thing.md#a'
    );
  });

  it('pins an on-disk out-of-pack target to a github blob url from an https remote', () => {
    const { context } = makeContext({
      gitContext: git('https://github.com/acme/widget'),
      fileExistsInRepo: outsideExists,
    });
    expect(rewriteRelativeMarkdownUrl('../../outside/thing.md', context)).toBe(
      'https://github.com/acme/widget/blob/abc123/outside/thing.md'
    );
  });

  it('leaves a non-github remote unchanged and reports it', () => {
    const { context, spies } = makeContext({
      gitContext: git('git@gitlab.com:acme/widget.git'),
      fileExistsInRepo: outsideExists,
    });
    expect(rewriteRelativeMarkdownUrl('../../outside/thing.md', context)).toBeUndefined();
    expect(spies.nonGithub).toBe(1);
  });

  it('does not pin a dead .md target and counts it as unresolvable', () => {
    // Regression: a dead explicit .md target used to be pinned to a confident
    // blob URL for a file that does not exist (a fabricated citation).
    const { context, spies } = makeContext({
      gitContext: git('git@github.com:acme/widget.git'),
      fileExistsInRepo: () => false,
    });
    expect(rewriteRelativeMarkdownUrl('./does-not-exist.md', context)).toBeUndefined();
    expect(spies.unrewritten).toEqual(['unresolvable-relative']);
    expect(spies.nonGithub).toBe(0);
  });

  it('leaves a dead .md link unchanged in prose and never invents a blob url', () => {
    const { context, spies } = makeContext({
      gitContext: git('git@github.com:acme/widget.git'),
      fileExistsInRepo: () => false,
    });
    expect(rewriteProseLinks('a [gone](./does-not-exist.md) link', context)).toBe(
      'a [gone](./does-not-exist.md) link'
    );
    expect(spies.unrewritten).toEqual(['unresolvable-relative']);
  });

  it('does not pin an out-of-pack .md target when no existence probe is available', () => {
    // Relocated pack / configured-SDK path: no repo on disk, so existence is
    // unprovable and the link must be counted, not pinned.
    const { context, spies } = makeContext({ gitContext: git('git@github.com:acme/widget.git') });
    expect(rewriteRelativeMarkdownUrl('../../outside/thing.md', context)).toBeUndefined();
    expect(spies.unrewritten).toEqual(['unresolvable-relative']);
  });

  it('does not probe the repo for an in-pack .md target', () => {
    let probed = false;
    const { context } = makeContext({
      gitContext: git('git@github.com:acme/widget.git'),
      fileExistsInRepo: () => {
        probed = true;
        return true;
      },
    });
    expect(rewriteRelativeMarkdownUrl('../api/router.md', context)).toBe('pack:api/router.md');
    expect(probed).toBe(false);
  });

  it('never builds a blob url for a .md target that escapes the repo root', () => {
    // Even a permissive oracle must not leak a repo-escaping path into a URL:
    // sourceRootFromRepo is `docs`, so this normalizes above the repo root.
    const { context, spies } = makeContext({
      gitContext: git('git@github.com:acme/widget.git'),
      fileExistsInRepo: () => true,
    });
    expect(rewriteRelativeMarkdownUrl('../../../../etc/passwd.md', context)).toBeUndefined();
    expect(spies.unrewritten).toEqual(['unresolvable-relative']);
    expect(spies.nonGithub).toBe(0);
  });

  it('never builds a blob url for an extension-less target that escapes the repo root', () => {
    const { context, spies } = makeContext({
      linkDefinitions: new Map(),
      gitContext: git('git@github.com:acme/widget.git'),
      fileExistsInRepo: () => true,
    });
    expect(rewriteRelativeMarkdownUrl('../../../../etc/passwd', context)).toBeUndefined();
    expect(spies.unrewritten).toEqual(['unresolvable-relative']);
    expect(spies.nonGithub).toBe(0);
  });

  it('leaves absolute and non-markdown targets alone', () => {
    const { context } = makeContext();
    expect(rewriteRelativeMarkdownUrl('https://x.example/y.md', context)).toBeUndefined();
    expect(rewriteRelativeMarkdownUrl('../assets/logo.png', context)).toBeUndefined();
  });

  it('treats a site-absolute .md path as unrewritable and counts it (F4)', () => {
    const { context, spies } = makeContext({ gitContext: git('git@github.com:acme/widget.git') });
    expect(
      rewriteRelativeMarkdownUrl(
        '/router/latest/docs/framework/react/how-to/README.md#auth',
        context
      )
    ).toBeUndefined();
    expect(spies.unrewritten).toEqual(['site-absolute']);
  });

  it('counts a site-absolute extension-less route as a doc cross-reference (F4)', () => {
    const { context, spies } = makeContext({ gitContext: git('git@github.com:acme/widget.git') });
    expect(
      rewriteRelativeMarkdownUrl('/router/latest/docs/guide/preloading', context)
    ).toBeUndefined();
    expect(spies.unrewritten).toEqual(['site-absolute']);
  });

  it('does not count a site-absolute non-doc asset path', () => {
    const { context, spies } = makeContext({ gitContext: git('git@github.com:acme/widget.git') });
    expect(rewriteRelativeMarkdownUrl('/img/logo.png', context)).toBeUndefined();
    expect(spies.unrewritten).toEqual([]);
  });

  it('leaves an angle-bracket destination unchanged and never counts it', () => {
    const { context, spies } = makeContext({ linkDefinitions: new Map() });
    // `[abbr](<https://en.wikipedia.org/wiki/Garbage_collection_(computer_science)>)`
    // parses to a `<...`-prefixed target; its last segment has no extension, so
    // without the guard it would be miscounted as an unresolvable relative link.
    expect(
      rewriteRelativeMarkdownUrl('<https://en.wikipedia.org/wiki/Garbage_collection_(x', context)
    ).toBeUndefined();
    expect(spies.unrewritten).toEqual([]);
    expect(spies.nonGithub).toBe(0);
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
