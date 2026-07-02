import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigLoader } from '../../src/config/loader.js';
import {
  clearSpecCache,
  fetchSpec,
  getCachedSpecPath,
  isSpecCached,
  redactUrl,
} from '../../src/utils/fetcher.js';
import { Logger, LogLevel } from '../../src/utils/logger.js';

const tempDirs: string[] = [];

const specYaml = [
  'info:',
  '  id: swift',
  '  title: Supabase Swift SDK',
  '  description: Test fixture',
  'functions: []',
  '',
].join('\n');

type ServerHandler = (req: IncomingMessage, res: ServerResponse) => void;

const categoriesFixture = {
  categories: {
    database: {
      title: 'Database',
      description: 'Database operations',
      systemPrompt: 'Database operations for {sdk_name}.',
      operations: [],
      order: 1,
    },
  },
};

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

  await writeFile(join(dir, 'categories.json'), JSON.stringify(categoriesFixture, null, 2), 'utf-8');

  const config = new ConfigLoader(dir);
  await config.load();
  return config;
}

async function createVersionsConfig(sdkName: string, versionKeys: string[]): Promise<ConfigLoader> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-loader-config-'));
  tempDirs.push(dir);

  const versions = Object.fromEntries(
    versionKeys.map((key) => [
      key,
      {
        displayName: `Supabase Swift SDK ${key}`,
        spec: {
          url: `https://example.com/spec-${key}.yml`,
          localPath: null,
          format: 'openref-0.1',
        },
        output: {
          baseDir: 'swift',
          filenamePrefix: `supabase-swift-${key}`,
        },
      },
    ])
  );

  await writeFile(
    join(dir, 'sdks.json'),
    JSON.stringify({ sdks: { [sdkName]: { name: 'Swift', language: 'swift', versions } } }, null, 2),
    'utf-8'
  );
  await writeFile(join(dir, 'categories.json'), JSON.stringify(categoriesFixture, null, 2), 'utf-8');

  const config = new ConfigLoader(dir);
  await config.load();
  return config;
}

async function createCacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-fetcher-cache-'));
  tempDirs.push(dir);
  return dir;
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
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('redactUrl', () => {
  it('redacts presigned-URL signature and credential params case-insensitively', () => {
    const result = redactUrl(
      'https://bucket.s3.amazonaws.com/spec.yml' +
        '?X-Amz-Signature=deadbeef' +
        '&X-Amz-Credential=AKIAEXAMPLE%2F20260101' +
        '&X-Amz-Security-Token=sts-token' +
        '&AWSAccessKeyId=AKIAEXAMPLE' +
        '&X-Goog-Signature=goog-sig' +
        '&X-Goog-Credential=goog-cred'
    );

    const params = new URL(result).searchParams;
    for (const name of [
      'X-Amz-Signature',
      'X-Amz-Credential',
      'X-Amz-Security-Token',
      'AWSAccessKeyId',
      'X-Goog-Signature',
      'X-Goog-Credential',
    ]) {
      expect(params.get(name)).toBe('REDACTED');
    }
    expect(result).not.toContain('deadbeef');
    expect(result).not.toContain('sts-token');
  });

  it('redacts mixed-case variants of the existing secret params', () => {
    const result = redactUrl(
      'https://example.com/spec.yml?TOKEN=abc123&Api_Key=def456&Signature=ghi789'
    );

    const params = new URL(result).searchParams;
    expect(params.get('TOKEN')).toBe('REDACTED');
    expect(params.get('Api_Key')).toBe('REDACTED');
    expect(params.get('Signature')).toBe('REDACTED');
  });

  it('leaves non-secret params untouched', () => {
    const result = redactUrl('https://example.com/spec.yml?version=v2&format=yaml');

    const params = new URL(result).searchParams;
    expect(params.get('version')).toBe('v2');
    expect(params.get('format')).toBe('yaml');
  });
});

