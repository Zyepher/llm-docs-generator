# Multi-Format LLM Documentation Generator

For AI coding assistants. Converts documentation formats into LLM-optimized output.

## For Humans

### Purpose
Transforms documentation (OpenRef YAML, Markdown/DocC) into token-efficient text files for AI consumption.

### Quick Start

1. Install dependencies:
```bash
npm install
```

2. Generate documentation:
```bash
npx tsx src/cli.ts generate --source path/to/docs
```

3. View output in generated directory

### Supported Formats
- OpenRef YAML: Supabase SDK specifications
- Markdown/DocC: Swift Programming Language
- Auto-detection: Automatically identifies format

### Common Use Cases
- Generate reference docs for Claude Code
- Convert SDK specs to AI-readable format
- Process technical documentation for LLM context

### More Information
- Known sources: config/known-sources.json
- Examples: test-swift-book.ts
- Architecture: IMPLEMENTATION.md

---

## For AI Assistants

### CAPABILITIES
Input: openref (yml), markdown (md), docc
Output: LLM-optimized txt files
Features: auto-detection, hierarchical numbering, token-optimization, modular output

### KNOWN SOURCES
File: config/known-sources.json

Tested:
- supabase-sdks (openref): github.com/supabase/supabase/tree/master/apps/docs/spec
  - Files: supabase_js_v2.yml, supabase_swift_v2.yml, supabase_py_v2.yml, supabase_kt_v3.yml, supabase_dart_v2.yml, supabase_csharp_v1.yml
  - Languages: JavaScript, Python, Swift, Kotlin, Dart, C#
  - Versions: v0-v3 across SDKs
- swift-book (markdown/docc): github.com/swiftlang/swift-book/tree/main/TSPL.docc
  - Sections: GuidedTour, LanguageGuide, ReferenceManual
  - Format: Apple DocC markdown

Planned:
- python-docs (rst): github.com/python/cpython/tree/master/Doc
- typescript-handbook (markdown): github.com/microsoft/TypeScript-Handbook
- rust-book (markdown): github.com/rust-lang/book/tree/main/src

### CLI COMMANDS

Generate from source:
```bash
llm-docs generate --source <path>
llm-docs generate --source <path> --format <openref|markdown>
llm-docs generate --sdk <sdk-name> --sdk-version <version>
```

List available SDKs:
```bash
llm-docs list-sdks
```

Validate specification:
```bash
llm-docs validate --sdk <name>
```

Options:
- --verbose: Enable debug logging
- --output-dir: Specify output location (default: ../../public/llms-openref)
- --config-dir: Custom config directory (default: config)
- --force: Force re-download specs

### USAGE PATTERNS

Pattern 1: Supabase SDK (OpenRef)
```bash
cd supabase
llm-docs generate --source apps/docs/spec/supabase_swift_v2.yml
# Output: ../../public/llms-openref/swift/v2/llm-docs/
#   - supabase-swift-v2-full-llms.txt (complete)
#   - supabase-swift-v2-database-llms.txt (category)
#   - supabase-swift-v2-auth-llms.txt (category)
```

Pattern 2: Swift-Book (Markdown/DocC)
```bash
cd swift-book
llm-docs generate --source TSPL.docc/LanguageGuide --format markdown
# Output: ./output/*.txt
```

Pattern 3: Auto-detection
```bash
llm-docs generate --source /path/to/docs
# Format automatically detected
```

### OUTPUT STRUCTURE

Format: Hierarchical markdown with numbering
- Numbering: 1.1, 1.2.1, 2.1.3 (precise navigation)
- Headers: SYSTEM tags for semantic context
- Content: Code examples, schemas, JSON responses inline
- Files: Per-category + full combined

Example output:
```
<SYSTEM>Supabase Swift SDK v2 - Database Operations</SYSTEM>

# Supabase Swift SDK v2 Database Operations Documentation

# 1. Fetch Data: select()

## 1.1. Getting Your Data
```swift
let instruments: [Instrument] = try await supabase
  .from("instruments")
  .select()
  .execute()
  .value

