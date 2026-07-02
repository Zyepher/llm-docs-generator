/**
 * HTTP Spec Fetcher with Caching
 *
 * Performance optimizations:
 * - Uses undici (faster than node-fetch)
 * - File system cache to avoid repeated downloads
 * - Efficient path operations
 * - Connection pooling via undici
 */

import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'undici';

import type { ConfigLoader } from '../config/loader.js';
import { errorMessage } from './guards.js';
import { info, warn, error as logError } from './logger.js';
import { writeTextFileSafely } from './safe-write.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const FETCH_TIMEOUT = 30000; // 30 seconds
const USER_AGENT = 'llm-docs/1.0.0';
const MAX_SPEC_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MB safety cap for spec downloads

class SourceAvailabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceAvailabilityError';
  }
}

const REDACTED_QUERY_PARAMS = new Set([
  'token',
  'access_token',
  'apikey',
  'api_key',
  'key',
  'sig',
  'signature',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'x-goog-signature',
  'x-goog-credential',
  'awsaccesskeyid',
]);

/**
 * Strip credentials from a URL before logging: remove userinfo (user:token@)
 * and mask common secret query parameters (including presigned-URL signature
 * and credential families), so a spec URL carrying a token does not leak into
 * logs/error messages. Param names are matched case-insensitively.
 */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    // Snapshot the keys first: mutating searchParams while iterating its
    // live view can skip entries.
    for (const param of [...new Set(url.searchParams.keys())]) {
      if (REDACTED_QUERY_PARAMS.has(param.toLowerCase())) {
        url.searchParams.set(param, 'REDACTED');
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

// ============================================================================
// FETCHER FUNCTIONS
// ============================================================================

/**
 * Fetch specification file with caching
 * Performance: O(1) cache hit, O(n) cache miss (network bound)
 *
 * @param sdkName - SDK name (e.g., 'javascript', 'swift')
 * @param version - Version string (e.g., 'v2', 'latest')
 * @param config - Configuration loader
 * @param cacheDir - Absolute directory for cached spec files
 * @param forceDownload - Force download even if cached
 * @returns Tuple of [specPath, resolvedVersion]
 */
export async function fetchSpec(
  sdkName: string,
  version: string,
  config: ConfigLoader,
  cacheDir: string,
  forceDownload = false
): Promise<[string, string]> {
  // Get version config
  const versionConfig = config.getSDKVersionConfig(sdkName, version);

  // Resolve 'latest' to actual version for caching
  const actualVersion = config.resolveSDKVersion(sdkName, version);

  // Check for local path override
  if (versionConfig.spec.localPath !== null && !forceDownload) {
    const localPath = versionConfig.spec.localPath;

    if (existsSync(localPath)) {
      info(`Using local spec: ${localPath}`);
      return [localPath, actualVersion];
    }

    warn(`Local path specified but not found: ${localPath}`);
  }

  // Build cache path
  const cacheFileName = `supabase_${sdkName}_${actualVersion}.yml`;
  const cachePath = join(cacheDir, cacheFileName);

  // Check cache (unless force download)
  if (!forceDownload && existsSync(cachePath)) {
    info(`Using cached spec: ${cachePath}`);
    return [cachePath, actualVersion];
  }

  // Download from URL
  const specUrl = versionConfig.spec.url;
  info(`Fetching spec from: ${redactUrl(specUrl)}`);

  try {
    await checkRemoteSpecAvailability(specUrl, FETCH_TIMEOUT);
    const content = await downloadFile(specUrl, FETCH_TIMEOUT);

    // Ensure cache directory exists
    await mkdir(cacheDir, { recursive: true });

    // Write to cache atomically (temp + rename) so a crashed download can
    // never leave a truncated spec that later cache hits would trust.
    await writeTextFileSafely(cachePath, content);

    info(`Spec downloaded and cached: ${cachePath}`);
    return [cachePath, actualVersion];
  } catch (err) {
    if (err instanceof SourceAvailabilityError) {
      logError(err.message);
      throw err;
    }

    const message = errorMessage(err);
    logError(`Failed to download spec from ${redactUrl(specUrl)}: ${message}`);
    throw new Error(`Failed to download spec from ${redactUrl(specUrl)}: ${message}`);
  }
}

async function checkRemoteSpecAvailability(url: string, timeout: number): Promise<void> {
  let response: Awaited<ReturnType<typeof request>>;

  try {
    response = await request(url, {
      method: 'HEAD',
      headersTimeout: timeout,
      bodyTimeout: timeout,
      headers: {
        'User-Agent': USER_AGENT,
      },
    });
  } catch (err) {
    // A transport failure (reset, timeout, DNS) only proves the HEAD did not
    // get through; some servers drop HEAD while serving GET fine. Advisory
    // only: let the authoritative GET decide.
    warn(
      `Spec source availability check inconclusive for ${redactUrl(url)} (${errorMessage(err)}), proceeding to download`
    );
    return;
  }

  try {
    await response.body.text();
  } catch (err) {
    warn(
      `Spec source availability check inconclusive for ${redactUrl(url)} (${errorMessage(err)}), proceeding to download`
    );
    return;
  }

  const { statusCode } = response;

  if (statusCode >= 200 && statusCode < 300) {
    return;
  }

  // The GET path never follows redirects and requires 200, so a 3xx HEAD says
  // nothing about whether the download will succeed; let the GET produce the
  // real outcome.
  if (statusCode >= 300 && statusCode < 400) {
    warn(
      `Spec source availability check inconclusive for ${redactUrl(url)} (HTTP ${statusCode}), proceeding to download`
    );
    return;
  }

  // 404/410 mean the resource is definitively absent, so fail fast without a
  // wasted GET. Every other non-success HEAD status is inconclusive: the server
  // may simply restrict HEAD (405/501), require method-specific auth (401/403 on
  // a presigned GET-only URL, e.g. S3/GCS SigV4), rate-limit, or be transiently
  // erroring. Fall through to the authoritative GET rather than rejecting a spec
  // that GET can actually download.
  if (statusCode === 404 || statusCode === 410) {
    throw new SourceAvailabilityError(
      `Spec source unavailable at ${redactUrl(url)}: HTTP ${statusCode}`
    );
  }

  warn(
    `Spec source HEAD check inconclusive for ${redactUrl(url)} (HTTP ${statusCode}); trying GET`
  );
}

/**
 * Download file from URL using undici
 * Performance: O(n) where n = file size (network bound)
 *
 * Undici is significantly faster than node-fetch:
 * - Connection pooling
 * - Better HTTP/1.1 pipelining
 * - Lower memory overhead
 */
async function downloadFile(url: string, timeout: number): Promise<string> {
  const response = await request(url, {
    method: 'GET',
    headersTimeout: timeout,
    bodyTimeout: timeout,
    headers: {
      'User-Agent': USER_AGENT,
    },
  });

  if (response.statusCode !== 200) {
    try {
      await response.body.text();
    } catch {
      // Preserve the existing HTTP status failure while still attempting cleanup.
    }

    throw new Error(`HTTP ${response.statusCode}`);
  }

  return readBodyWithLimit(response.body, MAX_SPEC_DOWNLOAD_BYTES);
}

/**
 * Read a response body into a string, aborting if it exceeds maxBytes. Prevents
 * an unbounded (or maliciously large) spec response from exhausting memory.
 */
async function readBodyWithLimit(
  body: AsyncIterable<Buffer | Uint8Array | string>,
  maxBytes: number
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of body) {
    const buffer =
      typeof chunk === 'string'
        ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk);
    total += buffer.length;

    if (total > maxBytes) {
      throw new Error(`Spec response body exceeds the ${maxBytes}-byte limit`);
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Check if spec is cached
 * Performance: O(1) - file existence check
 */
export function isSpecCached(sdkName: string, version: string, cacheDir: string): boolean {
  const cacheFileName = `supabase_${sdkName}_${version}.yml`;
  const cachePath = join(cacheDir, cacheFileName);

  return existsSync(cachePath);
}

/**
 * Get cached spec path (does not download)
 * Performance: O(1)
 */
export function getCachedSpecPath(
  sdkName: string,
  version: string,
  cacheDir: string
): string | null {
  const cacheFileName = `supabase_${sdkName}_${version}.yml`;
  const cachePath = join(cacheDir, cacheFileName);

  return existsSync(cachePath) ? cachePath : null;
}

/**
 * Clear spec cache
 * Performance: O(n) where n = number of cached files
 */
export async function clearSpecCache(
  cacheDir: string,
  sdkName?: string,
  version?: string
): Promise<number> {
  if (sdkName !== undefined && version !== undefined) {
    // Clear specific cache file
    const cacheFileName = `supabase_${sdkName}_${version}.yml`;
    const cachePath = join(cacheDir, cacheFileName);

    if (existsSync(cachePath)) {
      const { unlink } = await import('node:fs/promises');
      await unlink(cachePath);
      return 1;
    }

    return 0;
  }

  // Clear all cache files
  const { readdir, unlink } = await import('node:fs/promises');

  if (!existsSync(cacheDir)) {
    return 0;
  }

  const files = await readdir(cacheDir);
  const cacheFiles = files.filter((f) => f.startsWith('supabase_') && f.endsWith('.yml'));

  let deletedCount = 0;
  for (const file of cacheFiles) {
    await unlink(join(cacheDir, file));
    deletedCount++;
  }

  return deletedCount;
}
