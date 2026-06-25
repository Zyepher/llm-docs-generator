/**
 * Static HTML parser implementation.
 *
 * Handles explicit local .html/.htm files and directories containing HTML
 * files. Directory traversal is deterministic, local-only, and does not follow
 * symlinked entries.
 */

import { lstat, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { DocNode } from '../../core/models.js';
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
        return await this.directoryContainsHtmlFiles(sourcePath);
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
    const files = (await this.findHtmlFiles(dirPath)).sort();

    if (files.length === 0) {
      throw new ParserError(`No HTML files found in ${dirPath}`, this.name);
    }

    const docs = await Promise.all(files.map((file) => parseHtmlFile(file)));
    return mergeHtmlDocuments(docs, basename(dirPath) || 'Documentation', dirPath);
  }

  private async findHtmlFiles(dirPath: string): Promise<string[]> {
    const results: string[] = [];
    const entries = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this.findHtmlFiles(fullPath)));
      } else if (entry.isFile() && this.isHtmlFileName(entry.name)) {
        results.push(fullPath);
      }
    }

    return results;
  }

  private async directoryContainsHtmlFiles(dirPath: string): Promise<boolean> {
    const entries = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isFile() && this.isHtmlFileName(entry.name)) {
        return true;
      }

      if (entry.isDirectory() && (await this.directoryContainsHtmlFiles(fullPath))) {
        return true;
      }
    }

    return false;
  }

  private isHtmlFileName(fileName: string): boolean {
    const extension = this.getFileExtension(fileName);
    return extension === 'html' || extension === 'htm';
  }
}

export const htmlParser = new HtmlFormatParser();

export { HtmlParser, getParserDetails, parseHtmlFile } from './parser.js';
export { htmlToDocNode, mergeHtmlDocuments } from './adapter.js';
export type { HtmlDocument, HtmlLink, HtmlParserWarning } from './parser.js';