// Data Source
/*
create table instruments (
  id int8 primary key,
  name text
);
*/

// Response
/*
{
  "data": [{"id": 1, "name": "violin"}],
  "status": 200
}
*/
```

## 1.2. Select Specific Columns
```

### ARCHITECTURE

Data flow:
```
Input → Parser → IR (DocNode) → Formatter → Output
```

Components:
- src/parsers/openref/: OpenRef YAML → IR
- src/parsers/markdown/: Markdown/DocC → IR
- src/core/detector.ts: Format auto-detection
- src/core/universal-formatter.ts: IR → LLM output
- src/core/models.ts: Unified IR types

Unified IR (Intermediate Representation):
- DocNode types: ROOT, CATEGORY, SECTION, OPERATION, ITEM
- ContentBlock types: PROSE, CODE, DATA
- Format-agnostic tree structure

Performance:
- O(1) map-based lookups
- O(n) single-pass parsing
- Streaming writes for large files (>10MB)
- Lazy configuration loading

### CONFIGURATION

Files:
- config/sdks.json: SDK definitions
- config/categories.json: Documentation categories
- config/known-sources.json: Source registry
- config/presets/: Format presets

SDK configuration (config/sdks.json):
```json
{
  "sdks": {
    "swift": {
      "name": "Swift",
      "language": "swift",
      "versions": {
        "v2": {
          "displayName": "Supabase Swift SDK v2",
          "spec": {
            "url": "https://raw.githubusercontent.com/.../supabase_swift_v2.yml",
            "localPath": "../../spec/supabase_swift_v2.yml"
          },
          "output": {
            "baseDir": "swift",
            "filenamePrefix": "supabase-swift-v2"
          }
        }
      }
    }
  }
}
```

Category configuration (config/categories.json):
```json
{
  "categories": {
    "database": {
      "title": "Database Operations",
      "systemPrompt": "This is the developer documentation for Supabase {sdk_name} - Database Operations.",
      "operations": ["select", "insert", "update", "delete", "..."],
      "order": 4
    }
  }
}
```

### PROGRAMMATIC API

TypeScript:
```typescript
import { markdownParser } from './src/parsers/markdown/index.js';
import { openRefParser } from './src/parsers/openref/index.js';
import { formatDocNode } from './src/core/universal-formatter.js';

// Parse markdown
const docNode = await markdownParser.parse(sourcePath);

// Format for LLMs
await formatDocNode(docNode, {
  outputDir: './output',
  filenamePrefix: 'docs',
  title: 'Documentation',
  systemPrompt: 'Context for LLM'
});
```

Exports:
- OpenRefParser, parseOpenRefSpec, getParserStats
- LLMFormatter, formatSpecData
- ConfigLoader, loadConfig
- fetchSpec, isSpecCached, clearSpecCache
- Logger, LogLevel

### ADDING SOURCE TO REGISTRY

Steps:
1. Edit config/known-sources.json
2. Add entry with required fields
3. Test generation
4. Update tested: true
5. Submit PR

Entry format:
```json
{
  "id": "project-id",
  "name": "Project Name",
  "repository": "https://github.com/org/repo",
  "format": "markdown",
  "path": "docs/",
  "pattern": "**/*.md",
  "description": "Brief description",
  "examples": [
    {
      "file": "docs/api.md",
      "description": "API documentation"
    }
  ],
  "usage": "llm-docs generate --source docs/",
  "tested": false,
  "maintainer": "Organization"
}
```

