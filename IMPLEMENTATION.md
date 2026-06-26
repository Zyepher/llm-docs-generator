# Multi-Format LLM Documentation Generator - Implementation Summary

**Status**: ✅ **COMPLETE AND WORKING**

Successfully implemented a general-purpose, multi-format LLM documentation generator that handles OpenRef YAML (Supabase), Markdown/MDX/DocC, RST, and static HTML parser inputs.

## What Was Built

### Core Architecture

```
llm-docs-generator/
├── src/
│   ├── core/
│   │   ├── models.ts              ✅ Unified IR (DocNode + ContentBlock)
│   │   ├── detector.ts            ✅ Auto-detect format
│   │   ├── chunker.ts             ✅ Deterministic DocNode semantic chunks
│   │   ├── universal-formatter.ts ✅ IR → LLM-optimized output
│   │   └── formatter.ts           ✅ Legacy OpenRef formatter (kept for backward compat)
│   ├── parsers/
│   │   ├── base.ts                ✅ Parser interface
│   │   ├── openapi/
│   │   │   └── index.ts           ✅ OpenAPI 3.x / Swagger 2.0 → IR parser
│   │   ├── openref/
│   │   │   ├── parser.ts          ✅ OpenRef YAML parser
│   │   │   ├── adapter.ts         ✅ OpenRef → IR adapter
│   │   │   └── index.ts           ✅ OpenRef wrapper
│   │   ├── markdown/
│   │   │   ├── parser.ts          ✅ Markdown/MDX/DocC parser
│   │   │   ├── adapter.ts         ✅ Markdown/MDX → IR adapter
│   │   │   └── index.ts           ✅ Markdown wrapper
│   │   ├── rst/
│   │   │   ├── parser.ts          ✅ deterministic RST subset parser
│   │   │   ├── adapter.ts         ✅ RST → IR adapter
│   │   │   └── index.ts           ✅ RST wrapper
│   │   └── html/
│   │       ├── parser.ts          ✅ static HTML extraction fallback parser
│   │       ├── adapter.ts         ✅ HTML → IR adapter
│   │       └── index.ts           ✅ HTML wrapper
│   └── config/
│       └── presets/
│           └── swift-book.json    ✅ Swift-book configuration
└── test-swift-book.ts             ✅ Working test!
```

### Key Features Implemented

1. **Unified Intermediate Representation (IR)**
   - Format-agnostic `DocNode` tree structure
   - `ContentBlock` for prose, code, and data
   - Type-safe with Zod validation

2. **Multi-Format Parsing**
   - **OpenRef YAML**: Supabase SDK specs
   - **OpenAPI / Swagger**: Explicit local OpenAPI 3.x and Swagger 2.0
     JSON/YAML files converted to DocNode IR as a parser/library capability
   - **Markdown/MDX/DocC**: local Markdown files, MDX cleanup foundation, and
     Swift Programming Language book
   - **RST**: explicit local `.rst` files and directories containing `.rst`
     files parsed as a deterministic Python-style documentation subset
   - **HTML**: explicit local `.html` / `.htm` files and directories containing
     HTML files parsed as a deterministic lower-confidence rendered-HTML
     fallback
   - Extensible: Add new formats easily

3. **Auto-Detection**
   - Automatically detects format from file extension + content
   - No manual configuration required

4. **LLM-Optimized Output**
   - Hierarchical numbering (1.1.1, 2.3.4)
   - SYSTEM prompts for semantic context
   - Token-efficient formatting
   - Modular per-category + full combined files

5. **Semantic Chunking Library**
   - Chunks existing DocNode IR by semantic section without merging unrelated
     siblings
   - Preserves heading/path context, prose, code fences, and data blocks
   - Emits stable path-derived IDs, ordinal order, source format/path metadata,
     content hash, character count, and estimated token count
   - Supports bounded prose/block splitting and warns honestly for oversized
     indivisible code or data blocks
   - Handles empty docs, duplicate sibling node IDs, repeated calls, malformed
     child/content shapes, and deep trees deterministically
   - Available as library support and as an opt-in JSONL export for explicit
     `generate --source` outputs only; source-docs refresh preserves that JSONL
     output only when the existing manifest recorded it. Source-docs manifests
     record compact JSONL-derived chunk indexes without embedding chunk content.
     Discovery reports, configured SDK generation, source-truth docs, and broad
     RAG systems do not consume semantic chunks

