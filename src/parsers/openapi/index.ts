/**
 * OpenAPI / Swagger Parser Implementation
 *
 * Converts explicit local OpenAPI 3.x and Swagger 2.0 JSON/YAML files into the
 * unified DocNode IR. It intentionally does not resolve remote references,
 * crawl websites, or infer source truth from implementation code.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { load as yamlLoad } from 'js-yaml';

import {
  ContentBlockType,
  DocNodeType,
  createContentBlock,
  createDocNode,
  type ContentBlock,
  type DocNode,
} from '../../core/models.js';
import { BaseParser, FormatType, ParserError } from '../base.js';
import { errorMessage, isRecord } from '../../utils/guards.js';
import { slugifyText } from '../../utils/slug.js';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const PARAMETER_LOCATION_ORDER = ['path', 'query', 'header', 'cookie', 'formData', 'body'] as const;
const FALLBACK_CATEGORY_TITLE = 'Untagged';
const MAX_EXAMPLE_LENGTH = 300;
// Inline markers emitted where an example or enum value cannot be shown, so the
// omission is visible in the pack instead of the value silently vanishing. The
// parenthetical wording keeps them from reading as real example values, and the
// text is deterministic (no sizes, no timestamps). A matching per-document
// summary warning reaches the manifest via the root node's 'warnings' metadata.
const OMITTED_VALUE_OVER_CAP = '(value omitted: exceeds inline cap)';
const OMITTED_VALUE_NOT_REPRESENTABLE = '(value omitted: not JSON-representable)';
// Cap each schema summary. Composition keywords (allOf/oneOf/anyOf) nest their
// child summaries, so a YAML-anchor doubling DAG would otherwise produce an
// O(2^depth)-length string (V8 throws "Invalid string length") even with
// memoized walking. Legitimate summaries are far shorter than this.
const MAX_SCHEMA_SUMMARY_LENGTH = 200;

type HttpMethod = (typeof HTTP_METHODS)[number];
type ApiSourceKind = 'openapi' | 'swagger';
type ApiFileFormat = 'json' | 'yaml';
type ApiDocument = Record<string, unknown>;

export interface ApiVersionInfo {
  sourceKind: ApiSourceKind;
  specVersion: string;
}

interface OperationEntry {
  categoryTitle: string;
  node: DocNode;
  path: string;
  method: HttpMethod;
}

// Per-document tally of omitted example/enum values. Counters, not per-site
// messages, so a spec with thousands of oversized examples yields at most two
// bounded summary warnings in the manifest.
interface ValueOmissions {
  overCap: number;
  notRepresentable: number;
}

// Shared per-document state threaded through the summarizers: the document is
// needed to dereference local schema $refs, the omissions tally backs the
// manifest warnings emitted by Wave 1.
interface SummaryContext {
  document: ApiDocument;
  omissions: ValueOmissions;
}

/**
 * OpenAPI / Swagger format parser.
 */
export class OpenApiFormatParser extends BaseParser {
  readonly name = 'OpenAPI / Swagger Parser';
  readonly format = FormatType.OPENAPI;

  /**
   * Detect OpenAPI / Swagger documents by content, not extension alone.
   *
   * Performance: O(n) JSON/YAML parse after an O(1) extension check.
   */
  async detect(sourcePath: string): Promise<boolean> {
    const ext = this.getFileExtension(sourcePath);
    if (ext !== 'json' && ext !== 'yaml' && ext !== 'yml') {
      return false;
    }

    if (!(await this.fileExists(sourcePath))) {
      return false;
    }

    try {
      const document = await this.loadDocument(sourcePath);
      // Numbers are accepted because unquoted YAML versions (`openapi: 3.0`,
      // `swagger: 2.0`) parse as numbers.
      return (
        typeof document.openapi === 'string' ||
        typeof document.openapi === 'number' ||
        typeof document.swagger === 'string' ||
        typeof document.swagger === 'number'
      );
    } catch {
      return false;
    }
  }

  /**
   * Parse an explicit local OpenAPI / Swagger file into DocNode IR.
   */
  async parse(sourcePath: string): Promise<DocNode> {
    const document = await this.loadDocument(sourcePath);
    const versionInfo = this.getVersionInfo(document);
    const paths = document.paths;

    if (!isRecord(paths)) {
      throw new ParserError('OpenAPI / Swagger document must contain a paths object', this.name);
    }

    try {
      return this.convertDocument(document, paths, versionInfo, sourcePath);
    } catch (error) {
      if (error instanceof ParserError) {
        throw error;
      }
      // Surface unexpected conversion failures (e.g. a RangeError from deeply
      // nested schemas exhausting the call stack) as an honest ParserError
      // instead of leaking a raw runtime error.
      const message = errorMessage(error);
      throw new ParserError(`Failed to convert OpenAPI / Swagger document: ${message}`, this.name);
    }
  }

  private async loadDocument(sourcePath: string): Promise<ApiDocument> {
    const fileFormat = getOpenApiFileFormat(sourcePath, this.name);
    const content = await readFile(sourcePath, 'utf-8');

    let parsed: unknown;

    try {
      parsed = fileFormat === 'json' ? JSON.parse(content) : yamlLoad(content);
    } catch (error) {
      const message = errorMessage(error);
      throw new ParserError(`Failed to parse OpenAPI / Swagger document: ${message}`, this.name);
    }

    if (!isRecord(parsed) || Array.isArray(parsed)) {
      throw new ParserError('OpenAPI / Swagger document root must be an object', this.name);
    }

    return parsed;
  }

  private getVersionInfo(document: ApiDocument): ApiVersionInfo {
    const openapi = document.openapi;
    if (typeof openapi === 'string' || typeof openapi === 'number') {
      // js-yaml parses unquoted `openapi: 3.0` as the number 3 and
      // `openapi: 3.1` as the number 3.1; restore the intended version string.
      let openapiVersion: string;
      if (typeof openapi === 'number') {
        openapiVersion = Number.isInteger(openapi) ? `${openapi}.0.0` : String(openapi);
      } else {
        openapiVersion = openapi.trim();
      }
      if (/^3\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(openapiVersion)) {
        return { sourceKind: 'openapi', specVersion: openapiVersion };
      }

      throw new ParserError(
        `Unsupported OpenAPI version "${openapiVersion}". Supported versions: OpenAPI 3.x and Swagger 2.0`,
        this.name
      );
    }

    const swagger = document.swagger;
    if (typeof swagger === 'string' || typeof swagger === 'number') {
      // js-yaml parses unquoted `swagger: 2.0` as the number 2.
      const swaggerVersion = swagger === 2 ? '2.0' : String(swagger).trim();
      if (swaggerVersion === '2.0') {
        return { sourceKind: 'swagger', specVersion: swaggerVersion };
      }

      throw new ParserError(
        `Unsupported Swagger version "${swaggerVersion}". Supported versions: OpenAPI 3.x and Swagger 2.0`,
        this.name
      );
    }

    throw new ParserError(
      'Unsupported OpenAPI / Swagger document: expected an openapi 3.x or swagger 2.0 version field',
      this.name
    );
  }

