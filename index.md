# llm-docs-generator Index

This is the navigation index for humans and AI agents working with this project.

Read this file first, then follow the links for the task you are doing.

## Project Summary

`llm-docs-generator` is a Node.js / TypeScript CLI and library for producing
LLM-friendly documentation from reliable source material. The agent resolves
intent, source, scope, version, and path; the CLI performs deterministic,
bounded inspection and conversion over explicit inputs.
Discovery reports are candidate evidence for agent review only. Generation from
discovery candidates requires an explicit agent/user-selected source or a
documented automation flag, not CLI source selection.

The next-generation direction is to make the project an agent-aware system that
will be able to:

1. Help agents inspect explicit official documentation candidates.
2. Convert local documentation.
3. Explore cloned repositories when needed.
4. Respect pinned versions.
5. Verify generated docs against source provenance.
6. Fact-check official docs against source code when requested and available.
7. Generate source-truth codebase docs only when that workflow is explicitly
   selected and a dedicated generator mode exists.

Important distribution note:

- Installing the CLI makes `llm-docs` available as a command.
- Installing or registering skills is a separate step unless a future installer
  command performs it for the user's AI host.
- `llm-docs agent doctor` is read-only diagnostics; it reports packaged
  artifact hashes, expected binary metadata, PATH visibility, and skipped host
  checks without installing/registering skills or mutating user config.
- A future command such as `llm-docs agent install codex` should keep host
  installation explicit.

## Start Here By Role

### AI Agent

Read:

1. [AGENT_CONTEXT.md](AGENT_CONTEXT.md)
2. [skills/repo-docs-discovery/SKILL.md](skills/repo-docs-discovery/SKILL.md)
   when the task starts from an external repo URL, docs URL,
   package/product name, or local docs path
3. [skills/llm-docs-generator/SKILL.md](skills/llm-docs-generator/SKILL.md)
   when maintaining this repo or checking the installed CLI contract
4. [NEXT_GEN_PLAN.html](NEXT_GEN_PLAN.html)
5. [README.md](README.md)

Use [AGENT_CONTEXT.md](AGENT_CONTEXT.md) to decide the user's intent before
running commands.

### Human Evaluating The Product

Read:

1. [NEXT_GEN_PLAN.html](NEXT_GEN_PLAN.html)
2. [AGENT_CONTEXT.md](AGENT_CONTEXT.md)
3. [README.md](README.md)

The HTML plan explains the next-generation architecture, edge cases, skill
integration, CLI shape, and roadmap.

### Engineer Changing The Tool

Read:

1. [README.md](README.md)
2. [IMPLEMENTATION.md](IMPLEMENTATION.md)
3. [AGENT_CONTEXT.md](AGENT_CONTEXT.md)
4. Source files listed below

Run relevant checks after changes:

```bash
npm run type-check
npm run test
```

## Intent Map

Use this map to choose the intended workflow. Some workflows are target
next-generation behavior and are not fully implemented in the current CLI yet;
check [AGENT_CONTEXT.md](AGENT_CONTEXT.md) and source before promising support.

| User Intent                              | First File To Read                     | Workflow                                                             |
| ---------------------------------------- | -------------------------------------- | -------------------------------------------------------------------- |
| Convert a known local docs path          | [AGENT_CONTEXT.md](AGENT_CONTEXT.md)   | Intent 2: locally provided documentation                             |
| Generate docs for official product docs  | [AGENT_CONTEXT.md](AGENT_CONTEXT.md)   | Intent 1: official documentation                                     |
| Verify official docs against source code | [AGENT_CONTEXT.md](AGENT_CONTEXT.md)   | Intent 1 plus source verification                                    |
| Generate docs from a GitHub repo         | [AGENT_CONTEXT.md](AGENT_CONTEXT.md)   | Determine whether user means repo docs or source-truth codebase docs |
| Generate docs from source code           | [AGENT_CONTEXT.md](AGENT_CONTEXT.md)   | Intent 3: source-truth codebase docs                                 |
| Refresh generated docs                   | [AGENT_CONTEXT.md](AGENT_CONTEXT.md)   | Intent 4: refresh or verify                                          |
| Implement new functionality              | [IMPLEMENTATION.md](IMPLEMENTATION.md) | Intent 5: maintain or extend tool                                    |

## Current CLI

Development commands:

