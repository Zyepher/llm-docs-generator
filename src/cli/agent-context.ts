import { access, readFile, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { delimiter, resolve } from 'node:path';

import packageJson from '../../package.json';
import { isSameOrDescendant } from '../utils/fs-path.js';
import { errorMessage, isFileNotFoundError, isObjectRecord } from '../utils/guards.js';
import { sha256Hex } from '../utils/hash.js';
import { CLI_NAME, GENERATOR_NAME, GENERATOR_VERSION, EXPECTED_BINARY_NAME } from './metadata.js';

export const AGENT_CONTEXT_SCHEMA_VERSION = '0.2.0';
export const AGENT_DOCTOR_SCHEMA_VERSION = '0.1.0';

const AGENT_CONTEXT_ARTIFACTS = [
  {
    id: 'agent-context',
    name: 'Agent Context',
    path: 'AGENT_CONTEXT.md',
    intendedUse:
      'Agent-facing product boundary, intent router, current capabilities, limitations, and workflow rules.',
  },
  {
    id: 'project-index',
    name: 'Project Index',
    path: 'index.md',
    intendedUse:
      'Navigation map for agents, humans, engineers, current CLI commands, and source files.',
  },
] as const;

const AGENT_SKILL_ARTIFACTS = [
  {
    id: 'llm-docs-generator',
    name: 'llm-docs-generator',
    path: 'skills/llm-docs-generator/SKILL.md',
    intendedUse:
      'Agent workflow for using and maintaining this CLI while preserving the deterministic CLI boundary.',
  },
  {
    id: 'repo-docs-discovery',
    name: 'repo-docs-discovery',
    path: 'skills/repo-docs-discovery/SKILL.md',
    intendedUse:
      'Agent workflow for investigating repo, website, package, or local docs targets before calling the CLI with explicit inputs.',
  },
] as const;

export type AgentContextArtifact = {
  id: string;
  name: string;
  path: string;
  byteSize: number;
  sha256: string;
  intendedUse: string;
};

export type AgentContextContract = {
  schemaVersion: string;
  mode: string;
  generator: {
    packageName: string;
    packageVersion: string;
    cliName: string;
    binary: string;
  };
  contextArtifacts: AgentContextArtifact[];
  skillArtifacts: AgentContextArtifact[];
  limitations: string[];
};

export type AgentDoctorCheckStatus = 'pass' | 'warning' | 'fail' | 'skipped';

export type AgentDoctorCheck = {
  id: string;
  name: string;
  status: AgentDoctorCheckStatus;
  summary: string;
  facts: Record<string, unknown>;
};

export type AgentDoctorContract = {
  schemaVersion: string;
  mode: string;
  generator: AgentContextContract['generator'];
  summary: {
    overallStatus: AgentDoctorCheckStatus;
    totalChecks: number;
    passed: number;
    warnings: number;
    failed: number;
    skipped: number;
    hardFailureCount: number;
    packagedArtifactCount: number;
    contextArtifactCount: number;
    skillArtifactCount: number;
    pathBinaryFound: boolean;
  };
  checks: AgentDoctorCheck[];
  limitations: string[];
};

type AgentArtifactDescriptor =
  | (typeof AGENT_CONTEXT_ARTIFACTS)[number]
  | (typeof AGENT_SKILL_ARTIFACTS)[number];

type AgentArtifactFailure = {
  id: string;
  name: string;
  path: string;
  error: string;
};

function resolvePackageLocalPath(packageRoot: string, packageRelativePath: string): string {
  const resolvedPath = resolve(packageRoot, packageRelativePath);

  if (!isSameOrDescendant(packageRoot, resolvedPath)) {
    throw new Error(`context artifact path escapes package root: ${packageRelativePath}`);
  }

  return resolvedPath;
}

async function readPackagedAgentArtifact(
  packageRoot: string,
  artifact: AgentArtifactDescriptor
): Promise<AgentContextArtifact> {
  const artifactPath = resolvePackageLocalPath(packageRoot, artifact.path);
  let content: Buffer;

  try {
    content = await readFile(artifactPath);
  } catch (error) {
    const errorCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'unknown';

    throw new Error(`packaged agent artifact unavailable (${errorCode}): ${artifact.path}`);
  }

  return {
    id: artifact.id,
    name: artifact.name,
    path: artifact.path,
    byteSize: content.byteLength,
    sha256: sha256Hex(content),
    intendedUse: artifact.intendedUse,
  };
}

async function readPackagedAgentArtifactsForDoctor(packageRoot: string): Promise<{
  contextArtifacts: AgentContextArtifact[];
  skillArtifacts: AgentContextArtifact[];
  failures: AgentArtifactFailure[];
}> {
  const contextArtifacts: AgentContextArtifact[] = [];
  const skillArtifacts: AgentContextArtifact[] = [];
  const failures: AgentArtifactFailure[] = [];

  for (const artifact of AGENT_CONTEXT_ARTIFACTS) {
    try {
      contextArtifacts.push(await readPackagedAgentArtifact(packageRoot, artifact));
    } catch (error) {
      failures.push({
        id: artifact.id,
        name: artifact.name,
        path: artifact.path,
        error: errorMessage(error),
      });
    }
  }

  for (const artifact of AGENT_SKILL_ARTIFACTS) {
    try {
      skillArtifacts.push(await readPackagedAgentArtifact(packageRoot, artifact));
    } catch (error) {
      failures.push({
        id: artifact.id,
        name: artifact.name,
        path: artifact.path,
        error: errorMessage(error),
      });
    }
  }

  return { contextArtifacts, skillArtifacts, failures };
}

export async function buildAgentContextContract(
  packageRoot: string
): Promise<AgentContextContract> {
  return {
    schemaVersion: AGENT_CONTEXT_SCHEMA_VERSION,
    mode: 'agent-context-packaged-metadata',
    generator: {
      packageName: GENERATOR_NAME,
      packageVersion: GENERATOR_VERSION,
      cliName: CLI_NAME,
      binary: EXPECTED_BINARY_NAME,
    },
    contextArtifacts: await Promise.all(
      AGENT_CONTEXT_ARTIFACTS.map((artifact) => readPackagedAgentArtifact(packageRoot, artifact))
    ),
    skillArtifacts: await Promise.all(
      AGENT_SKILL_ARTIFACTS.map((artifact) => readPackagedAgentArtifact(packageRoot, artifact))
    ),
    limitations: [
      'Reports packaged context and skill metadata only.',
      'Does not install or register skills.',
      'Does not write user config.',
      'Does not probe environment state.',
      'Does not perform network access.',
    ],
  };
}

function readExpectedPackageBinaryEntry(): string {
  const metadata = packageJson as { bin?: unknown };

  if (!isObjectRecord(metadata.bin)) {
    throw new Error('malformed package metadata: bin map is missing');
  }

  const binaryPath = metadata.bin[EXPECTED_BINARY_NAME];

  if (typeof binaryPath !== 'string' || binaryPath.length === 0) {
    throw new Error(`malformed package metadata: expected ${EXPECTED_BINARY_NAME} bin entry`);
  }

  return binaryPath;
}

function getPathEnvironmentValue(): string {
  return process.env.PATH ?? process.env.Path ?? '';
}

function getExecutableCandidateNames(binary: string): string[] {
  if (process.platform !== 'win32') {
    return [binary];
  }

  const lowerBinary = binary.toLowerCase();
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => extension.length > 0);

  if (extensions.some((extension) => lowerBinary.endsWith(extension.toLowerCase()))) {
    return [binary];
  }

  return [binary, ...extensions.map((extension) => `${binary}${extension.toLowerCase()}`)];
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const fileStats = await stat(path);

    if (!fileStats.isFile()) {
      return false;
    }

    await access(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return false;
    }

    return false;
  }
}

