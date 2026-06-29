import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, win32 } from 'node:path';

import { isObjectRecord } from '../utils/guards.js';

export const PARSER_PLUGIN_MANIFEST_SCHEMA_VERSION = '0.1.0';
export const PARSER_PLUGIN_MANIFEST_KIND = 'parser-plugin';

const ROOT_KEYS = ['schemaVersion', 'kind', 'name', 'version', 'module', 'formats'] as const;
const FORMAT_KEYS = ['id', 'displayName', 'extensions', 'mediaTypes', 'directorySupport'] as const;

const FORMAT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const EXTENSION_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface ParserPluginFormatMetadata {
  id: string;
  displayName: string;
  extensions: string[];
  mediaTypes?: string[];
  directorySupport?: boolean;
}

export interface ParserPluginManifestMetadata {
  schemaVersion: typeof PARSER_PLUGIN_MANIFEST_SCHEMA_VERSION;
  kind: typeof PARSER_PLUGIN_MANIFEST_KIND;
  name: string;
  version: string;
  module: string;
  formats: ParserPluginFormatMetadata[];
}

export interface ParserPluginManifestValidationError {
  code: string;
  path: string;
  message: string;
}

export interface ParserPluginManifestValidationResult {
  schemaVersion: typeof PARSER_PLUGIN_MANIFEST_SCHEMA_VERSION;
  manifestPath: string;
  valid: boolean;
  manifest?: ParserPluginManifestMetadata;
  errors: ParserPluginManifestValidationError[];
  warnings: string[];
}

export async function validateParserPluginManifestFile(options: {
  manifestPath: string;
}): Promise<ParserPluginManifestValidationResult> {
  const manifestPath = resolve(options.manifestPath);
  let manifestText: string;

  try {
    manifestText = await readFile(manifestPath, 'utf-8');
  } catch (error) {
    return buildInvalidResult(manifestPath, [
      {
        code: 'manifest-unreadable',
        path: '$',
        message: `manifest file could not be read (${getErrorCode(error)}): ${manifestPath}`,
      },
    ]);
  }

  let manifestJson: unknown;

  try {
    manifestJson = JSON.parse(manifestText) as unknown;
  } catch {
    return buildInvalidResult(manifestPath, [
      {
        code: 'manifest-malformed-json',
        path: '$',
        message: 'manifest file must contain valid JSON.',
      },
    ]);
  }

  return validateParserPluginManifestValue(manifestJson, manifestPath);
}

export function validateParserPluginManifestValue(
  value: unknown,
  manifestPath: string
): ParserPluginManifestValidationResult {
  const errors: ParserPluginManifestValidationError[] = [];

  if (!isObjectRecord(value)) {
    return buildInvalidResult(manifestPath, [
      {
        code: 'root-object',
        path: '$',
        message: 'manifest root must be a JSON object.',
      },
    ]);
  }

  validateExactString(
    value.schemaVersion,
    '$.schemaVersion',
    PARSER_PLUGIN_MANIFEST_SCHEMA_VERSION,
    'schemaVersion',
    errors
  );
  validateExactString(value.kind, '$.kind', PARSER_PLUGIN_MANIFEST_KIND, 'kind', errors);
  validateNonEmptyString(value.name, '$.name', 'name', errors);
  validateNonEmptyString(value.version, '$.version', 'version', errors);
  validateModulePath(value.module, '$.module', errors);
  const formats = validateFormats(value.formats, errors);
  validateUnsupportedKeys(value, ROOT_KEYS, '$', 'root', errors);

  if (errors.length > 0) {
    return buildInvalidResult(manifestPath, errors);
  }

  return {
    schemaVersion: PARSER_PLUGIN_MANIFEST_SCHEMA_VERSION,
    manifestPath,
    valid: true,
    manifest: {
      schemaVersion: PARSER_PLUGIN_MANIFEST_SCHEMA_VERSION,
      kind: PARSER_PLUGIN_MANIFEST_KIND,
      name: value.name as string,
      version: value.version as string,
      module: value.module as string,
      formats,
    },
    errors: [],
    warnings: [],
  };
}

