#!/usr/bin/env node

/**
 * CLI Entry Point for Supabase LLM Docs Generator
 *
 * Performance considerations:
 * - Lazy module loading (only load what's needed)
 * - Parallel SDK processing where possible
 * - Efficient error handling
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import packageJson from '../package.json';
import { rm } from 'node:fs/promises';

import { ConfigLoader } from './config/loader.js';
import { discoverLocalSource } from './core/discovery.js';
import { discoverRepo } from './core/repo-discovery.js';
import { discoverWebsite } from './core/website-discovery.js';
import { OpenRefParser } from './parsers/openref/parser.js';
import { LLMFormatter } from './core/formatter.js';
import { verifyGenerationManifest, writeGenerationManifest } from './core/manifest.js';
import { fetchSpec } from './utils/fetcher.js';
import { Logger, LogLevel } from './utils/logger.js';

// ============================================================================
// CLI PROGRAM
// ============================================================================

const program = new Command();
const CLI_NAME = 'supabase-llm-docs';
const GENERATOR_NAME = packageJson.name;
const GENERATOR_VERSION = packageJson.version;
const LEGACY_FORMATTER_FORMAT = 'legacy-llm-docs';

function resolvePlannedOutputVersion(
  sdkName: string,
  requestedVersion: string,
  config: ConfigLoader
): string {
  return config.resolveSDKVersion(sdkName, requestedVersion);
}

async function removeScopedManifest(outputDir: string): Promise<void> {
  await rm(`${outputDir}/manifest.json`, { force: true });
}

program
  .name(CLI_NAME)
  .description('Generate LLM-optimized documentation from Supabase SDK specifications')
  .version(GENERATOR_VERSION)
  .enablePositionalOptions();

// ============================================================================
// SOURCE-TRUTH COMMAND
// ============================================================================

const sourceTruthCommand = program
  .command('source-truth')
  .description('Inspect explicit local source code and generate bounded source-truth export docs');

sourceTruthCommand
  .command('inspect')
  .description('Print deterministic JSON evidence for an explicit local source path')
  .requiredOption('--source <path>', 'Explicit local file or directory to inspect')
  .action(async (options: { source: string }) => {
    try {
      const { inspectSourceTruth } = await import('./core/source-truth.js');
      const report = await inspectSourceTruth({ source: options.source });

      console.log(`${JSON.stringify(report, null, 2)}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Source-truth inspection failed: ${errorMsg}`));
      process.exit(1);
    }
  });

sourceTruthCommand
  .command('generate')
  .description('Generate evidence-bound Markdown docs from an explicit local source path')
  .requiredOption('--source <path>', 'Explicit local file or directory to inspect')
  .requiredOption('--output-dir <dir>', 'Directory for source-truth output files')
  .action(async (options: { source: string; outputDir: string }) => {
    try {
      const { generateSourceTruthDocs } = await import('./core/source-truth-docs.js');
      const result = await generateSourceTruthDocs({
        source: options.source,
        outputDir: options.outputDir,
      });

      console.log(chalk.bold('Source-truth docs generated'));
      console.log(`  Source: ${result.report.source.resolvedPath}`);
      console.log(`  Export facts: ${result.report.facts.length}`);
      console.log(`  Package/config facts: ${result.report.configFacts.length}`);
      console.log(`  Output: ${chalk.cyan(result.outputDir)}`);
      console.log(`  Markdown: ${chalk.cyan(result.markdownPath)}`);
      console.log(`  Manifest: ${chalk.cyan(result.manifestPath)}`);
    } catch (error) {
      const { SourceTruthDocsNoFactsError } = await import('./core/source-truth-docs.js');
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (error instanceof SourceTruthDocsNoFactsError) {
        console.error(chalk.red(`Source-truth generation failed: ${errorMsg}`));
        console.error(chalk.yellow(`Failure report: ${error.failurePath}`));
        console.error(chalk.yellow(`Evidence report: ${error.reportPath}`));
      } else {
        console.error(chalk.red(`Source-truth generation failed: ${errorMsg}`));
      }

      process.exit(1);
    }
  });

// ============================================================================
// DISCOVER COMMAND
// ============================================================================

program
  .command('discover')
  .description('Write a bounded discovery report for an explicit local source, repo, or URL')
  .option('--source <path>', 'Explicit local file or directory to inspect')
  .option(
    '--repo <git-url-or-local-git-repo>',
    'Explicit git URL or local git repository to inspect'
  )
  .option('--url <http-or-https-url>', 'Explicit HTTP(S) URL to inspect')
  .option('--scope <path>', 'Repo-relative path to inspect in repo mode')
  .option('--cache-dir <dir>', 'Directory for cached repo clones')
  .option('--output-dir <dir>', 'Directory for discovery-report.json')
  .action(
    async (options: {
      source?: string;
      repo?: string;
      url?: string;
      scope?: string;
      cacheDir?: string;
      outputDir?: string;
    }) => {
      try {
        const inputCount =
          (options.source === undefined ? 0 : 1) +
          (options.repo === undefined ? 0 : 1) +
          (options.url === undefined ? 0 : 1);

        if (inputCount !== 1) {
          throw new Error('discover requires exactly one of --source, --repo, or --url.');
        }

        if (options.source !== undefined) {
          if (options.scope !== undefined || options.cacheDir !== undefined) {
            throw new Error('discover --scope and --cache-dir are only supported with --repo.');
          }

          const report = await discoverLocalSource(
            options.outputDir === undefined
              ? { source: options.source }
              : { source: options.source, outputDir: options.outputDir }
          );

          console.log(chalk.bold('Local source discovery'));
          console.log(`  Source: ${report.source.resolvedPath}`);
          console.log(`  Type: ${report.source.type}`);
          console.log(`  Candidate files: ${report.candidates.length}`);
          console.log(`  Warnings: ${report.warnings.length}`);
          console.log(`  Report: ${chalk.cyan(report.output.reportPath)}`);

          return;
        }

        if (options.url !== undefined) {
          if (options.scope !== undefined || options.cacheDir !== undefined) {
            throw new Error('discover --scope and --cache-dir are only supported with --repo.');
          }

          const { report } = await discoverWebsite(
            options.outputDir === undefined
              ? { url: options.url }
              : { url: options.url, outputDir: options.outputDir }
          );

          console.log(chalk.bold('Website discovery'));
          console.log(`  URL: ${report.website.normalizedUrl}`);
          console.log(`  Resources inspected: ${report.inspectedResources.length}`);
          console.log(`  Candidate URLs: ${report.candidates.length}`);
          console.log(`  Warnings: ${report.warnings.length}`);
          console.log(`  Report: ${chalk.cyan(report.output.reportPath)}`);

          for (const warning of report.warnings) {
            console.error(chalk.yellow(`Warning: ${warning}`));
          }

          return;
        }

        const repoInput = options.repo;

        if (repoInput === undefined) {
          throw new Error('discover requires --repo.');
        }

        const repoOptions: Parameters<typeof discoverRepo>[0] = { repo: repoInput };

        if (options.scope !== undefined) {
          repoOptions.scope = options.scope;
        }

        if (options.cacheDir !== undefined) {
          repoOptions.cacheDir = options.cacheDir;
        }

        if (options.outputDir !== undefined) {
          repoOptions.outputDir = options.outputDir;
        }

        const { report } = await discoverRepo(repoOptions);

        console.log(chalk.bold('Repo discovery'));
        console.log(`  Repo: ${report.repo.normalizedInput}`);
        console.log(`  Cache: ${report.repo.cachePath}`);
        console.log(`  Scope: ${report.scope.path}`);
        console.log(`  Commit: ${report.repo.git.commit ?? 'unknown'}`);
        console.log(
          `  Dirty: ${report.repo.git.dirty === null ? 'unknown' : String(report.repo.git.dirty)}`
        );
        console.log(`  Candidate files: ${report.candidates.length}`);
        console.log(`  Warnings: ${report.warnings.length}`);
        console.log(`  Report: ${chalk.cyan(report.output.reportPath)}`);

        for (const warning of report.warnings) {
          console.error(chalk.yellow(`Warning: ${warning}`));
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Discovery failed: ${errorMsg}`));
        process.exit(1);
      }
    }
  );

// ============================================================================
// GENERATE COMMAND
// ============================================================================

program
  .command('generate')
  .description('Generate LLM documentation for specified SDK(s) and version(s)')
  .requiredOption('--sdk <sdk>', 'SDK to generate (or "all" for all SDKs)')
  .option('--sdk-version <version>', 'Version to generate (or "all" for all versions)', 'latest')
  .option('--config-dir <dir>', 'Configuration directory', 'config')
  .option('--output-dir <dir>', 'Output directory', '../../public/llms-openref')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .option('--force', 'Force re-download specs (ignore cache)', false)
  .action(
    async (options: {
      sdk: string;
      sdkVersion: string;
      configDir: string;
      outputDir: string;
      verbose: boolean;
      force: boolean;
    }) => {
      // Set log level
      Logger.setLevel(options.verbose ? LogLevel.DEBUG : LogLevel.INFO);

      console.log(chalk.bold.blue('\nSupabase LLM Documentation Generator\n'));

      try {
        // Load configuration
        const config = new ConfigLoader(options.configDir);
        await config.load();

        // Determine which SDKs to process
        const availableSDKs = config.getAllSDKs();
        const sdksToProcess = options.sdk === 'all' ? availableSDKs : [options.sdk];

        // Validate SDK names
        for (const sdkName of sdksToProcess) {
          if (!config.hasSDK(sdkName)) {
            console.error(chalk.red(`\nError: SDK '${sdkName}' not found`));
            console.log(`Available SDKs: ${availableSDKs.join(', ')}`);
            process.exit(1);
          }
        }

        // Build list of (sdk, version) pairs to process
        const tasks: Array<[string, string]> = [];

        for (const sdkName of sdksToProcess) {
          if (options.sdkVersion === 'all') {
            const versions = config.getSDKVersions(sdkName);
            for (const ver of versions) {
              tasks.push([sdkName, ver]);
            }
          } else {
            tasks.push([sdkName, options.sdkVersion]);
          }
        }

        console.log(chalk.cyan(`Processing ${tasks.length} SDK/version pair(s)...\n`));

        // Process each SDK/version combination
        let successCount = 0;
        let failureCount = 0;

        for (const [sdkName, ver] of tasks) {
          const spinner = ora(`Processing ${sdkName} ${ver}...`).start();

          try {
            const plannedVersion = resolvePlannedOutputVersion(sdkName, ver, config);
            const plannedOutputDir = `${options.outputDir}/${sdkName}/${plannedVersion}`;
            await removeScopedManifest(plannedOutputDir);

            // Fetch spec (uses cache by default) - returns [specPath, resolvedVersion]
            const [specPath, resolvedVersion] = await fetchSpec(
              sdkName,
              ver,
              config,
              options.force
            );
            const versionConfig = config.getSDKVersionConfig(sdkName, resolvedVersion);

            // Parse spec
            const parser = new OpenRefParser(specPath);
            const parsedData = await parser.parse();

            // Save parsed JSON using resolved version
            const outputDir = `${options.outputDir}/${sdkName}/${resolvedVersion}`;
            const parsedSpecPath = `${outputDir}/parsed/${sdkName}-${resolvedVersion}-spec.json`;
            await parser.saveJSON(parsedData, parsedSpecPath);

            // Format for LLM using resolved version
            const formatter = new LLMFormatter(
              parsedData,
              config,
              sdkName,
              resolvedVersion,
              specPath
            );
            const llmOutputPaths = await formatter.generateAll(outputDir);

            await writeGenerationManifest({
              manifestPath: `${outputDir}/manifest.json`,
              generatedAt: new Date(),
              generator: {
                name: GENERATOR_NAME,
                version: GENERATOR_VERSION,
                cliName: CLI_NAME,
              },
              sdk: {
                name: sdkName,
                resolvedVersion,
                displayName: versionConfig.displayName,
              },
              source: {
                configuredUrl: versionConfig.spec.url,
                configuredLocalPath: versionConfig.spec.localPath,
                resolvedSpecPath: specPath,
                format: versionConfig.spec.format,
              },
              parser: {
                name: 'OpenRefParser',
                version: GENERATOR_VERSION,
                format: versionConfig.spec.format,
              },
              formatter: {
                name: 'LLMFormatter',
                version: GENERATOR_VERSION,
                format: LEGACY_FORMATTER_FORMAT,
              },
              generatedOutputs: [
                { path: parsedSpecPath, kind: 'parsed-spec-json' },
                ...llmOutputPaths.map((path) => ({ path, kind: 'llm-docs' as const })),
              ],
              warnings: [],
            });

            spinner.succeed(chalk.green(`Completed ${sdkName} ${resolvedVersion}`));
            successCount++;
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            spinner.fail(chalk.red(`Failed ${sdkName} ${ver}: ${errorMsg}`));
            failureCount++;

            if (options.verbose && error instanceof Error && error.stack !== undefined) {
              console.error(chalk.gray(error.stack));
            }

            // Continue with other SDKs even if one fails
            continue;
          }
        }

        // Summary
        console.log(chalk.bold.green(`\nGeneration complete!`));
        console.log(`  Successful: ${successCount}`);
        if (failureCount > 0) {
          console.log(chalk.red(`  Failed: ${failureCount}`));
        }
        console.log(`\nOutput location: ${chalk.cyan(options.outputDir)}`);

        process.exit(failureCount > 0 ? 1 : 0);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(chalk.bold.red(`\nFatal error: ${errorMsg}`));

        if (options.verbose && error instanceof Error && error.stack !== undefined) {
          console.error(chalk.gray(error.stack));
        }

        process.exit(1);
      }
    }
  );

// ============================================================================
// VERIFY COMMAND
// ============================================================================

program
  .command('verify')
  .description('Verify an existing configured SDK manifest by hash and byte size')
  .option('--manifest <path>', 'Path to manifest.json')
  .option('--output-dir <dir>', 'Output directory containing manifest.json')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(async (options: { manifest?: string; outputDir?: string; verbose: boolean }) => {
    const manifestOptionCount =
      (options.manifest === undefined ? 0 : 1) + (options.outputDir === undefined ? 0 : 1);

    if (manifestOptionCount !== 1) {
      console.error(chalk.red('Error: provide exactly one of --manifest or --output-dir'));
      process.exit(1);
    }

    const manifestPath =
      options.manifest === undefined ? `${options.outputDir}/manifest.json` : options.manifest;

    try {
      const result = await verifyGenerationManifest({ manifestPath });

      console.log(chalk.bold('Manifest verification'));
      console.log(`  Manifest: ${result.manifestPath}`);
      console.log(`  Checked files: ${result.checkedFiles}`);
      console.log(`  Failures: ${result.failures.length}`);

      if (result.failures.length > 0) {
        for (const failure of result.failures) {
          console.error(chalk.red(`  - ${failure}`));
        }

        process.exit(1);
      }

      console.log(chalk.green('Verification passed'));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Verification failed: ${errorMsg}`));

      if (options.verbose && error instanceof Error && error.stack !== undefined) {
        console.error(chalk.gray(error.stack));
      }

      process.exit(1);
    }
  });

// ============================================================================
// LIST-SDKS COMMAND
// ============================================================================

program
  .command('list-sdks')
  .description('List all configured SDKs and their versions')
  .option('--config-dir <dir>', 'Configuration directory', 'config')
  .action(async (options: { configDir: string }) => {
    try {
      const config = new ConfigLoader(options.configDir);
      await config.load();

      console.log(chalk.bold('\nConfigured SDKs:\n'));

      const sdks = config.getAllSDKs();

      for (const sdkName of sdks) {
        const sdk = config.getSDK(sdkName);
        const versions = Object.keys(sdk.versions);

        console.log(chalk.cyan(`  ${sdkName}`));
        console.log(`    Name: ${sdk.name}`);
        console.log(`    Language: ${sdk.language}`);
        console.log(`    Versions: ${versions.join(', ')}`);

        // Show details for each version
        for (const ver of versions) {
          const verConfig = sdk.versions[ver];
          if (verConfig !== undefined) {
            console.log(chalk.gray(`      ${ver}:`));
            console.log(chalk.gray(`        Display: ${verConfig.displayName}`));
            console.log(chalk.gray(`        Spec: ${verConfig.spec.url}`));
          }
        }

        console.log();
      }

      console.log(chalk.gray(`Total SDKs: ${sdks.length}`));
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Error: ${errorMsg}`));
      process.exit(1);
    }
  });

// ============================================================================
// VALIDATE COMMAND
// ============================================================================

program
  .command('validate')
  .description('Validate SDK specification')
  .requiredOption('--sdk <sdk>', 'SDK name')
  .option('--version <version>', 'Version to validate', 'latest')
  .option('--config-dir <dir>', 'Configuration directory', 'config')
  .option('-v, --verbose', 'Enable verbose logging', false)
  .action(
    async (options: { sdk: string; version: string; configDir: string; verbose: boolean }) => {
      Logger.setLevel(options.verbose ? LogLevel.DEBUG : LogLevel.INFO);

      console.log(chalk.yellow(`\nValidating ${options.sdk} ${options.version}...\n`));

      try {
        const config = new ConfigLoader(options.configDir);
        await config.load();

        // Fetch and parse spec - returns [specPath, resolvedVersion]
        const [specPath, resolvedVersion] = await fetchSpec(options.sdk, options.version, config);
        const parser = new OpenRefParser(specPath);
        const parsedData = await parser.parse();

        console.log(chalk.green('Validation successful!\n'));
        console.log(`  SDK: ${chalk.cyan(options.sdk)}`);
        console.log(`  Version: ${chalk.cyan(resolvedVersion)}`);
        console.log(`  Operations: ${parsedData.operations.length}`);
        console.log(
          `  Examples: ${parsedData.operations.reduce(
            (sum: number, op) => sum + op.examples.length,
            0
          )}`
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`\nValidation failed: ${errorMsg}`));

        if (options.verbose && error instanceof Error && error.stack !== undefined) {
          console.error(chalk.gray(error.stack));
        }

        process.exit(1);
      }
    }
  );

// ============================================================================
// PARSE AND RUN
// ============================================================================

program.parse();