6. **Performance Optimizations**
   - O(1) Map-based lookups
   - Streaming writes for large files (>10MB)
   - Array join vs string concatenation
   - Pre-compiled regex patterns

## Test Results

**✅ Markdown Parser Test: PASSED**

```
Testing Swift-Book Markdown Parser...
1. Parsing ../TSPL.docc/LanguageGuide/BasicOperators.md...
   ✓ Parsed successfully
   Title: Basic Operators
   Type: SECTION
   Children: 1
   Content blocks: 0

2. Formatting to LLM-optimized output...
   ✓ Generated test-output/swift-basic-operators-full-llms.txt

Success!
```

**Generated Output Sample:**

```
<SYSTEM>Swift Basic Operators documentation for LLMs</SYSTEM>

<!-- Format: markdown, Generated: October 17, 2025 -->

# Swift Basic Operators

## 1.1. Terminology

Operators are unary, binary, or ternary...
```

## How to Use

### For Swift-Book (Markdown)

```bash
# Parse a single markdown file
npx tsx test-swift-book.ts

# Deterministic preset defaults over an explicit local source path
llm-docs generate --source ../TSPL.docc --preset swift-book --output-dir ./swift-book-agent-docs
```

### For Supabase (OpenRef - Backward Compatible)

```bash
# Existing Supabase workflow still works
cd /path/to/supabase/apps/docs/scripts
# The old OpenRef parser still works via adapter
```

## Architecture Highlights

### Unified IR Design

```
Input Sources → Auto-Detect → Parser → Unified IR → Formatter → Output
     ↓              ↓            ↓          ↓           ↓          ↓
  YAML/MD      OpenRef/MD   Format      DocNode    Universal   TXT
                            Specific      Tree      Formatter
```

### Format Mapping

**OpenRef → IR:**

- SDK → ROOT DocNode
- Category → CATEGORY DocNode
- Operation → OPERATION DocNode
- Example → ITEM DocNode (with code ContentBlocks)

**Markdown / MDX → IR:**

- File → SECTION DocNode
- H2 → CATEGORY DocNode
- H3 → OPERATION DocNode
- H4 → ITEM DocNode
- Code block → CODE ContentBlock
- MDX source syntax → Markdown format metadata with deterministic cleanup
  outside fenced code

**OpenAPI / Swagger → IR:**

- API document → ROOT DocNode with format, source kind, source path, title, and
  version metadata
- First operation tag → CATEGORY DocNode, with `Untagged` as the stable fallback
- Operation → OPERATION DocNode with stable `operationId` or method/path ID
- Endpoint details, parameters, request bodies, responses, schema refs, and
  simple examples → deterministic PROSE ContentBlocks

**RST → IR:**

- File → SECTION DocNode with `format: rst` and `sourcePath` metadata
- Directory → ROOT DocNode containing sorted file SECTION nodes
- Underline heading adornments → SECTION / CATEGORY / OPERATION / ITEM hierarchy
- Paragraphs and simple bullet/enumerated lists → deterministic PROSE
  ContentBlocks
- Literal blocks and `code-block` / `code` directives → CODE ContentBlocks
- Unsupported directives/includes → warnings plus safe prose where possible;
  includes are not executed or fetched

**HTML → IR:**

- File → SECTION DocNode with `format: html`, `sourcePath`, parser details,
  warnings, and lower-confidence rendered-HTML fallback metadata