```bash
npx tsx src/cli.ts discover --source ./docs --output-dir ./reports/local-docs
npx tsx src/cli.ts discover --repo https://github.com/owner/repo --scope docs --output-dir ./reports/repo-docs
npx tsx src/cli.ts discover --url https://example.com/docs --output-dir ./reports/website
npx tsx src/cli.ts capabilities --json
npx tsx src/cli.ts source-truth inspect --source ./src
npx tsx src/cli.ts source-truth generate --source ./src --output-dir ./reports/source-truth
npx tsx src/cli.ts source-truth verify-docs --source ./src --docs ./docs --output-dir ./reports/source-verification
npx tsx src/cli.ts agent context --json
npx tsx src/cli.ts generate --source ./docs --format markdown --output-dir ./agent-docs
npx tsx src/cli.ts generate --source ./docs --format markdown --chunks jsonl --output-dir ./agent-docs
npx tsx src/cli.ts generate --source ./TSPL.docc --preset swift-book --output-dir ./swift-book-agent-docs
npx tsx src/cli.ts list-sdks
npx tsx src/cli.ts generate --sdk swift --sdk-version v2 --output-dir ./output
npx tsx src/cli.ts verify --output-dir ./output/swift/v2
npx tsx src/cli.ts refresh --output-dir ./agent-docs
npx tsx src/cli.ts refresh --manifest ./reports/source-truth/manifest.json
npx tsx src/cli.ts validate --sdk swift --version v2
npx tsx src/cli.ts agent doctor --json
```

The current `discover --source` command performs local, explicit, bounded file
inspection for a provided file or directory. It writes `discovery-report.json`
and a discovery-report `manifest.json` with candidate file hints, deterministic
evidence categories and signals, report order, hashes, traversal settings, and
warnings. The manifest also records a compact content-free
`candidateEvidenceIndex` derived from `discovery-report.json`.

The current `discover --repo` command clones or reuses an explicit git repo in
a stable cache, optionally inspects one repo-relative scope path, and writes a
repo discovery report and discovery-report `manifest.json` with cache path,
commit, dirty state, traversal settings, candidates, and warnings. For clean
matching caches it fetches remote refs but does not pull or mutate the
checked-out commit, and it does not run repo scripts. Ignored local files in the
cache are treated as dirty cache contents, so fetches are skipped before any
update step can risk those files. The manifest also records a compact
content-free `candidateEvidenceIndex` derived from `discovery-report.json`.

The current `discover --url` command performs bounded static inspection for one
explicit HTTP(S) URL. It fetches only the explicit URL, same-origin root
`/llms.txt`, and same-origin root `/sitemap.xml`; it does not render JavaScript
or fetch linked candidates. It writes a website discovery report with inspected
resources, response status/content type/byte counts, explicit observed HTTP
freshness evidence (`ETag`, `Last-Modified`) when returned, crawl policy,
extracted candidate URLs, evidence/provenance, warnings, and a discovery-report
`manifest.json` with a compact content-free `candidateEvidenceIndex` derived
from `discovery-report.json`.

The current `capabilities --json` command prints a deterministic
machine-readable contract for agents. The contract includes schema version
`0.1.0`, package name/version metadata, product-boundary metadata, implemented
commands, source-truth fact-family scope and limitations, planned/unsupported
capabilities, and stable output file names where they exist. It intentionally
omits `generatedAt` and does not inspect sources, load config, write files, or
perform network work.

New successful `configured-sdk`, `local-source-docs`,
`source-truth-local-docs`, `discovery-report`, and
`source-verification-local-evidence` manifests include a top-level
`manifestContract` block. It is descriptive validation metadata for the
deterministic CLI/agent boundary only; it does not score candidates, prove
authority, prove source truth, validate freshness, or select sources.

New successful manifests for those same modes also include a top-level
`inputProvenance` block. It is deterministic content-free summary metadata for
explicit inputs, report provenance, configured SDK/version metadata, and parser
or formatter identifiers already represented elsewhere in the manifest. It
does not add raw content, new source paths, candidate selection, scores,
ranking, authority, task-fit, freshness proof, or source-truth proof.