async function findExecutableOnPath(binary: string): Promise<{
  pathConfigured: boolean;
  pathEntryCount: number;
  found: boolean;
  matches: string[];
}> {
  const pathValue = getPathEnvironmentValue();
  const pathEntries = pathValue.length === 0 ? [] : pathValue.split(delimiter);
  const candidateNames = getExecutableCandidateNames(binary);
  const matches: string[] = [];
  const seen = new Set<string>();

  for (const pathEntry of pathEntries) {
    const basePath = resolve(pathEntry.length === 0 ? '.' : pathEntry);

    for (const candidateName of candidateNames) {
      const candidatePath = resolve(basePath, candidateName);

      if (seen.has(candidatePath)) {
        continue;
      }

      seen.add(candidatePath);

      if (await isExecutableFile(candidatePath)) {
        matches.push(candidatePath);
      }
    }
  }

  return {
    pathConfigured: pathValue.length > 0,
    pathEntryCount: pathEntries.length,
    found: matches.length > 0,
    matches,
  };
}

function summarizeDoctorChecks(
  checks: AgentDoctorCheck[],
  options: {
    packagedArtifactCount: number;
    contextArtifactCount: number;
    skillArtifactCount: number;
    pathBinaryFound: boolean;
  }
): AgentDoctorContract['summary'] {
  const passed = checks.filter((check) => check.status === 'pass').length;
  const warnings = checks.filter((check) => check.status === 'warning').length;
  const failed = checks.filter((check) => check.status === 'fail').length;
  const skipped = checks.filter((check) => check.status === 'skipped').length;
  const overallStatus: AgentDoctorCheckStatus =
    failed > 0 ? 'fail' : warnings > 0 ? 'warning' : 'pass';

  return {
    overallStatus,
    totalChecks: checks.length,
    passed,
    warnings,
    failed,
    skipped,
    hardFailureCount: failed,
    packagedArtifactCount: options.packagedArtifactCount,
    contextArtifactCount: options.contextArtifactCount,
    skillArtifactCount: options.skillArtifactCount,
    pathBinaryFound: options.pathBinaryFound,
  };
}