### FILE STRUCTURE
```
llm-docs-generator/
├── src/
│   ├── cli.ts                      # CLI entry point
│   ├── index.ts                    # Programmatic API exports
│   ├── core/
│   │   ├── models.ts               # Unified IR types + legacy OpenRef
│   │   ├── detector.ts             # Format auto-detection
│   │   ├── universal-formatter.ts  # IR → LLM output
│   │   ├── formatter.ts            # Legacy OpenRef formatter
│   │   └── parser.ts               # Legacy OpenRef parser
│   ├── parsers/
│   │   ├── base.ts                 # Parser interface
│   │   ├── openref/
│   │   │   ├── parser.ts           # OpenRef YAML parser
│   │   │   ├── adapter.ts          # OpenRef → IR
│   │   │   └── index.ts            # Wrapper
│   │   └── markdown/
│   │       ├── parser.ts           # Markdown/DocC parser
│   │       ├── adapter.ts          # Markdown → IR
│   │       └── index.ts            # Wrapper
│   ├── config/
│   │   ├── loader.ts               # Configuration loader
│   │   └── schemas.ts              # Zod validation schemas
│   └── utils/
│       ├── fetcher.ts              # HTTP client + caching
│       └── logger.ts               # Logging utilities
├── config/
│   ├── sdks.json                   # SDK definitions (OpenRef)
│   ├── categories.json             # Documentation categories
│   ├── known-sources.json          # Source registry
│   └── presets/
│       └── swift-book.json         # Swift-Book preset
├── tests/
│   └── unit/
│       └── models.test.ts          # Unit tests
├── test-swift-book.ts              # Example usage
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### INSTALLATION
```bash
npm install
npm run build
```

Dependencies:
- chalk: Terminal styling
- commander: CLI framework
- js-yaml: YAML parsing
- marked: Markdown parsing
- ora: Progress spinners
- undici: HTTP client
- zod: Schema validation

DevDependencies:
- typescript, tsx, tsup
- vitest, @vitest/coverage-v8
- eslint, prettier

### DEVELOPMENT

Commands:
```bash
npm test              # Run tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
npm run lint          # Lint code
npm run lint:fix      # Fix lint issues
npm run format        # Format code
npm run type-check    # TypeScript check
npm run build         # Build dist/
```

Adding new SDK (OpenRef):
1. Add to config/sdks.json
2. Ensure spec YAML exists at localPath
3. Run: npx tsx src/cli.ts generate --sdk your_sdk

Adding new category:
1. Edit config/categories.json
2. Specify operations array
3. Set order for sorting

### TROUBLESHOOTING

Configuration not loaded:
- Run commands from project directory
- Or use --config-dir flag

SDK not found:
- Run: npx tsx src/cli.ts list-sdks
- Check SDK name is exact match

Spec file not found:
- Verify localPath in config/sdks.json
- Paths are relative to script directory

Uncategorized operations:
- Check warnings during generation
- Add operation IDs to config/categories.json

### ADVANCED USAGE

Programmatic consumption:
```
URL pattern: /llms-openref/{sdk}/{version}/llm-docs/{filename}.txt
Example: https://supabase.com/llms-openref/swift/v2/llm-docs/supabase-swift-v2-full-llms.txt
```

Embedding pipelines:
```python
import requests

url = 'https://supabase.com/llms-openref/dart/v2/llm-docs/supabase-dart-v2-full-llms.txt'
docs = requests.get(url).text
chunks = docs.split('\n## ')  # Split by H2 headers

for chunk in chunks:
    # Process for embeddings
    pass
```

Hierarchical parsing:
```javascript
const docs = await fetch(url).then(r => r.text());
const operations = docs.split(/\n### \d+\.\d+\./);
const examples = operation.split(/\n#### \d+\.\d+\.\d+\./);
```

Metadata headers:
```html
<!-- Generated from: spec/supabase_dart_v2.yml -->
<!-- SDK: dart, Version: v2, Generated: October 17, 2025 -->
```

### FUTURE ENHANCEMENTS

Planned:
- Manifest files: JSON listing all artifacts with hashes
- JSONL export: For embedding pipelines
- CI integration: Automated validation
- Deterministic chunk IDs: Stable anchors for retrieval
- MCP server: Native Claude Code integration
- Git repository support: Clone and process remote sources
- Watch mode: Auto-regenerate on file changes

### REFERENCES

- OpenRef Specifications: github.com/supabase/supabase/tree/master/apps/docs/spec
- Swift-Book: github.com/swiftlang/swift-book
- Supabase PR: github.com/supabase/supabase/pull/39461