New successful manifests for those same modes also include a top-level
`artifactSummary` block. It is deterministic content-free manifest metadata:
generated-output counts, kinds, byte/line/token totals where present,
aggregate hashes over existing manifest file metadata, warning counts,
source-file totals where already represented, and compact index counters. It
does not include raw content, excerpts, new paths, scores, ranking, authority,
task-fit, freshness proof, source-truth proof, or source-selection judgment.
V2 is a fresh manifest/docs-pack contract: regenerate V1 or early next-gen
packs with the V2 CLI before verifying them. `verify` requires and validates
`manifestContract`, `inputProvenance`, and `artifactSummary` for supported
successful manifests, requires `candidateEvidenceIndex` on discovery-report
manifests, and requires `sourceVerification.fileEvidenceIndex` on
source-verification manifests.

The current `agent context` command prints read-only metadata for packaged
agent context and skill artifacts. The JSON form reports schema version
`0.2.0`, package name/version metadata, the `llm-docs` binary,
`AGENT_CONTEXT.md`, `index.md`, `skills/llm-docs-generator/SKILL.md`, and
`skills/repo-docs-discovery/SKILL.md` package-relative paths, byte sizes,
SHA-256 hashes, intended uses, and explicit limitations. It reports packaged
metadata only and does not install or register skills, write user config, probe
the environment, or perform network work.

The current `agent doctor` command prints read-only packaging and environment
diagnostics. The JSON form reports schema version `0.1.0`, package
name/version metadata, the `llm-docs` binary, summary counts, packaged context
and skill artifact hash checks, the expected binary name, an informational PATH
check for `llm-docs`, and a skipped/not-configured Codex skill-installation
check. Missing `llm-docs` on PATH is a warning, not a hard failure. The command
does not install/register skills, write user config, mutate host skill
directories, run network requests, or infer source truth or task fit. `agent
install codex` remains planned/unsupported and is reported that way through
`capabilities --json`.

The current `plugins validate --manifest <path>` command validates explicit
local parser plugin JSON manifests and prints human output or deterministic
JSON with `--json`. Manifest schema `0.1.0` requires root
`schemaVersion: "0.1.0"`, `kind: "parser-plugin"`, non-empty `name`,
non-empty `version`, a relative local `module` path with no URL-like,
absolute, empty-segment, or `..` traversal form, and a non-empty `formats`
array. Format objects may contain only `id`, `displayName`, `extensions`,
optional `mediaTypes`, and optional `directorySupport`; duplicate format ids,
duplicate extensions anywhere in the manifest, and unsupported keys are
rejected. The command does not load, import, execute, or trust plugin code.

The current explicit parser-plugin generate path (`generate --source` with
`--parser-plugin-manifest` and explicit custom `--format`) executes one
selected local parser plugin module for one explicit local source file or
directory. Directory sources require `directorySupport: true` on the selected
manifest format. The requested custom format id must be declared by the
manifest and must not be `auto` or a built-in source format. Plugin code is
trusted local code and is not sandboxed. The generated source-docs manifest
records parser plugin provenance under `parser.plugin`; parser-plugin
directory manifests record all non-symlink regular files in deterministic
`sourceFiles` metadata for provenance only; and `verify` checks recorded plugin
metadata against the plugin manifest contents and manifest file hash/byte size
without importing or executing plugin code. Plugin discovery, install, package
resolution, auto-selection, sandboxing, and broad custom parser workflows
remain planned/unsupported.

The current `source-truth inspect --source` command accepts one explicit local
file or directory and prints a deterministic JSON evidence report to stdout. It
uses bounded traversal, skips common dependency/build directories, does not
follow symlinks, records hashes for inspected supported files, and extracts
conservative top-level TypeScript/JavaScript export facts plus `package.json`
and `tsconfig*.json` package/config facts with normalized source paths and line
ranges. It also reports path-based test/example context facts for inspected
supported files whose normalized path or filename matches conservative test,
spec, example, demo, sample, or docs/examples signals. For files identified as
tests by that existing path/filename logic, it also reports AST-observed
`describe`, `it`, and `test` label facts for direct calls and `.only` / `.skip`
forms when the first argument is a string literal or no-substitution template
literal. Directly exported top-level declarations may include compact AST
signature evidence with bodies and initializer values omitted. Re-exports,
export-all declarations, and export assignments remain unresolved. It does not
parse assertions, serialize test bodies, execute tests, prove claims, infer
runtime behavior, infer framework identity, decide task fit, summarize
behavior, or select sources.

