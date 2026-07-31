/**
 * Field-level validators and equality helpers for manifest metadata.
 */

import { isNonEmptyString, isNonNegativeInteger, isObjectRecord } from '../../utils/guards.js';
import { isUnprefixedSha256Hash } from '../../utils/hash.js';
import { isPositiveInteger } from './predicates.js';

export function requiredObjectField(
  value: Record<string, unknown>,
  field: string,
  label: string
): Record<string, unknown> {
  const fieldValue = value[field];

  if (!isObjectRecord(fieldValue)) {
    throw new Error(`${label}.${field} must be an object`);
  }

  return fieldValue;
}

export function requiredStringField(
  value: Record<string, unknown>,
  field: string,
  label: string
): string {
  const fieldValue = value[field];

  if (!isNonEmptyString(fieldValue)) {
    throw new Error(`${label}.${field} must be a non-empty string`);
  }

  return fieldValue;
}

export function requiredArrayField(
  value: Record<string, unknown>,
  field: string,
  label: string
): unknown[] {
  const fieldValue = value[field];

  if (!Array.isArray(fieldValue)) {
    throw new Error(`${label}.${field} must be an array`);
  }

  return fieldValue;
}

export function optionalNonNegativeIntegerField(
  value: Record<string, unknown>,
  field: string,
  label: string
): number | undefined {
  const fieldValue = value[field];

  if (fieldValue === undefined) {
    return undefined;
  }

  if (!isNonNegativeInteger(fieldValue)) {
    throw new Error(`${label}.${field} must be a non-negative integer when present`);
  }

  return fieldValue;
}

export function optionalStringOrNullField(
  value: Record<string, unknown>,
  field: string,
  label: string
): string | null {
  const fieldValue = value[field];

  if (fieldValue === undefined || fieldValue === null) {
    return null;
  }

  if (!isNonEmptyString(fieldValue)) {
    throw new Error(`${label}.${field} must be a non-empty string or null`);
  }

  return fieldValue;
}

export function requiredBooleanField(
  value: Record<string, unknown>,
  field: string,
  label: string
): boolean {
  const fieldValue = value[field];

  if (typeof fieldValue !== 'boolean') {
    throw new Error(`${label}.${field} must be a boolean`);
  }

  return fieldValue;
}

export function optionalBooleanOrNullField(
  value: Record<string, unknown>,
  field: string,
  label: string
): boolean | null {
  const fieldValue = value[field];

  if (fieldValue === undefined || fieldValue === null) {
    return null;
  }

  if (typeof fieldValue !== 'boolean') {
    throw new Error(`${label}.${field} must be a boolean or null`);
  }

  return fieldValue;
}

export function requiredFalseField(
  value: Record<string, unknown>,
  field: string,
  label: string
): false {
  const fieldValue = value[field];

  if (fieldValue !== false) {
    throw new Error(`${label}.${field} must be false`);
  }

  return false;
}

export function requiredPositiveIntegerField(
  value: Record<string, unknown>,
  field: string,
  label: string
): number {
  const fieldValue = value[field];

  if (!isPositiveInteger(fieldValue)) {
    throw new Error(`${label}.${field} must be a positive integer`);
  }

  return fieldValue;
}

export function requiredNonNegativeIntegerField(
  value: Record<string, unknown>,
  field: string,
  label: string
): number {
  const fieldValue = value[field];

  if (!isNonNegativeInteger(fieldValue)) {
    throw new Error(`${label}.${field} must be a non-negative integer`);
  }

  return fieldValue;
}

export function requiredUnprefixedSha256Field(
  value: Record<string, unknown>,
  field: string,
  label: string
): string {
  const fieldValue = value[field];

  if (!isUnprefixedSha256Hash(fieldValue)) {
    throw new Error(`${label}.${field} must be a sha256 hex digest`);
  }

  return fieldValue;
}

export function optionalStringArrayField(
  value: Record<string, unknown>,
  field: string,
  label: string
): string[] {
  const fieldValue = value[field];

  if (fieldValue === undefined) {
    return [];
  }

  if (!Array.isArray(fieldValue)) {
    throw new Error(`${label}.${field} must be a string array`);
  }

  return requireStringArray(fieldValue, `${label}.${field}`);
}

export function requireStringArray(values: unknown[], label: string): string[] {
  if (!values.every((value) => typeof value === 'string')) {
    throw new Error(`${label} must contain only strings`);
  }

  return values;
}

export function optionalStringArraysEqual(left: unknown, right: string[] | undefined): boolean {
  if (left === undefined && right === undefined) {
    return true;
  }

  if (!Array.isArray(left) || !left.every((entry) => typeof entry === 'string')) {
    return false;
  }

  if (right === undefined) {
    return false;
  }

  return stringArraysEqual(left, right);
}

export function stringArraysEqual(actual: string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

export function validateOptionalStringArray(
  value: unknown,
  label: string,
  failures: string[]
): string[] | undefined {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    failures.push(`malformed manifest: ${label} must be a string array when present`);
    return undefined;
  }

  if (!value.every((entry) => typeof entry === 'string')) {
    failures.push(`malformed manifest: ${label} must contain only strings`);
    return undefined;
  }

  return value;
}

export function validateAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string,
  failures: string[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      failures.push(`malformed manifest: ${label}.${key} is not supported`);
    }
  }
}
