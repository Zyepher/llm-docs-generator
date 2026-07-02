/**
 * Directory names that bounded local traversals never descend into: version
 * control internals, dependency trees, and build outputs. Shared by discovery,
 * source-docs generation, source-truth, and source-verification so every
 * command that claims bounded local inspection skips the same vendored trees.
 * The lists had already drifted while copy-pasted per module ('.docusaurus'
 * was skipped only by source-verification); this is the reconciled union.
 */
export const SKIPPED_DIRECTORY_NAMES = [
  '.cache',
  '.docusaurus',
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
] as const;

const SKIPPED_DIRECTORY_NAME_SET: ReadonlySet<string> = new Set(SKIPPED_DIRECTORY_NAMES);

export function isSkippedTraversalDirectory(name: string): boolean {
  return SKIPPED_DIRECTORY_NAME_SET.has(name);
}