The current `source-truth generate --source --output-dir` command accepts one
explicit local file or directory, reuses the source-truth inspector, and writes
`source-truth-report.json`, `source-truth.md`, and `manifest.json`. The Markdown
contains observed export facts, package/config facts, and test/example context
facts, including observed test-case labels when present, grouped by normalized
source file. Test-case labels are local evidence only, not proof of behavior or
correctness, and test bodies are omitted. If no export, package/config, or
context facts are extractable, the command exits non-zero and writes
`failure.json` referencing the raw evidence report instead of Markdown. It
rejects output directories that are the source path or inside the source path.
The source-truth docs manifest records source file hashes, byte sizes,
content-free line counts, deterministic estimated token counts, and fact counts,
plus generated output hashes, byte sizes, line counts, and deterministic
estimated token counts.

The current `source-truth verify-docs --source --docs --output-dir` command
accepts explicit local source and docs file/directory paths only, reuses
`inspectSourceTruth` for source export facts, and extracts bounded Markdown/MDX
inline-code identifier evidence from the explicit local docs path. It writes
`source-verification-report.json` and a `manifest.json` with compact
content-free source/docs file evidence index metadata derived from the local
report on success, or `failure.json` plus the evidence report when no supported
docs files or no inline-code identifier references are found. Exact matches are
lexical matches against observed exported names; unmatched references are
observations for agent review, not correctness failures. It does not fetch
network resources, render JavaScript, select sources, infer routes, frameworks,
or runtime behavior, or perform broad official-docs behavior/API claim
verification.

The current `generate --source <local-file-or-directory>` command supports
explicit local source docs generation only. It rejects URL-like inputs, missing
paths, discovery reports, `--source` plus `--sdk`, unknown presets, and presets
without `--source`. Its `--format` option is a parser hint supporting `auto`,
`markdown`, `mdx` through the Markdown parser, `openapi`, `openref`, `rst`, and
`html`.
Successful source generation writes `manifest.json` at the requested output
root and generated LLM docs under `llm-docs/`. When `--chunks jsonl` is
requested, it also writes `chunks/semantic-chunks.jsonl` from the parsed DocNode
tree and a compact `semanticChunkIndexes` manifest entry derived from the JSONL
records without embedding chunk content. The source manifest records the
input path, resolved source type, format hint and resolved format, parser and
formatter metadata, source file paths, formats, hashes, byte sizes, line
counts, deterministic estimated token counts, directory aggregate hash when
applicable, generated output hashes, byte sizes, line counts, deterministic
estimated token counts, output kind/name metadata, per-chunk index facts for
opt-in chunk JSONL, and warnings.

`--preset swift-book` is implemented only as deterministic defaults for
explicit local Markdown/DocC-style sources. It sets Markdown generation,
`swift-book` output naming, the Swift Programming Language title, neutral
source-derived system prompt, and non-authoritative preset provenance
in `manifest.json`. It does not infer or append `TSPL.docc`, clone or cache
repos, select sources, verify source truth, claim completeness, or perform
source-code verification. Additional preset names remain planned/unsupported.