describe('spec cache helpers', () => {
  it('resolve cache paths under the provided cacheDir', async () => {
    const cacheDir = await createCacheDir();
    const cachePath = join(cacheDir, 'supabase_swift_v2.yml');

    expect(isSpecCached('swift', 'v2', cacheDir)).toBe(false);
    expect(getCachedSpecPath('swift', 'v2', cacheDir)).toBeNull();

    await writeFile(cachePath, specYaml, 'utf-8');

    expect(isSpecCached('swift', 'v2', cacheDir)).toBe(true);
    expect(getCachedSpecPath('swift', 'v2', cacheDir)).toBe(cachePath);

    await expect(clearSpecCache(cacheDir, 'swift', 'v2')).resolves.toBe(1);
    expect(isSpecCached('swift', 'v2', cacheDir)).toBe(false);
  });

  it('clearSpecCache without sdk/version removes only cached specs in cacheDir', async () => {
    const cacheDir = await createCacheDir();
    await writeFile(join(cacheDir, 'supabase_swift_v2.yml'), specYaml, 'utf-8');
    await writeFile(join(cacheDir, 'supabase_javascript_v2.yml'), specYaml, 'utf-8');
    await writeFile(join(cacheDir, 'sdks.json'), '{}', 'utf-8');

    await expect(clearSpecCache(cacheDir)).resolves.toBe(2);
    expect(existsSync(join(cacheDir, 'sdks.json'))).toBe(true);
  });
});