  private convertDocument(
    document: ApiDocument,
    paths: Record<string, unknown>,
    versionInfo: ApiVersionInfo,
    sourcePath: string
  ): DocNode {
    const info = isRecord(document.info) ? document.info : {};
    const title = readTrimmedString(info.title) ?? defaultRootTitle(versionInfo.sourceKind);
    const version = readTrimmedString(info.version);
    const description = readTrimmedString(info.description) ?? '';

    const metadata = new Map<string, unknown>();
    metadata.set('format', versionInfo.sourceKind);
    metadata.set('sourceKind', versionInfo.sourceKind);
    metadata.set('sourcePath', sourcePath);
    metadata.set('specVersion', versionInfo.specVersion);
    if (version !== undefined) {
      metadata.set('version', version);
    }
    metadata.set('title', title);

    const root = createDocNode(
      DocNodeType.ROOT,
      slugify(title || basenameWithoutExtension(sourcePath)),
      title,
      {
        description,
        metadata,
      }
    );

    const tagDescriptions = collectTagDescriptions(document);
    const omissions: ValueOmissions = { overCap: 0, notRepresentable: 0 };
    const operations = collectOperationEntries(document, paths, versionInfo, omissions);
    // The authentication category claims its id first so a real tag named
    // "Authentication" is disambiguated by the shared uniqueId guard.
    const usedCategoryIds = new Map<string, number>();
    const authenticationNode = buildAuthenticationNode(document, versionInfo, usedCategoryIds);
    const categories = groupOperationsByCategory(
      operations,
      tagDescriptions,
      versionInfo,
      usedCategoryIds
    );
    root.children =
      authenticationNode !== undefined ? [authenticationNode, ...categories] : categories;

    const omissionWarnings = summarizeValueOmissions(omissions);
    if (omissionWarnings.length > 0) {
      metadata.set('warnings', omissionWarnings);
    }

    return root;
  }
}

export const openApiParser = new OpenApiFormatParser();

export async function parseOpenApiFile(sourcePath: string): Promise<DocNode> {
  return await openApiParser.parse(sourcePath);
}

function collectOperationEntries(
  document: ApiDocument,
  paths: Record<string, unknown>,
  versionInfo: ApiVersionInfo,
  omissions: ValueOmissions
): OperationEntry[] {
  const entries: OperationEntry[] = [];
  const usedOperationIds = new Map<string, number>();

  for (const path of Object.keys(paths).sort(compareText)) {
    if (path.startsWith('x-')) {
      continue;
    }
    if (!path.startsWith('/')) {
      throw new ParserError(
        `Path key "${path}" must start with "/" or be an x- extension field`,
        'OpenAPI / Swagger Parser'
      );
    }

    const pathItem = paths[path];
    if (!isRecord(pathItem)) {
      throw new ParserError(
        `Path item for "${path}" must be an object`,
        'OpenAPI / Swagger Parser'
      );
    }

    const pathParameters = readParameterArray(pathItem.parameters, `parameters for path "${path}"`);

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (operation === undefined) {
        continue;
      }
      if (!isRecord(operation)) {
        throw new ParserError(
          `Operation ${method.toUpperCase()} ${path} must be an object`,
          'OpenAPI / Swagger Parser'
        );
      }

      const operationParameters = readParameterArray(
        operation.parameters,
        `parameters for ${method.toUpperCase()} ${path}`
      );
      const parameters = mergeParameters(pathParameters, operationParameters);
      const responses = readResponsesObject(
        operation.responses,
        `responses for ${method.toUpperCase()} ${path}`,
        versionInfo
      );
      const requestBody =
        versionInfo.sourceKind === 'openapi'
          ? readOpenApiRequestBodyObject(
              operation.requestBody,
              `requestBody for ${method.toUpperCase()} ${path}`
            )
          : undefined;
      const categoryTitle = getFirstTag(operation) ?? FALLBACK_CATEGORY_TITLE;
      const baseOperationId =
        readTrimmedString(operation.operationId) ?? fallbackOperationId(method, path);
      const nodeId = uniqueId(baseOperationId, usedOperationIds);
      const node = convertOperation(
        document,
        operation,
        nodeId,
        parameters,
        requestBody,
        responses,
        method,
        path,
        versionInfo,
        omissions
      );

      entries.push({
        categoryTitle,
        node,
        path,
        method,
      });
    }
  }

  return entries.sort(compareOperationEntries);
}

function convertOperation(
  document: ApiDocument,
  operation: Record<string, unknown>,
  nodeId: string,
  parameters: unknown[],
  requestBody: Record<string, unknown> | undefined,
  responses: Record<string, unknown>,
  method: HttpMethod,
  path: string,
  versionInfo: ApiVersionInfo,
  omissions: ValueOmissions
): DocNode {
  const operationId = readTrimmedString(operation.operationId);
  const summary = readTrimmedString(operation.summary);
  const description = readTrimmedString(operation.description);
  const deprecated = operation.deprecated === true;
  const baseTitle = summary ?? operationId ?? `${method.toUpperCase()} ${path}`;
  const title = deprecated ? `${baseTitle} (deprecated)` : baseTitle;
  const nodeDescription = description ?? summary ?? '';

  const metadata = new Map<string, unknown>();
  metadata.set('method', method.toUpperCase());
  metadata.set('path', path);
  metadata.set('sourceKind', versionInfo.sourceKind);
  metadata.set('specVersion', versionInfo.specVersion);
  if (operationId !== undefined) {
    metadata.set('operationId', operationId);
  }
  if (deprecated) {
    metadata.set('deprecated', true);
  }

  const content = buildOperationContent(
    document,
    operation,
    requestBody,
    parameters,
    method,
    path,
    {
      summary,
      description,
      responses,
      sourceKind: versionInfo.sourceKind,
      omissions,
    }
  );

  return createDocNode(DocNodeType.OPERATION, nodeId, title, {
    description: nodeDescription,
    content,
    metadata,
  });
}