- Directory → ROOT DocNode containing sorted file SECTION nodes
- Document `<title>` with H1 fallback → document title
- H2 → CATEGORY, H3 → OPERATION, H4-H6 → nested ITEM hierarchy
- Paragraphs and simple list items → PROSE ContentBlocks
- `pre` / `code` blocks → CODE ContentBlocks with simple language hints
- Simple tables → DATA ContentBlocks
- `script`, `style`, and `template` elements are stripped; JavaScript is not
  rendered or executed, and linked resources are not fetched

## Benefits

1. **Reusability**: One tool for multiple doc sources
2. **Consistency**: Same LLM-optimized format across projects
3. **Extensibility**: Easy to add RST, AsciiDoc, etc.
4. **Intelligence**: Auto-detection reduces config burden
5. **Backward Compatible**: Supabase OpenRef code still works

## Next Steps (Future Work)

- [x] Deterministic configured SDK `generate --format` / `--preset` handling:
      `--format openref` and `--format openref-0.1` are accepted for the
      existing `generate --sdk` OpenRef compatibility path; unsupported
      configured-SDK `--format` values and `--preset` with `--sdk` fail
      honestly before generation
- [x] Explicit local source docs generation through
      `generate --source <local-file-or-directory> --output-dir <dir>` with
      parser hints for `auto`, `markdown`, `mdx`, `openapi`, `openref`, `rst`,
      and `html`, source provenance manifest writing, URL/discovery-report
      rejection, and `--sdk` mutual exclusion
- [x] Supported scoped `--preset swift-book` generation over explicit local
      Markdown/DocC sources only; no source path inference or source truth claim
- [x] Recursive directory parsing for swift-book-style Markdown/DocC chapters
- [x] Opt-in JSONL export format for explicit local source docs semantic chunks
- [x] OpenAPI 3.x / Swagger 2.0 parser foundation for explicit local JSON/YAML
      files
- [x] Scoped manifest generation for configured OpenRef CLI output
- [x] Scoped manifest hash/size verification for current configured SDK output
- [x] Explicit local `discover --source` bounded inspection report
- [x] Explicit repo `discover --repo` cache and bounded inspection report
- [x] Explicit website `discover --url` bounded inspection report
- [x] Deterministic discovery report manifests and integrity verification for
      `discover --source`, `discover --repo`, and `discover --url`
- [x] Explicit `source-truth inspect --source` deterministic evidence report
      for conservative TypeScript/JavaScript export facts and `package.json` /
      `tsconfig*.json` package/config facts, plus path-based test/example
      context facts for inspected supported files
- [x] Explicit `source-truth generate --source --output-dir` Markdown evidence
      facts with raw evidence report and provenance manifest
- [x] Explicit `source-truth verify-docs --source --docs --output-dir`
      source/docs lexical evidence report for local Markdown/MDX inline-code
      references compared with observed local source exported names
- [x] Partial generated-output RAG metadata for configured SDK and source-truth
      docs manifests (`lineCount` and deterministic `estimatedTokenCount`)
- [x] RST parser foundation for explicit local Python-style documentation
- [x] Static HTML parser foundation for explicit local rendered-HTML fallback
- [x] Semantic chunking foundation for existing DocNode IR as a library API
- [x] Deterministic `capabilities --json` contract for agents with implemented
      and planned/unsupported capabilities separated
- [x] Read-only `agent context` metadata command for packaged context and skill
      artifacts
- [x] Read-only `agent doctor` diagnostics for packaged artifact readability,
      expected binary metadata, PATH visibility, and skipped host-install checks
- [x] Bundled package skill files for current CLI usage and repo/docs discovery
- [x] Deterministic local explicit-manifest refresh for current
      `local-source-docs` and `source-truth-local-docs` manifests only, with
      post-refresh manifest integrity verification for regenerated outputs
- [x] Deterministic semantic chunk manifest-index metadata for opt-in
      source-docs `chunks/semantic-chunks.jsonl` exports
- [ ] Full manifest expansion for RAG, discovery, and refresh systems
- [ ] Broad official-docs behavior/API claim verification, broad website
      crawling, configured SDK refresh, discovery-report refresh, and remote
      freshness refresh
- [ ] Plugin system for custom parsers
- [x] OpenRef backward compatibility tests