The current `refresh --manifest <path>` / `refresh --output-dir <dir>` command
supports current built-in-parser `local-source-docs`,
`source-truth-local-docs`, configured OpenRef SDK manifests with recorded
absolute local `source.resolvedSpecPath` values, `discovery-report` manifests
only when `discovery.kind` is `source`, and existing successful
`source-verification-local-evidence` manifests. Parser-plugin
`local-source-docs` manifests are not refreshed yet; rerun the explicit
parser-plugin generate command instead. Source-docs refresh reads the existing
manifest, uses only the recorded absolute local source path,
`source.formatHint`, preset metadata if present, and whether
`semantic-chunks-jsonl` was previously present, then regenerates through the
current source docs generator into the manifest directory, including refreshed
chunk index metadata.
Source-truth refresh reads the existing manifest, uses only the recorded
absolute local source path, and regenerates through the current source-truth
docs generator into the manifest directory, including current source-file
content-free line/token manifest metadata. Configured SDK refresh requires the
recorded spec path to be an absolute local, existing, non-symlink OpenRef spec
file outside the output directory; it reparses that exact path, rewrites
`parsed/<sdk>-<resolvedVersion>-spec.json`, regenerates legacy LLM docs, and
rewrites `manifest.json`, including current deterministic content-free source
spec line/token metadata. Local source discovery-report refresh reads
`discovery-report.json` from `manifest.discovery.reportPath`, validates the
local-bounded source report, uses only `report.source.resolvedPath`, preserves
`traversal.maxDepth`, `traversal.maxEntries`, and `traversal.maxFiles`, reruns
`discover --source` behavior into the same output directory, and rewrites
`discovery-report.json` plus `manifest.json` as candidate evidence for agent
review. Source-verification local evidence refresh reads the existing
`source-verification-report.json` named by
`manifest.sourceVerification.reportPath` only after relative forward-slash path
containment and symlink-safe file checks, validates report schema/mode plus
explicit local `source.resolvedPath`, `docs.resolvedPath`, and docs traversal
bounds, preserves `docs.traversal.maxDepth`, `maxEntries`, `maxFiles`, and
`maxFileBytes`, reruns the same narrow local source/docs lexical evidence
workflow into the same output directory, and rewrites
`source-verification-report.json` plus `manifest.json` on success. If refreshed
docs no longer contain supported local evidence, it writes `failure.json` plus
the report and does not leave a stale success manifest. After successful
regeneration, refresh runs the existing manifest verifier over the newly
written manifest outputs and reports the checked-file count. Successful
regeneration also records a top-level `refresh` provenance block with
`refreshedAt`, source manifest mode, static strategy, deterministic input
boundary, and limitations before post-refresh verification. This is
deterministic manifest/output integrity verification only; it
does not claim freshness, source truth, source-code behavior, or runtime
behavior. Refresh does not support repo/URL discovery-report refresh, remote
freshness refresh, broad crawling, source selection, source-code verification,
behavior validation, remote network work, registry lookup, candidate report
consumption, candidate auto-selection, parser-plugin source-docs refresh,
source project script execution, broad official-docs behavior/API claim
verification, or source-code behavior validation.

The current CLI exposes only narrow explicit-local source/docs lexical evidence
through `source-truth verify-docs`; broad official-docs behavior/API claim
verification remains planned/unsupported. It also writes `manifest.json` for
successful configured `generate --sdk` tasks and successful discovery tasks
with generated output or report hashes, byte sizes, line counts, and
deterministic estimated token counts. Current `verify` supports configured-SDK,
source-mode, source-truth docs, discovery-report, and source-verification
manifests.
Configured SDK verification checks source and output file hashes, byte sizes,
recorded generator/sdk/parser/formatter metadata, required V2 source spec
line/token metadata, and required generated output line/token metadata, and
rejects malformed metadata before file checks. Source-mode verification checks
local source path shape and existence, recorded source file hashes, byte sizes,
line counts, and deterministic
estimated token counts, generated output paths, hashes, byte sizes, line
counts, and deterministic estimated token counts. When
optional source-docs semantic chunk index metadata is present, it is rebuilt
from `chunks/semantic-chunks.jsonl` and compared with the manifest.
Source-truth docs verification checks conservative source-truth manifest shape,
source path existence/type, source file hashes, byte sizes, and required
content-free line/token metadata, generated output paths, hashes,
byte sizes, line counts, deterministic estimated token counts, symlink/path
containment, and count consistency with `source-truth-report.json` when
available. Discovery-report verification checks report file integrity and
basic schema/mode/kind/count consistency, and required V2 candidate evidence index
metadata against `discovery-report.json`, including URL resource observed HTTP
freshness evidence when present. Discovery reports are candidate evidence
reports for agent review. They do not generate docs, choose sources, assign
trust or authority labels, infer authority, validate freshness, refresh remote
resources, decide task fit, decide correctness, decide source intent, decide
whether a candidate satisfies the task, or claim source truth.
Source-verification manifest verification checks report file integrity and
deterministic report-path, source/docs provenance, summary metadata, report
body count, and `sourceInspection.source` consistency for
`source-verification-report.json`, plus required V2
`sourceVerification.fileEvidenceIndex` metadata: a compact content-free
source/docs file evidence index rebuilt from that report. For supported
successful manifests, required top-level `manifestContract`, `inputProvenance`,
and `artifactSummary` metadata is validated against existing manifest arrays and
metadata, and top-level `refresh` provenance is validated for timestamp, mode,
strategy, input boundary, limitations, and unsupported keys; these checks do
not refresh outputs or sources, inspect additional
source/docs files, perform broad official-docs claim checking, validate
source-code behavior, decide task fit/source truth/source selection, or prove
docs correctness.
Discovery candidates are ordered deterministically for agent review only.
Semantic chunking exists as a library API for existing DocNode IR and as an
opt-in JSONL export for explicit `generate --source` outputs. It emits stable
semantic chunk records with path-derived IDs, order, source metadata, hashes,
sizes, token estimates, split metadata, and warnings. Discovery reports,
configured SDK generation, source-truth docs, and source-selection workflows do
not publish semantic chunks. New source-docs manifests with opt-in chunk JSONL
also record compact semantic chunk indexes for the JSONL artifact. Source-docs
refresh preserves semantic chunk JSONL and regenerates that index metadata only
when the existing manifest recorded the `semantic-chunks-jsonl` output.

