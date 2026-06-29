import { createHash } from 'node:crypto';

/**
 * Deterministic aggregate hash over a directory's source files.
 *
 * Shared by the source-docs writer and the manifest verifier so the two can
 * never drift (a divergence would make every source-docs directory manifest
 * fail verification, or pass with a meaningless hash). The exact byte format —
 * seed line, NUL-separated path/byteSize/hash, newline-terminated records — is
 * part of the on-disk contract and must not change without a version bump.
 *
 * Note: the NUL separator is not strictly injective against newline-bearing
 * file names, but per-file hashes are also recorded individually and the
 * writer/verifier share this function, so it cannot cause a false verify
 * failure. Hardening to a length-prefixed encoding would change recorded
 * hashes and is intentionally deferred.
 */
export function aggregateSourceFilesHash(
  files: ReadonlyArray<{ path: string; byteSize: number; hash: string }>
): string {
  const hash = createHash('sha256');
  hash.update('llm-docs-generator:source-docs-directory:v1\n');

  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.byteSize));
    hash.update('\0');
    hash.update(file.hash);
    hash.update('\n');
  }

  return `sha256:${hash.digest('hex')}`;
}
