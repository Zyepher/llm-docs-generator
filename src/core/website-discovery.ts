import { mkdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';

import { request } from 'undici';

import { DISCOVERY_REPORT_SCHEMA_VERSION } from './discovery.js';
import { writeTextFileSafely } from '../utils/safe-write.js';
import { compareStringsByCodeUnit } from '../utils/sort.js';

export const WEBSITE_BOUNDED_INSPECTION_MODE = 'website-bounded-inspection';
export const DEFAULT_WEBSITE_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_WEBSITE_MAX_BYTES_PER_RESPONSE = 65_536;
export const DEFAULT_WEBSITE_MAX_CANDIDATES = 200;

const USER_AGENT = 'llm-docs-generator/1.0 website-discovery';

const WEBSITE_RESOURCE_ROLE_ORDER: Record<WebsiteResourceRole, number> = {
  'explicit-url': 0,
  'llms-txt': 1,
  'sitemap-xml': 2,
};

const WEBSITE_EVIDENCE_RELATION_ORDER: Record<WebsiteCandidateEvidenceRelation, number> = {
  canonical: 0,
  link: 1,
  'markdown-link': 2,
  'bare-url': 3,
  'sitemap-loc': 4,
};

export type WebsiteResourceRole = 'explicit-url' | 'llms-txt' | 'sitemap-xml';
export type WebsiteCandidateEvidenceRelation =
  | 'bare-url'
  | 'canonical'
  | 'link'
  | 'markdown-link'
  | 'sitemap-loc';
export type WebsiteCandidateEvidenceFlag =
  | 'docs-like-url'
  | 'github-url'
  | 'machine-readable-url'
  | 'source-like-url';

export interface DiscoverWebsiteOptions {
  url: string;
  outputDir?: string;
  timeoutMs?: number;
  maxBytesPerResponse?: number;
  maxCandidates?: number;
  /**
   * Allow fetching private/link-local/metadata IP literals. Default false:
   * link-local (incl. cloud metadata 169.254.169.254) and RFC1918 ranges are
   * refused as an SSRF guard. Loopback is always allowed (local dev). Hostnames
   * are not DNS-resolved, so DNS-rebinding is out of scope.
   */
  allowPrivateHosts?: boolean;
}

export interface WebsiteInspectedResource {
  url: string;
  status: number | null;
  contentType: string | null;
  byteSize: number;
  truncated: boolean;
  sourceRole: WebsiteResourceRole;
  freshness: WebsiteResourceFreshnessMetadata;
}

export interface WebsiteResourceFreshnessMetadata {
  observedAt: string;
  etag: string | null;
  lastModified: string | null;
}

export interface WebsiteCrawlPolicy {
  inspectedResourceUrls: string[];
  sameOriginWellKnownResources: string[];
  linkedCandidateFetches: false;
  renderedJavaScript: false;
  timeoutMs: number;
  maxBytesPerResponse: number;
  maxCandidates: number;
  candidateLimitReached: boolean;
}

export interface WebsiteCandidateSourceResource {
  url: string;
  sourceRole: WebsiteResourceRole;
  evidence: WebsiteCandidateEvidenceRelation;
}

export interface WebsiteCandidateEvidence {
  relations: WebsiteCandidateEvidenceRelation[];
  flags: WebsiteCandidateEvidenceFlag[];
  signals: string[];
}

export interface WebsiteDiscoveryCandidate {
  url: string;
  sameOrigin: boolean;
  external: boolean;
  order: number;
  evidence: WebsiteCandidateEvidence;
  sourceResources: WebsiteCandidateSourceResource[];
}

export interface WebsiteDiscoveryInspection {
  website: {
    input: string;
    normalizedUrl: string;
    origin: string;
  };
  inspectedResources: WebsiteInspectedResource[];
  crawlPolicy: WebsiteCrawlPolicy;
  candidates: WebsiteDiscoveryCandidate[];
  warnings: string[];
}

export interface WebsiteDiscoveryReport extends WebsiteDiscoveryInspection {
  schemaVersion: typeof DISCOVERY_REPORT_SCHEMA_VERSION;
  mode: typeof WEBSITE_BOUNDED_INSPECTION_MODE;
  generatedAt: string;
  output: {
    reportPath: string;
  };
}

export interface DiscoverWebsiteResult {
  report: WebsiteDiscoveryReport;
  reportPath: string;
}

interface PlannedWebsiteResource {
  url: string;
  sourceRole: WebsiteResourceRole;
}

interface FetchedWebsiteResource {
  resource: WebsiteInspectedResource;
  text: string | null;
  error: string | null;
}

interface ReadBodyResult {
  text: string;
  byteSize: number;
  truncated: boolean;
}

class BodyReadError extends Error {
  constructor(
    message: string,
    readonly byteSize: number,
    readonly truncated: boolean
  ) {
    super(message);
    this.name = 'BodyReadError';
  }
}

interface CandidateAccumulator {
  url: string;
  sameOrigin: boolean;
  external: boolean;
  firstObservedOrder: number;
  relations: Set<WebsiteCandidateEvidenceRelation>;
  flags: Set<WebsiteCandidateEvidenceFlag>;
  signals: Set<string>;
  sourceResources: Map<string, WebsiteCandidateSourceResource>;
}

interface CandidateCollectionState {
  candidatesByUrl: Map<string, CandidateAccumulator>;
  maxCandidates: number;
  nextObservedOrder: number;
  limitReached: boolean;
}

type CandidateFilter = (normalizedUrl: string) => boolean;

export async function discoverWebsite(
  options: DiscoverWebsiteOptions
): Promise<DiscoverWebsiteResult> {
  const inspection = await inspectWebsite(options);
  const outputDir =
    options.outputDir === undefined
      ? defaultOutputDirForWebsite(inspection.website.normalizedUrl)
      : resolve(options.outputDir);
  const reportPath = join(outputDir, 'discovery-report.json');
  const report: WebsiteDiscoveryReport = {
    schemaVersion: DISCOVERY_REPORT_SCHEMA_VERSION,
    mode: WEBSITE_BOUNDED_INSPECTION_MODE,
    generatedAt: new Date().toISOString(),
    website: inspection.website,
    inspectedResources: inspection.inspectedResources,
    crawlPolicy: inspection.crawlPolicy,
    output: {
      reportPath,
    },
    candidates: inspection.candidates,
    warnings: inspection.warnings,
  };

  await mkdir(outputDir, { recursive: true });
  await writeTextFileSafely(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  return { report, reportPath };
}

export async function inspectWebsite(
  options: Omit<DiscoverWebsiteOptions, 'outputDir'>
): Promise<WebsiteDiscoveryInspection> {
  const normalizedUrl = normalizeWebsiteUrl(options.url, options.allowPrivateHosts ?? false);
  const websiteUrl = new URL(normalizedUrl);
  const timeoutMs = resolvePositiveSafeInteger(
    options.timeoutMs,
    DEFAULT_WEBSITE_FETCH_TIMEOUT_MS,
    'timeoutMs'
  );
  const maxBytesPerResponse = resolvePositiveSafeInteger(
    options.maxBytesPerResponse,
    DEFAULT_WEBSITE_MAX_BYTES_PER_RESPONSE,
    'maxBytesPerResponse'
  );
  const maxCandidates = resolvePositiveSafeInteger(
    options.maxCandidates,
    DEFAULT_WEBSITE_MAX_CANDIDATES,
    'maxCandidates'
  );
  const resourcePlan = buildResourcePlan(normalizedUrl);
  const warnings: string[] = [];
  const candidateState: CandidateCollectionState = {
    candidatesByUrl: new Map(),
    maxCandidates,
    nextObservedOrder: 1,
    limitReached: false,
  };
  const inspectedResources: WebsiteInspectedResource[] = [];

  for (const plannedResource of resourcePlan) {
    const fetched = await fetchWebsiteResource({
      plannedResource,
      timeoutMs,
      maxBytesPerResponse,
    });
    inspectedResources.push(fetched.resource);

    if (fetched.error !== null) {
      warnings.push(
        `Fetch failed for ${plannedResource.sourceRole} resource: ${plannedResource.url}. ${fetched.error}`
      );
      continue;
    }

    if (fetched.resource.status === null) {
      continue;
    }

    if (fetched.resource.status < 200 || fetched.resource.status >= 300) {
      warnings.push(
        `Non-2xx HTTP ${fetched.resource.status} for ${plannedResource.sourceRole} resource: ${plannedResource.url}`
      );
      continue;
    }

    if (fetched.resource.truncated) {
      warnings.push(
        `Response truncated at ${maxBytesPerResponse} bytes for ${plannedResource.sourceRole} resource: ${plannedResource.url}`
      );
    }

    if (!isSupportedContentType(plannedResource.sourceRole, fetched.resource.contentType)) {
      warnings.push(
        `Unsupported content type for ${plannedResource.sourceRole} resource: ${formatContentTypeForWarning(
          fetched.resource.contentType
        )} at ${plannedResource.url}`
      );
      continue;
    }

    if (fetched.text !== null) {
      extractCandidatesFromResource({
        plannedResource,
        text: fetched.text,
        websiteOrigin: websiteUrl.origin,
        state: candidateState,
        warnings,
      });
    }
  }

  const candidates = finalizeCandidates(candidateState.candidatesByUrl);

  return {
    website: {
      input: options.url,
      normalizedUrl,
      origin: websiteUrl.origin,
    },
    inspectedResources,
    crawlPolicy: {
      inspectedResourceUrls: resourcePlan.map((resource) => resource.url),
      sameOriginWellKnownResources: resourcePlan
        .filter((resource) => resource.sourceRole !== 'explicit-url')
        .map((resource) => resource.url),
      linkedCandidateFetches: false,
      renderedJavaScript: false,
      timeoutMs,
      maxBytesPerResponse,
      maxCandidates,
      candidateLimitReached: candidateState.limitReached,
    },
    candidates,
    warnings,
  };
}

function normalizeWebsiteUrl(input: string, allowPrivateHosts: boolean): string {
  const trimmed = input.trim();

  if (trimmed === '') {
    throw new Error('URL input is required for discover --url.');
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Malformed URL for discover --url.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme for discover --url: ${url.protocol}`);
  }

  if (url.username !== '' || url.password !== '') {
    throw new Error('Embedded credentials are not supported in discover --url.');
  }

  if (!allowPrivateHosts && isBlockedPrivateHost(url.hostname)) {
    throw new Error(
      `Refusing to fetch a private, link-local, or cloud-metadata address for discover --url: ${url.hostname} (use --allow-private-hosts to override).`
    );
  }

  url.hash = '';

  return url.href;
}

/**
 * SSRF guard: block link-local (incl. cloud metadata 169.254.169.254) and
 * RFC1918 private IP literals (and their IPv6 equivalents). Loopback is allowed
 * (local development and the same host the agent already controls). Non-literal
 * hostnames are not DNS-resolved here, so DNS-rebinding is explicitly out of
 * scope for this syntactic check.
 */
function isBlockedPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const ipVersion = isIP(host);

  if (ipVersion === 4) {
    const octets = host.split('.').map((part) => Number.parseInt(part, 10));
    const [a, b] = octets;
    if (a === undefined || b === undefined) {
      return false;
    }
    if (a === 169 && b === 254) {
      return true; // link-local, incl. cloud metadata
    }
    if (a === 10) {
      return true; // RFC1918
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true; // RFC1918
    }
    if (a === 192 && b === 168) {
      return true; // RFC1918
    }
    return false; // loopback (127/8) and public addresses allowed
  }

  if (ipVersion === 6) {
    // fe80::/10 (link-local) and fc00::/7 (unique local). ::1 loopback allowed.
    return /^fe[89ab]/.test(host) || /^f[cd]/.test(host);
  }

  return false;
}

function buildResourcePlan(normalizedUrl: string): PlannedWebsiteResource[] {
  return [
    { url: normalizedUrl, sourceRole: 'explicit-url' },
    { url: new URL('/llms.txt', normalizedUrl).href, sourceRole: 'llms-txt' },
    { url: new URL('/sitemap.xml', normalizedUrl).href, sourceRole: 'sitemap-xml' },
  ];
}

async function fetchWebsiteResource(options: {
  plannedResource: PlannedWebsiteResource;
  timeoutMs: number;
  maxBytesPerResponse: number;
}): Promise<FetchedWebsiteResource> {
  const { plannedResource, timeoutMs, maxBytesPerResponse } = options;
  const abortController = new AbortController();
  let timedOut = false;
  let status: number | null = null;
  let contentType: string | null = null;
  let etag: string | null = null;
  let lastModified: string | null = null;
  let byteSize = 0;
  let truncated = false;
  const observedAt = new Date().toISOString();
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);

  try {
    const response = await request(plannedResource.url, {
      method: 'GET',
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      maxRedirections: 0,
      signal: abortController.signal,
      headers: {
        Accept: 'text/html,text/plain,text/markdown,application/xml,text/xml,*/*;q=0.1',
        'User-Agent': USER_AGENT,
      },
    });
    status = response.statusCode;
    contentType = normalizeContentType(readHeaderValue(response.headers['content-type']));
    etag = normalizeFreshnessHeaderValue(readHeaderValue(response.headers.etag));
    lastModified = normalizeFreshnessHeaderValue(
      readHeaderValue(response.headers['last-modified'])
    );
    const readBody = await readBodyWithLimit(response.body, maxBytesPerResponse);
    byteSize = readBody.byteSize;
    truncated = readBody.truncated;

    return {
      resource: {
        url: plannedResource.url,
        status,
        contentType,
        byteSize,
        truncated,
        sourceRole: plannedResource.sourceRole,
        freshness: {
          observedAt,
          etag,
          lastModified,
        },
      },
      text: readBody.text,
      error: null,
    };
  } catch (error) {
    if (error instanceof BodyReadError) {
      byteSize = error.byteSize;
      truncated = error.truncated;
    }

    return {
      resource: {
        url: plannedResource.url,
        status,
        contentType,
        byteSize,
        truncated,
        sourceRole: plannedResource.sourceRole,
        freshness: {
          observedAt,
          etag,
          lastModified,
        },
      },
      text: null,
      error: timedOut ? `Timed out after ${timeoutMs} ms` : formatFetchError(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readBodyWithLimit(
  body: AsyncIterable<Buffer | Uint8Array | string> & { destroy?: () => void },
  maxBytes: number
): Promise<ReadBodyResult> {
  const chunks: Buffer[] = [];
  let byteSize = 0;
  let truncated = false;

  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remainingBytes = maxBytes - byteSize;

      if (remainingBytes > 0) {
        const retained =
          buffer.byteLength > remainingBytes ? buffer.subarray(0, remainingBytes) : buffer;
        chunks.push(retained);
        byteSize += retained.byteLength;
      }

      if (buffer.byteLength > remainingBytes) {
        truncated = true;
        body.destroy?.();
        break;
      }
    }
  } catch (error) {
    throw new BodyReadError(formatFetchError(error), byteSize, truncated);
  }

  return {
    text: Buffer.concat(chunks, byteSize).toString('utf-8'),
    byteSize,
    truncated,
  };
}

function extractCandidatesFromResource(options: {
  plannedResource: PlannedWebsiteResource;
  text: string;
  websiteOrigin: string;
  state: CandidateCollectionState;
  warnings: string[];
}): void {
  const { plannedResource, text, websiteOrigin, state, warnings } = options;

  switch (plannedResource.sourceRole) {
    case 'explicit-url':
      extractHtmlCandidates({ plannedResource, text, websiteOrigin, state, warnings });
      return;
    case 'llms-txt':
      extractLlmsTxtCandidates({ plannedResource, text, websiteOrigin, state, warnings });
      return;
    case 'sitemap-xml':
      extractSitemapCandidates({ plannedResource, text, websiteOrigin, state, warnings });
      return;
  }
}

function extractHtmlCandidates(options: {
  plannedResource: PlannedWebsiteResource;
  text: string;
  websiteOrigin: string;
  state: CandidateCollectionState;
  warnings: string[];
}): void {
  const { plannedResource, text, websiteOrigin, state, warnings } = options;

  for (const tag of text.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = parseHtmlAttributes(tag[0]);
    const rel = attributes.get('rel');
    const href = attributes.get('href');

    if (rel === undefined || href === undefined) {
      continue;
    }

    const relTokens = rel
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token !== '');

    if (relTokens.includes('canonical')) {
      addCandidate({
        rawUrl: href,
        baseUrl: plannedResource.url,
        relation: 'canonical',
        plannedResource,
        websiteOrigin,
        state,
        warnings,
      });
    }
  }

  for (const tag of text.matchAll(/<a\b[^>]*>/gi)) {
    const href = parseHtmlAttributes(tag[0]).get('href');

    if (href === undefined) {
      continue;
    }

    addCandidate({
      rawUrl: href,
      baseUrl: plannedResource.url,
      relation: 'link',
      plannedResource,
      websiteOrigin,
      state,
      warnings,
      shouldKeepCandidate: isHtmlAnchorCandidate,
    });
  }
}

function extractLlmsTxtCandidates(options: {
  plannedResource: PlannedWebsiteResource;
  text: string;
  websiteOrigin: string;
  state: CandidateCollectionState;
  warnings: string[];
}): void {
  const { plannedResource, text, websiteOrigin, state, warnings } = options;

  for (const match of text.matchAll(/!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    const rawUrl = match[1];

    if (rawUrl === undefined) {
      continue;
    }

    addCandidate({
      rawUrl,
      baseUrl: plannedResource.url,
      relation: 'markdown-link',
      plannedResource,
      websiteOrigin,
      state,
      warnings,
    });
  }

  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const rawUrl = match[0];

    addCandidate({
      rawUrl: trimBareUrl(rawUrl),
      baseUrl: plannedResource.url,
      relation: 'bare-url',
      plannedResource,
      websiteOrigin,
      state,
      warnings,
    });
  }
}

function extractSitemapCandidates(options: {
  plannedResource: PlannedWebsiteResource;
  text: string;
  websiteOrigin: string;
  state: CandidateCollectionState;
  warnings: string[];
}): void {
  const { plannedResource, text, websiteOrigin, state, warnings } = options;

  for (const match of text.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    const rawUrl = match[1];

    if (rawUrl === undefined) {
      continue;
    }

    addCandidate({
      rawUrl: decodeXmlEntities(rawUrl.trim()),
      baseUrl: plannedResource.url,
      relation: 'sitemap-loc',
      plannedResource,
      websiteOrigin,
      state,
      warnings,
    });
  }
}

function addCandidate(options: {
  rawUrl: string;
  baseUrl: string;
  relation: WebsiteCandidateEvidenceRelation;
  plannedResource: PlannedWebsiteResource;
  websiteOrigin: string;
  state: CandidateCollectionState;
  warnings: string[];
  shouldKeepCandidate?: CandidateFilter;
}): void {
  const {
    rawUrl,
    baseUrl,
    relation,
    plannedResource,
    websiteOrigin,
    state,
    warnings,
    shouldKeepCandidate,
  } = options;
  const normalizedUrl = normalizeCandidateUrl(rawUrl, baseUrl, plannedResource, warnings);

  if (normalizedUrl === null) {
    return;
  }

  if (shouldKeepCandidate !== undefined && !shouldKeepCandidate(normalizedUrl)) {
    return;
  }

  let candidate = state.candidatesByUrl.get(normalizedUrl);

  if (candidate === undefined) {
    if (state.candidatesByUrl.size >= state.maxCandidates) {
      if (!state.limitReached) {
        warnings.push(
          `Candidate limit reached: ${state.maxCandidates}; additional normalized URLs were not recorded.`
        );
        state.limitReached = true;
      }

      return;
    }

    const candidateUrl = new URL(normalizedUrl);
    const sameOrigin = candidateUrl.origin === websiteOrigin;
    candidate = {
      url: normalizedUrl,
      sameOrigin,
      external: !sameOrigin,
      firstObservedOrder: state.nextObservedOrder,
      relations: new Set(),
      flags: new Set(),
      signals: new Set(),
      sourceResources: new Map(),
    };
    state.nextObservedOrder++;
    state.candidatesByUrl.set(normalizedUrl, candidate);
  }

  candidate.relations.add(relation);
  candidate.signals.add(`relation:${relation}`);
  candidate.signals.add(candidate.sameOrigin ? 'origin:same' : 'origin:external');

  for (const flag of inferCandidateFlags(normalizedUrl)) {
    candidate.flags.add(flag);
    candidate.signals.add(signalForCandidateFlag(flag));
  }

  const sourceResourceKey = [plannedResource.url, plannedResource.sourceRole, relation].join('\0');

  if (!candidate.sourceResources.has(sourceResourceKey)) {
    candidate.sourceResources.set(sourceResourceKey, {
      url: plannedResource.url,
      sourceRole: plannedResource.sourceRole,
      evidence: relation,
    });
  }
}

function normalizeCandidateUrl(
  rawUrl: string,
  baseUrl: string,
  plannedResource: PlannedWebsiteResource,
  warnings: string[]
): string | null {
  const trimmed = decodeHtmlEntities(rawUrl).trim();

  if (trimmed === '') {
    return null;
  }

  let url: URL;

  try {
    url = new URL(trimmed, baseUrl);
  } catch {
    warnings.push(`Skipped malformed candidate URL in ${plannedResource.sourceRole} resource.`);
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    warnings.push(
      `Skipped unsupported candidate URL scheme ${url.protocol} in ${plannedResource.sourceRole} resource.`
    );
    return null;
  }

  if (url.username !== '' || url.password !== '') {
    url.username = '';
    url.password = '';
    warnings.push(
      `Scrubbed embedded credentials from candidate URL in ${plannedResource.sourceRole} resource.`
    );
  }

  url.hash = '';

  return url.href;
}

function finalizeCandidates(
  candidatesByUrl: Map<string, CandidateAccumulator>
): WebsiteDiscoveryCandidate[] {
  return [...candidatesByUrl.values()]
    .sort((a, b) => {
      const observedDifference = a.firstObservedOrder - b.firstObservedOrder;

      if (observedDifference !== 0) {
        return observedDifference;
      }

      return compareStringsByCodeUnit(a.url, b.url);
    })
    .map((candidate, index) => ({
      url: candidate.url,
      sameOrigin: candidate.sameOrigin,
      external: candidate.external,
      order: index + 1,
      evidence: {
        relations: sortRelations(candidate.relations),
        flags: [...candidate.flags].sort(compareStringsByCodeUnit),
        signals: [...candidate.signals].sort(compareStringsByCodeUnit),
      },
      sourceResources: [...candidate.sourceResources.values()].sort(compareSourceResources),
    }));
}

function isAttributeNameChar(ch: string): boolean {
  return !/\s/.test(ch) && !'"\'=<>`'.includes(ch);
}

/**
 * Parse name="value" attributes from a tag in a single linear pass.
 *
 * The previous regex `([^\s"'=<>`]+)\s*=\s*(...)` backtracked quadratically:
 * a long run of name characters with no following `=` made the engine rescan
 * from each position, so one ~64KB tag could burn seconds. This hand-written
 * scanner is O(tag length) and preserves the same name/value semantics
 * (quoted or unquoted values; boolean attributes without a value are skipped).
 */
function parseHtmlAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const length = tag.length;
  let index = 0;

  while (index < length) {
    // Skip separators (whitespace and stray '/').
    while (index < length && (/\s/.test(tag[index]!) || tag[index] === '/')) {
      index += 1;
    }
    if (index >= length) {
      break;
    }

    const nameStart = index;
    while (index < length && isAttributeNameChar(tag[index]!)) {
      index += 1;
    }

    if (index === nameStart) {
      // Not a name character (e.g. '<', '>', a stray quote/'='); advance past it.
      index += 1;
      continue;
    }

    const name = tag.slice(nameStart, index).toLowerCase();

    while (index < length && /\s/.test(tag[index]!)) {
      index += 1;
    }

    if (index >= length || tag[index] !== '=') {
      // Boolean attribute with no value; matches the old regex (which required
      // a value) by simply not recording it.
      continue;
    }

    index += 1; // consume '='
    while (index < length && /\s/.test(tag[index]!)) {
      index += 1;
    }

    let value: string;
    const quote = tag[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      const valueStart = index;
      while (index < length && tag[index] !== quote) {
        index += 1;
      }
      value = tag.slice(valueStart, index);
      if (index < length) {
        index += 1; // consume closing quote
      }
    } else {
      const valueStart = index;
      while (index < length && isAttributeNameChar(tag[index]!)) {
        index += 1;
      }
      value = tag.slice(valueStart, index);
      if (value === '') {
        continue;
      }
    }

    attributes.set(name, decodeHtmlEntities(value));
  }

  return attributes;
}

function inferCandidateFlags(url: string): WebsiteCandidateEvidenceFlag[] {
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();
  const pathname = parsedUrl.pathname.toLowerCase();
  const flags: WebsiteCandidateEvidenceFlag[] = [];

  if (hostname === 'github.com' || hostname.endsWith('.github.com')) {
    flags.push('github-url');
  }

  if (isSourceLikeUrl(hostname, pathname)) {
    flags.push('source-like-url');
  }

  if (isDocsLikeUrl(hostname, pathname)) {
    flags.push('docs-like-url');
  }

  if (isMachineReadableLikeUrl(pathname)) {
    flags.push('machine-readable-url');
  }

  return flags;
}

function isDocsLikeUrl(hostname: string, pathname: string): boolean {
  const target = `${hostname}${pathname}`;

  return /(^|[./_-])(api|docs?|documentation|guide|guides|handbook|learn|manual|reference)([./_-]|$)/i.test(
    target
  );
}

function isSourceLikeUrl(hostname: string, pathname: string): boolean {
  if (hostname === 'github.com' || hostname.endsWith('.github.com')) {
    return false;
  }

  if (
    hostname === 'gitlab.com' ||
    hostname.endsWith('.gitlab.com') ||
    hostname === 'bitbucket.org' ||
    hostname.endsWith('.bitbucket.org')
  ) {
    return true;
  }

  return /(^|[./_-])(repo|repository|source)([./_-]|$)/i.test(pathname);
}

function isHtmlAnchorCandidate(normalizedUrl: string): boolean {
  const flags = inferCandidateFlags(normalizedUrl);

  return (
    flags.includes('docs-like-url') ||
    flags.includes('github-url') ||
    flags.includes('machine-readable-url') ||
    flags.includes('source-like-url')
  );
}

function isMachineReadableLikeUrl(pathname: string): boolean {
  if (/\/llms\.txt$/i.test(pathname)) {
    return true;
  }

  if (!/\.(json|ya?ml)$/i.test(pathname)) {
    return false;
  }

  return /(^|[./_-])(openapi|openref|spec|swagger)([./_-]|$)/i.test(pathname);
}

function signalForCandidateFlag(flag: WebsiteCandidateEvidenceFlag): string {
  switch (flag) {
    case 'docs-like-url':
      return 'path:docs-like';
    case 'github-url':
      return 'url:github';
    case 'machine-readable-url':
      return 'path:machine-readable-like';
    case 'source-like-url':
      return 'path:source-like';
  }
}

function isSupportedContentType(role: WebsiteResourceRole, contentType: string | null): boolean {
  if (contentType === null) {
    return false;
  }

  switch (role) {
    case 'explicit-url':
      return contentType === 'text/html' || contentType === 'application/xhtml+xml';
    case 'llms-txt':
      return (
        contentType === 'text/plain' ||
        contentType === 'text/markdown' ||
        contentType === 'text/x-markdown'
      );
    case 'sitemap-xml':
      return (
        contentType === 'application/xml' ||
        contentType === 'text/xml' ||
        contentType === 'application/atom+xml' ||
        contentType === 'application/rss+xml'
      );
  }
}

function readHeaderValue(value: string | string[] | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function normalizeContentType(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const mediaType = value.split(';')[0]?.trim().toLowerCase();

  return mediaType === '' || mediaType === undefined ? null : mediaType;
}

function normalizeFreshnessHeaderValue(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === '' ? null : trimmed;
}

function formatContentTypeForWarning(contentType: string | null): string {
  return contentType ?? 'none';
}

function trimBareUrl(value: string): string {
  return value.replace(/[),.;!?]+$/g, '');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function decodeXmlEntities(value: string): string {
  return decodeHtmlEntities(value).replace(/&apos;/g, "'");
}

function sortRelations(
  relations: Set<WebsiteCandidateEvidenceRelation>
): WebsiteCandidateEvidenceRelation[] {
  return [...relations].sort(
    (a, b) => WEBSITE_EVIDENCE_RELATION_ORDER[a] - WEBSITE_EVIDENCE_RELATION_ORDER[b]
  );
}

function compareSourceResources(
  a: WebsiteCandidateSourceResource,
  b: WebsiteCandidateSourceResource
): number {
  const roleDifference =
    WEBSITE_RESOURCE_ROLE_ORDER[a.sourceRole] - WEBSITE_RESOURCE_ROLE_ORDER[b.sourceRole];

  if (roleDifference !== 0) {
    return roleDifference;
  }

  const urlDifference = compareStringsByCodeUnit(a.url, b.url);

  if (urlDifference !== 0) {
    return urlDifference;
  }

  return WEBSITE_EVIDENCE_RELATION_ORDER[a.evidence] - WEBSITE_EVIDENCE_RELATION_ORDER[b.evidence];
}

function defaultOutputDirForWebsite(normalizedUrl: string): string {
  const url = new URL(normalizedUrl);
  const port = url.port === '' ? '' : `-${url.port}`;
  const path = url.pathname === '/' ? 'root' : url.pathname.replace(/^\/+|\/+$/g, '');
  const directoryName = `${sanitizeFileName(`${url.hostname}${port}-${path}`)}-website-discovery`;

  return resolve(directoryName);
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'website';
}

function resolvePositiveSafeInteger(
  value: number | undefined,
  defaultValue: number,
  name: string
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return value;
}

function formatFetchError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