function buildOperationContent(
  document: ApiDocument,
  operation: Record<string, unknown>,
  requestBody: Record<string, unknown> | undefined,
  parameters: unknown[],
  method: HttpMethod,
  path: string,
  context: {
    summary: string | undefined;
    description: string | undefined;
    responses: Record<string, unknown>;
    sourceKind: ApiSourceKind;
    omissions: ValueOmissions;
  }
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const ctx: SummaryContext = { document, omissions: context.omissions };

  const endpointLines = [
    `Method: ${method.toUpperCase()}`,
    `Path: ${path}`,
    `Source kind: ${context.sourceKind}`,
  ];
  if (operation.deprecated === true) {
    endpointLines.push('Deprecated: yes');
  }
  blocks.push(createDetailBlock('Endpoint', endpointLines));

  if (context.summary !== undefined) {
    blocks.push(createDetailBlock('Summary', [context.summary]));
  }
  if (context.description !== undefined && context.description !== context.summary) {
    blocks.push(createDetailBlock('Description', [context.description]));
  }

  // Operation-level security overrides the document default; an explicit empty
  // array means the operation is public.
  const effectiveSecurity = Array.isArray(operation.security)
    ? operation.security
    : Array.isArray(document.security)
      ? document.security
      : undefined;
  if (effectiveSecurity !== undefined) {
    const securityLines = summarizeSecurityRequirements(effectiveSecurity);
    if (securityLines.length > 0) {
      blocks.push(createDetailBlock('Security', securityLines));
    }
  }

  const parameterLines = summarizeParameters(parameters, ctx);
  if (parameterLines.length > 0) {
    blocks.push(createDetailBlock('Parameters', parameterLines));
  }

  const requestBodyLines =
    context.sourceKind === 'openapi'
      ? summarizeOpenApiRequestBody(requestBody, ctx)
      : summarizeSwaggerRequestBody(operation, parameters, ctx);
  if (requestBodyLines.length > 0) {
    blocks.push(createDetailBlock('Request Body', requestBodyLines));
  }

  const responseLines = summarizeResponses(context.responses, context.sourceKind, ctx);
  if (responseLines.length > 0) {
    blocks.push(createDetailBlock('Responses', responseLines));
  }

  return blocks;
}

function createDetailBlock(title: string, lines: string[]): ContentBlock {
  return createContentBlock(
    ContentBlockType.PROSE,
    [title, ...lines.map((line) => `- ${line}`)].join('\n'),
    {
      annotations: new Map([['section', title.toLowerCase().replace(/\s+/g, '-')]]),
    }
  );
}

function summarizeParameters(parameters: unknown[], ctx: SummaryContext): string[] {
  return parameters
    .map((parameter) => summarizeParameter(parameter, ctx))
    .filter((line): line is string => line !== undefined)
    .sort(compareParameterLines);
}

function summarizeParameter(parameter: unknown, ctx: SummaryContext): string | undefined {
  const ref = readRef(parameter);
  if (ref !== undefined) {
    return `$ref: ${ref}`;
  }
  if (!isRecord(parameter)) {
    return undefined;
  }

  const name = readTrimmedString(parameter.name) ?? '(unnamed)';
  const location = readTrimmedString(parameter.in) ?? 'unknown';
  const required = parameter.required === true ? 'required' : 'optional';
  const description = readTrimmedString(parameter.description);
  const schema = summarizeSchema(parameter.schema, ctx) ?? summarizeSchema(parameter, ctx);
  const example = stringifySimpleExample(parameter.example, ctx.omissions);
  const parts = [`${name} (${location}, ${required})`];

  if (schema !== undefined) {
    parts.push(`schema ${schema}`);
  }
  if (description !== undefined) {
    parts.push(description);
  }
  if (example !== undefined) {
    parts.push(`example ${example}`);
  }

  return parts.join('; ');
}

function summarizeOpenApiRequestBody(
  requestBody: Record<string, unknown> | undefined,
  ctx: SummaryContext
): string[] {
  if (requestBody === undefined) {
    return [];
  }

  const ref = readRef(requestBody);
  if (ref !== undefined) {
    return [`$ref: ${ref}`];
  }

  const lines: string[] = [];
  const description = readTrimmedString(requestBody.description);
  if (description !== undefined) {
    lines.push(description);
  }
  if (requestBody.required === true) {
    lines.push('required: true');
  }

  const content = requestBody.content as Record<string, unknown>;
  lines.push(...summarizeMediaTypeMap(content, ctx));

  return lines;
}

function summarizeSwaggerRequestBody(
  operation: Record<string, unknown>,
  parameters: unknown[],
  ctx: SummaryContext
): string[] {
  const bodyParameters = parameters.filter((parameter) => {
    if (!isRecord(parameter)) {
      return false;
    }
    const location = readTrimmedString(parameter.in);
    return location === 'body' || location === 'formData';
  });

  if (bodyParameters.length === 0) {
    return [];
  }

  const contentTypes = readStringArray(operation.consumes);
  const fallbackContentTypes = readStringArray(ctx.document.consumes);
  const effectiveContentTypes =
    contentTypes.length > 0
      ? contentTypes
      : fallbackContentTypes.length > 0
        ? fallbackContentTypes
        : ['not specified'];

  const lines: string[] = [`content types: ${effectiveContentTypes.sort(compareText).join(', ')}`];

  for (const parameter of bodyParameters) {
    if (!isRecord(parameter)) {
      continue;
    }
    const name = readTrimmedString(parameter.name) ?? '(unnamed)';
    const schema = summarizeSchema(parameter.schema, ctx) ?? summarizeSchema(parameter, ctx);
    const description = readTrimmedString(parameter.description);
    const parts = [`${name} (${readTrimmedString(parameter.in) ?? 'body'})`];
    if (schema !== undefined) {
      parts.push(`schema ${schema}`);
    }
    if (description !== undefined) {
      parts.push(description);
    }
    lines.push(parts.join('; '));
  }

  return lines;
}