The current CLI is implemented in:

- [src/cli.ts](src/cli.ts)

Package metadata:

- [package.json](package.json)

## Source Map

Core model and formatting:

- [src/core/models.ts](src/core/models.ts)
- [src/core/chunker.ts](src/core/chunker.ts)
- [src/core/formatter.ts](src/core/formatter.ts)
- [src/core/universal-formatter.ts](src/core/universal-formatter.ts)
- [src/core/manifest.ts](src/core/manifest.ts)
- [src/core/refresh.ts](src/core/refresh.ts)
- [src/core/detector.ts](src/core/detector.ts)
- [src/core/website-discovery.ts](src/core/website-discovery.ts)
- [src/core/source-truth.ts](src/core/source-truth.ts)

Parsers:

- [src/parsers/base.ts](src/parsers/base.ts)
- [src/parsers/openref/index.ts](src/parsers/openref/index.ts)
- [src/parsers/openref/parser.ts](src/parsers/openref/parser.ts)
- [src/parsers/openref/adapter.ts](src/parsers/openref/adapter.ts)
- [src/parsers/openapi/index.ts](src/parsers/openapi/index.ts)
- [src/parsers/markdown/index.ts](src/parsers/markdown/index.ts)
- [src/parsers/markdown/parser.ts](src/parsers/markdown/parser.ts)
- [src/parsers/markdown/adapter.ts](src/parsers/markdown/adapter.ts)
- [src/parsers/rst/index.ts](src/parsers/rst/index.ts)
- [src/parsers/rst/parser.ts](src/parsers/rst/parser.ts)
- [src/parsers/rst/adapter.ts](src/parsers/rst/adapter.ts)
- [src/parsers/html/index.ts](src/parsers/html/index.ts)
- [src/parsers/html/parser.ts](src/parsers/html/parser.ts)
- [src/parsers/html/adapter.ts](src/parsers/html/adapter.ts)

Configuration and source hints:

- [config/sdks.json](config/sdks.json)
- [config/categories.json](config/categories.json)
- [config/known-sources.json](config/known-sources.json) - compatibility path for non-authoritative source hints
- [config/presets/swift-book.json](config/presets/swift-book.json)

Utilities:

- [src/config/loader.ts](src/config/loader.ts)
- [src/config/schemas.ts](src/config/schemas.ts)
- [src/utils/fetcher.ts](src/utils/fetcher.ts)
- [src/utils/logger.ts](src/utils/logger.ts)

Tests:

- [tests/unit/models.test.ts](tests/unit/models.test.ts)
- [tests/unit/cli.test.ts](tests/unit/cli.test.ts)

## Planning And Design Files

- [NEXT_GEN_PLAN.html](NEXT_GEN_PLAN.html): visual next-generation product and
  architecture plan.
- [AGENT_CONTEXT.md](AGENT_CONTEXT.md): operational instructions for AI agents.
- [IMPLEMENTATION.md](IMPLEMENTATION.md): current implementation notes.
- [CODEBASE_TO_YAML_DESIGN.md](CODEBASE_TO_YAML_DESIGN.md): future
  source-truth codebase docs idea, if present in the worktree.
- [SWIFT-6.2-GUIDE.md](SWIFT-6.2-GUIDE.md): Swift 6.2 generation notes, if
  present in the worktree.

## Next-Generation Concepts

The project should evolve toward these modules:

```text
agent intent/source/scope resolution
  -> CLI input normalizer
  -> bounded source inspection
  -> repo explorer / cache manager
  -> candidate evidence report writer
  -> docs parser
  -> source-truth codebase docs generator, when explicitly requested
  -> LLM formatter
  -> manifest writer
  -> verifier / refresher
```

