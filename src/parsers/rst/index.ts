/**
 * reStructuredText parser implementation.
 *
 * Handles explicit local .rst files and directories containing .rst files.
 */

import { lstat, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { DocNode } from '../../core/models.js';
import { BaseParser, FormatType, ParserError } from '../base.js';
import { mergeRstDocuments, rstToDocNode } from './adapter.js';
import { RstParser } from './parser.js';

export class RstFormatParser extends BaseParser {
  readonly name = 'reStructuredText Parser';
  readonly format = FormatType.RST;

  async detect(sourcePath: string): Promise<boolean> {
    try {
      const stats = await lstat(sourcePath);
      if (stats.isFile()) {
        return this.isRstFileName(sourcePath);
      }

      if (stats.isDirectory()) {
        return await this.directoryContainsRstFiles(sourcePath);
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

    throw new ParserError(`Invalid RST source path: ${sourcePath}`, this.name);
  }

  private async parseSingleFile(filePath: string): Promise<DocNode> {
    if (!this.isRstFileName(filePath)) {
      throw new ParserError(`Unsupported RST file extension: ${filePath}`, this.name);
    }

    const parser = new RstParser(filePath);
    return rstToDocNode(await parser.parse());
  }

  private async parseDirectory(dirPath: string): Promise<DocNode> {
    const files = (await this.findRstFiles(dirPath)).sort();

    if (files.length === 0) {
      throw new ParserError(`No RST files found in ${dirPath}`, this.name);
    }

    const docs = await Promise.all(
      files.map(async (file) => {
        const parser = new RstParser(file);
        return await parser.parse();
      })
    );

    return mergeRstDocuments(docs, basename(dirPath) || 'Documentation', dirPath);
  }

  private async findRstFiles(dirPath: string): Promise<string[]> {
    const results: string[] = [];
    const entries = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this.findRstFiles(fullPath)));
      } else if (entry.isFile() && this.isRstFileName(entry.name)) {
        results.push(fullPath);
      }
    }

    return results;
  }

  private async directoryContainsRstFiles(dirPath: string): Promise<boolean> {
    const entries = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isFile() && this.isRstFileName(entry.name)) {
        return true;
      }

      if (entry.isDirectory() && (await this.directoryContainsRstFiles(fullPath))) {
        return true;
      }
    }

    return false;
  }

  private isRstFileName(fileName: string): boolean {
    return this.getFileExtension(fileName) === 'rst';
  }
}

export const rstParser = new RstFormatParser();

export { RstParser, parseRstFile } from './parser.js';
export { mergeRstDocuments, rstToDocNode } from './adapter.js';
export type { RstDocument } from './parser.js';