export async function buildAgentDoctorContract(packageRoot: string): Promise<AgentDoctorContract> {
  const artifacts = await readPackagedAgentArtifactsForDoctor(packageRoot);
  let packageBinEntry: string | undefined;
  let packageBinError: string | undefined;

  try {
    packageBinEntry = readExpectedPackageBinaryEntry();
  } catch (error) {
    packageBinError = errorMessage(error);
  }

  const pathCheck = await findExecutableOnPath(EXPECTED_BINARY_NAME);
  const contextArtifactCount = AGENT_CONTEXT_ARTIFACTS.length;
  const skillArtifactCount = AGENT_SKILL_ARTIFACTS.length;
  const packagedArtifactCount = contextArtifactCount + skillArtifactCount;
  const artifactCheckFailed = artifacts.failures.length > 0;
  const expectedBinaryCheckFailed = packageBinEntry === undefined;
  const checks: AgentDoctorCheck[] = [
    {
      id: 'packaged-agent-artifacts',
      name: 'Packaged agent artifacts',
      status: artifactCheckFailed ? 'fail' : 'pass',
      summary: artifactCheckFailed
        ? 'One or more packaged context or skill artifacts could not be read.'
        : 'Packaged context and skill artifacts are readable and hashable.',
      facts: {
        expectedContextArtifactCount: contextArtifactCount,
        expectedSkillArtifactCount: skillArtifactCount,
        readableContextArtifactCount: artifacts.contextArtifacts.length,
        readableSkillArtifactCount: artifacts.skillArtifacts.length,
        contextArtifactCount,
        skillArtifactCount,
        artifacts: [...artifacts.contextArtifacts, ...artifacts.skillArtifacts],
        failures: artifacts.failures,
      },
    },
    {
      id: 'expected-binary-name',
      name: 'Expected binary name',
      status: expectedBinaryCheckFailed ? 'fail' : 'pass',
      summary: expectedBinaryCheckFailed
        ? `Package metadata does not expose the expected ${EXPECTED_BINARY_NAME} binary.`
        : `Expected CLI binary name is ${EXPECTED_BINARY_NAME}.`,
      facts: {
        expectedBinary: EXPECTED_BINARY_NAME,
        packageBinEntry: packageBinEntry ?? null,
        matchesExpectedBinary: packageBinEntry !== undefined,
        error: packageBinError ?? null,
      },
    },
    {
      id: 'path-binary',
      name: 'PATH binary visibility',
      status: pathCheck.found ? 'pass' : 'warning',
      summary: pathCheck.found
        ? `${EXPECTED_BINARY_NAME} was found on PATH.`
        : `${EXPECTED_BINARY_NAME} was not found on PATH; this is a warning, not a hard failure.`,
      facts: {
        expectedBinary: EXPECTED_BINARY_NAME,
        pathConfigured: pathCheck.pathConfigured,
        pathEntryCount: pathCheck.pathEntryCount,
        found: pathCheck.found,
        matches: pathCheck.matches,
      },
    },
    {
      id: 'codex-skill-installation',
      name: 'Codex skill installation',
      status: 'skipped',
      summary:
        'No explicit Codex home or skill-installation location was provided; host skill installation was not checked.',
      facts: {
        checked: false,
        reason: 'not-configured',
      },
    },
  ];

  return {
    schemaVersion: AGENT_DOCTOR_SCHEMA_VERSION,
    mode: 'agent-doctor-read-only-diagnostics',
    generator: {
      packageName: GENERATOR_NAME,
      packageVersion: GENERATOR_VERSION,
      cliName: CLI_NAME,
      binary: EXPECTED_BINARY_NAME,
    },
    summary: summarizeDoctorChecks(checks, {
      packagedArtifactCount,
      contextArtifactCount,
      skillArtifactCount,
      pathBinaryFound: pathCheck.found,
    }),
    checks,
    limitations: [
      'Read-only diagnostics only.',
      'Does not install or register skills.',
      'Does not write user config.',
      'Does not mutate host skill directories.',
      'Does not perform network access.',
      'Does not infer source authority, source truth, or task fit.',
      'Missing llm-docs on PATH is reported as a warning for development installs.',
      'Codex host skill installation is not checked without an explicit supported configuration.',
    ],
  };
}