## Version And Freshness Rules

- Always distinguish latest from pinned.
- If the user pins a version, branch, tag, commit, or major version, do not
  silently upgrade.
- If the user asks for latest, verify remote state before reusing a cached clone.
- Successful configured SDK generation currently writes a scoped manifest with
  generator/sdk/parser/formatter metadata, source and output hashes, byte
  sizes, line counts, and deterministic estimated token counts for generated
  outputs. Current `verify` checks configured SDK manifest metadata, file
  hashes, byte sizes, required V2 source spec line/token metadata, and required
  generated output line/token metadata, while rejecting malformed metadata
  before file checks. It also
  verifies `local-source-docs` manifests by checking recorded
  generator/parser/formatter
  metadata, local source path shape and existence, source file hashes, byte
  sizes, line counts, deterministic estimated token counts, generated output
  paths, hashes, byte sizes, line counts, deterministic estimated token counts,
  optional parser plugin metadata
  against recorded plugin manifest contents and manifest hash/byte size, and
  optional semantic chunk indexes when present. It parses plugin manifests as
  data and does not import or execute parser plugin modules. It verifies
  `source-truth-local-docs` manifests with deterministic integrity/schema
  checks over source files, generated outputs, inspection shape, and raw report
  count consistency. It also verifies discovery-report manifests by checking
  `discovery-report.json` existence, hashes, byte sizes, line counts,
  deterministic estimated token counts, basic report schema/mode/kind/count
  consistency, and required V2 `candidateEvidenceIndex` metadata rebuilt from
  that report. These checks do not decide authority, task fit, source truth,
  freshness validation, or source selection. Local source docs generation is
  available through `generate --source <local-file-or-directory> --output-dir <dir>` for explicit
  local Markdown/MDX, OpenAPI, OpenRef, RST, and static HTML inputs, with
  optional `--chunks jsonl` semantic chunk JSONL publication and source-docs
  chunk index metadata. Local bounded inspection reports are available through
  `discover --source`, and
  repo cache/inspection reports are available through `discover --repo`.
  Bounded explicit URL inspection reports are available through `discover
--url`; the implemented command surface is available through deterministic
  `capabilities --json`; bounded local TypeScript/JavaScript export, optional
  AST signature, package/config, path-based test/example context evidence, and
  observed test-case label reports are available through `source-truth inspect --source`, and
  evidence-bound Markdown is available through `source-truth generate --source
--output-dir`. Narrow explicit-local source/docs reference evidence is
  available through `source-truth verify-docs --source --docs --output-dir`.
  Explicit local manifest refresh for current built-in-parser
  `local-source-docs`, `source-truth-local-docs`, configured OpenRef SDK
  manifests with recorded absolute local source paths, local source
  `discovery-report` manifests, and `source-verification-local-evidence`
  manifests is available through
  `refresh --manifest <path>` or `refresh --output-dir <dir>`, with
  deterministic post-refresh manifest/output integrity verification and
  verified refresh provenance metadata.
  Parser-plugin `local-source-docs` refresh, broader crawling,
  repo/URL discovery-report refresh, remote freshness refresh, broad
  official-docs behavior/API claim verification, source-code verification, and
  behavior-level source documentation remain planned.
- Every generated output should eventually include full manifest provenance:
  - source URL or path
  - repo URL
  - branch, tag, or commit
  - dirty state
  - source-code verification coverage, when requested
  - conflicts between official docs and implementation
  - content hash
  - parser and formatter
  - generated files
  - warnings
- Broad parser plugin workflows remain future work. The current CLI implements
  explicit local parser plugin generation only for one source file or a
  directory whose selected manifest format declares `directorySupport: true`,
  from one selected manifest and custom format id. Plugin discovery, install,
  package resolution, auto-selection, sandboxing, and broad custom parser
  workflows remain future work.

## Agent Crawl Order

When an AI agent enters this repo, use this order:

1. Read this [index.md](index.md).
2. Read [AGENT_CONTEXT.md](AGENT_CONTEXT.md).
3. Read [README.md](README.md) for current usage.
4. Read [NEXT_GEN_PLAN.html](NEXT_GEN_PLAN.html) for product direction if the
   task is about architecture or future work.
5. Inspect source files only after intent is clear.

Do not assume that every planned next-generation capability is already
implemented. Verify in source before promising behavior.