function summarizeResponses(
  responses: Record<string, unknown>,
  sourceKind: ApiSourceKind,
  ctx: SummaryContext
): string[] {
  return Object.keys(responses)
    .filter((status) => !status.toLowerCase().startsWith('x-'))
    .sort(compareResponseStatus)
    .map((status) => summarizeResponse(status, responses[status], sourceKind, ctx))
    .filter((line): line is string => line !== undefined);
}

function summarizeResponse(
  status: string,
  response: unknown,
  sourceKind: ApiSourceKind,
  ctx: SummaryContext
): string | undefined {
  const ref = readRef(response);
  if (ref !== undefined) {
    return `${status}: $ref ${ref}`;
  }
  if (!isRecord(response)) {
    return undefined;
  }

  const description = readTrimmedString(response.description) ?? 'No description';
  const parts = [`${status}: ${description}`];

  if (sourceKind === 'swagger') {
    const schema = summarizeSchema(response.schema, ctx);
    if (schema !== undefined) {
      parts.push(`schema ${schema}`);
    }
    const swaggerExamples = summarizeSwaggerExamples(response.examples, ctx.omissions);
    if (swaggerExamples.length > 0) {
      parts.push(`examples ${swaggerExamples.join('; ')}`);
    }
  }

  const content = isRecord(response.content) ? response.content : {};
  const mediaTypes = summarizeMediaTypeMap(content, ctx);
  if (mediaTypes.length > 0) {
    parts.push(mediaTypes.join('; '));
  }

  return parts.join('; ');
}

function summarizeMediaTypeMap(content: Record<string, unknown>, ctx: SummaryContext): string[] {
  return Object.keys(content)
    .sort(compareText)
    .map((contentType) => summarizeMediaType(contentType, content[contentType], ctx))
    .filter((line): line is string => line !== undefined);
}

function summarizeMediaType(
  contentType: string,
  mediaType: unknown,
  ctx: SummaryContext
): string | undefined {
  if (!isRecord(mediaType)) {
    return `${contentType}: no schema declared`;
  }

  const parts = [
    `${contentType}: ${summarizeSchema(mediaType.schema, ctx) ?? 'no schema declared'}`,
  ];
  const examples = summarizeMediaExamples(mediaType, ctx.omissions);
  if (examples.length > 0) {
    parts.push(`examples ${examples.join('; ')}`);
  }

  return parts.join('; ');
}

function summarizeMediaExamples(
  mediaType: Record<string, unknown>,
  omissions: ValueOmissions
): string[] {
  const examples: string[] = [];
  const directExample = stringifySimpleExample(mediaType.example, omissions);
  if (directExample !== undefined) {
    examples.push(`default ${directExample}`);
  }

  const namedExamples = isRecord(mediaType.examples) ? mediaType.examples : {};
  for (const name of Object.keys(namedExamples).sort(compareText)) {
    const rawExample = namedExamples[name];
    // Example Objects carry their payload in `value`, but reference objects and
    // externalValue-only examples have no inline value; surface those instead
    // of dropping the entry silently.
    const ref = readRef(rawExample);
    if (ref !== undefined) {
      examples.push(`${name} $ref ${ref}`);
      continue;
    }
    if (isRecord(rawExample) && !('value' in rawExample)) {
      const externalValue = readTrimmedString(rawExample.externalValue);
      if (externalValue !== undefined) {
        examples.push(`${name} externalValue ${externalValue}`);
      }
      continue;
    }
    const exampleValue = isRecord(rawExample) ? rawExample.value : rawExample;
    const example = stringifySimpleExample(exampleValue, omissions);
    if (example !== undefined) {
      examples.push(`${name} ${example}`);
    }
  }

  return examples;
}

function summarizeSwaggerExamples(examples: unknown, omissions: ValueOmissions): string[] {
  if (!isRecord(examples)) {
    return [];
  }

  const lines: string[] = [];
  for (const contentType of Object.keys(examples).sort(compareText)) {
    const example = stringifySimpleExample(examples[contentType], omissions);
    if (example !== undefined) {
      lines.push(`${contentType} ${example}`);
    }
  }
  return lines;
}

function summarizeSchema(
  schema: unknown,
  ctx: SummaryContext,
  seen = new WeakSet<object>(),
  memo = new WeakMap<object, string | undefined>()
): string | undefined {
  if (!isRecord(schema)) {
    return undefined;
  }

  // Memoize the per-object summary so a schema shared via YAML anchors/aliases
  // (which js-yaml resolves to the SAME object) is summarized exactly once.
  // `seen` (deleted on exit) only detects ancestor cycles, so without this a
  // doubling anchor DAG was re-walked O(2^depth) times.
  if (memo.has(schema)) {
    return memo.get(schema);
  }
  if (seen.has(schema)) {
    return 'circular schema';
  }
  seen.add(schema);

  let result: string | undefined;
  try {
    result = ((): string | undefined => {
      const ref = readRef(schema);
      if (ref !== undefined) {
        // Dereference only document-local schema refs; external or unknown
        // pointers stay verbatim (never fetched). The resolved target flows
        // through the same seen/memo guards, so self-referential schemas
        // collapse to "circular schema" instead of recursing forever.
        const resolved = resolveLocalSchemaRef(ref, ctx.document);
        if (resolved === undefined) {
          return ref;
        }
        const target = summarizeSchema(resolved.schema, ctx, seen, memo);
        if (target === undefined) {
          return ref;
        }
        return target.startsWith('{') ? `${resolved.name}${target}` : `${resolved.name}(${target})`;
      }

      for (const compositionKey of ['oneOf', 'anyOf', 'allOf'] as const) {
        const values = schema[compositionKey];
        if (Array.isArray(values) && values.length > 0) {
          const summaries = values
            .map((value) => summarizeSchema(value, ctx, seen, memo))
            .filter((summary): summary is string => summary !== undefined);
          if (summaries.length > 0) {
            return `${compositionKey}<${summaries.join(' | ')}>`;
          }
        }
      }

      const enumValues = Array.isArray(schema.enum)
        ? schema.enum
            .map((value) => stringifySimpleExample(value, ctx.omissions))
            .filter((value): value is string => value !== undefined)
        : [];
      if (enumValues.length > 0) {
        return `enum<${enumValues.join(' | ')}>`;
      }

      const type = readTrimmedString(schema.type);
      const format = readTrimmedString(schema.format);
      if (type === 'array') {
        return `array<${summarizeSchema(schema.items, ctx, seen, memo) ?? 'unknown'}>`;
      }
      const propertySummary = summarizeObjectProperties(schema, ctx, seen, memo);
      if (propertySummary !== undefined && (type === undefined || type === 'object')) {
        return propertySummary;
      }
      if (type !== undefined) {
        return format !== undefined ? `${type}(${format})` : type;
      }

      return 'inline schema';
    })();
  } finally {
    seen.delete(schema);
  }

  // Bound the summary length so nested composition cannot grow it exponentially.
  if (result !== undefined && result.length > MAX_SCHEMA_SUMMARY_LENGTH) {
    result = `${result.slice(0, MAX_SCHEMA_SUMMARY_LENGTH - 1)}…`;
  }

  memo.set(schema, result);
  return result;
}

