/**
 * Refresh provenance type, builder, and validator.
 */

import { isObjectRecord } from '../../utils/guards.js';
import {
  REFRESH_PROVENANCE_BY_MODE,
  REFRESH_PROVENANCE_ISO_DATETIME_PATTERN,
  REFRESH_PROVENANCE_KEYS,
} from './constants.js';
import type { RefreshSourceManifestMode } from './constants.js';
import { stringArraysEqual } from './field-validators.js';

export interface RefreshProvenance {
  refreshedAt: string;
  sourceManifestMode: RefreshSourceManifestMode;
  strategy: (typeof REFRESH_PROVENANCE_BY_MODE)[RefreshSourceManifestMode]['strategy'];
  inputBoundary: string;
  limitations: string[];
}

export function buildRefreshProvenance(
  mode: RefreshSourceManifestMode,
  refreshedAt: Date
): RefreshProvenance {
  const contract = REFRESH_PROVENANCE_BY_MODE[mode];

  return {
    refreshedAt: refreshedAt.toISOString(),
    sourceManifestMode: mode,
    strategy: contract.strategy,
    inputBoundary: contract.inputBoundary,
    limitations: [...contract.limitations],
  };
}

export function validateRefreshProvenance(
  refresh: unknown,
  expectedMode: RefreshSourceManifestMode,
  failures: string[]
): void {
  if (refresh === undefined) {
    return;
  }

  if (!isObjectRecord(refresh)) {
    failures.push('malformed manifest: refresh must be an object when present');
    return;
  }

  for (const key of Object.keys(refresh)) {
    if (!REFRESH_PROVENANCE_KEYS.has(key)) {
      failures.push(`malformed manifest: refresh.${key} is not supported`);
    }
  }

  const expected = REFRESH_PROVENANCE_BY_MODE[expectedMode];

  if (!isRefreshIsoDatetimeString(refresh.refreshedAt)) {
    failures.push('malformed manifest: refresh.refreshedAt must be an ISO datetime string');
  }

  if (refresh.sourceManifestMode !== expectedMode) {
    failures.push(
      `malformed manifest: refresh.sourceManifestMode must match manifest mode ${expectedMode}`
    );
  }

  if (refresh.strategy !== expected.strategy) {
    failures.push(
      `malformed manifest: refresh.strategy must be ${expected.strategy} for ${expectedMode}`
    );
  }

  if (refresh.inputBoundary !== expected.inputBoundary) {
    failures.push(
      `malformed manifest: refresh.inputBoundary must match the expected boundary for ${expectedMode}`
    );
  }

  if (!Array.isArray(refresh.limitations) || refresh.limitations.length === 0) {
    failures.push('malformed manifest: refresh.limitations must be a non-empty array');
    return;
  }

  if (
    refresh.limitations.some(
      (limitation) => typeof limitation !== 'string' || limitation.length === 0
    )
  ) {
    failures.push('malformed manifest: refresh.limitations must contain only non-empty strings');
    return;
  }

  if (!stringArraysEqual(refresh.limitations, expected.limitations)) {
    failures.push(
      `malformed manifest: refresh.limitations must match the expected limitations for ${expectedMode}`
    );
  }
}
function isRefreshIsoDatetimeString(value: unknown): value is string {
  if (typeof value !== 'string' || !REFRESH_PROVENANCE_ISO_DATETIME_PATTERN.test(value)) {
    return false;
  }

  const time = Date.parse(value);

  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
