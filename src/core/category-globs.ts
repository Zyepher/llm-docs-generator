/**
 * Deterministic, self-contained glob matching for `--categories` include
 * patterns over POSIX source relpaths.
 *
 * Supported subset (matched against the whole relpath, anchored):
 *  - `**`  matches any run of characters including `/`
 *  - `*`   matches any run of characters except `/`
 *  - `?`   matches a single character except `/`
 *  - all other characters match literally
 *
 * This is intentionally small and dependency-free; it is not a full glob
 * implementation (no brace expansion, no character classes).
 */

export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        pattern += '.*';
        index += 1;
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += escapeRegExpChar(char);
    }
  }
  return new RegExp(`^${pattern}$`);
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

export function matchesGlob(relpath: string, glob: string): boolean {
  return globToRegExp(glob).test(relpath);
}

export function matchesAnyGlob(relpath: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesGlob(relpath, glob));
}