function summarizeObjectProperties(
  schema: Record<string, unknown>,
  ctx: SummaryContext,
  seen: WeakSet<object>,
  memo: WeakMap<object, string | undefined>
): string | undefined {
  const properties = schema.properties;
  if (!isRecord(properties)) {
    return undefined;
  }

  const names = Object.keys(properties).sort(compareText);
  if (names.length === 0) {
    return undefined;
  }

  const required = new Set(readStringArray(schema.required));
  const parts = names.map((name) => {
    const summary = summarizeSchema(properties[name], ctx, seen, memo) ?? 'unknown';
    return `${name}${required.has(name) ? '' : '?'}: ${summary}`;
  });

  return `{${parts.join(', ')}}`;
}

// Resolves #/components/schemas/<name> (OpenAPI 3.x) and #/definitions/<name>
// (Swagger 2.0) against the loaded document. Anything else (external files,
// URLs, non-schema pointers, deeper paths) is left to the caller verbatim.
function resolveLocalSchemaRef(
  ref: string,
  document: ApiDocument
): { name: string; schema: Record<string, unknown> } | undefined {
  const match = /^#\/(components\/schemas|definitions)\/([^/]+)$/.exec(ref);
  const rawName = match?.[2];
  if (match === null || rawName === undefined) {
    return undefined;
  }

  // JSON pointer segments escape "/" as "~1" and "~" as "~0" (in that order).
  const name = rawName.replaceAll('~1', '/').replaceAll('~0', '~');
  const container =
    match[1] === 'definitions'
      ? document.definitions
      : isRecord(document.components)
        ? document.components.schemas
        : undefined;
  if (!isRecord(container) || !hasOwn(container, name)) {
    return undefined;
  }

  const schema = container[name];
  return isRecord(schema) ? { name, schema } : undefined;
}

// Renders the effective security requirements of an operation. The outer array
// lists alternatives (any one line suffices); entries within a line are all
// required together. An empty array or an empty requirement object means the
// operation is callable without credentials.
function summarizeSecurityRequirements(security: unknown[]): string[] {
  if (security.length === 0) {
    return ['none (no authentication required)'];
  }

  return security
    .map((requirement) => {
      if (!isRecord(requirement)) {
        return undefined;
      }
      const names = Object.keys(requirement).sort(compareText);
      if (names.length === 0) {
        return 'none (no authentication required)';
      }
      return names
        .map((name) => {
          const scopes = readStringArray(requirement[name]);
          return scopes.length > 0 ? `${name} (scopes: ${scopes.join(', ')})` : name;
        })
        .join(' + ');
    })
    .filter((line): line is string => line !== undefined);
}

// Builds the synthetic Authentication category summarizing the document's
// security schemes and default requirements, so a pack states how to
// authenticate. Structural fields only (type, scheme, location); never secrets.
function buildAuthenticationNode(
  document: ApiDocument,
  versionInfo: ApiVersionInfo,
  usedCategoryIds: Map<string, number>
): DocNode | undefined {
  const schemes =
    versionInfo.sourceKind === 'swagger'
      ? document.securityDefinitions
      : isRecord(document.components)
        ? document.components.securitySchemes
        : undefined;

  const schemeLines: string[] = [];
  if (isRecord(schemes)) {
    for (const name of Object.keys(schemes).sort(compareText)) {
      const line = summarizeSecurityScheme(name, schemes[name]);
      if (line !== undefined) {
        schemeLines.push(line);
      }
    }
  }

  const defaultSecurityLines = Array.isArray(document.security)
    ? summarizeSecurityRequirements(document.security)
    : [];

  if (schemeLines.length === 0 && defaultSecurityLines.length === 0) {
    return undefined;
  }

  const blocks: ContentBlock[] = [];
  if (schemeLines.length > 0) {
    blocks.push(createDetailBlock('Security Schemes', schemeLines));
  }
  if (defaultSecurityLines.length > 0) {
    blocks.push(createDetailBlock('Default Security', defaultSecurityLines));
  }

  const metadata = new Map<string, unknown>();
  metadata.set('sourceKind', versionInfo.sourceKind);
  metadata.set('synthetic', 'authentication');

  return createDocNode(
    DocNodeType.CATEGORY,
    uniqueSlug('Authentication', usedCategoryIds),
    'Authentication',
    {
      description: 'Authentication and authorization requirements declared by this API document.',
      content: blocks,
      metadata,
    }
  );
}

function summarizeSecurityScheme(name: string, scheme: unknown): string | undefined {
  const ref = readRef(scheme);
  if (ref !== undefined) {
    return `${name}: $ref ${ref}`;
  }
  if (!isRecord(scheme)) {
    return undefined;
  }

  const type = readTrimmedString(scheme.type) ?? 'unknown';
  const details: string[] = [];

  if (type === 'apiKey') {
    const location = readTrimmedString(scheme.in);
    const keyName = readTrimmedString(scheme.name);
    if (location !== undefined) {
      details.push(`in ${location}`);
    }
    if (keyName !== undefined) {
      details.push(`name: ${keyName}`);
    }
  } else if (type === 'http') {
    const httpScheme = readTrimmedString(scheme.scheme);
    const bearerFormat = readTrimmedString(scheme.bearerFormat);
    if (httpScheme !== undefined) {
      details.push(`scheme: ${httpScheme}`);
    }
    if (bearerFormat !== undefined) {
      details.push(`bearerFormat: ${bearerFormat}`);
    }
  } else if (type === 'oauth2') {
    // OpenAPI 3.x nests flow objects under `flows`; Swagger 2.0 uses a single
    // top-level `flow` string with a flat `scopes` map.
    const flowNames: string[] = [];
    const scopeNames = new Set<string>();
    if (isRecord(scheme.flows)) {
      for (const flowName of Object.keys(scheme.flows).sort(compareText)) {
        flowNames.push(flowName);
        const flow = scheme.flows[flowName];
        if (isRecord(flow) && isRecord(flow.scopes)) {
          for (const scope of Object.keys(flow.scopes)) {
            scopeNames.add(scope);
          }
        }
      }
    }
    const swaggerFlow = readTrimmedString(scheme.flow);
    if (swaggerFlow !== undefined) {
      flowNames.push(swaggerFlow);
    }
    if (isRecord(scheme.scopes)) {
      for (const scope of Object.keys(scheme.scopes)) {
        scopeNames.add(scope);
      }
    }
    if (flowNames.length > 0) {
      details.push(`flows: ${flowNames.join(', ')}`);
    }
    if (scopeNames.size > 0) {
      details.push(`scopes: ${[...scopeNames].sort(compareText).join(', ')}`);
    }
  } else if (type === 'openIdConnect') {
    const url = readTrimmedString(scheme.openIdConnectUrl);
    if (url !== undefined) {
      details.push(`url: ${url}`);
    }
  }

  const description = readTrimmedString(scheme.description);
  const parts = [`${name}: ${type}${details.length > 0 ? ` (${details.join(', ')})` : ''}`];
  if (description !== undefined) {
    parts.push(description);
  }
  return parts.join('; ');
}