Current discovery scope:

- `llm-docs discover --source <path>` accepts an explicit local file or
  directory, writes a candidate evidence report at `discovery-report.json` plus
  a discovery-report `manifest.json`, and reports candidate file hints,
  deterministic evidence categories and signals, report order, byte sizes,
  hashes, traversal bounds, skipped generated directories, warnings, and a
  compact content-free `candidateEvidenceIndex` derived from
  `discovery-report.json`.
- `llm-docs discover --repo <git-url-or-local-git-repo>` clones or reuses an
  explicit git repo in a cache, optionally inspects repo-relative
  `--scope <path>`, and writes a candidate evidence report at
  `discovery-report.json` plus a discovery-report `manifest.json` with repo
  input, cache path, commit, dirty state, traversal settings, candidates,
  warnings, and a compact content-free `candidateEvidenceIndex` derived from
  `discovery-report.json`.
- `llm-docs discover --url <http-or-https-url>` inspects one explicit URL plus
  same-origin root `/llms.txt` and `/sitemap.xml`. It writes a candidate
  evidence report at `discovery-report.json` plus a discovery-report
  `manifest.json` with website input, normalized URL, inspected resources,
  status/content type/byte counts, truncation flags, crawl policy, candidate
  URLs, evidence/provenance, and warnings. The manifest includes a compact
  content-free `candidateEvidenceIndex` derived from `discovery-report.json`.
  It does not fetch linked candidates or render JavaScript.

Discovery does not generate docs, crawl linked website candidates, choose
candidates, assign trust or authority labels, infer authority, claim source
truth, decide task fit, or implement source-truth codebase docs generation. It lists, groups,
filters, and orders candidates deterministically for agent review only. There is
no automatic selection or generation from a first ordered candidate unless the
agent or user explicitly selects that candidate or a future documented
automation flag requires it. Repo cache handling is non-destructive; clean
matching caches fetch remote refs without pulling into the checkout, and cached
checkouts with local changes or ignored files are warned about and inspected as
present.

Current capabilities contract scope:

- `llm-docs capabilities --json` prints a deterministic JSON contract for
  agents. The contract has schema version `0.1.0`, package name/version
  metadata, product-boundary metadata, implemented command entries,
  source-truth fact-family scope, explicit source-truth limitations, and
  planned/unsupported entries.
- Implemented entries cover `discover --source`, `discover --repo`,
  `discover --url`, `source-truth inspect --source`,
  `source-truth generate --source --output-dir`,
  `source-truth verify-docs --source --docs --output-dir`, read-only
  `agent context`, read-only `agent doctor`,
  explicit local `generate --source` with parser hints and optional
  `--chunks jsonl`, scoped `generate --source --preset swift-book`, configured
  `generate --sdk` with optional `--format openref` /
  `--format openref-0.1`, configured SDK, source-docs, source-truth docs, and
  discovery-report/source-verification `verify`, local explicit-manifest
  source-docs/source-truth `refresh`, `list-sdks`, and `validate --sdk`.
- Planned/unsupported entries include additional `generate --preset` names,
  configured SDK refresh, discovery-report refresh, remote freshness refresh,
  broad official-docs behavior/API claim verification, broad website crawling,
  automatic source selection or automatic generation from first ordered
  candidates, framework/route understanding, behavior-level generation from
  source code, and
  `agent install codex`.
- Stable output files are reported where they exist:
  `discovery-report.json`, `source-truth-report.json`, `source-truth.md`,
  `source-verification-report.json`, `manifest.json`, `failure.json`, source
  docs under `llm-docs/`, configured SDK parsed spec output, and configured SDK
  LLM docs output.
