/**
 * Type-guard predicates and small classifiers shared across manifest modules.
 */

import { isSameOrDescendant } from '../../utils/fs-path.js';
import {
  DISCOVERY_REPORT_MODE_BY_KIND,
  MANIFEST_CONTRACT_BY_MODE,
  SOURCE_DOCS_SOURCE_TYPES,
} from './constants.js';
import type { DiscoveryReportKind, ManifestContractMode } from './constants.js';

export function isManifestContractMode(value: string): value is ManifestContractMode {
  return Object.prototype.hasOwnProperty.call(MANIFEST_CONTRACT_BY_MODE, value);
}

export function isIsoTimestampString(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }

  const date = new Date(value);

  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function isAllowedOutputKind(
  value: unknown,
  allowedKinds: ReadonlySet<string>
): value is string {
  return typeof value === 'string' && allowedKinds.has(value);
}

export function isDiscoveryReportKind(value: unknown): value is DiscoveryReportKind {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(DISCOVERY_REPORT_MODE_BY_KIND, value)
  );
}

export function formatAllowedOutputKinds(allowedKinds: ReadonlySet<string>): string {
  const kinds = [...allowedKinds];

  if (kinds.length <= 1) {
    return kinds[0] ?? 'a supported output kind';
  }

  return `${kinds.slice(0, -1).join(', ')} or ${kinds[kinds.length - 1]}`;
}

export function isSourceDocsSourceType(value: unknown): value is 'file' | 'directory' {
  return typeof value === 'string' && SOURCE_DOCS_SOURCE_TYPES.has(value);
}

export const isSourceTruthSourceType = isSourceDocsSourceType;

export function isInsideDirectory(parentDir: string, childPath: string): boolean {
  return isSameOrDescendant(parentDir, childPath);
}