function readParameterArray(value: unknown, context: string): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ParserError(`${context} must be an array`, 'OpenAPI / Swagger Parser');
  }

  value.forEach((parameter, index) => validateParameter(parameter, context, index));
  return value;
}

function validateParameter(parameter: unknown, context: string, index: number): void {
  if (!isRecord(parameter)) {
    throw new ParserError(
      `Parameter ${index} in ${context} must be an object or reference object`,
      'OpenAPI / Swagger Parser'
    );
  }

  if (hasOwn(parameter, '$ref')) {
    const ref = readRef(parameter);
    if (ref === undefined) {
      throw new ParserError(
        `Parameter ${index} in ${context} has an invalid $ref value`,
        'OpenAPI / Swagger Parser'
      );
    }
    return;
  }

  if (readTrimmedString(parameter.name) === undefined) {
    throw new ParserError(
      `Parameter ${index} in ${context} must include a non-empty string name`,
      'OpenAPI / Swagger Parser'
    );
  }

  if (readTrimmedString(parameter.in) === undefined) {
    throw new ParserError(
      `Parameter ${index} in ${context} must include a non-empty string in location`,
      'OpenAPI / Swagger Parser'
    );
  }

  validateSchemaRefs(parameter.schema, `schema for parameter ${index} in ${context}`);
}

function readOpenApiRequestBodyObject(
  value: unknown,
  context: string
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ParserError(
      `${context} must be an object or reference object`,
      'OpenAPI / Swagger Parser'
    );
  }

  if (hasOwn(value, '$ref')) {
    if (readRef(value) === undefined) {
      throw new ParserError(`${context} has an invalid $ref value`, 'OpenAPI / Swagger Parser');
    }
    return value;
  }

  if (value.content === undefined) {
    throw new ParserError(`${context} must include a content object`, 'OpenAPI / Swagger Parser');
  }

  validateMediaTypeMap(value.content, `${context} content`);
  return value;
}

function readResponsesObject(
  value: unknown,
  context: string,
  versionInfo: ApiVersionInfo
): Record<string, unknown> {
  if (value === undefined) {
    // OpenAPI 3.1 made the operation-level responses object optional; treat a
    // missing one as empty so the operation renders with no responses section.
    // Swagger 2.0 and OpenAPI 3.0.x still require it.
    if (operationResponsesOptional(versionInfo)) {
      return {};
    }
    throw new ParserError(`${context} must be present`, 'OpenAPI / Swagger Parser');
  }
  if (!isRecord(value)) {
    throw new ParserError(`${context} must be an object`, 'OpenAPI / Swagger Parser');
  }

  // `x-` keys are specification extensions, not responses; ignore them so a
  // valid Responses Object carrying extensions (incl. non-object values) is not
  // rejected.
  const statuses = Object.keys(value).filter((status) => !status.toLowerCase().startsWith('x-'));
  if (statuses.length === 0) {
    throw new ParserError(
      `${context} must contain at least one response`,
      'OpenAPI / Swagger Parser'
    );
  }

  for (const status of statuses) {
    if (status.trim().length === 0) {
      throw new ParserError(
        `${context} contains an empty response status`,
        'OpenAPI / Swagger Parser'
      );
    }

    const response = value[status];
    if (!isRecord(response)) {
      throw new ParserError(
        `Response "${status}" in ${context} must be an object or reference object`,
        'OpenAPI / Swagger Parser'
      );
    }

    if (hasOwn(response, '$ref') && readRef(response) === undefined) {
      throw new ParserError(
        `Response "${status}" in ${context} has an invalid $ref value`,
        'OpenAPI / Swagger Parser'
      );
    }

    if (hasOwn(response, '$ref')) {
      continue;
    }

    validateSchemaRefs(response.schema, `schema for response "${status}" in ${context}`);
    if (response.content !== undefined) {
      validateMediaTypeMap(response.content, `content for response "${status}" in ${context}`);
    }
    if (versionInfo.sourceKind === 'swagger' && response.examples !== undefined) {
      validateSwaggerExamples(response.examples, `examples for response "${status}" in ${context}`);
    }
  }

  return value;
}

function operationResponsesOptional(versionInfo: ApiVersionInfo): boolean {
  if (versionInfo.sourceKind !== 'openapi') {
    return false;
  }

  const minor = /^3\.(\d+)/.exec(versionInfo.specVersion)?.[1];
  return minor !== undefined && Number(minor) >= 1;
}

function validateMediaTypeMap(value: unknown, context: string): void {
  if (!isRecord(value)) {
    throw new ParserError(`${context} must be an object`, 'OpenAPI / Swagger Parser');
  }

  for (const contentType of Object.keys(value)) {
    if (contentType.trim().length === 0) {
      throw new ParserError(`${context} contains an empty media type`, 'OpenAPI / Swagger Parser');
    }
    validateMediaTypeObject(value[contentType], `media type "${contentType}" in ${context}`);
  }
}

function validateMediaTypeObject(value: unknown, context: string): void {
  if (!isRecord(value)) {
    throw new ParserError(`${context} must be an object`, 'OpenAPI / Swagger Parser');
  }

  validateSchemaRefs(value.schema, `schema for ${context}`);

  if (value.examples !== undefined) {
    validateOpenApiExamples(value.examples, `examples for ${context}`);
  }
}

