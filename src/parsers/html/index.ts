/**
 * Static HTML parser implementation.
 *
 * Handles explicit local .html/.htm files and directories containing HTML
 * files. Directory traversal is deterministic, local-only, and does not follow
 * symlinked entries.
 */

import { lstat } from 'node:fs/promises';
import { basename } from 'node:path';

import type { DocNode } from '../../core/models.js';
import { directoryContainsMatchingFile, findFilesRecursively } from '../../utils/traversal.js';
import { BaseParser, FormatType, ParserError } from '../base.js';
import { htmlToDocNode, mergeHtmlDocuments } from './adapter.js';
import { parseHtmlFile } from './parser.js';

export class HtmlFormatParser extends BaseParser {
  readonly name = 'Static HTML Parser';
  readonly format = FormatType.HTML;

  async detect(sourcePath: string): Promise<boolean> {
    try {
      const stats = await lstat(sourcePath);
      if (stats.isFile()) {
        return this.isHtmlFileName(sourcePath);
      }

      if (stats.isDirectory()) {
        return await directoryContainsMatchingFile(sourcePath, (fileName) =>
          this.isHtmlFileName(fileName)
        );
      }
    } catch {
      return false;
    }

    return false;
  }

  async parse(sourcePath: string): Promise<DocNode> {
    const stats = await lstat(sourcePath);

    if (stats.isFile()) {
      return await this.parseSingleFile(sourcePath);
    }

    if (stats.isDirectory()) {
      return await this.parseDirectory(sourcePath);
    }

    throw new ParserError(`Invalid HTML source path: ${sourcePath}`, this.name);
  }

  private async parseSingleFile(filePath: string): Promise<DocNode> {
    if (!this.isHtmlFileName(filePath)) {
      throw new ParserError(`Unsupported HTML file extension: ${filePath}`, this.name);
    }

    return htmlToDocNode(await parseHtmlFile(filePath));
  }

  private async parseDirectory(dirPath: string): Promise<DocNode> {
    const files = (
      await findFilesRecursively(dirPath, (fileName) => this.isHtmlFileName(fileName))
    ).sort();

    if (files.length === 0) {
      throw new ParserError(`No HTML files found in ${dirPath}`, this.name);
    }

    const docs = await Promise.all(files.map((file) => parseHtmlFile(file)));
    return mergeHtmlDocuments(docs, basename(dirPath) || 'Documentation', dirPath);
  }

  private isHtmlFileName(fileName: string): boolean {
    const extension = this.getFileExtension(fileName);
    return extension === 'html' || extension === 'htm';
  }
}

export const htmlParser = new HtmlFormatParser();

export { parseHtmlFile } from './parser.js';
export type { HtmlDocument, HtmlLink, HtmlParserWarning } from './parser.js';
