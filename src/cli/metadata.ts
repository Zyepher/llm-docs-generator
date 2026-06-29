import packageJson from '../../package.json';

/**
 * Shared CLI identity and schema-version constants. Extracted to a leaf module
 * so the capabilities contract and the agent-context/doctor builders can
 * reference them without importing back from cli.ts (which would be a cycle).
 */
export const CLI_NAME = 'llm-docs';
export const GENERATOR_NAME = packageJson.name;
export const GENERATOR_VERSION = packageJson.version;
export const EXPECTED_BINARY_NAME = 'llm-docs';
export const CAPABILITIES_SCHEMA_VERSION = '0.1.0';
