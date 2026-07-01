import { readFile } from 'node:fs/promises';

import { sha256Prefixed } from '../utils/hash.js';
import { estimateTokenCount } from '../utils/text-metrics.js';

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
    // Use the shared estimator (text-metrics) so per-output token counts match
    // the per-chunk counts recorded by the chunker / semantic-chunk index. The
    // previous local `Array.from(text).length / 4` both diverged from that
    // shared formula (code points vs UTF-16 units on astral characters) and
    // allocated a full per-code-point array for a single integer.
    estimatedTokenCount: estimateTokenCount(text),
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
