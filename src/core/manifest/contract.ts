/**
 * Manifest contract type, builder, and validators.
 */

import { isNonEmptyString, isObjectRecord } from '../../utils/guards.js';
import {
  MANIFEST_CONTRACT_ARTIFACT_ROLES,
  MANIFEST_CONTRACT_BY_MODE,
  MANIFEST_CONTRACT_KEYS,
  MANIFEST_CONTRACT_SCHEMA,
} from './constants.js';
import type { ManifestContractMode } from './constants.js';
import { stringArraysEqual, validateAllowedKeys } from './field-validators.js';
import { isManifestContractMode } from './predicates.js';

export interface ManifestContract {
  schema: typeof MANIFEST_CONTRACT_SCHEMA;
  manifestMode: ManifestContractMode;
  artifactRole: (typeof MANIFEST_CONTRACT_BY_MODE)[ManifestContractMode]['artifactRole'];
  cliGuarantees: string[];
  agentResponsibilities: string[];
  unsupportedAutomation: string[];
}

export function buildManifestContract(mode: ManifestContractMode): ManifestContract {
  const contract = MANIFEST_CONTRACT_BY_MODE[mode];

  return {
    schema: MANIFEST_CONTRACT_SCHEMA,
    manifestMode: mode,
    artifactRole: contract.artifactRole,
    cliGuarantees: [...contract.cliGuarantees],
    agentResponsibilities: [...contract.agentResponsibilities],
    unsupportedAutomation: [...contract.unsupportedAutomation],
  };
}

export function validateRequiredManifestContract(
  contract: unknown,
  expectedMode: ManifestContractMode,
  failures: string[]
): void {
  if (contract === undefined) {
    failures.push(
      'malformed manifest: manifestContract is required for V2 manifests; unsupported pre-V2 manifest; regenerate with V2'
    );
    return;
  }

  validateManifestContract(contract, expectedMode, failures);
}
function validateManifestContract(
  contract: unknown,
  expectedMode: ManifestContractMode,
  failures: string[]
): void {
  if (contract === undefined) {
    return;
  }

  if (!isObjectRecord(contract)) {
    failures.push('malformed manifest: manifestContract must be an object');
    return;
  }

  validateAllowedKeys(contract, MANIFEST_CONTRACT_KEYS, 'manifestContract', failures);

  const expected = MANIFEST_CONTRACT_BY_MODE[expectedMode];

  if (contract.schema !== MANIFEST_CONTRACT_SCHEMA) {
    failures.push(
      `malformed manifest: manifestContract.schema must be ${MANIFEST_CONTRACT_SCHEMA}`
    );
  }

  if (!isNonEmptyString(contract.manifestMode) || !isManifestContractMode(contract.manifestMode)) {
    failures.push('malformed manifest: manifestContract.manifestMode must be a supported mode');
  } else if (contract.manifestMode !== expectedMode) {
    failures.push(
      `malformed manifest: manifestContract.manifestMode must match manifest mode ${expectedMode}`
    );
  }

  if (
    !isNonEmptyString(contract.artifactRole) ||
    !MANIFEST_CONTRACT_ARTIFACT_ROLES.has(contract.artifactRole)
  ) {
    failures.push(
      'malformed manifest: manifestContract.artifactRole must be generated-docs, candidate-evidence-report, or local-source-evidence-report'
    );
  } else if (contract.artifactRole !== expected.artifactRole) {
    failures.push(
      `malformed manifest: manifestContract.artifactRole must be ${expected.artifactRole} for ${expectedMode}`
    );
  }

  validateManifestContractStringArray(
    contract.cliGuarantees,
    expected.cliGuarantees,
    'cliGuarantees',
    expectedMode,
    failures
  );
  validateManifestContractStringArray(
    contract.agentResponsibilities,
    expected.agentResponsibilities,
    'agentResponsibilities',
    expectedMode,
    failures
  );
  validateManifestContractStringArray(
    contract.unsupportedAutomation,
    expected.unsupportedAutomation,
    'unsupportedAutomation',
    expectedMode,
    failures
  );
}
function validateManifestContractStringArray(
  value: unknown,
  expected: readonly string[],
  key: 'cliGuarantees' | 'agentResponsibilities' | 'unsupportedAutomation',
  expectedMode: ManifestContractMode,
  failures: string[]
): void {
  if (!Array.isArray(value) || value.length === 0) {
    failures.push(`malformed manifest: manifestContract.${key} must be a non-empty array`);
    return;
  }

  if (value.some((entry) => !isNonEmptyString(entry))) {
    failures.push(
      `malformed manifest: manifestContract.${key} must contain only non-empty strings`
    );
    return;
  }

  const entries = value as string[];

  if (!stringArraysEqual(entries, expected)) {
    failures.push(
      `malformed manifest: manifestContract.${key} must match the expected ${key} for ${expectedMode}`
    );
  }
}
