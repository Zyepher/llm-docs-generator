/**
 * Shared text metrics for recorded chunk and output metadata.
 *
 * The estimatedTokenCount values produced here are recomputed and compared by
 * `verify`, so the chunk writer (chunker) and the JSONL-index verifier
 * (semantic-chunk-index) must call the SAME function or manifests would
 * silently fail verification. The estimate is deliberately a crude
 * characters/divisor budgeting hint, not a real tokenizer; changing the formula
 * would change every recorded value, so it is part of the on-disk contract.
 */
export const DEFAULT_ESTIMATED_CHARACTERS_PER_TOKEN = 4;

/**
 * Estimate token count as ceil(characters / divisor). The divisor is sanitized
 * exactly as the chunker previously did (non-finite falls back to the default,
 * otherwise floored and clamped to at least 1), so callers passing an unchecked
 * option get the same value the chunker produced.
 */
export function estimateTokenCount(
  content: string,
  estimatedCharactersPerToken: number = DEFAULT_ESTIMATED_CHARACTERS_PER_TOKEN
): number {
  const divisor = Number.isFinite(estimatedCharactersPerToken)
    ? Math.max(1, Math.floor(estimatedCharactersPerToken))
    : DEFAULT_ESTIMATED_CHARACTERS_PER_TOKEN;

  return Math.ceil(content.length / divisor);
}