- Generated-output manifest metadata is currently partial: source docs,
  configured SDK, source-truth docs, and discovery-report manifests record
  `lineCount` and deterministic `estimatedTokenCount` for explicit generated
  or report files. Discovery-report manifests additionally record compact
  content-free candidate evidence indexes derived only from
  `discovery-report.json`. Source docs can additionally publish opt-in
  `chunks/semantic-chunks.jsonl` records for explicit `generate --source`
  outputs plus compact manifest chunk indexes derived only from those JSONL
  records. Source-docs refresh preserves that output and regenerates the index
  when the existing manifest recorded it. Capabilities output does not claim
  full RAG systems, configured SDK refresh, discovery-report refresh, remote
  freshness refresh, broad official-docs behavior/API claim verification, broad
  crawling, or automatic source selection.
- The contract intentionally omits `generatedAt`. The command does not inspect
  sources, load config, write files, perform network work, or probe hidden
  environment state.

Current agent context metadata scope:

- `llm-docs agent context` prints a concise human-readable summary of packaged
  agent context and skill artifacts and points to `--json`.
- `llm-docs agent context --json` prints deterministic JSON with schema version
  `0.2.0`, package name/version metadata, the `llm-docs` binary, context
  artifact entries for `AGENT_CONTEXT.md` and `index.md`, and skill artifact
  entries for `skills/llm-docs-generator/SKILL.md` and
  `skills/repo-docs-discovery/SKILL.md`.
- Each artifact entry includes an artifact id, display name, package-relative
  path, byte size, SHA-256 hash, and intended use.
- The command reads only package-local context files, writes only stdout, omits
  `generatedAt`, performs no network access, and does not probe environment
  state.
- The command does not install or register skills, write user config, or
  implement `agent install codex`.

Current agent doctor diagnostics scope:

- `llm-docs agent doctor` prints concise human-readable read-only diagnostics
  and points to `--json`.
- `llm-docs agent doctor --json` prints deterministic JSON with schema version
  `0.1.0`, package name/version metadata, the `llm-docs` binary, summary
  counts, check results, and limitations.
- Checks are intentionally narrow: packaged context and skill artifacts are
  read and SHA-256 hashed through the same package-local metadata path used by
  `agent context`; the expected package binary name is checked as `llm-docs`;
  `PATH` is inspected only from the explicit process environment and reports
  found/not-found facts; Codex skill installation is skipped/not-configured.
- Missing `llm-docs` on PATH is a warning and exits successfully. Hard failures
  are reserved for packaged artifact read/hash failures or malformed internal
  package metadata.
- The command writes only stdout, omits `generatedAt`, performs no network
  access, does not install/register skills, does not write user config, does
  not mutate host skill directories, and does not infer source authority, source
  truth, or task fit.
- The bundled skill files are current-state instructions for agents. They tell
  agents to inspect `capabilities --json` before assuming support, preserve
  the boundary that the agent chooses explicit source/scope/candidate while the
  CLI reports deterministic evidence, and include repo URL, docs URL,
  package/product name, and local path examples. Candidate evidence reports are
  described as inputs for agent review, not source selection or authority
  decisions.

Current source-truth evidence scope:

- `llm-docs source-truth inspect --source <path>` accepts an explicit local file
  or directory and prints deterministic JSON to stdout. It reports observed
  TypeScript/JavaScript export facts, optional direct-declaration AST signature
  evidence, and package/config facts from `package.json` and `tsconfig*.json`
  only. It also reports file-level test/example context facts using explicit
  normalized path and filename signals only; it does not parse assertions,
  execute tests, or infer behavior.
- `llm-docs source-truth generate --source <path> --output-dir <dir>` accepts
  the same explicit local source boundary, reuses the inspector, and writes
  `source-truth-report.json`, `source-truth.md`, and `manifest.json` on success.
  It rejects output directories that are the source path or inside the source
  path. If no export, package/config, or context facts are found, it exits
  non-zero and writes `failure.json` referencing the raw evidence report without
  producing Markdown.
- Traversal is bounded by depth, entry, file, and per-file byte limits. It does
  not follow symlinks and skips common dependency/build directories such as
  `node_modules`, `dist`, `build`, `coverage`, and `.git`.
- Supported evidence extraction is intentionally conservative:
  TypeScript/JavaScript source files only, starting with top-level exports,
  re-exports, export-all declarations, and export assignments. Signature
  evidence is emitted only for directly exported top-level declarations and
  omits function/class bodies and variable initializer values.