function validateFormats(
  value: unknown,
  errors: ParserPluginManifestValidationError[]
): ParserPluginFormatMetadata[] {
  const formats: ParserPluginFormatMetadata[] = [];

  if (!Array.isArray(value) || value.length === 0) {
    errors.push({
      code: 'formats-array',
      path: '$.formats',
      message: 'formats must be a non-empty array of format objects.',
    });
    return formats;
  }

  const formatIds = new Set<string>();
  const extensionOwners = new Map<string, { path: string; formatId: string | undefined }>();

  value.forEach((format, index) => {
    const formatPath = `$.formats[${index}]`;

    if (!isObjectRecord(format)) {
      errors.push({
        code: 'format-object',
        path: formatPath,
        message: 'format must be a JSON object.',
      });
      return;
    }

    validateUnsupportedKeys(format, FORMAT_KEYS, formatPath, 'format', errors);
    const id = validateFormatId(format.id, `${formatPath}.id`, errors);

    if (id !== undefined) {
      if (formatIds.has(id)) {
        errors.push({
          code: 'duplicate-format-id',
          path: `${formatPath}.id`,
          message: `duplicate format id '${id}'.`,
        });
      } else {
        formatIds.add(id);
      }
    }

    validateNonEmptyString(format.displayName, `${formatPath}.displayName`, 'displayName', errors);
    const extensions = validateExtensions(
      format.extensions,
      `${formatPath}.extensions`,
      id,
      extensionOwners,
      errors
    );
    const mediaTypes = validateMediaTypes(format.mediaTypes, `${formatPath}.mediaTypes`, errors);
    const directorySupport = validateDirectorySupport(
      format.directorySupport,
      `${formatPath}.directorySupport`,
      errors
    );

    formats.push({
      id: id ?? '',
      displayName: typeof format.displayName === 'string' ? format.displayName : '',
      extensions,
      ...(mediaTypes === undefined ? {} : { mediaTypes }),
      ...(directorySupport === undefined ? {} : { directorySupport }),
    });
  });

  return formats;
}

function validateExactString(
  value: unknown,
  path: string,
  expected: string,
  fieldName: string,
  errors: ParserPluginManifestValidationError[]
): void {
  if (value !== expected) {
    errors.push({
      code: `${fieldName}-invalid`,
      path,
      message: `${fieldName} must be exactly '${expected}'.`,
    });
  }
}

function validateNonEmptyString(
  value: unknown,
  path: string,
  fieldName: string,
  errors: ParserPluginManifestValidationError[]
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push({
      code: `${fieldName}-non-empty-string`,
      path,
      message: `${fieldName} must be a non-empty string.`,
    });
  }
}

function validateFormatId(
  value: unknown,
  path: string,
  errors: ParserPluginManifestValidationError[]
): string | undefined {
  if (typeof value !== 'string' || !FORMAT_ID_PATTERN.test(value)) {
    errors.push({
      code: 'format-id-invalid',
      path,
      message: "format id must match '^[a-z][a-z0-9-]*$'.",
    });
    return undefined;
  }

  return value;
}

