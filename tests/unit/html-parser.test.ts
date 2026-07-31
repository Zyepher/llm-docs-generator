import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FormatDetector } from '../../src/core/detector.js';
import {
  ContentBlockType,
  DocNodeType,
  type ContentBlock,
  type DocNode,
} from '../../src/core/models.js';
import { FormatType } from '../../src/parsers/base.js';
import { HtmlFormatParser, parseHtmlFile } from '../../src/parsers/html/index.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-html-'));
  tempDirs.push(dir);
  return dir;
}

function collectContentBlocks(node: DocNode): ContentBlock[] {
  return [...node.content, ...node.children.flatMap((child) => collectContentBlocks(child))];
}

function collectText(node: DocNode): string {
  const ownContent = node.content.map((block) => block.content).join('\n');
  const childContent = node.children.map((child) => collectText(child)).join('\n');
  return [node.title, node.description, ownContent, childContent].filter(Boolean).join('\n');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('static HTML parser foundation', () => {
  it('detects .html/.htm files and registers HTML with the format detector', async () => {
    const dir = await createTempDir();
    const htmlPath = join(dir, 'index.html');
    const htmPath = join(dir, 'legacy.htm');
    const textPath = join(dir, 'index.txt');

    await writeFile(htmlPath, '<!doctype html><title>Index</title>', 'utf-8');
    await writeFile(htmPath, '<!doctype html><h1>Legacy</h1>', 'utf-8');
    await writeFile(textPath, '<!doctype html><h1>Text</h1>', 'utf-8');

    const parser = new HtmlFormatParser();
    const detector = new FormatDetector();

    expect(await parser.detect(htmlPath)).toBe(true);
    expect(await parser.detect(htmPath)).toBe(true);
    expect(await parser.detect(textPath)).toBe(false);
    expect(await detector.detect(htmlPath)).toBe(FormatType.HTML);
    expect(await detector.detect(htmPath)).toBe(FormatType.HTML);
    expect(detector.getAvailableFormats()).toContain(FormatType.HTML);
  });

  it('parses title/H1 fallback, headings, paragraphs, and lists into DocNode IR', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'guide.html');

    await writeFile(
      sourcePath,
      [
        '<!doctype html>',
        '<main>',
        '<h1>Getting Started</h1>',
        '<p>Intro &amp; setup prose.</p>',
        '<h2>Install</h2>',
        '<p>Use the package installer.</p>',
        '<ul><li>Download package.</li><li>Run installer.</li></ul>',
        '<h3>Configure</h3>',
        '<ol><li>Open settings.</li><li>Save changes.</li></ol>',
        '<h4>Advanced</h4>',
        '<p>Enable advanced options.</p>',
        '<h5>Nested Detail</h5>',
        '<p>Nested detail prose.</p>',
        '</main>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const parsedText = collectText(root);

    expect(root).toMatchObject({
      type: DocNodeType.SECTION,
      title: 'Getting Started',
    });
    expect(root.metadata.get('format')).toBe('html');
    expect(root.metadata.get('sourcePath')).toBe(sourcePath);
    expect(root.metadata.get('parser')).toBe('html-static-subset');
    expect(root.metadata.get('sourceKind')).toBe('rendered-html-fallback');
    expect(root.metadata.get('renderedHtmlFallback')).toBe(true);
    expect(root.metadata.get('confidence')).toBe('lower');
    expect(root.metadata.get('parserDetails')).toEqual(
      expect.objectContaining({
        javascript: 'not rendered or executed',
        network: 'no linked resources are fetched',
      })
    );

    expect(root.children[0]).toMatchObject({
      type: DocNodeType.CATEGORY,
      id: 'install',
      title: 'Install',
    });
    expect(root.children[0]?.children[0]).toMatchObject({
      type: DocNodeType.OPERATION,
      id: 'configure',
      title: 'Configure',
    });
    expect(root.children[0]?.children[0]?.children[0]).toMatchObject({
      type: DocNodeType.ITEM,
      id: 'advanced',
      title: 'Advanced',
    });
    expect(root.children[0]?.children[0]?.children[0]?.children[0]).toMatchObject({
      type: DocNodeType.ITEM,
      id: 'nested-detail',
      title: 'Nested Detail',
    });

    expect(parsedText).toContain('Intro & setup prose.');
    expect(parsedText).toContain('Use the package installer.');
    expect(parsedText).toContain('- Download package.\n- Run installer.');
    expect(parsedText).toContain('1. Open settings.\n2. Save changes.');
    expect(parsedText).toContain('Enable advanced options.');
    expect(parsedText).toContain('Nested detail prose.');
  });

  it('parses pre/code blocks as CODE and simple tables as DATA', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'reference.html');

    await writeFile(
      sourcePath,
      [
        '<html><head><title>Reference</title></head><body>',
        '<h2>Examples</h2>',
        '<pre><code class="language-js">const ok = true;\nconsole.log(ok);</code></pre>',
        '<code data-language="bash">npm test</code>',
        '<table>',
        '<thead><tr><th>Name</th><th>Value</th></tr></thead>',
        '<tbody><tr><td>Status</td><td>Stable</td></tr></tbody>',
        '</table>',
        '</body></html>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const blocks = collectContentBlocks(root);
    const codeBlocks = blocks.filter((block) => block.type === ContentBlockType.CODE);
    const dataBlocks = blocks.filter((block) => block.type === ContentBlockType.DATA);

    expect(root.title).toBe('Reference');
    expect(codeBlocks).toEqual([
      expect.objectContaining({
        language: 'js',
        content: 'const ok = true;\nconsole.log(ok);',
      }),
      expect.objectContaining({
        language: 'bash',
        content: 'npm test',
      }),
    ]);
    expect(dataBlocks).toEqual([
      expect.objectContaining({
        content: 'Name | Value\nStatus | Stable',
      }),
    ]);
    expect(dataBlocks[0]?.annotations?.get('type')).toBe('table');
  });

  it('decodes code block entities exactly once', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'code-entities.html');

    await writeFile(
      sourcePath,
      [
        '<title>Code Entities</title>',
        '<pre><code class="language-html">&amp;lt;tag&amp;gt;\n&lt;tag&gt;</code></pre>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const codeBlocks = collectContentBlocks(root).filter(
      (block) => block.type === ContentBlockType.CODE
    );

    expect(codeBlocks).toEqual([
      expect.objectContaining({
        language: 'html',
        content: '&lt;tag&gt;\n<tag>',
      }),
    ]);
  });

  it('strips scripts, styles, and templates before extracting prose', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'safe.html');

    await writeFile(
      sourcePath,
      [
        '<title>Safe Page</title>',
        '<style>.hidden { display: none; }</style>',
        '<script>document.body.innerHTML = "EXECUTED";</script>',
        '<template><p>Hidden template prose.</p></template>',
        '<p>Visible text.</p>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const parsedText = collectText(root);
    const warnings = root.metadata.get('warnings');
    const strippedElementCounts = root.metadata.get('strippedElementCounts');

    expect(parsedText).toContain('Visible text.');
    expect(parsedText).not.toContain('display: none');
    expect(parsedText).not.toContain('EXECUTED');
    expect(parsedText).not.toContain('Hidden template prose');
    expect(JSON.stringify(warnings)).toContain('lower-confidence static rendered HTML fallback');
    expect(strippedElementCounts).toEqual({ script: 1, style: 1, template: 1 });
  });

  it('preserves invalid numeric entities without throwing', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'entities.html');
    const hugeDecimal = '&#999999999999999999999999;';
    const hugeHex = '&#xFFFFFFFFFFFFFFFF;';
    const aboveUnicodeRange = '&#1114112;';
    const surrogate = '&#xD800;';

    await writeFile(
      sourcePath,
      [
        '<title>Entities</title>',
        `<p>Values: &#65; &#x41; ${hugeDecimal} ${hugeHex} ${aboveUnicodeRange} ${surrogate} remain.</p>`,
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const parsedText = collectText(root);

    expect(parsedText).toContain(
      `Values: A A ${hugeDecimal} ${hugeHex} ${aboveUnicodeRange} ${surrogate} remain.`
    );
  });

  it('excludes unclosed stripped container content conservatively', async () => {
    const dir = await createTempDir();
    const cases: Array<{ tag: 'script' | 'style' | 'template'; leakedText: string }> = [
      { tag: 'script', leakedText: 'LEAKED_SCRIPT' },
      { tag: 'style', leakedText: 'LEAKED_STYLE' },
      { tag: 'template', leakedText: 'LEAKED_TEMPLATE' },
    ];

    for (const strippedCase of cases) {
      const sourcePath = join(dir, `${strippedCase.tag}.html`);
      await writeFile(
        sourcePath,
        [
          `<title>${strippedCase.tag}</title>`,
          `<p>${strippedCase.tag} before.</p>`,
          `<${strippedCase.tag}>${strippedCase.leakedText}`,
          `<p>${strippedCase.tag} after.</p>`,
        ].join('\n'),
        'utf-8'
      );

      const root = await new HtmlFormatParser().parse(sourcePath);
      const parsedText = collectText(root);
      const warnings = root.metadata.get('warnings');
      const strippedElementCounts = root.metadata.get('strippedElementCounts') as Record<
        string,
        number
      >;

      expect(parsedText).toContain(`${strippedCase.tag} before.`);
      expect(parsedText).not.toContain(strippedCase.leakedText);
      expect(parsedText).not.toContain(`${strippedCase.tag} after.`);
      expect(strippedElementCounts[strippedCase.tag]).toBe(1);
      expect(JSON.stringify(warnings)).toContain(`Stripped 1 <${strippedCase.tag}> element`);
    }
  });

  it('preserves links as text and metadata without fetching linked resources or executing scripts', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'index.html');
    const linkedPath = join(dir, 'linked.html');

    await writeFile(linkedPath, '<title>Linked Secret</title><p>Fetched content.</p>', 'utf-8');
    await writeFile(
      sourcePath,
      [
        '<title>Links</title>',
        '<p>Read <a href="./linked.html">linked page</a>.</p>',
        '<script>document.body.append("EXECUTED");</script>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const parsedText = collectText(root);

    expect(parsedText).toContain('Read linked page (./linked.html).');
    expect(parsedText).not.toContain('Linked Secret');
    expect(parsedText).not.toContain('Fetched content');
    expect(parsedText).not.toContain('EXECUTED');
    expect(root.metadata.get('links')).toEqual([{ text: 'linked page', href: './linked.html' }]);
  });

  it('detects and parses nested directories deterministically without following symlinks', async () => {
    const dir = await createTempDir();
    const sourceDir = join(dir, 'docs');
    const nestedDir = join(sourceDir, 'api');
    const symlinkTarget = join(dir, 'external');

    await mkdir(nestedDir, { recursive: true });
    await mkdir(symlinkTarget, { recursive: true });
    await writeFile(join(sourceDir, 'zoo.html'), '<title>Zoo</title><p>Zed.</p>', 'utf-8');
    await writeFile(join(nestedDir, 'api.htm'), '<title>API</title><p>Reference.</p>', 'utf-8');
    await writeFile(join(sourceDir, 'notes.txt'), '<title>Notes</title>', 'utf-8');
    await writeFile(join(symlinkTarget, 'hidden.html'), '<title>Hidden</title>', 'utf-8');
    await symlink(symlinkTarget, join(sourceDir, 'linked-docs'));
    await symlink(join(symlinkTarget, 'hidden.html'), join(sourceDir, 'linked-file.html'));

    const parser = new HtmlFormatParser();
    const detector = new FormatDetector();

    expect(await parser.detect(sourceDir)).toBe(true);
    expect(await detector.detect(sourceDir)).toBe(FormatType.HTML);

    const root = await parser.parse(sourceDir);
    const sourcePaths = root.metadata.get('sourcePaths');

    expect(root).toMatchObject({
      type: DocNodeType.ROOT,
      title: 'docs',
    });
    expect(root.metadata.get('format')).toBe('html');
    expect(root.metadata.get('sourcePath')).toBe(sourceDir);
    expect(root.metadata.get('sourceKind')).toBe('rendered-html-fallback');
    expect(root.metadata.get('count')).toBe(2);
    expect(sourcePaths).toEqual([join(nestedDir, 'api.htm'), join(sourceDir, 'zoo.html')]);
    expect(root.children.map((child) => child.title)).toEqual(['API', 'Zoo']);
    expect(collectText(root)).not.toContain('Hidden');
  });

  it('rejects non-HTML files and root symlinks through the facade and helper', async () => {
    const dir = await createTempDir();
    const textPath = join(dir, 'guide.txt');
    const targetPath = join(dir, 'target.html');
    const symlinkPath = join(dir, 'linked.html');

    await writeFile(textPath, '<!doctype html><h1>Guide</h1>', 'utf-8');
    await writeFile(targetPath, '<title>Linked</title>', 'utf-8');
    await symlink(targetPath, symlinkPath);

    const parser = new HtmlFormatParser();
    const detector = new FormatDetector();

    expect(await parser.detect(textPath)).toBe(false);
    await expect(parser.parse(textPath)).rejects.toThrow(/Unsupported HTML file extension/);
    await expect(parseHtmlFile(textPath)).rejects.toThrow(/Unsupported HTML file extension/);
    await expect(detector.detect(textPath)).rejects.toThrow(/Unable to detect format/);

    expect(await parser.detect(symlinkPath)).toBe(false);
    await expect(parser.parse(symlinkPath)).rejects.toThrow(/Invalid HTML source path/);
    await expect(parseHtmlFile(symlinkPath)).rejects.toThrow(/Invalid HTML file path/);
  });

  it('preserves nested list items with indentation (regression: nested lists dropped)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'nested-list.html');

    await writeFile(
      sourcePath,
      [
        '<!doctype html>',
        '<title>List</title>',
        '<ul>',
        '<li>Top item',
        '<ul><li>Nested item one</li><li>Nested item two</li></ul>',
        '</li>',
        '<li>Second top item</li>',
        '</ul>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const text = collectText(root);

    expect(text).toContain('Top item');
    expect(text).toContain('Nested item one');
    expect(text).toContain('Nested item two');
    expect(text).toContain('Second top item');
  });

  it('does not flatten or duplicate nested table rows into the outer table (regression)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'nested-table.html');

    await writeFile(
      sourcePath,
      [
        '<!doctype html>',
        '<title>Tables</title>',
        '<table>',
        '<tr><td>Outer A</td><td><table><tr><td>Inner X</td></tr></table></td></tr>',
        '</table>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const tableBlocks = collectContentBlocks(root).filter(
      (block) => block.type === ContentBlockType.DATA && block.annotations?.get('type') === 'table'
    );

    expect(tableBlocks).toHaveLength(2); // outer + nested, rendered separately
    const outer = tableBlocks.find((block) => block.content.includes('Outer A'));
    expect(outer).toBeDefined();
    // The inner row must not be flattened/duplicated into the outer table block.
    expect((outer?.content.match(/Inner X/g) ?? []).length).toBeLessThanOrEqual(0);
    expect(tableBlocks.some((block) => block.content.includes('Inner X'))).toBe(true);
  });

  it('preserves loose text adjacent to block-level children (regression: silent content loss)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'mixed.html');

    await writeFile(
      sourcePath,
      [
        '<!doctype html>',
        '<title>Mixed</title>',
        '<div>',
        'Lead-in prose before the list.',
        '<ul><li>First item.</li><li>Second item.</li></ul>',
        'Trailing prose after the list.',
        '</div>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const text = collectText(root);

    expect(text).toContain('Lead-in prose before the list.');
    expect(text).toContain('First item.');
    expect(text).toContain('Trailing prose after the list.');
  });

  it('tokenizes large malformed (unterminated) markup in linear time', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'unterminated.html');

    // ~400KB of unclosed comment/markup starts; the previous global-regex
    // tokenizer rescanned to end-of-input from every `<` (~54s). The linear scan
    // must finish promptly.
    await writeFile(sourcePath, '<!--a'.repeat(80_000), 'utf-8');

    const start = Date.now();
    await parseHtmlFile(sourcePath);

    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('strips a large flood of unterminated <script openings in linear time', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'script-flood.html');

    // ~400KB of unclosed <script openings; the previous global lazy regex
    // rescanned to end-of-input from every opening. The linear indexOf scan must
    // finish promptly and leak no script text.
    await writeFile(
      sourcePath,
      `<title>Doc</title><p>Keep this.</p>${'<script '.repeat(50_000)}`,
      'utf-8'
    );

    const start = Date.now();
    const doc = await parseHtmlFile(sourcePath);

    expect(Date.now() - start).toBeLessThan(3000);
    expect(JSON.stringify(doc)).toContain('Keep this.');
  });

  it('survives a comment-wrapped script opener (regression: comment content treated as real opener)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'commented-script.html');

    await writeFile(
      sourcePath,
      [
        '<title>Commented Script</title>',
        '<p>Before the comment.</p>',
        '<!-- <script src="x.js"> -->',
        '<h2>After Heading</h2>',
        '<p>After the comment.</p>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const text = collectText(root);

    expect(text).toContain('Before the comment.');
    expect(text).toContain('After Heading');
    expect(text).toContain('After the comment.');
    expect(text).not.toContain('x.js');
    // The commented-out opener is not a real element, so nothing was stripped.
    expect(root.metadata.get('strippedElementCounts')).toEqual({
      script: 0,
      style: 0,
      template: 0,
    });
  });

  it('treats an unterminated <!-- as commenting out the remainder without crashing', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'unterminated-comment.html');

    await writeFile(
      sourcePath,
      [
        '<title>Unterminated Comment</title>',
        '<p>Kept prose.</p>',
        '<!-- never closed <p>Commented out.</p>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const text = collectText(root);

    expect(text).toContain('Kept prose.');
    expect(text).not.toContain('Commented out.');
  });

  it('still drops the remainder after a genuinely unclosed <script> (conservative behavior)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'unclosed-script.html');

    await writeFile(
      sourcePath,
      [
        '<title>Unclosed Script</title>',
        '<p>Before the script.</p>',
        '<script>var LEAKED = true;',
        '<p>Dropped tail.</p>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const text = collectText(root);

    expect(text).toContain('Before the script.');
    expect(text).not.toContain('LEAKED');
    expect(text).not.toContain('Dropped tail.');
  });

  it('parses a ">" inside a quoted attribute value without leaking the tag tail (regression)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'attr-gt.html');

    await writeFile(
      sourcePath,
      [
        '<title>Arrow Attribute</title>',
        '<p>See <img alt="A -> B" src="d.png"> for the flow.</p>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const text = collectText(root);

    expect(text).toContain('See A -> B for the flow.');
    expect(text).not.toContain('src=');
    expect(text).not.toContain('d.png');
  });

  it('does not inject spaces inside words split by inline markup (regression)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'inline-split.html');

    await writeFile(
      sourcePath,
      ['<title>Inline Split</title>', '<p>The <code>get</code>ter and re<em>name</em>d</p>'].join(
        '\n'
      ),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const text = collectText(root);

    // Inline <code> is backtick-wrapped, still with no injected spaces.
    expect(text).toContain('The `get`ter and renamed');
    expect(text).not.toContain('get ter');
  });

  it('keeps non-title h1 headings as top-level sections', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'chapters.html');

    await writeFile(
      sourcePath,
      [
        '<!doctype html>',
        '<title>Manual</title>',
        '<h1>Chapter One</h1>',
        '<p>First chapter prose.</p>',
        '<h2>Basics</h2>',
        '<p>Basics prose.</p>',
        '<h1>Chapter Two</h1>',
        '<p>Second chapter prose.</p>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);

    expect(root.title).toBe('Manual');
    expect(root.children.map((child) => child.title)).toEqual(['Chapter One', 'Chapter Two']);
    expect(root.children[0]).toMatchObject({ type: DocNodeType.SECTION, id: 'chapter-one' });
    expect(root.children[0]?.metadata.get('level')).toBe(1);
    expect(root.children[0]?.children[0]).toMatchObject({
      type: DocNodeType.CATEGORY,
      title: 'Basics',
    });
    expect(collectText(root.children[1] ?? root)).toContain('Second chapter prose.');
  });

  it('dedups only the h1 that matches the document title, keeping later duplicates', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'dedup.html');

    await writeFile(
      sourcePath,
      [
        '<!doctype html>',
        '<title>Widgets</title>',
        '<h1>Widgets</h1>',
        '<p>Overview prose.</p>',
        '<h1>Widgets</h1>',
        '<p>Second occurrence prose.</p>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);

    expect(root.title).toBe('Widgets');
    // First h1 equals the extracted title and is not re-nested; the second one
    // is a real section.
    expect(root.content.map((block) => block.content)).toContain('Overview prose.');
    expect(root.children.map((child) => child.title)).toEqual(['Widgets']);
    expect(collectText(root.children[0] ?? root)).toContain('Second occurrence prose.');
  });

  it('dedups the first h1 when it is the title fallback (no <title> tag)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'fallback-title.html');

    await writeFile(
      sourcePath,
      [
        '<!doctype html>',
        '<h1>Getting Started</h1>',
        '<p>Intro prose.</p>',
        '<h1>Appendix</h1>',
        '<p>Appendix prose.</p>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);

    expect(root.title).toBe('Getting Started');
    expect(root.content.map((block) => block.content)).toContain('Intro prose.');
    expect(root.children.map((child) => child.title)).toEqual(['Appendix']);
  });

  it('excludes nav, header, footer, and aside chrome from extracted content', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'chrome.html');

    await writeFile(
      sourcePath,
      [
        '<!doctype html>',
        '<title>Chrome</title>',
        '<header><h1>Site Name</h1><nav><a href="/home">Home</a></nav></header>',
        '<nav><ul><li>Docs</li><li>Blog</li></ul></nav>',
        '<main>',
        '<p>Real content prose.</p>',
        '<aside>Related links sidebar.</aside>',
        '</main>',
        '<footer>Copyright chrome.</footer>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const text = collectText(root);

    expect(text).toContain('Real content prose.');
    expect(text).not.toContain('Site Name');
    expect(text).not.toContain('Home');
    expect(text).not.toContain('Blog');
    expect(text).not.toContain('Related links sidebar.');
    expect(text).not.toContain('Copyright chrome.');
  });

  it('renders inline code spans with backticks and other inline markup as plain text', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'inline-code.html');

    await writeFile(
      sourcePath,
      [
        '<!doctype html>',
        '<title>Inline Code</title>',
        '<p>Call <code>fetch()</code> with a <strong>required</strong> <em>url</em> argument.</p>',
        '<ul><li>Set <code>timeout</code> in options.</li></ul>',
      ].join('\n'),
      'utf-8'
    );

    const root = await new HtmlFormatParser().parse(sourcePath);
    const text = collectText(root);

    expect(text).toContain('Call `fetch()` with a required url argument.');
    expect(text).toContain('- Set `timeout` in options.');
  });
});
