/**
 * Acceptance coverage for the current Markdown/DocC parser path and universal formatter.
 */

import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ContentBlockType, DocNodeType, type DocNode } from '../../src/core/models.js';
import { formatDocNode } from '../../src/core/universal-formatter.js';
import { MarkdownFormatParser } from '../../src/parsers/markdown/index.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-markdown-'));
  tempDirs.push(dir);
  return dir;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function collectContent(node: DocNode): string {
  const ownContent = node.content.map((block) => block.content).join('\n');
  const childContent = node.children.map((child) => collectContent(child)).join('\n');
  return [node.title, ownContent, childContent].filter(Boolean).join('\n');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Markdown/DocC parser and universal formatter acceptance', () => {
  it('parses DocC-flavored Markdown into DocNode hierarchy and formatted outputs', async () => {
    const tempDir = await createTempDir();
    const sourcePath = join(tempDir, 'DocC Acceptance Guide.md');
    const outputDir = join(tempDir, 'output');

    await writeFile(
      sourcePath,
      [
        '@Metadata {',
        '  @DocumentationExtension(mergeBehavior: append)',
        '  @PageColor(purple)',
        '}',
        '',
        '<!-- parser-only comment that should be removed -->',
        '',
        '## Authentication',
        'Use <doc:SignInWithOTP> when you need passwordless access.',
        '',
        '@Options(scope: local) {',
        '  @AutomaticSeeAlso(disabled)',
        '}',
        '',
        '### Sign in with OTP',
        'Call the auth client and keep the session returned by <doc:AuthSession>.',
        '',
        '```swift',
        'try await supabase.auth.signInWithOTP(email: "person@example.com")',
        '```',
        '',
        '#### Parameters',
        'Pass an email address that can receive the magic link.',
        '',
        '```json',
        '{ "email": "person@example.com" }',
        '```',
        '',
        '## Storage',
        'Use storage buckets for user files.',
        '',
      ].join('\n'),
      'utf-8'
    );

    const parser = new MarkdownFormatParser();

    expect(await parser.detect(sourcePath)).toBe(true);

    const docNode = await parser.parse(sourcePath);

    expect(docNode.type).toBe(DocNodeType.SECTION);
    expect(docNode.title).toBe('DocC Acceptance Guide');
    expect(docNode.metadata.get('format')).toBe('markdown');
    expect(docNode.metadata.get('path')).toBe(sourcePath);

    const authentication = docNode.children[0];
    const storage = docNode.children[1];

    expect(authentication).toMatchObject({
      type: DocNodeType.CATEGORY,
      id: 'authentication',
      title: 'Authentication',
    });
    expect(storage).toMatchObject({
      type: DocNodeType.CATEGORY,
      id: 'storage',
      title: 'Storage',
    });

    const signInOperation = authentication?.children[0];
    expect(signInOperation).toMatchObject({
      type: DocNodeType.OPERATION,
      id: 'sign-in-with-otp',
      title: 'Sign in with OTP',
    });

    const parameters = signInOperation?.children[0];
    expect(parameters).toMatchObject({
      type: DocNodeType.ITEM,
      id: 'parameters',
      title: 'Parameters',
    });

    expect(authentication?.content[0]).toMatchObject({
      type: ContentBlockType.PROSE,
      content: 'Use SignInWithOTP when you need passwordless access.',
    });
    expect(signInOperation?.content[0]).toMatchObject({
      type: ContentBlockType.PROSE,
      content: 'Call the auth client and keep the session returned by AuthSession.',
    });
    expect(signInOperation?.content[1]).toMatchObject({
      type: ContentBlockType.CODE,
      language: 'swift',
      content: 'try await supabase.auth.signInWithOTP(email: "person@example.com")',
    });
    expect(parameters?.content[1]).toMatchObject({
      type: ContentBlockType.CODE,
      language: 'json',
      content: '{ "email": "person@example.com" }',
    });

    const parsedText = collectContent(docNode);
    expect(parsedText).toContain('SignInWithOTP');
    expect(parsedText).toContain('AuthSession');
    expect(parsedText).not.toContain('@Metadata');
    expect(parsedText).not.toContain('@Options');
    expect(parsedText).not.toContain('@DocumentationExtension');
    expect(parsedText).not.toContain('@AutomaticSeeAlso');
    expect(parsedText).not.toContain('@PageColor');
    expect(parsedText).not.toContain('PageColor');
    expect(parsedText).not.toContain('<!--');
    expect(parsedText).not.toContain('parser-only comment');
    expect(parsedText).not.toContain('<doc:');

    await formatDocNode(docNode, {
      outputDir,
      filenamePrefix: 'docc-acceptance',
      title: docNode.title,
    });

    const fullOutputPath = join(outputDir, 'docc-acceptance-full-llms.txt');
    const categoryOutputPath = join(outputDir, 'docc-acceptance-authentication-llms.txt');

    expect(await pathExists(fullOutputPath)).toBe(true);
    expect(await pathExists(categoryOutputPath)).toBe(true);

    const fullOutput = await readFile(fullOutputPath, 'utf-8');
    const categoryOutput = await readFile(categoryOutputPath, 'utf-8');

    expect(fullOutput).toContain('# DocC Acceptance Guide');
    expect(fullOutput).toContain('Authentication');
    expect(fullOutput).toContain('Storage');
    expect(fullOutput).toContain('Use SignInWithOTP when you need passwordless access.');
    expect(fullOutput).toContain('Call the auth client and keep the session returned by AuthSession.');
    expect(fullOutput).toContain('```swift\n');
    expect(fullOutput).toContain('try await supabase.auth.signInWithOTP(email: "person@example.com")');
    expect(fullOutput).toContain('```json\n');
    expect(fullOutput).toContain('{ "email": "person@example.com" }');
    expect(fullOutput).not.toContain('@Metadata');
    expect(fullOutput).not.toContain('@Options');
    expect(fullOutput).not.toContain('@PageColor');
    expect(fullOutput).not.toContain('PageColor');
    expect(fullOutput).not.toContain('parser-only comment');
    expect(fullOutput).not.toContain('<doc:');

    expect(categoryOutput).toContain('# DocC Acceptance Guide Authentication Documentation');
    expect(categoryOutput).toContain('Authentication');
    expect(categoryOutput).toContain('Sign in with OTP');
    expect(categoryOutput).toContain('Parameters');
    expect(categoryOutput).toContain('Use SignInWithOTP when you need passwordless access.');
    expect(categoryOutput).toContain(
      'Call the auth client and keep the session returned by AuthSession.'
    );
    expect(categoryOutput).toContain('```swift\n');
    expect(categoryOutput).toContain(
      'try await supabase.auth.signInWithOTP(email: "person@example.com")'
    );
    expect(categoryOutput).toContain('```json\n');
    expect(categoryOutput).toContain('{ "email": "person@example.com" }');
    expect(categoryOutput).not.toContain('@Metadata');
    expect(categoryOutput).not.toContain('@Options');
    expect(categoryOutput).not.toContain('@PageColor');
    expect(categoryOutput).not.toContain('PageColor');
    expect(categoryOutput).not.toContain('parser-only comment');
    expect(categoryOutput).not.toContain('<doc:');
  });
});