- Every extracted fact cites a normalized source path and line range. Supported
  inspected files include byte size and SHA-256 hash; unsupported or oversized
  files are reported as skipped with warnings.
- Generated source-truth Markdown groups observed facts by normalized source
  file and lists export facts, optional signature evidence, and package/config
  facts with line ranges and warnings/limitations. It does not prove existing
  documentation claims, infer runtime behavior, decide task fit, select sources,
  or summarize behavior beyond observed export and package/config facts.

Current source/docs evidence scope:

- `llm-docs source-truth verify-docs --source <path> --docs <path>
--output-dir <dir>` accepts explicit local source and docs paths only.
- The source side reuses `inspectSourceTruth`; it does not execute code, run
  package scripts, load project config dynamically, resolve re-export targets
  beyond existing facts, infer routes/frameworks, or infer runtime behavior.
- The docs side accepts explicit local `.md`, `.mdx`, and `.markdown` files or
  directories, traverses with bounded depth/entry/file/byte limits, skips common
  dependency/generated directories, rejects symlink roots and parents, and does
  not fetch network resources or render JavaScript.
- Docs evidence is limited to inline-code identifiers and empty call identifiers
  such as `makeClient` or `makeClient()`, outside fenced code. Each reference
  records file path, line range, raw text, normalized identifier, and order.
- Exact matches are lexical matches against observed source exported names.
  Unmatched references are reported as observations, not correctness failures.
- Successful runs write `source-verification-report.json` and `manifest.json`.
  Unsupported docs inputs or supported docs with no inline-code identifier
  references write `source-verification-report.json` plus `failure.json` and do
  not write a manifest.
  `source-verification-local-evidence` manifests are supported by `verify` for
  report file integrity and basic schema/count consistency only.

Current explicit local source docs generation scope:

- `llm-docs generate --source <local-file-or-directory> --output-dir <dir>`
  accepts only explicit local file or directory paths.
- `--sdk` and `--source` are mutually exclusive. `--preset swift-book` is
  supported only with an explicit local `--source`; unknown presets, presets
  without `--source`, presets with `--sdk`, and preset-incompatible explicit
  formats fail before output work.
- URL-like sources, missing paths, symlinked source roots, discovery reports,
  and candidate evidence/discovery report automatic selection are rejected honestly;
  there is no generation from a first ordered candidate. Source mode never
  fetches network resources and does not consume discovery reports
  automatically.
- `--format` is a parser hint. Supported values are `auto`, `markdown`, `mdx`
  as Markdown parser support, `openapi`, `openref`, `rst`, and `html`.
  Unsupported source-mode formats fail before output work.
- Source mode parses through the existing parser registry, formats through
  `UniversalFormatter`, writes generated docs under `llm-docs/`, and writes a
  root `manifest.json` only after successful parsing and formatting.
- `--preset swift-book` sets deterministic Markdown defaults, `swift-book`
  filename prefix, title, neutral source-derived system prompt, and
  non-authoritative preset metadata in the manifest. It does not infer or
  append `TSPL.docc`, select sources, clone/cache repositories, verify source
  code, claim completeness, or claim source truth.
- `--chunks jsonl` is an opt-in source-mode-only export. When requested, source
  mode chunks the already parsed DocNode tree with `chunkDocNode` and writes
  one semantic chunk JSON object per line to `chunks/semantic-chunks.jsonl`.
  Unsupported `--chunks` values and `--chunks` with `--sdk` fail before output
  work.
- The source manifest has mode `local-source-docs` and records generator
  metadata, source input/resolved path/type, format hint and resolved format,
  parser/formatter metadata, deterministic source file hashes and byte sizes,
  a stable directory aggregate hash when applicable, generated output hashes,
  byte sizes, line counts, deterministic estimated token counts, output
  kind/name metadata, and warnings. Opt-in chunk JSONL is recorded as a
  generated text output with kind `semantic-chunks-jsonl`, plus a compact
  `semanticChunkIndexes` entry with output path, format, chunk count, aggregate
  hash, per-chunk IDs/order/title/path/nodePath/content hash/counts/source
  metadata, and warning counts without chunk content.
