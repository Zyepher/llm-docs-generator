/**
 * reStructuredText parser implementation.
 *
 * Handles explicit local .rst files and directories containing .rst files.
 */

import { lstat } from 'node:fs/promises';
import { basename } from 'node:path';

import type { DocNode } from '../../core/models.js';
import { directoryContainsMatchingFile, findFilesRecursively } from '../../utils/traversal.js';
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
        return await directoryContainsMatchingFile(sourcePath, (fileName) =>
          this.isRstFileName(fileName)
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
    const files = (
      await findFilesRecursively(dirPath, (fileName) => this.isRstFileName(fileName))
    ).sort();

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

  private isRstFileName(fileName: string): boolean {
    return this.getFileExtension(fileName) === 'rst';
  }
}

export const rstParser = new RstFormatParser();

export { parseRstFile } from './parser.js';
export type { RstDocument } from './parser.js';
