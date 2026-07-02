import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FormatDetector } from '../../src/core/detector.js';
import { DocNodeType, type DocNode } from '../../src/core/models.js';
import { FormatType } from '../../src/parsers/base.js';
import { OpenApiFormatParser, parseOpenApiFile } from '../../src/parsers/openapi/index.js';
import { openRefParser } from '../../src/parsers/openref/index.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-openapi-'));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf-8');
}

function findNode(root: DocNode, id: string): DocNode | undefined {
  if (root.id === id) {
    return root;
  }

  for (const child of root.children) {
    const found = findNode(child, id);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function collectContent(node: DocNode): string {
  const ownContent = node.content.map((block) => block.content).join('\n');
  const childContent = node.children.map((child) => collectContent(child)).join('\n');
  return [node.title, node.description, ownContent, childContent].filter(Boolean).join('\n');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('OpenAPI / Swagger parser', () => {
  it('parses OpenAPI JSON into deterministic DocNode IR', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'pets.openapi.json');

    await writeJson(sourcePath, {
      openapi: '3.0.3',
      info: {
        title: 'Pets API',
        version: '1.2.3',
        description: 'Manage pets.',
      },
      tags: [{ name: 'pets', description: 'Pet operations.' }],
      paths: {
        'x-generated-by': {
          name: 'unit-test',
        },
        '/pets': {
          get: {
            tags: ['pets'],
            operationId: 'listPets',
            summary: 'List pets',
            description: 'Returns pets.',
            parameters: [
              {
                name: 'limit',
                in: 'query',
                description: 'Maximum pets to return.',
                schema: { type: 'integer', format: 'int32' },
                example: 10,
              },
            ],
            responses: {
              '200': {
                description: 'A paged array of pets.',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Pets' },
                    example: [{ id: 1, name: 'Fido' }],
                  },
                },
              },
              default: { $ref: '#/components/responses/Error' },
            },
          },
          post: {
            tags: ['pets'],
            summary: 'Create a pet',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PetInput' },
                  examples: {
                    simple: { value: { name: 'Fido' } },
                  },
                },
              },
            },
            responses: {
              '201': { description: 'Created.' },
            },
          },
        },
        '/health': {
          get: {
            summary: 'Health check',
            responses: {
              '204': { description: 'OK.' },
            },
          },
        },
      },
    });

    const parser = new OpenApiFormatParser();

    expect(await parser.detect(sourcePath)).toBe(true);

    const root = await parser.parse(sourcePath);

    expect(root).toMatchObject({
      type: DocNodeType.ROOT,
      id: 'pets-api',
      title: 'Pets API',
      description: 'Manage pets.',
    });
    expect(root.metadata.get('format')).toBe('openapi');
    expect(root.metadata.get('sourceKind')).toBe('openapi');
    expect(root.metadata.get('sourcePath')).toBe(sourcePath);
    expect(root.metadata.get('specVersion')).toBe('3.0.3');
    expect(root.metadata.get('version')).toBe('1.2.3');

    const petsCategory = findNode(root, 'pets');
    const untaggedCategory = findNode(root, 'untagged');
    expect(petsCategory).toMatchObject({
      type: DocNodeType.CATEGORY,
      title: 'pets',
      description: 'Pet operations.',
    });
    expect(untaggedCategory).toMatchObject({
      type: DocNodeType.CATEGORY,
      title: 'Untagged',
    });

    const listPets = findNode(root, 'listPets');
    const createPet = findNode(root, 'post-pets');
    const healthCheck = findNode(root, 'get-health');

    expect(listPets).toMatchObject({
      type: DocNodeType.OPERATION,
      title: 'List pets',
      description: 'Returns pets.',
    });
    expect(listPets?.metadata.get('method')).toBe('GET');
    expect(listPets?.metadata.get('path')).toBe('/pets');
    expect(listPets?.metadata.get('operationId')).toBe('listPets');
    expect(createPet).toMatchObject({
      type: DocNodeType.OPERATION,
      title: 'Create a pet',
    });
    expect(healthCheck).toMatchObject({
      type: DocNodeType.OPERATION,
      title: 'Health check',
    });

    const listPetsContent = collectContent(listPets as DocNode);
    expect(listPetsContent).toContain('Method: GET');
    expect(listPetsContent).toContain('Path: /pets');
    expect(listPetsContent).toContain('limit (query, optional); schema integer(int32)');
    expect(listPetsContent).toContain('example 10');
    expect(listPetsContent).toContain('200: A paged array of pets.');
    expect(listPetsContent).toContain('#/components/schemas/Pets');
    expect(listPetsContent).toContain('default: $ref #/components/responses/Error');
    expect(listPetsContent).toContain('[{"id":1,"name":"Fido"}]');

    const createPetContent = collectContent(createPet as DocNode);
    expect(createPetContent).toContain('required: true');
    expect(createPetContent).toContain('application/json: #/components/schemas/PetInput');
    expect(createPetContent).toContain('simple {"name":"Fido"}');
  });

  it('parses OpenAPI YAML and keeps OpenRef YAML detection distinct', async () => {
    const dir = await createTempDir();
    const openApiPath = join(dir, 'openapi.yaml');
    const openRefPath = join(dir, 'openref.yaml');
    const nullableOpenRefPath = join(dir, 'openref-empty.yaml');

    await writeFile(
      openApiPath,
      [
        'openapi: 3.1.0',
        'info:',
        '  title: YAML API',
        '  version: 2026.06',
        'paths:',
        '  /users/{id}:',
        '    get:',
        '      tags: [users]',
        '      summary: Get user',
        '      parameters:',
        '        - name: id',
        '          in: path',
        '          required: true',
        '          schema:',
        '            type: string',
        '      responses:',
        '        "200":',
        '          description: OK',
        '          content:',
        '            application/json:',
        '              schema:',
        '                $ref: "#/components/schemas/User"',
      ].join('\n'),
      'utf-8'
    );

    await writeFile(
      openRefPath,
      [
        'info:',
        '  id: supabase-js',
        '  title: Supabase JS',
        '  description: Supabase client.',
        'functions:',
        '  - id: from',
        '    title: From',
        '    description: Query a table.',
      ].join('\n'),
      'utf-8'
    );
    await writeFile(
      nullableOpenRefPath,
      ['info:', '  id: supabase-js', '  title: Supabase JS', 'functions:', ''].join('\n'),
      'utf-8'
    );

    const detector = new FormatDetector();

    expect(await detector.detect(openApiPath)).toBe(FormatType.OPENAPI);
    expect(await detector.detect(openRefPath)).toBe(FormatType.OPENREF);
    expect(await detector.detect(nullableOpenRefPath)).toBe(FormatType.OPENREF);
    expect(await openRefParser.detect(openApiPath)).toBe(false);

    const root = await parseOpenApiFile(openApiPath);
    const operation = findNode(root, 'get-users-id');

    expect(root.metadata.get('format')).toBe('openapi');
    expect(root.metadata.get('specVersion')).toBe('3.1.0');
    expect(operation).toMatchObject({
      type: DocNodeType.OPERATION,
      title: 'Get user',
    });
    expect(collectContent(operation as DocNode)).toContain('#/components/schemas/User');
  });

  it('parses Swagger 2.0 operations, parameters, request bodies, and responses', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'swagger.json');

    await writeJson(sourcePath, {
      swagger: '2.0',
      info: {
        title: 'Store API',
        version: '2.0.0',
      },
      consumes: ['application/json'],
      produces: ['application/json'],
      tags: [{ name: 'store', description: 'Store operations.' }],
      paths: {
        '/pets': {
          get: {
            tags: ['store'],
            operationId: 'findPets',
            summary: 'Find pets',
            parameters: [
              {
                name: 'q',
                in: 'query',
                description: 'Search term.',
                type: 'string',
              },
            ],
            responses: {
              '200': {
                description: 'OK.',
                schema: { $ref: '#/definitions/Pets' },
                examples: {
                  'application/json': [{ id: 1 }],
                },
              },
            },
          },
          post: {
            tags: ['store'],
            summary: 'Create pet',
            parameters: [
              {
                name: 'pet',
                in: 'body',
                required: true,
                description: 'Pet payload.',
                schema: { $ref: '#/definitions/Pet' },
              },
            ],
            responses: {
              '201': { description: 'Created.' },
            },
          },
        },
      },
    });

    const root = await parseOpenApiFile(sourcePath);

    expect(root.metadata.get('format')).toBe('swagger');
    expect(root.metadata.get('sourceKind')).toBe('swagger');
    expect(root.metadata.get('specVersion')).toBe('2.0');

    const findPets = findNode(root, 'findPets');
    const createPet = findNode(root, 'post-pets');

    expect(findPets).toMatchObject({
      type: DocNodeType.OPERATION,
      title: 'Find pets',
    });
    expect(collectContent(findPets as DocNode)).toContain('q (query, optional); schema string');
    expect(collectContent(findPets as DocNode)).toContain('#/definitions/Pets');
    expect(collectContent(findPets as DocNode)).toContain('application/json [{"id":1}]');

    const createPetContent = collectContent(createPet as DocNode);
    expect(createPetContent).toContain('content types: application/json');
    expect(createPetContent).toContain('pet (body); schema #/definitions/Pet');
    expect(createPetContent).toContain('Pet payload.');
  });

  it('uses deterministic fallback operation IDs from method and path', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'fallbacks.json');

    await writeJson(sourcePath, {
      openapi: '3.0.0',
      info: { title: 'Fallback API', version: '1.0.0' },
      paths: {
        '/pets/{petId}': {
          patch: {
            summary: 'Patch pet',
            responses: { '200': { description: 'OK.' } },
          },
        },
        '/pets': {
          get: {
            responses: { '200': { description: 'OK.' } },
          },
        },
      },
    });

    const root = await parseOpenApiFile(sourcePath);

    expect(findNode(root, 'get-pets')).toMatchObject({
      title: 'GET /pets',
    });
    expect(findNode(root, 'patch-pets-petid')).toMatchObject({
      title: 'Patch pet',
    });
  });

  it('rejects unsupported extensions instead of parsing them as YAML', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'api.txt');

    await writeFile(
      sourcePath,
      ['openapi: 3.0.0', 'info:', '  title: Text API', '  version: 1.0.0', 'paths: {}'].join('\n'),
      'utf-8'
    );

    const parser = new OpenApiFormatParser();

    expect(await parser.detect(sourcePath)).toBe(false);
    await expect(parseOpenApiFile(sourcePath)).rejects.toThrow(
      /Unsupported OpenAPI \/ Swagger file extension "\.txt"/
    );
  });

  it('rejects malformed or unsupported API inputs honestly', async () => {
    const dir = await createTempDir();
    const invalidRootPath = join(dir, 'invalid-root.json');
    const missingPathsPath = join(dir, 'missing-paths.json');
    const unsupportedPath = join(dir, 'unsupported.json');

    await writeJson(invalidRootPath, ['not', 'an', 'object']);
    await writeJson(missingPathsPath, {
      openapi: '3.0.0',
      info: { title: 'No Paths', version: '1.0.0' },
    });
    await writeJson(unsupportedPath, {
      openapi: '2.0.0',
      info: { title: 'Old API', version: '1.0.0' },
      paths: {},
    });

    await expect(parseOpenApiFile(invalidRootPath)).rejects.toThrow(/root must be an object/);
    await expect(parseOpenApiFile(missingPathsPath)).rejects.toThrow(/paths object/);
    await expect(parseOpenApiFile(unsupportedPath)).rejects.toThrow(/Unsupported OpenAPI version/);

    const parser = new OpenApiFormatParser();
    const arbitraryJsonPath = join(dir, 'arbitrary.json');
    await writeJson(arbitraryJsonPath, { info: { title: 'Not an API' }, data: [] });

    expect(await parser.detect(arbitraryJsonPath)).toBe(false);
  });

  it('rejects malformed path, operation, parameter, and response shapes with context', async () => {
    const dir = await createTempDir();
    const cases: Array<{
      filename: string;
      document: unknown;
      message: RegExp;
    }> = [
      {
        filename: 'invalid-path-key.json',
        document: {
          openapi: '3.0.0',
          info: { title: 'Invalid Path Key', version: '1.0.0' },
          paths: {
            pets: {
              get: {
                responses: { '200': { description: 'OK.' } },
              },
            },
          },
        },
        message: /Path key "pets" must start with "\/"/,
      },
      {
        filename: 'non-object-path-item.json',
        document: {
          openapi: '3.0.0',
          info: { title: 'Bad Path Item', version: '1.0.0' },
          paths: {
            '/pets': 'bad-path-item',
          },
        },
        message: /Path item for "\/pets" must be an object/,
      },
      {
        filename: 'non-object-operation.json',
        document: {
          openapi: '3.0.0',
          info: { title: 'Bad Operation', version: '1.0.0' },
          paths: {
            '/pets': {
              get: 'bad-operation',
            },
          },
        },
        message: /Operation GET \/pets must be an object/,
      },
      {
        filename: 'non-object-parameter.json',
        document: {
          openapi: '3.0.0',
          info: { title: 'Bad Parameter', version: '1.0.0' },
          paths: {
            '/pets': {
              get: {
                parameters: ['limit'],
                responses: { '200': { description: 'OK.' } },
              },
            },
          },
        },
        message: /Parameter 0 in parameters for GET \/pets must be an object/,
      },
      {
        filename: 'parameter-missing-name.json',
        document: {
          openapi: '3.0.0',
          info: { title: 'Missing Parameter Name', version: '1.0.0' },
          paths: {
            '/pets': {
              get: {
                parameters: [{ in: 'query' }],
                responses: { '200': { description: 'OK.' } },
              },
            },
          },
        },
        message: /Parameter 0 in parameters for GET \/pets must include a non-empty string name/,
      },
      {
        filename: 'parameter-missing-location.json',
        document: {
          openapi: '3.0.0',
          info: { title: 'Missing Parameter Location', version: '1.0.0' },
          paths: {
            '/pets': {
              get: {
                parameters: [{ name: 'limit' }],
                responses: { '200': { description: 'OK.' } },
              },
            },
          },
        },
        message:
          /Parameter 0 in parameters for GET \/pets must include a non-empty string in location/,
      },
      {
        filename: 'missing-responses.json',
        document: {
          openapi: '3.0.0',
          info: { title: 'Missing Responses', version: '1.0.0' },
          paths: {
            '/pets': {
              get: {
                summary: 'List pets',
              },
            },
          },
        },
        message: /responses for GET \/pets must be present/,
      },
      {
        filename: 'non-object-responses.json',
        document: {
          openapi: '3.0.0',
          info: { title: 'Bad Responses', version: '1.0.0' },
          paths: {
            '/pets': {
              get: {
                responses: 'bad-responses',
              },
            },
          },
        },
        message: /responses for GET \/pets must be an object/,
      },
      {
        filename: 'empty-responses.json',
        document: {
          openapi: '3.0.0',
          info: { title: 'Empty Responses', version: '1.0.0' },
          paths: {
            '/pets': {
              get: {
                responses: {},
              },
            },
          },
        },
        message: /responses for GET \/pets must contain at least one response/,
      },
      {
        filename: 'non-object-response-entry.json',
        document: {
          openapi: '3.0.0',
          info: { title: 'Bad Response Entry', version: '1.0.0' },
          paths: {
            '/pets': {
              get: {
                responses: {
                  '200': 'bad-response',
                },
              },
            },
          },
        },
        message: /Response "200" in responses for GET \/pets must be an object/,
      },
    ];

    for (const testCase of cases) {
      const sourcePath = join(dir, testCase.filename);
      await writeJson(sourcePath, testCase.document);

      await expect(parseOpenApiFile(sourcePath)).rejects.toThrow(testCase.message);
    }
  });

  it('rejects malformed request body and nested response content with context', async () => {
    const dir = await createTempDir();
    const cases: Array<{
      filename: string;
      operation: Record<string, unknown>;
      message: RegExp;
    }> = [
      {
        filename: 'non-object-request-body.json',
        operation: {
          requestBody: 'bad-request-body',
          responses: { '200': { description: 'OK.' } },
        },
        message: /requestBody for POST \/pets must be an object or reference object/,
      },
      {
        filename: 'invalid-request-body-ref.json',
        operation: {
          requestBody: { $ref: 123 },
          responses: { '200': { description: 'OK.' } },
        },
        message: /requestBody for POST \/pets has an invalid \$ref value/,
      },
      {
        filename: 'non-object-request-body-content.json',
        operation: {
          requestBody: { content: 'bad-content' },
          responses: { '200': { description: 'OK.' } },
        },
        message: /requestBody for POST \/pets content must be an object/,
      },
      {
        filename: 'non-object-request-media-type.json',
        operation: {
          requestBody: { content: { 'application/json': 'bad-media-type' } },
          responses: { '200': { description: 'OK.' } },
        },
        message:
          /media type "application\/json" in requestBody for POST \/pets content must be an object/,
      },
      {
        filename: 'invalid-request-schema-ref.json',
        operation: {
          requestBody: { content: { 'application/json': { schema: { $ref: 123 } } } },
          responses: { '200': { description: 'OK.' } },
        },
        message:
          /schema for media type "application\/json" in requestBody for POST \/pets content has an invalid \$ref value/,
      },
      {
        filename: 'invalid-response-ref.json',
        operation: {
          responses: { '200': { $ref: 123 } },
        },
        message: /Response "200" in responses for POST \/pets has an invalid \$ref value/,
      },
      {
        filename: 'non-object-response-content.json',
        operation: {
          responses: { '200': { description: 'OK.', content: 'bad-content' } },
        },
        message: /content for response "200" in responses for POST \/pets must be an object/,
      },
      {
        filename: 'non-object-response-media-type.json',
        operation: {
          responses: {
            '200': {
              description: 'OK.',
              content: { 'application/json': 'bad-media-type' },
            },
          },
        },
        message:
          /media type "application\/json" in content for response "200" in responses for POST \/pets must be an object/,
      },
      {
        filename: 'non-object-response-examples.json',
        operation: {
          responses: {
            '200': {
              description: 'OK.',
              content: { 'application/json': { examples: 'bad-examples' } },
            },
          },
        },
        message:
          /examples for media type "application\/json" in content for response "200" in responses for POST \/pets must be an object/,
      },
      {
        filename: 'malformed-response-example-entry.json',
        operation: {
          responses: {
            '200': {
              description: 'OK.',
              content: { 'application/json': { examples: { simple: 'bad-example' } } },
            },
          },
        },
        message:
          /Example "simple" in examples for media type "application\/json" in content for response "200" in responses for POST \/pets must be an object/,
      },
      {
        filename: 'invalid-response-example-ref.json',
        operation: {
          responses: {
            '200': {
              description: 'OK.',
              content: { 'application/json': { examples: { simple: { $ref: 123 } } } },
            },
          },
        },
        message:
          /Example "simple" in examples for media type "application\/json" in content for response "200" in responses for POST \/pets has an invalid \$ref value/,
      },
      {
        filename: 'invalid-response-schema-ref.json',
        operation: {
          responses: {
            '200': {
              description: 'OK.',
              content: { 'application/json': { schema: { $ref: 123 } } },
            },
          },
        },
        message:
          /schema for media type "application\/json" in content for response "200" in responses for POST \/pets has an invalid \$ref value/,
      },
    ];

    for (const testCase of cases) {
      const sourcePath = join(dir, testCase.filename);
      await writeJson(sourcePath, {
        openapi: '3.0.0',
        info: { title: 'Nested Validation API', version: '1.0.0' },
        paths: {
          '/pets': {
            post: testCase.operation,
          },
        },
      });

      await expect(parseOpenApiFile(sourcePath)).rejects.toThrow(testCase.message);
    }
  });

  it('summarizes recursive YAML alias schemas without raw RangeError', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'recursive-schema.yaml');

    await writeFile(
      sourcePath,
      [
        'openapi: 3.0.0',
        'info:',
        '  title: Recursive API',
        '  version: 1.0.0',
        'paths:',
        '  /nodes:',
        '    get:',
        '      responses:',
        '        "200":',
        '          description: OK',
        '          content:',
        '            application/json:',
        '              schema: &recursive',
        '                allOf:',
        '                  - *recursive',
      ].join('\n'),
      'utf-8'
    );

    const root = await parseOpenApiFile(sourcePath);
    const operation = findNode(root, 'get-nodes');

    expect(operation).toMatchObject({
      type: DocNodeType.OPERATION,
      title: 'GET /nodes',
    });
    expect(collectContent(operation as DocNode)).toContain('allOf<circular schema>');
  });

  it('deduplicates operation node IDs deterministically while preserving operationId metadata', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'duplicate-operation-ids.json');

    await writeJson(sourcePath, {
      openapi: '3.0.0',
      info: { title: 'Duplicate IDs API', version: '1.0.0' },
      paths: {
        '/b': {
          get: {
            operationId: 'duplicate',
            responses: { '200': { description: 'OK.' } },
          },
        },
        '/c': {
          get: {
            operationId: 'duplicate-2',
            responses: { '200': { description: 'OK.' } },
          },
        },
        '/foo_bar': {
          get: {
            responses: { '200': { description: 'OK.' } },
          },
        },
        '/foo-bar': {
          get: {
            responses: { '200': { description: 'OK.' } },
          },
        },
        '/a': {
          get: {
            operationId: 'duplicate',
            responses: { '200': { description: 'OK.' } },
          },
        },
      },
    });

    const root = await parseOpenApiFile(sourcePath);
    const untagged = findNode(root, 'untagged') as DocNode;

    expect(untagged.children.map((child) => child.id)).toEqual([
      'duplicate',
      'duplicate-2',
      'duplicate-2-2',
      'get-foo-bar',
      'get-foo-bar-2',
    ]);
    expect(untagged.children[0]?.metadata.get('operationId')).toBe('duplicate');
    expect(untagged.children[1]?.metadata.get('operationId')).toBe('duplicate');
    expect(untagged.children[2]?.metadata.get('operationId')).toBe('duplicate-2');
    expect(untagged.children[3]?.metadata.get('path')).toBe('/foo-bar');
    expect(untagged.children[4]?.metadata.get('path')).toBe('/foo_bar');
  });

  it('accepts x- specification extensions in a Responses Object (regression)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'ext-responses.json');

    await writeJson(sourcePath, {
      openapi: '3.0.0',
      info: { title: 'Ext', version: '1.0.0' },
      paths: {
        '/a': {
          get: {
            operationId: 'a',
            responses: {
              '200': { description: 'ok' },
              'x-rate-limit': 'documented elsewhere',
            },
          },
        },
      },
    });

    const root = await parseOpenApiFile(sourcePath);
    expect(root.children.length).toBeGreaterThan(0);
  });

  it('parses YAML with an unquoted swagger version number (regression)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'unquoted-swagger.yaml');

    // js-yaml parses unquoted `swagger: 2.0` as the number 2.
    await writeFile(
      sourcePath,
      [
        'swagger: 2.0',
        'info:',
        '  title: Unquoted Swagger',
        '  version: 1.0.0',
        'paths:',
        '  /pets:',
        '    get:',
        '      operationId: listPets',
        '      responses:',
        "        '200':",
        '          description: OK',
      ].join('\n'),
      'utf-8'
    );

    const parser = new OpenApiFormatParser();
    expect(await parser.detect(sourcePath)).toBe(true);

    const root = await parseOpenApiFile(sourcePath);

    expect(root.metadata.get('sourceKind')).toBe('swagger');
    expect(root.metadata.get('specVersion')).toBe('2.0');
    expect(findNode(root, 'listPets')).toMatchObject({
      type: DocNodeType.OPERATION,
      title: 'listPets',
    });
  });

  it('parses YAML with an unquoted openapi version number (regression)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'unquoted-openapi.yaml');

    // js-yaml parses unquoted `openapi: 3.0` as the number 3.
    await writeFile(
      sourcePath,
      [
        'openapi: 3.0',
        'info:',
        '  title: Unquoted OpenAPI',
        '  version: 1.0.0',
        'paths:',
        '  /pets:',
        '    get:',
        '      operationId: listPets',
        '      responses:',
        "        '200':",
        '          description: OK',
      ].join('\n'),
      'utf-8'
    );

    const parser = new OpenApiFormatParser();
    expect(await parser.detect(sourcePath)).toBe(true);

    const root = await parseOpenApiFile(sourcePath);

    expect(root.metadata.get('sourceKind')).toBe('openapi');
    expect(root.metadata.get('specVersion')).toBe('3.0.0');
    expect(findNode(root, 'listPets')).toMatchObject({
      type: DocNodeType.OPERATION,
      title: 'listPets',
    });
  });

  it('accepts an OpenAPI 3.1 operation without a responses object (regression)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'no-responses-3-1.json');

    await writeJson(sourcePath, {
      openapi: '3.1.0',
      info: { title: 'No Responses', version: '1.0.0' },
      paths: {
        '/events': {
          post: {
            operationId: 'publishEvent',
            summary: 'Publish event',
          },
        },
      },
    });

    const root = await parseOpenApiFile(sourcePath);
    const operation = findNode(root, 'publishEvent');

    expect(operation).toMatchObject({
      type: DocNodeType.OPERATION,
      title: 'Publish event',
    });
    expect(collectContent(operation as DocNode)).not.toContain('Responses');
  });

  it('still rejects a missing responses object for OpenAPI 3.0 (regression)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'no-responses-3-0.json');

    await writeJson(sourcePath, {
      openapi: '3.0.3',
      info: { title: 'No Responses', version: '1.0.0' },
      paths: {
        '/events': {
          post: {
            operationId: 'publishEvent',
          },
        },
      },
    });

    await expect(parseOpenApiFile(sourcePath)).rejects.toThrow(
      /responses for POST \/events must be present/
    );
  });

  it('assigns unique category ids when slugs collide with disambiguated slugs (regression)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'slug-collision.json');

    // "Foo Bar" and "Foo-Bar" both slugify to "foo-bar"; the second becomes
    // "foo-bar-2", which then collides with "Foo Bar 2"'s slug. uniqueSlug must
    // disambiguate against already-used ids (it previously did not).
    await writeJson(sourcePath, {
      openapi: '3.0.0',
      info: { title: 'Slug Collision', version: '1.0.0' },
      tags: [{ name: 'Foo Bar' }, { name: 'Foo-Bar' }, { name: 'Foo Bar 2' }],
      paths: {
        '/a': { get: { operationId: 'a', tags: ['Foo Bar'], responses: { '200': { description: 'ok' } } } },
        '/b': { get: { operationId: 'b', tags: ['Foo-Bar'], responses: { '200': { description: 'ok' } } } },
        '/c': { get: { operationId: 'c', tags: ['Foo Bar 2'], responses: { '200': { description: 'ok' } } } },
      },
    });

    const root = await parseOpenApiFile(sourcePath);

    const ids: string[] = [];
    const walk = (node: DocNode): void => {
      ids.push(node.id);
      node.children.forEach(walk);
    };
    walk(root);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('parses a YAML anchor-doubling schema DAG in bounded time (regression: exponential blowup)', async () => {
    const dir = await createTempDir();
    const sourcePath = join(dir, 'anchor-dag.yaml');

    // Each level references the previous anchor TWICE, so js-yaml resolves them
    // to the same shared object 2^depth times along distinct paths. Without
    // memoized schema walking this hangs; with it, each node is visited once.
    const depth = 64;
    const lines: string[] = [
      'openapi: 3.0.0',
      'info:',
      '  title: Anchor DAG',
      '  version: 1.0.0',
      'x-anchors:',
      '  - &d0 { type: string }',
    ];
    for (let level = 1; level <= depth; level += 1) {
      lines.push(`  - &d${level} { allOf: [*d${level - 1}, *d${level - 1}] }`);
    }
    lines.push('paths:');
    lines.push('  /x:');
    lines.push('    get:');
    lines.push('      operationId: getX');
    lines.push('      responses:');
    lines.push("        '200':");
    lines.push('          description: ok');
    lines.push('          content:');
    lines.push('            application/json:');
    lines.push(`              schema: *d${depth}`);

    await writeFile(sourcePath, lines.join('\n'), 'utf-8');

    const start = Date.now();
    const root = await parseOpenApiFile(sourcePath);
    const elapsedMs = Date.now() - start;

    expect(root.children.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(2000);
  });
});