- `verify` supports current `configured-sdk`, `local-source-docs`,
  `source-truth-local-docs`, `discovery-report`, and
  `source-verification-local-evidence` manifests.
  Discovery-report verification checks `discovery-report.json` existence, hash,
  byte size, line count, deterministic estimated token count, and basic report
  schema/mode/kind/count consistency. When optional candidate evidence index
  metadata is present, verification rebuilds it from `discovery-report.json`
  and fails on malformed or stale index data; it does not choose candidates,
  validate task fit, claim source truth, refresh repos or websites, or perform
  source-code verification. Source-docs verification checks source files and
  all generated text outputs, including opt-in chunk JSONL when present. When a
  source-docs semantic chunk index is present, verification rebuilds it from the
  JSONL records and fails on malformed JSONL or stale index facts.
  Source-truth docs verification checks deterministic source-truth manifest
  shape, source/source-file integrity, generated output integrity, symlink/path
  containment, inspection basics, and raw report count consistency; it does not
  infer behavior or perform broad source-code verification.
  Source-verification manifest checks verify `source-verification-report.json`
  file integrity and basic schema/count consistency only; they do not refresh
  sources, inspect additional files, parse behavior claims, or decide whether
  docs statements are correct.

- `refresh --manifest <path>` / `refresh --output-dir <dir>` supports only
  current `local-source-docs` and `source-truth-local-docs` manifests. For
  source docs it reads the existing manifest and uses only the recorded
  absolute local source path, `source.formatHint`, preset metadata if present,
  and whether `semantic-chunks-jsonl` was previously present, then regenerates
  through the current source docs generator into the manifest directory. For
  source-truth docs it uses only the recorded absolute local source path and
  regenerates through the current source-truth docs generator into the manifest
  directory. After successful regeneration, it runs the existing manifest
  verifier over the newly written manifest outputs and reports the checked-file
  count. This post-refresh check is deterministic manifest/output integrity
  verification only; it does not claim freshness, source truth, source-code
  behavior, or runtime behavior. It rejects configured-SDK manifests,
  discovery-report manifests, malformed/missing manifests, URL-like or
  non-absolute recorded source paths, and unsupported manifest modes. It does
  not perform URL fetching, repo freshness checks, broad website crawling,
  source selection, source-code verification, behavior validation, remote
  network work, or source project script execution.

Current OpenAPI / Swagger parser scope:

- Accepts only explicit local `.json`, `.yaml`, and `.yml` files.
- Supports OpenAPI 3.x and Swagger 2.0 roots with a required `paths` object.
- Preserves schema references and simple inline examples in the IR, but does
  not fetch, dereference, or resolve remote sources.
- Is available through `generate --source <local-file> --format openapi` or
  auto-detection for explicit local files. Directory source mode is not
  supported by this parser.

Current Markdown / MDX parser scope:

- Accepts explicit local `.md`, `.markdown`, and `.mdx` files.
- Accepts directories containing Markdown or MDX files and parses them through
  the existing Markdown/DocNode pipeline.
- Records `format: markdown` metadata and `sourceSyntax: markdown` or
  `sourceSyntax: mdx` when straightforward.
- Strips YAML frontmatter from parsed content while preserving simple
  frontmatter metadata extraction.
- Performs deterministic MDX cleanup outside fenced code only: import/export
  declarations, JSX comments, simple expression-only lines or blocks, common
  wrapper components, and self-closing presentational components without useful
  text.
- Preserves fenced code content, including JSX/import/export text inside code
  fences.
- Does not evaluate JSX, execute imports, fetch network sources, or add
  product-specific MDX rules.
- Is available through `generate --source <local-file-or-directory>
--format markdown`; `--format mdx` is accepted as a Markdown parser hint.

Current RST parser scope:

