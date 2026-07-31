import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import { generateSourceDocs } from '../../src/core/source-docs.js';
import { FormatType } from '../../src/parsers/base.js';
import { RstFormatParser, parseRstFile } from '../../src/parsers/rst/index.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-rst-'));
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

describe('reStructuredText parser foundation', () => {
  it('detects .rst files and registers RST with the format detector', async () => {
    const dir = await createTempDir();
    const rstPath = join(dir, 'tutorial.rst');
    const textPath = join(dir, 'tutorial.txt');

    await writeFile(rstPath, 'Tutorial\n========\n', 'utf-8');
    await writeFile(textPath, 'Tutorial\n========\n', 'utf-8');

    const parser = new RstFormatParser();
    const detector = new FormatDetector();

    expect(await parser.detect(rstPath)).toBe(true);
    expect(await parser.detect(textPath)).toBe(false);
    expect(await detector.detect(rstPath)).toBe(FormatType.RST);
    expect(detector.getAvailableFormats()).toContain(FormatType.RST);
  });

  it('parses underline headings, paragraphs, and simple lists into DocNode IR', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'tutorial.rst');

    await writeFile(
      sourcePath,
      [
        'Python Tutorial',
        '===============',
        '',
        'Intro prose spans',
        'multiple source lines.',
        '',
        '- Install Python.',
        '- Create a project.',
        '',
        '1. Run the interpreter.',
        '2. Exit cleanly.',
        '',
        'Installation',
        '------------',
        '',
        'Use the installer for your platform.',
        '',
        'Virtual Environments',
        '~~~~~~~~~~~~~~~~~~~~',
        '',
        'Use venv for isolated dependencies.',
        '',
      ].join('\n'),
      'utf-8'
    );

    const root = await new RstFormatParser().parse(sourcePath);
    const parsedText = collectText(root);

    expect(root).toMatchObject({
      type: DocNodeType.SECTION,
      title: 'Python Tutorial',
    });
    expect(root.metadata.get('format')).toBe('rst');
    expect(root.metadata.get('sourcePath')).toBe(sourcePath);
    expect(root.metadata.get('parser')).toBe('rst-subset');

    expect(root.children[0]).toMatchObject({
      type: DocNodeType.CATEGORY,
      id: 'installation',
      title: 'Installation',
    });
    expect(root.children[0]?.children[0]).toMatchObject({
      type: DocNodeType.OPERATION,
      id: 'virtual-environments',
      title: 'Virtual Environments',
    });

    expect(parsedText).toContain('Intro prose spans multiple source lines.');
    expect(parsedText).toContain('- Install Python.\n- Create a project.');
    expect(parsedText).toContain('1. Run the interpreter.\n2. Exit cleanly.');
    expect(parsedText).toContain('Use the installer for your platform.');
    expect(parsedText).toContain('Use venv for isolated dependencies.');
  });

  it('parses literal blocks and code directives without executing directives', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'examples.rst');

    await writeFile(
      sourcePath,
      [
        'Examples',
        '========',
        '',
        'Literal example::',
        '',
        '    >>> print("hello")',
        '    hello',
        '',
        '.. code-block:: python',
        '   :linenos:',
        '',
        '   def ok():',
        '       return True',
        '',
        '.. code:: javascript',
        '',
        '   console.log("ok");',
        '',
      ].join('\n'),
      'utf-8'
    );

    const root = await new RstFormatParser().parse(sourcePath);
    const blocks = collectContentBlocks(root);
    const proseBlocks = blocks.filter((block) => block.type === ContentBlockType.PROSE);
    const codeBlocks = blocks.filter((block) => block.type === ContentBlockType.CODE);

    expect(proseBlocks.map((block) => block.content)).toContain('Literal example:');
    expect(codeBlocks).toEqual([
      expect.objectContaining({
        language: 'text',
        content: '>>> print("hello")\nhello',
      }),
      expect.objectContaining({
        language: 'python',
        content: 'def ok():\n    return True',
      }),
      expect.objectContaining({
        language: 'javascript',
        content: 'console.log("ok");',
      }),
    ]);
  });

  it('records unsupported directives and includes without fetching or executing them', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'directives.rst');

    await writeFile(
      sourcePath,
      [
        'Directives',
        '==========',
        '',
        '.. include:: missing-file.rst',
        '',
        '.. note::',
        '',
        '   Keep this note body as prose.',
        '',
        '.. image:: diagram.png',
        '   :alt: Architecture diagram',
        '',
      ].join('\n'),
      'utf-8'
    );

    const root = await new RstFormatParser().parse(sourcePath);
    const warnings = root.metadata.get('warnings');
    const parsedText = collectText(root);

    expect(Array.isArray(warnings)).toBe(true);
    expect(JSON.stringify(warnings)).toContain('include directive not executed');
    expect(JSON.stringify(warnings)).toContain('note');
    expect(JSON.stringify(warnings)).toContain('image');
    expect(parsedText).toContain(
      'Unsupported RST include directive not executed: missing-file.rst'
    );
    expect(parsedText).toContain('Keep this note body as prose.');
    expect(parsedText).toContain('diagram.png');
    expect(parsedText).not.toContain('Architecture diagram');
    expect(root.metadata.get('parserDetails')).toEqual(
      expect.objectContaining({
        unsupportedDirectives: expect.stringContaining('includes are not executed'),
      })
    );
  });

  it('detects and parses nested directories deterministically without following symlinks', async () => {
    const dir = await createTempDir();
    const sourceDir = join(dir, 'docs');
    const nestedDir = join(sourceDir, 'api');
    const symlinkTarget = join(dir, 'external');

    await mkdir(nestedDir, { recursive: true });
    await mkdir(symlinkTarget, { recursive: true });
    await writeFile(join(sourceDir, 'tutorial.rst'), 'Tutorial\n========\n', 'utf-8');
    await writeFile(join(nestedDir, 'index.rst'), 'API\n===\n', 'utf-8');
    await writeFile(join(sourceDir, 'notes.txt'), 'Notes\n=====\n', 'utf-8');
    await writeFile(join(symlinkTarget, 'hidden.rst'), 'Hidden\n======\n', 'utf-8');
    await symlink(symlinkTarget, join(sourceDir, 'linked-docs'));

    const parser = new RstFormatParser();
    const detector = new FormatDetector();

    expect(await parser.detect(sourceDir)).toBe(true);
    expect(await detector.detect(sourceDir)).toBe(FormatType.RST);

    const root = await parser.parse(sourceDir);
    const sourcePaths = root.metadata.get('sourcePaths');

    expect(root).toMatchObject({
      type: DocNodeType.ROOT,
      title: 'docs',
    });
    expect(root.metadata.get('format')).toBe('rst');
    expect(root.metadata.get('sourcePath')).toBe(sourceDir);
    expect(root.metadata.get('count')).toBe(2);
    expect(sourcePaths).toEqual([join(nestedDir, 'index.rst'), join(sourceDir, 'tutorial.rst')]);
    expect(root.children.map((child) => child.title)).toEqual(['API', 'Tutorial']);
    expect(collectText(root)).not.toContain('Hidden');
  });

  it('rejects non-RST files even when they contain RST-looking content', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'tutorial.txt');

    await writeFile(sourcePath, 'Tutorial\n========\n', 'utf-8');

    const parser = new RstFormatParser();
    const detector = new FormatDetector();

    expect(await parser.detect(sourcePath)).toBe(false);
    await expect(parser.parse(sourcePath)).rejects.toThrow(/Unsupported RST file extension/);
    await expect(parseRstFile(sourcePath)).rejects.toThrow(/Unsupported RST file extension/);
    await expect(detector.detect(sourcePath)).rejects.toThrow(/Unable to detect format/);
  });

  it('rejects root symlink files through the facade and parseRstFile helper', async () => {
    const dir = await createTempDir();
    const targetPath = join(dir, 'target.rst');
    const symlinkPath = join(dir, 'linked.rst');

    await writeFile(targetPath, 'Linked\n======\n', 'utf-8');
    await symlink(targetPath, symlinkPath);

    const parser = new RstFormatParser();

    expect(await parser.detect(symlinkPath)).toBe(false);
    await expect(parser.parse(symlinkPath)).rejects.toThrow(/Invalid RST source path/);
    await expect(parseRstFile(symlinkPath)).rejects.toThrow(/Invalid RST file path/);
  });

  it('exposes parseRstFile for parser-library use without a CLI generation workflow', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'library.rst');

    await writeFile(sourcePath, 'Library\n=======\n\nReference prose.\n', 'utf-8');

    const doc = await parseRstFile(sourcePath);

    expect(doc.title).toBe('Library');
    expect(doc.path).toBe(sourcePath);
    expect(doc.metadata.get('format')).toBe('rst');
    expect(doc.content[0]?.content).toBe('Reference prose.');
  });

  it('does not emit a spurious empty code block for `::` with no indented body (regression)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'colon.rst');
    await writeFile(
      sourcePath,
      [
        'Title',
        '=====',
        '',
        'A trailing marker with no block follows::',
        '',
        'Next paragraph.',
        '',
      ].join('\n'),
      'utf-8'
    );

    const root = await new RstFormatParser().parse(sourcePath);
    const blocks = collectContentBlocks(root);
    const codeBlocks = blocks.filter((block) => block.type === ContentBlockType.CODE);
    const proseText = blocks
      .filter((block) => block.type === ContentBlockType.PROSE)
      .map((block) => block.content)
      .join('\n');

    expect(codeBlocks).toHaveLength(0);
    expect(proseText).toContain('A trailing marker with no block follows:');
    expect(proseText).toContain('Next paragraph.');
  });

  it('consumes non-directive explicit markup silently while keeping directives working', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'comments.rst');
    await writeFile(
      sourcePath,
      [
        'Guide',
        '=====',
        '',
        '.. _installation:',
        '',
        '.. TODO: internal note',
        '',
        'Visible prose.',
        '',
        '.. this comment has a body',
        '   spanning indented lines',
        '',
        '   including blank-separated continuation',
        '',
        '.. |version| replace:: 2.0',
        '',
        '.. code-block:: python',
        '',
        '   print("still parsed")',
        '',
        'Closing prose.',
        '',
      ].join('\n'),
      'utf-8'
    );

    const root = await new RstFormatParser().parse(sourcePath);
    const parsedText = collectText(root);
    const codeBlocks = collectContentBlocks(root).filter(
      (block) => block.type === ContentBlockType.CODE
    );

    expect(parsedText).not.toContain('_installation');
    expect(parsedText).not.toContain('internal note');
    expect(parsedText).not.toContain('this comment has a body');
    expect(parsedText).not.toContain('spanning indented lines');
    expect(parsedText).not.toContain('blank-separated continuation');
    expect(parsedText).not.toContain('|version|');
    expect(parsedText).toContain('Visible prose.');
    expect(parsedText).toContain('Closing prose.');
    expect(codeBlocks).toEqual([
      expect.objectContaining({
        language: 'python',
        content: 'print("still parsed")',
      }),
    ]);
  });

  it('recognizes over-and-under section titles without leaking adornment prose', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'over-under.rst');
    await writeFile(
      sourcePath,
      [
        '==============',
        'Document Title',
        '==============',
        '',
        'Intro prose.',
        '',
        'Usage',
        '=====',
        '',
        'Usage prose.',
        '',
      ].join('\n'),
      'utf-8'
    );

    const root = await new RstFormatParser().parse(sourcePath);
    const parsedText = collectText(root);

    expect(root.title).toBe('Document Title');
    expect(parsedText).not.toContain('==');
    expect(parsedText).toContain('Intro prose.');
    expect(parsedText).toContain('Usage prose.');

    // The over-and-under `=` title is level 1; the underline-only `=` section
    // is a distinct style and must land on level 2 per docutils semantics.
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toMatchObject({
      type: DocNodeType.CATEGORY,
      id: 'usage',
      title: 'Usage',
    });
    expect(root.children[0]?.metadata.get('level')).toBe(2);
  });

  it('captures tab-indented literal block bodies (regression)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'tabbed.rst');
    await writeFile(
      sourcePath,
      ['Title', '=====', '', 'Example::', '', '\tconst tabbed = true;', '', 'After.', ''].join(
        '\n'
      ),
      'utf-8'
    );

    const root = await new RstFormatParser().parse(sourcePath);
    const codeBlocks = collectContentBlocks(root).filter(
      (block) => block.type === ContentBlockType.CODE
    );

    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0]?.content).toContain('const tabbed = true;');
  });
});

