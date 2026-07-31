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

/**
 * Manifest invariant: a manifest's `generatedOutputs` must never contain two
 * entries for the same path. Two entries for one path (which can arise when a
 * reserved artifact name is claimed by a category slice, so one file overwrites
 * the other) hide the loss from verify — a duplicate path+hash pair still hashes
 * clean. Every manifest writer runs this before serializing, so the corruption
 * fails loudly at generation instead of shipping a masked pack.
 */
export function assertUniqueGeneratedOutputPaths(outputs: ReadonlyArray<{ path: string }>): void {
  const seen = new Set<string>();
  for (const output of outputs) {
    if (seen.has(output.path)) {
      throw new Error(
        `manifest invariant violated: generatedOutputs contains duplicate path ${output.path}`
      );
    }
    seen.add(output.path);
  }
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
