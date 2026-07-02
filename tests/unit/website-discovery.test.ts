/**
 * Pure-function tests for website-discovery candidate extraction:
 * entity decoding (single pass, once per extraction boundary), paren-aware
 * llms.txt URL extraction, and quote-aware HTML tag scanning. No network.
 */

import { describe, expect, it } from 'vitest';

import {
  type CandidateCollectionState,
  decodeHtmlEntities,
  decodeXmlEntities,
  extractCandidatesFromResource,
  extractMarkdownLinkUrls,
  findHtmlTags,
  type PlannedWebsiteResource,
  trimBareUrl,
  type WebsiteResourceRole,
} from '../../src/core/website-discovery.js';

const WEBSITE_ORIGIN = 'https://example.com';

const RESOURCE_URLS: Record<WebsiteResourceRole, string> = {
  'explicit-url': 'https://example.com/',
  'llms-txt': 'https://example.com/llms.txt',
  'sitemap-xml': 'https://example.com/sitemap.xml',
};

function collectCandidateUrls(
  sourceRole: WebsiteResourceRole,
  text: string
): { urls: string[]; warnings: string[] } {
  const plannedResource: PlannedWebsiteResource = {
    url: RESOURCE_URLS[sourceRole],
    sourceRole,
  };
  const state: CandidateCollectionState = {
    candidatesByUrl: new Map(),
    maxCandidates: 50,
    nextObservedOrder: 1,
    limitReached: false,
  };
  const warnings: string[] = [];

  extractCandidatesFromResource({
    plannedResource,
    text,
    websiteOrigin: WEBSITE_ORIGIN,
    state,
    warnings,
  });

  return { urls: [...state.candidatesByUrl.keys()], warnings };
}

describe('decodeHtmlEntities', () => {
  it('decodes each entity exactly once, so double-escaped input stays escaped', () => {
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;');
  });

  it('decodes single-escaped entities', () => {
    expect(decodeHtmlEntities('&amp;')).toBe('&');
    expect(decodeHtmlEntities('&lt;')).toBe('<');
    expect(decodeHtmlEntities('&gt;')).toBe('>');
    expect(decodeHtmlEntities('&quot;')).toBe('"');
    expect(decodeHtmlEntities('&#39;')).toBe("'");
  });

  it('decodes mixed strings in one pass', () => {
    expect(decodeHtmlEntities('a &lt;b&gt; &quot;c&quot; &#39;d&#39; &amp;amp; e')).toBe(
      'a <b> "c" \'d\' &amp; e'
    );
    expect(decodeHtmlEntities('a=1&amp;b=2')).toBe('a=1&b=2');
  });

  it('leaves unknown entities and plain text untouched', () => {
    expect(decodeHtmlEntities('&copy; &unknown; plain')).toBe('&copy; &unknown; plain');
  });
});