function validateExtensions(
  value: unknown,
  path: string,
  formatId: string | undefined,
  extensionOwners: Map<string, { path: string; formatId: string | undefined }>,
  errors: ParserPluginManifestValidationError[]
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({
      code: 'extensions-array',
      path,
      message: 'extensions must be a non-empty array of lowercase strings without leading dots.',
    });
    return [];
  }

  const extensions: string[] = [];

  value.forEach((extension, index) => {
    const extensionPath = `${path}[${index}]`;

    if (typeof extension !== 'string' || !EXTENSION_PATTERN.test(extension)) {
      errors.push({
        code: 'extension-invalid',
        path: extensionPath,
        message: "extension must match '^[a-z0-9][a-z0-9-]*$' and must not include a leading dot.",
      });
      return;
    }

    const existingOwner = extensionOwners.get(extension);

    if (existingOwner !== undefined) {
      const existingFormat =
        existingOwner.formatId === undefined ? '' : ` in format '${existingOwner.formatId}'`;

      errors.push({
        code: 'duplicate-extension',
        path: extensionPath,
        message: `duplicate extension '${extension}' in format '${formatId ?? '<unknown>'}'; first declared at ${existingOwner.path}${existingFormat}.`,
      });
      return;
    }

    extensionOwners.set(extension, { path: extensionPath, formatId });
    extensions.push(extension);
  });

  return extensions;
}

function validateMediaTypes(
  value: unknown,
  path: string,
  errors: ParserPluginManifestValidationError[]
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    errors.push({
      code: 'media-types-array',
      path,
      message: 'mediaTypes must be an array of non-empty strings when provided.',
    });
    return undefined;
  }

  const mediaTypes: string[] = [];

  value.forEach((mediaType, index) => {
    if (typeof mediaType !== 'string' || mediaType.trim().length === 0) {
      errors.push({
        code: 'media-type-non-empty-string',
        path: `${path}[${index}]`,
        message: 'mediaTypes entries must be non-empty strings.',
      });
      return;
    }

    mediaTypes.push(mediaType);
  });

  return mediaTypes;
}

function validateDirectorySupport(
  value: unknown,
  path: string,
  errors: ParserPluginManifestValidationError[]
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    errors.push({
      code: 'directory-support-boolean',
      path,
      message: 'directorySupport must be a boolean when provided.',
    });
    return undefined;
  }

  return value;
}

function validateModulePath(
  value: unknown,
  path: string,
  errors: ParserPluginManifestValidationError[]
): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push({
      code: 'module-non-empty-string',
      path,
      message: 'module must be a non-empty relative local path string.',
    });
    return;
  }

  if (isUrlLikePath(value)) {
    errors.push({
      code: 'module-url-like',
      path,
      message: 'module must be a relative local path, not a URL-like path.',
    });
  }

  if (isAbsolute(value) || win32.isAbsolute(value)) {
    errors.push({
      code: 'module-absolute',
      path,
      message: 'module must be relative, not absolute.',
    });
  }

  const segments = value.replace(/\\/g, '/').split('/');

  if (segments.some((segment) => segment.length === 0)) {
    errors.push({
      code: 'module-empty-segment',
      path,
      message: 'module must not contain empty path segments.',
    });
  }

  if (segments.some((segment) => segment === '..')) {
    errors.push({
      code: 'module-traversal',
      path,
      message: "module must not contain '..' traversal segments.",
    });
  }
}

function validateUnsupportedKeys(
  value: Record<string, unknown>,
  supportedKeys: readonly string[],
  path: string,
  level: 'root' | 'format',
  errors: ParserPluginManifestValidationError[]
): void {
  const supported = new Set<string>(supportedKeys);
  const unsupportedKeys = Object.keys(value)
    .filter((key) => !supported.has(key))
    .sort();

  for (const key of unsupportedKeys) {
    errors.push({
      code: `unsupported-${level}-key`,
      path: path === '$' ? `$.${key}` : `${path}.${key}`,
      message: `unsupported ${level} key '${key}'.`,
    });
  }
}

function buildInvalidResult(
  manifestPath: string,
  errors: ParserPluginManifestValidationError[]
): ParserPluginManifestValidationResult {
  return {
    schemaVersion: PARSER_PLUGIN_MANIFEST_SCHEMA_VERSION,
    manifestPath,
    valid: false,
    errors,
    warnings: [],
  };
}

function isUrlLikePath(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || value.startsWith('\\\\');
}

function getErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String(error.code);
  }

  return 'unknown';
}