describe('ConfigLoader version resolution', () => {
  it('exposes the config directory via configDir', () => {
    const loader = new ConfigLoader('/some/config/dir');
    expect(loader.configDir).toBe('/some/config/dir');
  });

  it.each([
    [['v2', 'v2-beta'], 'v2'],
    [['v2-beta', 'v2'], 'v2'],
    [['v1', 'v2'], 'v2'],
    [['v2.1', 'v2'], 'v2.1'],
    [['v2', 'v2.1'], 'v2.1'],
  ])('resolves latest among %j to %s', async (versionKeys, expected) => {
    const config = await createVersionsConfig('swiftlatest', versionKeys);
    expect(config.resolveSDKVersion('swiftlatest', 'latest')).toBe(expected);
  });
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
        const cacheDir = await createCacheDir();
        const cachePath = join(cacheDir, `supabase_${sdkName}_v2.yml`);
        const config = await createTestConfig(sdkName, `${baseUrl}/supabase_swift_v2.yml`);

        await expect(fetchSpec(sdkName, 'v2', config, cacheDir)).rejects.toThrow(
          `Spec source unavailable at ${baseUrl}/supabase_swift_v2.yml: HTTP 404`
        );

        expect(headCount).toBe(1);
        expect(getCount).toBe(0);
        expect(existsSync(cachePath)).toBe(false);
      }
    );
  });

  // HEAD is only a hint: 404/410 fail fast (see the test above), but every other
  // non-success status (auth-scoped GET-only URLs → 401/403, rate limits → 429,
  // transient 5xx, or method-restricted 405/501) must fall through to the
  // authoritative GET rather than rejecting a spec GET can actually download.
  it.each([401, 403, 405, 429, 500, 501])(
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
          const cacheDir = await createCacheDir();
          const cachePath = join(cacheDir, `supabase_${sdkName}_v2.yml`);
          const config = await createTestConfig(sdkName, `${baseUrl}/supabase_swift_v2.yml`);

          const [specPath, resolvedVersion] = await fetchSpec(sdkName, 'v2', config, cacheDir);

          expect(specPath).toBe(cachePath);
          expect(resolvedVersion).toBe('v2');
          expect(headCount).toBe(1);
          expect(getCount).toBe(1);
          await expect(readFile(specPath, 'utf-8')).resolves.toBe(specYaml);
        }
      );
    }
  );

  it('proceeds to GET when the HEAD request fails at the transport level', async () => {
    let headCount = 0;
    let getCount = 0;

    await withServer(
      (req, res) => {
        if (req.method === 'HEAD') {
          headCount++;
          req.socket.destroy();
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
        const sdkName = 'fetcherheaddrop';
        const cacheDir = await createCacheDir();
        const cachePath = join(cacheDir, `supabase_${sdkName}_v2.yml`);
        const config = await createTestConfig(sdkName, `${baseUrl}/supabase_swift_v2.yml`);

        const [specPath, resolvedVersion] = await fetchSpec(sdkName, 'v2', config, cacheDir);

        expect(specPath).toBe(cachePath);
        expect(resolvedVersion).toBe('v2');
        expect(headCount).toBe(1);
        expect(getCount).toBe(1);
        await expect(readFile(specPath, 'utf-8')).resolves.toBe(specYaml);
      }
    );
  });

  it('treats a redirecting HEAD as inconclusive and proceeds to GET', async () => {
    const methods: string[] = [];

    await withServer(
      (req, res) => {
        methods.push(req.method ?? '');

        if (req.method === 'HEAD') {
          res.writeHead(301, { Location: '/moved.yml' }).end();
          return;
        }

        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/yaml' }).end(specYaml);
          return;
        }

        res.writeHead(405).end();
      },
      async (baseUrl) => {
        const sdkName = 'fetcherhead301';
        const cacheDir = await createCacheDir();
        const cachePath = join(cacheDir, `supabase_${sdkName}_v2.yml`);
        const config = await createTestConfig(sdkName, `${baseUrl}/supabase_swift_v2.yml`);

        const [specPath, resolvedVersion] = await fetchSpec(sdkName, 'v2', config, cacheDir);

        expect(specPath).toBe(cachePath);
        expect(resolvedVersion).toBe('v2');
        expect(methods).toEqual(['HEAD', 'GET']);
        await expect(readFile(specPath, 'utf-8')).resolves.toBe(specYaml);
      }
    );
  });

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
        const cacheDir = await createCacheDir();
        const cachePath = join(cacheDir, `supabase_${sdkName}_v2.yml`);
        const config = await createTestConfig(sdkName, `${baseUrl}/supabase_swift_v2.yml`);

        const [specPath, resolvedVersion] = await fetchSpec(sdkName, 'v2', config, cacheDir);

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
        const cacheDir = await createCacheDir();
        const cachePath = join(cacheDir, `supabase_${sdkName}_v2.yml`);
        const localSpecPath = join(cacheDir, `${sdkName}-local-spec.yml`);
        await writeFile(localSpecPath, specYaml, 'utf-8');
        await writeFile(cachePath, 'cache fixture', 'utf-8');

        const config = await createTestConfig(
          sdkName,
          `${baseUrl}/supabase_swift_v2.yml`,
          localSpecPath
        );
        const [localPath] = await fetchSpec(sdkName, 'v2', config, cacheDir);

        expect(localPath).toBe(localSpecPath);
        expect(requestCount).toBe(0);

        const missingConfig = await createTestConfig(
          sdkName,
          `${baseUrl}/supabase_swift_v2.yml`,
          join(cacheDir, `${sdkName}-missing-spec.yml`)
        );
        const [resolvedCachePath] = await fetchSpec(sdkName, 'v2', missingConfig, cacheDir);

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
        const cacheDir = await createCacheDir();
        const cachePath = join(cacheDir, `supabase_${sdkName}_v2.yml`);
        const localSpecPath = join(cacheDir, `${sdkName}-local-spec.yml`);
        await writeFile(localSpecPath, specYaml, 'utf-8');
        await writeFile(cachePath, 'cache fixture', 'utf-8');

        const config = await createTestConfig(
          sdkName,
          `${baseUrl}/supabase_swift_v2.yml`,
          localSpecPath
        );

        const [specPath, resolvedVersion] = await fetchSpec(sdkName, 'v2', config, cacheDir, true);

        expect(specPath).toBe(cachePath);
        expect(resolvedVersion).toBe('v2');
        expect(methods).toEqual(['HEAD', 'GET']);
        await expect(readFile(cachePath, 'utf-8')).resolves.toBe(remoteSpecYaml);
      }
    );
  });
});