describe('reStructuredText inline markup rendering', () => {
  it('renders interpreted-text roles readably instead of leaking markup', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'roles.rst');
    await writeFile(
      sourcePath,
      [
        'API Reference',
        '=============',
        '',
        'Use :func:`mypkg.io.read_table` with :class:`~mypkg.frame.DataFrame` and',
        'call :py:meth:`DataFrame.merge` after. See :ref:`install-guide` and',
        ':ref:`the install guide <install-guide>` plus :doc:`/user/quickstart`.',
        'An unknown :term:`iterator` role stays readable, and',
        ':obj:`labeled name <mypkg.core.thing>` uses its label.',
        '',
        'The :mod:`json` module',
        '----------------------',
        '',
        'Heading prose.',
        '',
      ].join('\n'),
      'utf-8'
    );

    const root = await new RstFormatParser().parse(sourcePath);
    const parsedText = collectText(root);

    expect(parsedText).toContain('`mypkg.io.read_table`');
    expect(parsedText).toContain('`DataFrame`');
    expect(parsedText).not.toContain('~mypkg.frame.DataFrame');
    expect(parsedText).toContain('`DataFrame.merge`');
    expect(parsedText).toContain('See install-guide and the install guide plus /user/quickstart.');
    expect(parsedText).toContain('`iterator`');
    expect(parsedText).toContain('`labeled name`');
    expect(parsedText).not.toMatch(/:[a-z:]+:`/);

    expect(root.children[0]).toMatchObject({
      title: 'The `json` module',
      id: 'the-json-module',
    });
  });

  it('applies substitution definitions in a single non-recursive pass', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'substitutions.rst');
    await writeFile(
      sourcePath,
      [
        'Release Notes',
        '=============',
        '',
        '.. |project| replace:: DataLib',
        '.. |nested| replace:: uses |project| inside',
        '',
        '|project| is fast. |missing| stays as written. |nested| ends here.',
        '',
        '- |project| in a list item.',
        '',
      ].join('\n'),
      'utf-8'
    );

    const root = await new RstFormatParser().parse(sourcePath);
    const parsedText = collectText(root);

    expect(parsedText).toContain('DataLib is fast.');
    expect(parsedText).toContain('|missing| stays as written.');
    // Single pass: a substitution value containing another |ref| is not
    // expanded recursively.
    expect(parsedText).toContain('uses |project| inside ends here.');
    expect(parsedText).toContain('- DataLib in a list item.');
  });

  it('converts hyperlink references to markdown links without inventing URLs', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'links.rst');
    await writeFile(
      sourcePath,
      [
        'Links',
        '=====',
        '',
        'Visit `Python <https://www.python.org>`_ or the `docs`_ site.',
        'Anonymous `example <https://example.com>`__ still converts.',
        'The `orphan ref`_ has no target. Write to `us <mailto:x@y.example>`_.',
        'See the `guide`_ page and the relative `api`_ index.',
        '',
        '.. _docs: https://docs.python.org',
        '.. _guide:',
        '   https://example.com/guide',
        '.. _api: ../api/index.html',
        '',
      ].join('\n'),
      'utf-8'
    );

    const root = await new RstFormatParser().parse(sourcePath);
    const parsedText = collectText(root);

    expect(parsedText).toContain('[Python](https://www.python.org)');
    expect(parsedText).toContain('[docs](https://docs.python.org)');
    expect(parsedText).toContain('[example](https://example.com)');
    expect(parsedText).toContain('[guide](https://example.com/guide)');
    expect(parsedText).toContain('[api](../api/index.html)');
    expect(parsedText).toContain('The orphan ref has no target.');
    // Non-http(s) schemes are rejected rather than linked.
    expect(parsedText).toContain('Write to us.');
    expect(parsedText).not.toContain('mailto:');
    expect(parsedText).not.toContain('`_');
  });

  it('leaves inline literals untouched by role, substitution, and link rewriting', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'literals.rst');
    await writeFile(
      sourcePath,
      [
        'Literals',
        '========',
        '',
        '.. |ver| replace:: 9.9',
        '.. _refs: https://example.com',
        '',
        'Keep ``refs_`` and ``|ver|`` literal, but link `refs`_ and expand |ver|.',
        '',
      ].join('\n'),
      'utf-8'
    );

    const root = await new RstFormatParser().parse(sourcePath);
    const parsedText = collectText(root);

    expect(parsedText).toContain('``refs_``');
    expect(parsedText).toContain('``|ver|``');
    expect(parsedText).toContain('[refs](https://example.com)');
    expect(parsedText).toContain('expand 9.9.');
  });

  it('produces a generated pack with no raw role or trailing-underscore residue', async () => {
    const dir = await createTempDir();
    const sourceDir = join(dir, 'docs');
    const outputDir = join(dir, 'out');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, 'index.rst'),
      [
        'MyPkg Documentation',
        '===================',
        '',
        '.. |project| replace:: MyPkg',
        '.. _homepage: https://example.com/mypkg',
        '',
        '|project| ships :func:`mypkg.load` and :class:`~mypkg.core.Frame`.',
        'Read the `homepage`_ or `PyPI <https://pypi.org/project/mypkg/>`_ page,',
        'then see :ref:`Usage <usage>` and :doc:`/api/index`.',
        '',
      ].join('\n'),
      'utf-8'
    );
    await writeFile(
      join(sourceDir, 'usage.rst'),
      [
        'Usage',
        '=====',
        '',
        'Call :meth:`Frame.head` on the result of :func:`mypkg.load`.',
        '',
      ].join('\n'),
      'utf-8'
    );

    const result = await generateSourceDocs({
      source: sourceDir,
      outputDir,
      format: 'rst',
      generator: { name: 'llm-docs', version: '0.0.0-test', cliName: 'llm-docs' },
    });
    const full = await readFile(join(result.llmDocsDir, 'docs-full-llms.txt'), 'utf-8');

    expect(full).toContain('MyPkg ships `mypkg.load` and `Frame`.');
    expect(full).toContain('[homepage](https://example.com/mypkg)');
    expect(full).toContain('[PyPI](https://pypi.org/project/mypkg/)');
    expect(full).toContain('Usage and /api/index');
    expect(full).toContain('`Frame.head`');
    expect(full).not.toMatch(/:[a-z:]+:`/);
    expect(full).not.toContain('`_');
    expect(full).not.toContain('|project|');
  });
});