function validateOpenApiExamples(value: unknown, context: string): void {
  if (!isRecord(value)) {
    throw new ParserError(`${context} must be an object`, 'OpenAPI / Swagger Parser');
  }

  for (const name of Object.keys(value)) {
    const example = value[name];
    if (!isRecord(example)) {
      throw new ParserError(
        `Example "${name}" in ${context} must be an object or reference object`,
        'OpenAPI / Swagger Parser'
      );
    }

    if (hasOwn(example, '$ref') && readRef(example) === undefined) {
      throw new ParserError(
        `Example "${name}" in ${context} has an invalid $ref value`,
        'OpenAPI / Swagger Parser'
      );
    }
  }
}

function validateSwaggerExamples(value: unknown, context: string): void {
  if (!isRecord(value)) {
    throw new ParserError(`${context} must be an object`, 'OpenAPI / Swagger Parser');
  }
}

function validateSchemaRefs(schema: unknown, context: string, seen = new WeakSet<object>()): void {
  if (schema === undefined) {
    return;
  }
  if (!isRecord(schema)) {
    return;
  }

  // `seen` is a permanent visited set: validation is idempotent, so each unique
  // schema object is checked once. This both detects cycles and collapses
  // anchor/alias DAG sharing, which previously caused O(2^depth) re-walking
  // because the node was removed from `seen` on exit.
  if (seen.has(schema)) {
    return;
  }
  seen.add(schema);

  if (hasOwn(schema, '$ref') && readRef(schema) === undefined) {
    throw new ParserError(`${context} has an invalid $ref value`, 'OpenAPI / Swagger Parser');
  }

  for (const compositionKey of ['oneOf', 'anyOf', 'allOf'] as const) {
    const values = schema[compositionKey];
    if (Array.isArray(values)) {
      values.forEach((value, index) =>
        validateSchemaRefs(value, `${context}.${compositionKey}[${index}]`, seen)
      );
    }
  }

  validateSchemaRefs(schema.items, `${context}.items`, seen);

  if (isRecord(schema.properties)) {
    for (const propertyName of Object.keys(schema.properties)) {
      validateSchemaRefs(
        schema.properties[propertyName],
        `${context}.properties.${propertyName}`,
        seen
      );
    }
  }
}

function mergeParameters(pathParameters: unknown[], operationParameters: unknown[]): unknown[] {
  const merged = new Map<string, unknown>();

  for (const parameter of [...pathParameters, ...operationParameters]) {
    merged.set(parameterKey(parameter, merged.size), parameter);
  }

  return [...merged.values()];
}

function parameterKey(parameter: unknown, fallbackIndex: number): string {
  const ref = readRef(parameter);
  if (ref !== undefined) {
    return `$ref:${ref}`;
  }
  if (isRecord(parameter)) {
    const name = readTrimmedString(parameter.name);
    const location = readTrimmedString(parameter.in);
    if (name !== undefined && location !== undefined) {
      return `${location}:${name}`;
    }
  }
  return `anonymous:${fallbackIndex}`;
}

function getFirstTag(operation: Record<string, unknown>): string | undefined {
  const tags = readStringArray(operation.tags);
  return tags[0];
}

function groupOperationsByCategory(
  operations: OperationEntry[],
  tagDescriptions: Map<string, string>,
  versionInfo: ApiVersionInfo,
  usedCategoryIds: Map<string, number>
): DocNode[] {
  const grouped = new Map<string, OperationEntry[]>();

  for (const operation of operations) {
    const existing = grouped.get(operation.categoryTitle);
    if (existing !== undefined) {
      existing.push(operation);
    } else {
      grouped.set(operation.categoryTitle, [operation]);
    }
  }

  return [...grouped.keys()].sort(compareText).map((categoryTitle) => {
    const categoryOperations = grouped.get(categoryTitle) ?? [];
    const metadata = new Map<string, unknown>();
    metadata.set('tag', categoryTitle);
    metadata.set('sourceKind', versionInfo.sourceKind);

    return createDocNode(
      DocNodeType.CATEGORY,
      uniqueSlug(categoryTitle, usedCategoryIds),
      categoryTitle,
      {
        description: tagDescriptions.get(categoryTitle) ?? '',
        children: categoryOperations.map((operation) => operation.node),
        metadata,
      }
    );
  });
}

function collectTagDescriptions(document: ApiDocument): Map<string, string> {
  const descriptions = new Map<string, string>();
  const tags = Array.isArray(document.tags) ? document.tags : [];

  for (const tag of tags) {
    if (!isRecord(tag)) {
      continue;
    }
    const name = readTrimmedString(tag.name);
    const description = readTrimmedString(tag.description);
    if (name !== undefined && description !== undefined) {
      descriptions.set(name, description);
    }
  }

  return descriptions;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => readTrimmedString(item))
    .filter((item): item is string => item !== undefined);
}

function readRef(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return readTrimmedString(value.$ref);
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Serialize an example or enum value for inline display. Returns undefined only
 * when the value is absent; a value that is present but cannot be shown (over
 * the inline cap, circular, or otherwise not JSON-representable) yields a
 * visible omission marker and is tallied for the manifest warning, so content
 * never vanishes silently.
 */
function stringifySimpleExample(value: unknown, omissions: ValueOmissions): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const state = { overCap: false };
  const json = stableJsonStringify(
    value,
    new WeakSet<object>(),
    new WeakMap<object, string | undefined>(),
    MAX_EXAMPLE_LENGTH,
    state
  );
  if (json !== undefined && json.length <= MAX_EXAMPLE_LENGTH) {
    return json;
  }
  if (json !== undefined || state.overCap) {
    omissions.overCap += 1;
    return OMITTED_VALUE_OVER_CAP;
  }
  omissions.notRepresentable += 1;
  return OMITTED_VALUE_NOT_REPRESENTABLE;
}

function summarizeValueOmissions(omissions: ValueOmissions): string[] {
  const warnings: string[] = [];
  if (omissions.overCap > 0) {
    warnings.push(
      `Omitted ${omissions.overCap} example or enum value(s) exceeding the inline cap; each omission is marked "${OMITTED_VALUE_OVER_CAP}" in place.`
    );
  }
  if (omissions.notRepresentable > 0) {
    warnings.push(
      `Omitted ${omissions.notRepresentable} example or enum value(s) not representable as JSON; each omission is marked "${OMITTED_VALUE_NOT_REPRESENTABLE}" in place.`
    );
  }
  return warnings;
}

