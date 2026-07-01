/**
 * HTTP Spec Fetcher with Caching
 *
 * Performance optimizations:
 * - Uses undici (faster than node-fetch)
 * - File system cache to avoid repeated downloads
 * - Efficient path operations
 * - Connection pooling via undici
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { request } from 'undici';

import type { ConfigLoader } from '../config/loader.js';
import { info, warn, error as logError } from './logger.js';

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

const REDACTED_QUERY_PARAMS = ['token', 'access_token', 'apikey', 'api_key', 'key', 'sig', 'signature'];

/**
 * Strip credentials from a URL before logging: remove userinfo (user:token@)
 * and mask common secret query parameters, so a spec URL carrying a token does
 * not leak into logs/error messages.
 */
function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const param of REDACTED_QUERY_PARAMS) {
      if (url.searchParams.has(param)) {
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
 * @param forceDownload - Force download even if cached
 * @returns Tuple of [specPath, resolvedVersion]
 */
export async function fetchSpec(
  sdkName: string,
  version: string,
  config: ConfigLoader,
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
  const cacheDir = 'config';
  const cacheFileName = `supabase_${sdkName}_${actualVersion}.yml`;
  const cachePath = `${cacheDir}/${cacheFileName}`;

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

    // Write to cache
    await writeFile(cachePath, content, 'utf-8');

    info(`Spec downloaded and cached: ${cachePath}`);
    return [cachePath, actualVersion];
  } catch (err) {
    if (err instanceof SourceAvailabilityError) {
      logError(err.message);
      throw err;
    }

    logError(`Failed to download spec from ${redactUrl(specUrl)}: ${String(err)}`);
    throw new Error(`Failed to download spec from ${redactUrl(specUrl)}: ${String(err)}`);
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
    throw new SourceAvailabilityError(
      `Spec source availability check failed for ${redactUrl(url)}: ${String(err)}`
    );
  }

  try {
    await response.body.text();
  } catch (err) {
    throw new SourceAvailabilityError(
      `Spec source availability check failed for ${redactUrl(url)}: ${String(err)}`
    );
  }

  const { statusCode } = response;

  if (statusCode >= 200 && statusCode < 400) {
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
export function isSpecCached(sdkName: string, version: string): boolean {
  const cacheFileName = `supabase_${sdkName}_${version}.yml`;
  const cachePath = `config/${cacheFileName}`;

  return existsSync(cachePath);
}

/**
 * Get cached spec path (does not download)
 * Performance: O(1)
 */
export function getCachedSpecPath(sdkName: string, version: string): string | null {
  const cacheFileName = `supabase_${sdkName}_${version}.yml`;
  const cachePath = `config/${cacheFileName}`;

  return existsSync(cachePath) ? cachePath : null;
}

/**
 * Download spec to specific path (advanced usage)
 * Performance: O(n) where n = file size
 */
export async function downloadSpecTo(url: string, outputPath: string): Promise<void> {
  info(`Downloading from ${redactUrl(url)} to ${outputPath}`);

  try {
    const content = await downloadFile(url, FETCH_TIMEOUT);

    // Extract directory from path
    const lastSlash = outputPath.lastIndexOf('/');
    const dir = lastSlash > 0 ? outputPath.substring(0, lastSlash) : '.';

    // Ensure directory exists
    await mkdir(dir, { recursive: true });

    // Write file
    await writeFile(outputPath, content, 'utf-8');

    info(`Downloaded successfully: ${outputPath}`);
  } catch (err) {
    logError(`Download failed: ${String(err)}`);
    throw err;
  }
}

/**
 * Clear spec cache
 * Performance: O(n) where n = number of cached files
 */
export async function clearSpecCache(sdkName?: string, version?: string): Promise<number> {
  const cacheDir = 'config';

  if (sdkName !== undefined && version !== undefined) {
    // Clear specific cache file
    const cacheFileName = `supabase_${sdkName}_${version}.yml`;
    const cachePath = `${cacheDir}/${cacheFileName}`;

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
    await unlink(`${cacheDir}/${file}`);
    deletedCount++;
  }

  return deletedCount;
}
