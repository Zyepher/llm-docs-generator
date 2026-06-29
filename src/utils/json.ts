import { readFile } from 'node:fs/promises';

/**
 * Read and JSON-parse a UTF-8 file, returning the parsed value as `unknown`.
 *
 * Centralizes the read-then-parse that callers all performed inline. It
 * deliberately does NOT catch: every caller wraps it in its own try/catch and
 * maps ENOENT (missing file) versus SyntaxError (malformed JSON) to a
 * domain-specific error, so the rejection behavior is identical to the inline
 * `JSON.parse(await readFile(path, 'utf-8'))` it replaces.
 */
export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf-8'));
}