function stableJsonStringify(
  value: unknown,
  seen: WeakSet<object>,
  memo: WeakMap<object, string | undefined>,
  maxLength: number,
  state: { overCap: boolean }
): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    const serialized = JSON.stringify(value);
    if (serialized.length > maxLength) {
      state.overCap = true;
      return undefined;
    }
    return serialized;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return undefined;
    }
    const serialized = JSON.stringify(value);
    if (serialized.length > maxLength) {
      state.overCap = true;
      return undefined;
    }
    return serialized;
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    return undefined;
  }

  // Memoize per-object so a value shared via YAML anchors/aliases is serialized
  // once (the previous `seen.delete` made shared nodes re-serialize O(2^depth)
  // times), and bail as soon as the accumulated output exceeds the cap so a
  // doubling structure cannot build an O(2^depth)-length string before the
  // length check at the call site. Every length bail records `state.overCap` so
  // the caller can distinguish an oversized value from an unrepresentable one.
  if (memo.has(value)) {
    return memo.get(value);
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  let result: string | undefined;
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      let accumulated = 2; // surrounding []
      let bailed = false;
      for (const item of value) {
        const serialized = stableJsonStringify(item, seen, memo, maxLength, state);
        if (serialized === undefined) {
          bailed = true;
          break;
        }
        accumulated += serialized.length + 1;
        if (accumulated > maxLength) {
          state.overCap = true;
          bailed = true;
          break;
        }
        items.push(serialized);
      }
      result = bailed ? undefined : `[${items.join(',')}]`;
    } else {
      const properties: string[] = [];
      let accumulated = 2; // surrounding {}
      let bailed = false;
      for (const key of Object.keys(value).sort(compareText)) {
        const serialized = stableJsonStringify(value[key], seen, memo, maxLength, state);
        if (serialized === undefined) {
          bailed = true;
          break;
        }
        const keyJson = JSON.stringify(key);
        accumulated += keyJson.length + serialized.length + 2;
        if (accumulated > maxLength) {
          state.overCap = true;
          bailed = true;
          break;
        }
        properties.push(`${keyJson}:${serialized}`);
      }
      result = bailed ? undefined : `{${properties.join(',')}}`;
    }
  } finally {
    seen.delete(value);
  }

  memo.set(value, result);
  return result;
}

function fallbackOperationId(method: HttpMethod, path: string): string {
  return slugify(`${method}-${path}`);
}

function basenameWithoutExtension(path: string): string {
  const name = basename(path);
  const extension = extname(name);
  return extension.length > 0 ? name.slice(0, -extension.length) : name;
}

function defaultRootTitle(sourceKind: ApiSourceKind): string {
  return sourceKind === 'swagger' ? 'Swagger API' : 'OpenAPI API';
}

function uniqueSlug(value: string, used: Map<string, number>): string {
  // Route through uniqueId so a slugified id that collides with an already-used
  // id (e.g. an explicit category whose name slugs to `foo-bar-2`) is
  // disambiguated by the same while-loop guard, instead of silently colliding.
  return uniqueId(slugify(value), used);
}

function uniqueId(value: string, used: Map<string, number>): string {
  let count = used.get(value) ?? 0;
  let candidate = count === 0 ? value : `${value}-${count + 1}`;

  while (used.has(candidate)) {
    count++;
    candidate = `${value}-${count + 1}`;
  }

  used.set(value, count + 1);
  if (candidate !== value) {
    used.set(candidate, 1);
  }

  return candidate;
}

function slugify(value: string): string {
  return slugifyText(value, 'api-document');
}

function compareOperationEntries(left: OperationEntry, right: OperationEntry): number {
  const pathComparison = compareText(left.path, right.path);
  if (pathComparison !== 0) {
    return pathComparison;
  }

  return HTTP_METHODS.indexOf(left.method) - HTTP_METHODS.indexOf(right.method);
}

function compareResponseStatus(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const leftIsNumber = Number.isInteger(leftNumber);
  const rightIsNumber = Number.isInteger(rightNumber);

  if (leftIsNumber && rightIsNumber) {
    return leftNumber - rightNumber;
  }
  if (leftIsNumber) {
    return -1;
  }
  if (rightIsNumber) {
    return 1;
  }
  if (left === 'default' && right !== 'default') {
    return 1;
  }
  if (right === 'default' && left !== 'default') {
    return -1;
  }

  return compareText(left, right);
}

function compareParameterLines(left: string, right: string): number {
  const leftLocation = extractParameterLocation(left);
  const rightLocation = extractParameterLocation(right);
  const locationComparison =
    PARAMETER_LOCATION_ORDER.indexOf(leftLocation) -
    PARAMETER_LOCATION_ORDER.indexOf(rightLocation);

  return locationComparison !== 0 ? locationComparison : compareText(left, right);
}

function extractParameterLocation(line: string): (typeof PARAMETER_LOCATION_ORDER)[number] {
  // The formatted line is `name (location, required)`, so read the FIRST
  // parenthetical token rather than scanning the whole line — otherwise a
  // description containing e.g. "(path, ...)" could misclassify the parameter.
  const match = /\(([a-z]+)[,)]/.exec(line);
  const candidate = match?.[1];

  if (
    candidate !== undefined &&
    (PARAMETER_LOCATION_ORDER as readonly string[]).includes(candidate)
  ) {
    return candidate as (typeof PARAMETER_LOCATION_ORDER)[number];
  }

  return 'body';
}

function compareText(left: string, right: string): number {
  const leftFolded = left.toLowerCase();
  const rightFolded = right.toLowerCase();

  if (leftFolded < rightFolded) {
    return -1;
  }
  if (leftFolded > rightFolded) {
    return 1;
  }
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }

  return 0;
}

function getOpenApiFileFormat(sourcePath: string, parserName: string): ApiFileFormat {
  const ext = extname(sourcePath).toLowerCase();
  if (ext === '.json') {
    return 'json';
  }
  if (ext === '.yaml' || ext === '.yml') {
    return 'yaml';
  }

  throw new ParserError(
    `Unsupported OpenAPI / Swagger file extension "${ext || '(none)'}". Supported extensions: .json, .yaml, .yml`,
    parserName
  );
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
