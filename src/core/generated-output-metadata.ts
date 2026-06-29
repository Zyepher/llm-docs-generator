import { readFile } from 'node:fs/promises';

import { sha256Prefixed } from '../utils/hash.js';

export interface GeneratedTextOutputMetadata {
  byteSize: number;
  hash: string;
  lineCount: number;
  estimatedTokenCount: number;
}

export async function describeGeneratedTextOutput(
  path: string
): Promise<GeneratedTextOutputMetadata> {
  const bytes = await readFile(path);
  const text = bytes.toString('utf-8');

  return {
    byteSize: bytes.byteLength,
    hash: sha256Prefixed(bytes),
    lineCount: countTextLines(text),
    estimatedTokenCount: estimateTextTokens(text),
  };
}

export function countTextLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  let newlineCount = 0;

  for (const character of text) {
    if (character === '\n') {
      newlineCount++;
    }
  }

  return text.endsWith('\n') ? newlineCount : newlineCount + 1;
}

export function estimateTextTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.ceil(Array.from(text).length / 4);
}