describe('decodeXmlEntities', () => {
  it('decodes &apos; and keeps single-pass semantics', () => {
    expect(decodeXmlEntities('&apos;')).toBe("'");
    expect(decodeXmlEntities('&amp;apos;')).toBe('&apos;');
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('candidate extraction decodes exactly once per boundary', () => {
  it('decodes HTML href attributes exactly once', () => {
    const { urls } = collectCandidateUrls(
      'explicit-url',
      '<a href="/docs/guide?a=1&amp;amp;b=2">Guide</a>'
    );

    expect(urls).toContain('https://example.com/docs/guide?a=1&amp;b=2');
  });

  it('decodes sitemap <loc> values exactly once', () => {
    const { urls } = collectCandidateUrls(
      'sitemap-xml',
      '<urlset><url><loc>https://example.com/docs?a=1&amp;amp;b=2</loc></url></urlset>'
    );

    expect(urls).toEqual(['https://example.com/docs?a=1&amp;b=2']);
  });

  it('never decodes llms.txt content', () => {
    const { urls } = collectCandidateUrls(
      'llms-txt',
      'Docs: https://example.com/docs?a=1&amp;b=2'
    );

    expect(urls).toEqual(['https://example.com/docs?a=1&amp;b=2']);
  });
});

describe('extractMarkdownLinkUrls', () => {
  it('keeps balanced parens inside the URL', () => {
    expect(extractMarkdownLinkUrls('[Chunking](https://en.wikipedia.org/wiki/Chunking_(writing))')).toEqual([
      'https://en.wikipedia.org/wiki/Chunking_(writing)',
    ]);
  });

  it('stops at the whitespace before a link title', () => {
    expect(extractMarkdownLinkUrls('[a](https://example.com/docs "Title")')).toEqual([
      'https://example.com/docs',
    ]);
  });

  it('extracts multiple links including image links', () => {
    expect(extractMarkdownLinkUrls('![img](/a.png) and [b](/docs/b)')).toEqual([
      '/a.png',
      '/docs/b',
    ]);
  });
});

describe('trimBareUrl', () => {
  it('keeps balanced trailing parens', () => {
    expect(trimBareUrl('https://en.wikipedia.org/wiki/Chunking_(writing)')).toBe(
      'https://en.wikipedia.org/wiki/Chunking_(writing)'
    );
  });

  it('trims unbalanced trailing parens and punctuation', () => {
    expect(trimBareUrl('https://en.wikipedia.org/wiki/Chunking_(writing)).')).toBe(
      'https://en.wikipedia.org/wiki/Chunking_(writing)'
    );
    expect(trimBareUrl('https://example.com/docs).')).toBe('https://example.com/docs');
    expect(trimBareUrl('https://example.com/docs?!,;.')).toBe('https://example.com/docs');
  });
});

describe('llms.txt URL extraction end-to-end', () => {
  it('markdown link and bare URL with parens both survive intact', () => {
    const text = [
      'See [Chunking](https://en.wikipedia.org/wiki/Chunking_(writing)) for details.',
      'Also https://en.wikipedia.org/wiki/Chunking_(writing) as a bare URL.',
    ].join('\n');
    const { urls, warnings } = collectCandidateUrls('llms-txt', text);

    expect(urls).toEqual(['https://en.wikipedia.org/wiki/Chunking_(writing)']);
    expect(warnings).toEqual([]);
  });

  it('still trims an unbalanced closing paren after a bare URL', () => {
    const { urls } = collectCandidateUrls(
      'llms-txt',
      '(see https://example.com/docs/guide) for details'
    );

    expect(urls).toEqual(['https://example.com/docs/guide']);
  });
});

describe('findHtmlTags', () => {
  it('scans past ">" inside quoted attribute values', () => {
    expect(findHtmlTags('<a title="a>b" href="/x">text</a>', 'a')).toEqual([
      '<a title="a>b" href="/x">',
    ]);
  });

  it('requires a word boundary after the tag name', () => {
    expect(findHtmlTags('<abbr href="/x">', 'a')).toEqual([]);
    expect(findHtmlTags('<linkable href="/x">', 'link')).toEqual([]);
  });

  it('matches case-insensitively and handles multiple tags', () => {
    expect(findHtmlTags('<A HREF="/x"><a href="/y">', 'a')).toEqual([
      '<A HREF="/x">',
      '<a href="/y">',
    ]);
  });
});

describe('HTML candidate extraction end-to-end', () => {
  it('keeps an <a> href when an earlier attribute value contains ">"', () => {
    const { urls } = collectCandidateUrls(
      'explicit-url',
      '<a title="a>b" href="/docs/guide">Guide</a>'
    );

    expect(urls).toEqual(['https://example.com/docs/guide']);
  });

  it('preserves the full canonical <link> href containing ">"', () => {
    const { urls } = collectCandidateUrls(
      'explicit-url',
      '<link rel="canonical" href="https://x.com/y>z">'
    );

    // '>' is percent-encoded by URL normalization; the 'z' suffix survives.
    expect(urls).toEqual(['https://x.com/y%3Ez']);
  });
});
