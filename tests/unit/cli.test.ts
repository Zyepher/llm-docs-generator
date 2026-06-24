/**
 * CLI regression tests for documented compatibility commands.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

async function createTestConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-cli-'));
  tempDirs.push(dir);

  const specPath = join(dir, 'supabase_swift_v2.yml');
  await writeFile(specPath, testSpecYaml, 'utf-8');

  await writeFile(
    join(dir, 'sdks.json'),
    JSON.stringify(
      {
        sdks: {
          swift: {
            name: 'Swift',
            language: 'swift',
            versions: {
              v2: {
                displayName: 'Supabase Swift SDK v2',
                spec: {
                  url: 'http://127.0.0.1:9/supabase_swift_v2.yml',
                  localPath: specPath,
                  format: 'openref-0.1',
                },
                output: {
                  baseDir: 'swift',
                  filenamePrefix: 'supabase-swift-v2',
                },
              },
              v1: {
                displayName: 'Supabase Swift SDK v1',
                spec: {
                  url: 'http://127.0.0.1:9/supabase_swift_v1.yml',
                  localPath: specPath,
                  format: 'openref-0.1',
                },
                output: {
                  baseDir: 'swift',
                  filenamePrefix: 'supabase-swift-v1',
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
  });

  it('lists SDKs from a supplied config directory', async () => {
    const configDir = await createTestConfig();

    const { stdout } = await runCli(['list-sdks', '--config-dir', configDir]);

    expect(stdout).toContain('Configured SDKs:');
    expect(stdout).toContain('swift');
    expect(stdout).toContain('Name: Swift');
    expect(stdout).toContain('Versions: v2, v1');
    expect(stdout).toContain('Total SDKs: 1');
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
