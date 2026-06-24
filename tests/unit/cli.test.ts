/**
 * CLI regression tests for documented compatibility commands.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = join(repoRoot, 'src/cli.ts');
const tsxBin = join(
  repoRoot,
  'node_modules/.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
);

const tempDirs: string[] = [];
interface ManifestFileEntry {
  path: string;
  kind: string;
  byteSize: number;
  hash: string;
}

interface GenerationManifest {
  schemaVersion: string;
  generatedAt: string;
  generator: {
    name: string;
    version: string;
    cliName: string;
  };
  mode: string;
  sdk: {
    name: string;
    resolvedVersion: string;
    displayName: string;
  };
  source: {
    configuredUrl: string;
    configuredLocalPath: string | null;
    resolvedSpecPath: string;
    format: string;
    byteSize: number;
    contentHash: string;
  };
  parser: {
    name: string;
    version: string;
    format: string;
  };
  formatter: {
    name: string;
    version: string;
    format: string;
  };
  generatedOutputs: ManifestFileEntry[];
  warnings: string[];
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

const testSpecYaml = [
  'info:',
  '  id: swift',
  '  title: Supabase Swift SDK',
  '  description: Test fixture',
  'functions:',
  '  - id: select',
  '    title: Select data',
  '    description: Read rows',
  '    examples:',
  '      - id: select-basic',
  '        name: Basic select',
  '        code: supabase.from("todos").select()',
  '',
].join('\n');

async function createTestConfig(versionOrder: Array<'v1' | 'v2'> = ['v2', 'v1']): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-cli-'));
  tempDirs.push(dir);

  const specPath = join(dir, 'supabase_swift_v2.yml');
  await writeFile(specPath, testSpecYaml, 'utf-8');

  const versions = Object.fromEntries(
    versionOrder.map((version) => [
      version,
      {
        displayName: `Supabase Swift SDK ${version}`,
        spec: {
          url: `http://127.0.0.1:9/supabase_swift_${version}.yml`,
          localPath: specPath,
          format: 'openref-0.1',
        },
        output: {
          baseDir: 'swift',
          filenamePrefix: `supabase-swift-${version}`,
        },
      },
    ])
  );

  await writeFile(
    join(dir, 'sdks.json'),
    JSON.stringify(
      {
        sdks: {
          swift: {
            name: 'Swift',
            language: 'swift',
            versions,
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
            operations: ['select'],
            order: 1,
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  return dir;
}

async function runCli(args: string[], cwd = repoRoot): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(tsxBin, [cliPath, ...args], {
    cwd,
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
  });

  return { stdout, stderr };
}

async function runCliWithExit(args: string[], cwd = repoRoot): Promise<CliResult> {
  try {
    const { stdout, stderr } = await runCli(args, cwd);
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const execError = error as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string | null;
    };

    return {
      stdout: execError.stdout?.toString() ?? '',
      stderr: execError.stderr?.toString() ?? '',
      exitCode: typeof execError.code === 'number' ? execError.code : null,
    };
  }
}

async function sha256File(path: string): Promise<string> {
  const content = await readFile(path);
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

async function byteSize(path: string): Promise<number> {
  const fileStats = await stat(path);
  return fileStats.size;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findManifestFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    const entryPath = join(root, entry.name);

    if (entry.isDirectory()) {
      found.push(...(await findManifestFiles(entryPath)));
    } else if (entry.name === 'manifest.json') {
      found.push(entryPath);
    }
  }

  return found.sort(compareStringsByCodeUnit);
}

function compareStringsByCodeUnit(a: string, b: string): number {
  const length = Math.min(a.length, b.length);

  for (let index = 0; index < length; index++) {
    const difference = a.charCodeAt(index) - b.charCodeAt(index);

    if (difference !== 0) {
      return difference;
    }
  }

  return a.length - b.length;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('CLI compatibility behavior', () => {
  it('ships built-in SDK config without default local spec paths', async () => {
    const config = JSON.parse(await readFile(join(repoRoot, 'config/sdks.json'), 'utf-8')) as {
      sdks: Record<
        string,
        {
          versions: Record<string, { spec: { localPath: string | null } }>;
        }
      >;
    };

    const offenders = Object.entries(config.sdks)
      .flatMap(([sdkName, sdk]) =>
        Object.entries(sdk.versions).flatMap(([version, versionConfig]) => ({
          sdkName,
          version,
          localPath: versionConfig.spec.localPath,
        }))
      )
      .filter(({ localPath }) => localPath !== null);

    const offenderMessages = offenders.map(
      ({ sdkName, version, localPath }) => `${sdkName}@${version}: ${String(localPath)}`
    );

    expect(Object.keys(config.sdks).length).toBeGreaterThan(0);
    expect(offenderMessages).toEqual([]);
  });

  it('keeps the root --version option available', async () => {
    const { stdout } = await runCli(['--version']);

    expect(stdout.trim()).toBe('1.0.0');
  });

  it('treats validate --version as the SDK version option', async () => {
    const configDir = await createTestConfig();

    const { stdout } = await runCli([
      'validate',
      '--sdk',
      'swift',
      '--version',
      'v2',
      '--config-dir',
      configDir,
    ]);

    expect(stdout).toContain('Validating swift v2');
    expect(stdout).toContain('Validation successful!');
    expect(stdout).toContain('Version: v2');
    expect(stdout).toContain('Operations: 1');
    expect(stdout).toContain('Examples: 1');
    expect(stdout.trim()).not.toBe('1.0.0');
    expect(await findManifestFiles(configDir)).toEqual([]);
  });

  it('lists SDKs from a supplied config directory', async () => {
    const configDir = await createTestConfig();

    const { stdout } = await runCli(['list-sdks', '--config-dir', configDir]);

    expect(stdout).toContain('Configured SDKs:');
    expect(stdout).toContain('swift');
    expect(stdout).toContain('Name: Swift');
    expect(stdout).toContain('Versions: v2, v1');
    expect(stdout).toContain('Total SDKs: 1');
    expect(await findManifestFiles(configDir)).toEqual([]);
  });

  it('generates OpenRef documentation from a local configured spec', async () => {
    const configDir = await createTestConfig();
    const outputDir = join(configDir, 'output');

    const { stdout } = await runCli([
      'generate',
      '--sdk',
      'swift',
      '--sdk-version',
      'v2',
      '--config-dir',
      configDir,
      '--output-dir',
      outputDir,
    ]);

    expect(stdout).toContain('Processing 1 SDK/version pair');
    expect(stdout).toContain('Generation complete!');
    expect(stdout).toContain('Successful: 1');

    const parsedSpec = JSON.parse(
      await readFile(join(outputDir, 'swift/v2/parsed/swift-v2-spec.json'), 'utf-8')
    ) as { operations: Array<{ id: string; examples: unknown[] }> };
    expect(parsedSpec.operations).toHaveLength(1);
    expect(parsedSpec.operations[0]?.id).toBe('select');
    expect(parsedSpec.operations[0]?.examples).toHaveLength(1);

    const fullDoc = await readFile(
      join(outputDir, 'swift/v2/llm-docs/supabase-swift-v2-full-llms.txt'),
      'utf-8'
    );
    expect(fullDoc).toContain('# Supabase Swift SDK v2 Reference');
    expect(fullDoc).toContain(
      `<!-- Generated from: ${join(configDir, 'supabase_swift_v2.yml')} -->`
    );
    expect(fullDoc).not.toContain('<!-- Generated from:  -->');
    expect(fullDoc).toContain('Select data');
    expect(fullDoc).toContain('supabase.from("todos").select()');

    const moduleDoc = await readFile(
      join(outputDir, 'swift/v2/llm-docs/supabase-swift-v2-database-llms.txt'),
      'utf-8'
    );
    expect(moduleDoc).toContain('Supabase Swift SDK v2 Database Documentation');
    expect(moduleDoc).toContain('Database operations');

    const manifestPath = join(outputDir, 'swift/v2/manifest.json');
    const manifestText = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestText) as GenerationManifest;
    const specPath = join(configDir, 'supabase_swift_v2.yml');
    const generatedAt = new Date(manifest.generatedAt);
    const outputPaths = manifest.generatedOutputs.map((output) => output.path);
    const outputsByPath = new Map(
      manifest.generatedOutputs.map((output) => [output.path, output])
    );

    expect(manifestText.endsWith('\n')).toBe(true);
    expect(generatedAt.toISOString()).toBe(manifest.generatedAt);
    expect(manifest).toMatchObject({
      schemaVersion: '0.1.0',
      generator: {
        name: 'llm-docs-generator',
        version: '1.0.0',
        cliName: 'supabase-llm-docs',
      },
      mode: 'configured-sdk',
      sdk: {
        name: 'swift',
        resolvedVersion: 'v2',
        displayName: 'Supabase Swift SDK v2',
      },
      source: {
        configuredUrl: 'http://127.0.0.1:9/supabase_swift_v2.yml',
        configuredLocalPath: specPath,
        resolvedSpecPath: specPath,
        format: 'openref-0.1',
      },
      parser: {
        name: 'OpenRefParser',
        version: '1.0.0',
        format: 'openref-0.1',
      },
      formatter: {
        name: 'LLMFormatter',
        version: '1.0.0',
        format: 'legacy-llm-docs',
      },
      warnings: [],
    });
    expect(manifest.source.byteSize).toBe(await byteSize(specPath));
    expect(manifest.source.contentHash).toBe(await sha256File(specPath));
    expect(outputPaths).toEqual(
      [
        'llm-docs/supabase-swift-v2-database-llms.txt',
        'llm-docs/supabase-swift-v2-full-llms.txt',
        'parsed/swift-v2-spec.json',
      ]
    );
    expect(outputsByPath.get('parsed/swift-v2-spec.json')?.kind).toBe('parsed-spec-json');
    expect(outputsByPath.get('llm-docs/supabase-swift-v2-full-llms.txt')?.kind).toBe(
      'llm-docs'
    );
    expect(outputPaths).not.toContain('manifest.json');

    for (const output of manifest.generatedOutputs) {
      expect(isAbsolute(output.path)).toBe(false);
      expect(output.path.startsWith('..')).toBe(false);
      expect(output.path.includes('\\')).toBe(false);

      const actualPath = join(dirname(manifestPath), output.path);
      expect(output.byteSize).toBe(await byteSize(actualPath));
      expect(output.hash).toBe(await sha256File(actualPath));
    }
  });

  it('removes a stale manifest for failed generation tasks while continuing later tasks', async () => {
    const configDir = await createTestConfig();
    const outputDir = join(configDir, 'output');
    const v2ManifestPath = join(outputDir, 'swift/v2/manifest.json');
    const v1ManifestPath = join(outputDir, 'swift/v1/manifest.json');

    await runCli(
      [
        'generate',
        '--sdk',
        'swift',
        '--sdk-version',
        'v2',
        '--config-dir',
        configDir,
        '--output-dir',
        outputDir,
      ],
      configDir
    );
    expect(await pathExists(v2ManifestPath)).toBe(true);

    const sdksPath = join(configDir, 'sdks.json');
    const config = JSON.parse(await readFile(sdksPath, 'utf-8')) as {
      sdks: {
        swift: {
          versions: {
            v2: {
              spec: {
                localPath: string | null;
              };
            };
          };
        };
      };
    };
    config.sdks.swift.versions.v2.spec.localPath = join(configDir, 'missing-spec.yml');
    await writeFile(sdksPath, JSON.stringify(config, null, 2), 'utf-8');

    const result = await runCliWithExit(
      [
        'generate',
        '--sdk',
        'swift',
        '--sdk-version',
        'all',
        '--config-dir',
        configDir,
        '--output-dir',
        outputDir,
      ],
      configDir
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Processing 2 SDK/version pair');
    expect(result.stdout).toContain('Generation complete!');
    expect(result.stdout).toContain('Successful: 1');
    expect(result.stdout).toContain('Failed: 1');
    expect(await pathExists(v2ManifestPath)).toBe(false);
    expect(await pathExists(v1ManifestPath)).toBe(true);
    expect(await findManifestFiles(outputDir)).toEqual([v1ManifestPath]);
  });

  it('resolves latest consistently to the highest numeric version for output and cleanup', async () => {
    const configDir = await createTestConfig(['v1', 'v2']);
    const outputDir = join(configDir, 'output');
    const v1ManifestPath = join(outputDir, 'swift/v1/manifest.json');
    const v2ManifestPath = join(outputDir, 'swift/v2/manifest.json');

    const firstResult = await runCli([
      'generate',
      '--sdk',
      'swift',
      '--config-dir',
      configDir,
      '--output-dir',
      outputDir,
    ]);

    expect(firstResult.stdout).toContain('Successful: 1');
    expect(await pathExists(v1ManifestPath)).toBe(false);
    expect(await pathExists(v2ManifestPath)).toBe(true);

    const manifest = JSON.parse(await readFile(v2ManifestPath, 'utf-8')) as GenerationManifest;
    expect(manifest.sdk.resolvedVersion).toBe('v2');
    expect(manifest.source.configuredUrl).toBe('http://127.0.0.1:9/supabase_swift_v2.yml');

    const sdksPath = join(configDir, 'sdks.json');
    const config = JSON.parse(await readFile(sdksPath, 'utf-8')) as {
      sdks: {
        swift: {
          versions: {
            v2: {
              spec: {
                localPath: string | null;
              };
            };
          };
        };
      };
    };
    config.sdks.swift.versions.v2.spec.localPath = join(configDir, 'missing-spec.yml');
    await writeFile(sdksPath, JSON.stringify(config, null, 2), 'utf-8');

    const secondResult = await runCliWithExit(
      [
        'generate',
        '--sdk',
        'swift',
        '--config-dir',
        configDir,
        '--output-dir',
        outputDir,
      ],
      configDir
    );

    expect(secondResult.exitCode).toBe(1);
    expect(secondResult.stdout).toContain('Failed: 1');
    expect(await pathExists(v1ManifestPath)).toBe(false);
    expect(await pathExists(v2ManifestPath)).toBe(false);
    expect(await findManifestFiles(outputDir)).toEqual([]);
  });

  it('uses the resolved cache spec path in full-doc source comments when localPath is null', async () => {
    const configDir = await createTestConfig();
    const cacheSpecPath = join(configDir, 'config/supabase_swift_v2.yml');
    await mkdir(dirname(cacheSpecPath), { recursive: true });
    await writeFile(cacheSpecPath, testSpecYaml, 'utf-8');

    const sdksPath = join(configDir, 'sdks.json');
    const config = JSON.parse(await readFile(sdksPath, 'utf-8')) as {
      sdks: {
        swift: {
          versions: {
            v2: { spec: { localPath: string | null } };
          };
        };
      };
    };
    config.sdks.swift.versions.v2.spec.localPath = null;
    await writeFile(sdksPath, JSON.stringify(config, null, 2), 'utf-8');

    const outputDir = join(configDir, 'output');

    const { stdout } = await runCli(
      [
        'generate',
        '--sdk',
        'swift',
        '--sdk-version',
        'v2',
        '--config-dir',
        configDir,
        '--output-dir',
        outputDir,
      ],
      configDir
    );

    expect(stdout).toContain('Generation complete!');
    expect(stdout).toContain('Successful: 1');

    const fullDoc = await readFile(
      join(outputDir, 'swift/v2/llm-docs/supabase-swift-v2-full-llms.txt'),
      'utf-8'
    );
    expect(fullDoc).toContain('<!-- Generated from: config/supabase_swift_v2.yml -->');
    expect(fullDoc).not.toContain('<!-- Generated from:  -->');
  });

  it('continues to resolve validate without --version to the latest configured SDK version', async () => {
    const configDir = await createTestConfig();

    const { stdout } = await runCli(['validate', '--sdk', 'swift', '--config-dir', configDir]);

    expect(stdout).toContain('Validating swift latest');
    expect(stdout).toContain('Validation successful!');
    expect(stdout).toContain('Version: v2');
  });
});
