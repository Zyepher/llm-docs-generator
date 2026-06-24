import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigLoader } from '../../src/config/loader.js';
import { fetchSpec } from '../../src/utils/fetcher.js';
import { Logger, LogLevel } from '../../src/utils/logger.js';

const tempDirs: string[] = [];
const cacheFiles: string[] = [];

const specYaml = [
  'info:',
  '  id: swift',
  '  title: Supabase Swift SDK',
  '  description: Test fixture',
  'functions: []',
  '',
].join('\n');

type ServerHandler = (req: IncomingMessage, res: ServerResponse) => void;

async function createTestConfig(
  sdkName: string,
  specUrl: string,
  localPath: string | null = null
): Promise<ConfigLoader> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-fetcher-config-'));
  tempDirs.push(dir);

  await writeFile(
    join(dir, 'sdks.json'),
    JSON.stringify(
      {
        sdks: {
          [sdkName]: {
            name: 'Swift',
            language: 'swift',
            versions: {
              v2: {
                displayName: 'Supabase Swift SDK v2',
                spec: {
                  url: specUrl,
                  localPath,
                  format: 'openref-0.1',
                },
                output: {
                  baseDir: 'swift',
                  filenamePrefix: 'supabase-swift-v2',
                },
              },
            },
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  await writeFile(
    join(dir, 'categories.json'),
    JSON.stringify(
      {
        categories: {
          database: {
            title: 'Database',
            description: 'Database operations',
            systemPrompt: 'Database operations for {sdk_name}.',
            operations: [],
            order: 1,
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  const config = new ConfigLoader(dir);
  await config.load();
  return config;
}

function cachePathFor(sdkName: string): string {
  const cachePath = `config/supabase_${sdkName}_v2.yml`;
  cacheFiles.push(cachePath);
  return cachePath;
}

async function withServer(
  handler: ServerHandler,
  run: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  try {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Failed to bind test server to a TCP port');
    }

    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err !== undefined) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
}

beforeEach(async () => {
  Logger.setLevel(LogLevel.SILENT);
});

afterEach(async () => {
  Logger.setLevel(LogLevel.INFO);
  await Promise.all([
    ...cacheFiles.splice(0).map((file) => rm(file, { force: true })),
    ...tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  ]);
});

describe('fetchSpec source availability checks', () => {
  it('fails without GET or cache write when remote HEAD reports unavailable', async () => {
    let headCount = 0;
    let getCount = 0;

    await withServer(
      (req, res) => {
        if (req.method === 'HEAD') {
          headCount++;
          res.writeHead(404).end();
          return;
        }

        if (req.method === 'GET') {
          getCount++;
          res.writeHead(200, { 'Content-Type': 'text/yaml' }).end(specYaml);
          return;
        }

        res.writeHead(405).end();
      },
      async (baseUrl) => {
        const sdkName = 'fetcher404';
        const cachePath = cachePathFor(sdkName);
        const config = await createTestConfig(sdkName, `${baseUrl}/supabase_swift_v2.yml`);

        await expect(fetchSpec(sdkName, 'v2', config)).rejects.toThrow(
          `Spec source unavailable at ${baseUrl}/supabase_swift_v2.yml: HTTP 404`
        );

        expect(headCount).toBe(1);
        expect(getCount).toBe(0);
        expect(existsSync(cachePath)).toBe(false);
      }
    );
  });

  it.each([405, 501])(
    'falls back to GET and writes cache when remote HEAD returns HTTP %i',
    async (statusCode) => {
      let headCount = 0;
      let getCount = 0;

      await withServer(
        (req, res) => {
          if (req.method === 'HEAD') {
            headCount++;
            res.writeHead(statusCode).end();
            return;
          }

          if (req.method === 'GET') {
            getCount++;
            res.writeHead(200, { 'Content-Type': 'text/yaml' }).end(specYaml);
            return;
          }

          res.writeHead(405).end();
        },
        async (baseUrl) => {
          const sdkName = `fetcherhead${statusCode}`;
          const cachePath = cachePathFor(sdkName);
          const config = await createTestConfig(sdkName, `${baseUrl}/supabase_swift_v2.yml`);

          const [specPath, resolvedVersion] = await fetchSpec(sdkName, 'v2', config);

          expect(specPath).toBe(cachePath);
          expect(resolvedVersion).toBe('v2');
          expect(headCount).toBe(1);
          expect(getCount).toBe(1);
          await expect(readFile(specPath, 'utf-8')).resolves.toBe(specYaml);
        }
      );
    }
  );

  it('downloads and caches after a successful remote HEAD check', async () => {
    const methods: string[] = [];

    await withServer(
      (req, res) => {
        methods.push(req.method ?? '');

        if (req.method === 'HEAD') {
          res.writeHead(200).end();
          return;
        }

        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/yaml' }).end(specYaml);
          return;
        }

        res.writeHead(405).end();
      },
      async (baseUrl) => {
        const sdkName = 'fetcherremoteok';
        const cachePath = cachePathFor(sdkName);
        const config = await createTestConfig(sdkName, `${baseUrl}/supabase_swift_v2.yml`);

        const [specPath, resolvedVersion] = await fetchSpec(sdkName, 'v2', config);

        expect(specPath).toBe(cachePath);
        expect(resolvedVersion).toBe('v2');
        expect(methods).toEqual(['HEAD', 'GET']);
        await expect(readFile(specPath, 'utf-8')).resolves.toBe(specYaml);
      }
    );
  });

  it('keeps existing local override and cache precedence without remote checks', async () => {
    let requestCount = 0;

    await withServer(
      (_req, res) => {
        requestCount++;
        res.writeHead(500).end();
      },
      async (baseUrl) => {
        const sdkName = 'fetcherlocalcache';
        const cachePath = cachePathFor(sdkName);
        const localSpecPath = join(dirname(cachePath), `${sdkName}-local-spec.yml`);
        cacheFiles.push(localSpecPath);
        await mkdir(dirname(localSpecPath), { recursive: true });
        await writeFile(localSpecPath, specYaml, 'utf-8');
        await mkdir('config', { recursive: true });
        await writeFile(cachePath, 'cache fixture', 'utf-8');

        const config = await createTestConfig(
          sdkName,
          `${baseUrl}/supabase_swift_v2.yml`,
          localSpecPath
        );
        const [localPath] = await fetchSpec(sdkName, 'v2', config);

        expect(localPath).toBe(localSpecPath);
        expect(requestCount).toBe(0);

        const missingConfig = await createTestConfig(
          sdkName,
          `${baseUrl}/supabase_swift_v2.yml`,
          join(dirname(cachePath), `${sdkName}-missing-spec.yml`)
        );
        const [resolvedCachePath] = await fetchSpec(sdkName, 'v2', missingConfig);

        expect(resolvedCachePath).toBe(cachePath);
        expect(requestCount).toBe(0);
      }
    );
  });

  it('force download bypasses local and cache specs before remote HEAD and GET', async () => {
    const methods: string[] = [];
    const remoteSpecYaml = specYaml.replace('Test fixture', 'Remote fixture');

    await withServer(
      (req, res) => {
        methods.push(req.method ?? '');

        if (req.method === 'HEAD') {
          res.writeHead(200).end();
          return;
        }

        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/yaml' }).end(remoteSpecYaml);
          return;
        }

        res.writeHead(405).end();
      },
      async (baseUrl) => {
        const sdkName = 'fetcherforce';
        const cachePath = cachePathFor(sdkName);
        const localSpecPath = join(dirname(cachePath), `${sdkName}-local-spec.yml`);
        cacheFiles.push(localSpecPath);
        await mkdir(dirname(localSpecPath), { recursive: true });
        await writeFile(localSpecPath, specYaml, 'utf-8');
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(cachePath, 'cache fixture', 'utf-8');

        const config = await createTestConfig(
          sdkName,
          `${baseUrl}/supabase_swift_v2.yml`,
          localSpecPath
        );

        const [specPath, resolvedVersion] = await fetchSpec(sdkName, 'v2', config, true);

        expect(specPath).toBe(cachePath);
        expect(resolvedVersion).toBe('v2');
        expect(methods).toEqual(['HEAD', 'GET']);
        await expect(readFile(cachePath, 'utf-8')).resolves.toBe(remoteSpecYaml);
      }
    );
  });
});