- Accepts explicit local `.rst` files.
- Accepts directories containing nested `.rst` files, traverses local
  filesystem entries deterministically, sorts parsed files, and does not follow
  symlinked entries.
- Records `format: rst`, `sourcePath`, parser details, and warnings metadata.
- Supports underline title/section headings, paragraphs, simple
  bullet/enumerated lists as prose, literal blocks introduced by `::`, and
  `.. code-block::` / `.. code::` directives with optional language.
- Does not execute or fetch includes, run Sphinx/docutils transforms, resolve
  references, or claim full RST/Sphinx support.
- Is available through `generate --source <local-file-or-directory>
--format rst`.

Current HTML parser scope:

- Accepts explicit local `.html` and `.htm` files.
- Accepts directories containing nested HTML files, traverses local filesystem
  entries deterministically, sorts parsed files, and does not follow symlinked
  entries.
- Records `format: html`, `sourcePath`, parser details, warnings,
  `sourceKind: rendered-html-fallback`, `renderedHtmlFallback: true`, and
  `confidence: lower` metadata.
- Preserves document title with H1 fallback, H2-H6 hierarchy, paragraphs,
  simple list items as prose, `pre` / `code` blocks as CODE, and simple tables
  as DATA.
- Strips `script`, `style`, and `template` elements before parsing.
- Does not render JavaScript, execute content, fetch linked resources, follow
  links, infer source authority, or choose candidate sources.
- Is available through `generate --source <local-file-or-directory>
--format html`.

Current semantic chunking scope:

- Accepts an existing DocNode tree through the library API exported from
  `src/index.ts`, and source generation can opt in to JSONL publication with
  `generate --source ... --chunks jsonl`.
- Traverses deterministically in preorder without recursive calls, derives
  readable chunk IDs from semantic node paths, and disambiguates duplicate
  sibling node IDs with stable suffixes.
- Emits chunk order, title/path metadata, inherited source format/path metadata
  when present, SHA-256 content hash, character count, estimated token count,
  split metadata, and warning metadata.
- Preserves ancestor heading context, section prose, code fences, and data
  blocks. It does not merge unrelated sibling sections.
- Splits oversized prose at paragraph, line, sentence, or space boundaries when
  possible. Code and data blocks remain indivisible; oversized indivisible
  blocks produce explicit warnings and oversized metadata.
- Handles empty documents, repeated calls, malformed content/children shapes,
  traversal cycles, and deep trees deterministically.
- The CLI writes JSONL only for explicit source-mode generation when
  `--chunks jsonl` is requested, and source-docs refresh writes it only when
  the prior manifest already recorded `semantic-chunks-jsonl`. New source-docs
  manifests also record compact per-chunk index metadata for that JSONL artifact
  and verify it in O(number of chunk records + JSONL bytes) without network
  work, repo script execution, or unrelated file inspection. It does not write
  chunk records for discovery, configured SDK generation, source-truth docs, or
  any source selection workflow, and it does not select sources or infer
  authority.

## Files Modified/Created

**New Core Files:**

- `src/core/models.ts` - Added IR types at top
- `src/core/detector.ts` - Format detection
- `src/core/chunker.ts` - Deterministic DocNode semantic chunking
- `src/core/universal-formatter.ts` - IR-based formatter

**New Parser Files:**

- `src/parsers/base.ts` - Parser interface
- `src/parsers/openref/` - OpenRef parser + adapter
- `src/parsers/markdown/` - Markdown parser + adapter
- `src/parsers/html/` - Static HTML parser + adapter

**Configuration:**

- `config/presets/swift-book.json` - Swift preset
- `package.json` - Added `marked` dependency

**Tests:**

- `test-swift-book.ts` - Working test script

## Success Metrics

✅ All 10 implementation tasks completed
✅ Test passes with real swift-book markdown
✅ Output correctly formatted for LLMs
✅ Architecture extensible for new formats
✅ Backward compatible with existing OpenRef code

---

**Status**: Production-ready for swift-book markdown parsing
**Remaining**: CLI updates for ease of use, full directory parsing
