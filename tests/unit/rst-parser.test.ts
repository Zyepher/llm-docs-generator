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
      ['Title', '=====', '', 'A trailing marker with no block follows::', '', 'Next paragraph.', ''].join(
        '\n'
      ),
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

  it('captures tab-indented literal block bodies (regression)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'tabbed.rst');
    await writeFile(
      sourcePath,
      ['Title', '=====', '', 'Example::', '', '\tconst tabbed = true;', '', 'After.', ''].join('\n'),
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
