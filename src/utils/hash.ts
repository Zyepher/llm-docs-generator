import { createHash, type BinaryLike } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Shared SHA-256 helpers. Centralized so the hashes that feed manifests and
 * `verify`'s rebuild-and-compare cannot drift between modules.
 *
 * Determinism contract:
 * - sha256Hex hashes the value VERBATIM (a Buffer stays a Buffer); never coerce
 *   to string, or recorded source/content hashes would change.
 * - HASH_PREFIX is the canonical "sha256:" prefix used in recorded hashes.
 */
export const HASH_PREFIX = 'sha256:';

export function sha256Hex(data: BinaryLike): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256Prefixed(data: BinaryLike): string {
  return `${HASH_PREFIX}${sha256Hex(data)}`;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  return `${HASH_PREFIX}${hash.digest('hex')}`;
}

export function isSha256Hash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function isUnprefixedSha256Hash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
