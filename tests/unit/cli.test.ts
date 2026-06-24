/**
 * CLI regression tests for documented compatibility commands.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = join(repoRoot, 'src/cli.ts');
const tsxBin = join(repoRoot, 'node_modules/.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

const tempDirs: string[] = [];

async function createTestConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'llm-docs-cli-'));
  tempDirs.push(dir);

  const specPath = join(dir, 'supabase_swift_v2.yml');
  await writeFile(
    specPath,
    [
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
    ].join('\n'),
    'utf-8'
  );

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
                  url: 'https://example.com/supabase_swift_v2.yml',
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
                  url: 'https://example.com/supabase_swift_v1.yml',
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

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(tsxBin, [cliPath, ...args], {
    cwd: repoRoot,
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

  it('continues to resolve validate without --version to the latest configured SDK version', async () => {
    const configDir = await createTestConfig();

    const { stdout } = await runCli(['validate', '--sdk', 'swift', '--config-dir', configDir]);

    expect(stdout).toContain('Validating swift latest');
    expect(stdout).toContain('Validation successful!');
    expect(stdout).toContain('Version: v2');
  });
});
