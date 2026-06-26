# llm-docs-generator

`llm-docs-generator` builds local, agent-ready documentation packs from
explicit local documentation sources.

The AI agent is the intelligent planner. It investigates the user's request,
resolves intent, source, scope, version, and path, and decides which workflow to
run. The `llm-docs` CLI is the deterministic capability layer: it inspects
explicit inputs, parses supported local source files, preserves structure,
writes provenance, and reports honest failures.

## What It Produces

A generated docs pack is local, structured, version-aware, and inspectable:

```text
agent-docs/
  manifest.json
  llm-docs/
    docs-full-llms.txt
    docs-api-llms.txt
  chunks/
    semantic-chunks.jsonl  # only when --chunks jsonl is requested
```

The Markdown files are for the AI agent to read. The JSON and JSONL files are
for trust: they record source paths, source file formats, content hashes,
parser and formatter versions, warnings, generated files, and compact source-docs
semantic chunk indexes when JSONL chunks are requested.

## Core Workflow

Humans prompt their AI agent naturally:

```text
Generate agent-optimized docs for Tailwind CSS. Stay on Tailwind 3.
```

The agent resolves the source and scope, then calls deterministic CLI commands:

```bash
llm-docs discover --source <explicit-tailwind-v3-docs-path> --output-dir ./reports/tailwind-v3
llm-docs generate --source <explicit-tailwind-v3-docs-path> --format markdown --output-dir ./agent-docs/tailwind-v3
```

The CLI never silently decides that a source is authoritative. Discovery
produces candidate evidence reports for the agent to review. Generation uses an
explicit local file or directory selected by the agent.

Common input patterns:

- Repo URL: the agent chooses repo-docs versus source-truth intent, version/ref,
  and repo-relative scope, then calls
  `llm-docs discover --repo <url> --scope <scope>` before generating from a
  selected explicit local path.
- Docs URL: the agent calls `llm-docs discover --url <url>` for bounded
  evidence. Current generation still needs an explicit local source path; the
  CLI does not generate directly from a remote URL or discovery report.
- Package or product name: the agent resolves official package/product
  identity, docs/repo URL, version, and scope before the CLI is called. The CLI
  does not decide package authority, source truth, or task fit.
- Local path: the agent verifies the path, optionally runs `discover --source`,
  then runs `generate --source <path>` when that path remains selected.

## Capabilities

Current implemented capabilities include:

- deterministic inspection of explicit local paths, repository URLs, docs URLs,
  and packaged agent context
- external repo caching under a stable cache directory instead of the active
  workspace
- bounded website inspection from provided URLs, the same-origin `/llms.txt`,
  and the same-origin `/sitemap.xml`
- candidate evidence reports with deterministic evidence, warnings, skipped paths,
  discovery report integrity manifests, and compact content-free candidate
  evidence indexes
- parsers for OpenRef, OpenAPI/Swagger, Markdown, MDX, RST, DocC, and HTML
  fallback extraction from explicit local sources
- agent-optimized Markdown output for explicit local source generation
- a scoped `swift-book` preset that adds deterministic Markdown output
  defaults only when the agent or user supplies the exact local source path
- opt-in semantic chunk JSONL output for explicit local source generation
- manifests with source or discovery provenance, content hashes, generated file
  hashes, parser/formatter metadata, and warnings
- configured OpenRef SDK generation plus configured-SDK, source-docs,
  source-truth docs, discovery-report, and source-verification manifest
  verification, including recorded generator/sdk/parser/formatter metadata
  checks for configured-SDK manifests and recorded generator/parser/formatter
  metadata checks for local source-docs manifests
- explicit-manifest refresh for built-in-parser local source docs and
  source-truth docs that already record a local source path, with post-refresh
  manifest integrity verification
- conservative source-truth evidence inspection and evidence Markdown for local
  TypeScript/JavaScript/package/config files
- narrow explicit-local source/docs evidence reports that compare Markdown/MDX
  inline-code references against observed local source exported names
- read-only bundled agent context metadata
- read-only `agent doctor` diagnostics for packaged artifact hashes, expected
  binary metadata, PATH visibility, and skipped/not-configured host checks
- read-only parser plugin manifest validation for explicit local JSON manifests
  without loading, importing, or executing plugin modules
- explicit single-file parser plugin generation from one local source file,
  one local parser plugin manifest, and one custom explicit format id, with
  trusted local plugin execution and parser provenance in the source-docs
  manifest

Planned capabilities such as configured SDK refresh, discovery report refresh,
remote freshness checks, diff, host install helpers, broad crawling, documented
automation-flag candidate handling, broad official-docs behavior/API claim
verification, additional presets, parser plugin discovery/install/package
resolution, parser plugin auto-selection, directory plugin generation,
sandboxing, and broad custom parser workflows are not implemented in the
current CLI.

## Command Model

Use `llm-docs capabilities --json` when an agent needs the implemented command
surface in machine-readable form.

Common commands:

```bash
llm-docs capabilities --json

llm-docs discover --source ./docs --output-dir ./reports/local-docs
llm-docs discover --repo https://github.com/supabase/supabase --scope apps/docs --output-dir ./reports/supabase
llm-docs discover --url https://supabase.com/docs/reference/swift --output-dir ./reports/supabase-swift

llm-docs generate --source ./docs --format markdown --output-dir ./agent-docs
llm-docs generate --source ./docs --format markdown --chunks jsonl --output-dir ./agent-docs
llm-docs generate --source ./TSPL.docc --preset swift-book --output-dir ./swift-book-agent-docs
llm-docs generate --source ./openapi.yaml --format openapi --output-dir ./api-agent-docs
llm-docs generate --source ./guide.fixture --parser-plugin-manifest ./parser-plugin.json --format custom-doc --output-dir ./custom-agent-docs

llm-docs source-truth inspect --source ./src
llm-docs source-truth generate --source ./src --output-dir ./reports/source-truth
llm-docs source-truth verify-docs --source ./src --docs ./docs --output-dir ./reports/source-verification

llm-docs refresh --output-dir ./agent-docs
llm-docs refresh --manifest ./reports/source-truth/manifest.json

llm-docs plugins validate --manifest ./parser-plugin.json
llm-docs plugins validate --manifest ./parser-plugin.json --json

llm-docs agent context
llm-docs agent doctor
llm-docs agent doctor --json
```

Compatibility commands remain available for configured Supabase/OpenRef specs:

```bash
llm-docs list-sdks
llm-docs generate --sdk swift --sdk-version v2 --output-dir ./output
llm-docs verify --output-dir ./output/swift/v2
llm-docs validate --sdk swift --version v2
```

## Parser Plugin Manifests

`llm-docs plugins validate --manifest <path>` validates an explicit local JSON
manifest file only. The command is read-only: it does not load, import,
execute, or trust the declared plugin module.

`llm-docs generate --source <local-file> --parser-plugin-manifest <path>
--format <plugin-format-id>` is the only implemented parser plugin execution
path. It requires one explicit local source file, one explicit local manifest,
and one custom format id declared by the manifest. It rejects `--sdk`,
`--preset`, `--chunks`, `--format auto`, built-in formats, and directory source
inputs. The CLI validates the manifest, imports only the declared local module
file, executes trusted local plugin code without sandboxing, validates the
returned DocNode tree, formats through the existing universal formatter, and
writes parser plugin provenance under `parser.plugin` in `manifest.json`.

Manifest schema `0.1.0`:

- root object with only `schemaVersion`, `kind`, `name`, `version`, `module`,
  and `formats`
- `schemaVersion` exactly `0.1.0`
- `kind` exactly `parser-plugin`
- `name` and `version` as non-empty strings
- `module` as a non-empty relative local path string; URL-like paths, absolute
  paths, empty path segments, and `..` traversal segments are rejected
- `formats` as a non-empty array of format objects with only `id`,
  `displayName`, `extensions`, optional `mediaTypes`, and optional
  `directorySupport`
- each format `id` as a lowercase identifier matching `^[a-z][a-z0-9-]*$`
- each format `displayName` as a non-empty string
- each format `extensions` as a non-empty array of lowercase extension strings
  without a leading dot, matching `^[a-z0-9][a-z0-9-]*$`
- optional `mediaTypes` as an array of non-empty strings
- optional `directorySupport` as a boolean

Duplicate format ids, duplicate extensions anywhere in the manifest, and
unsupported root or format keys are rejected. Plugin discovery, installation,
package resolution, auto-selection, directory plugin generation, sandboxing,
and broad custom parser workflows remain planned/unsupported.

## Agent Boundary

The CLI is not a magical source-of-truth resolver. It does not make hidden
source-specific guesses or silently upgrade the user's version intent.

The agent is responsible for:

- interpreting natural-language user requests
- deciding whether the user wants official docs, local docs, repo docs,
  source-code verification, or source-truth codebase docs
- resolving ambiguous product names, packages, release lines, and candidate
  sources
- selecting a source or candidate from CLI reports
- asking the user when the choice materially changes the result

The CLI is responsible for:

- validating explicit inputs
- inspecting provided sources within explicit bounds
- parsing and normalizing supported formats
- preserving headings, examples, semantic structure, and stable IDs
- writing Markdown packs, manifests, discovery reports, provenance metadata,
  source-truth failure reports, and narrow local source/docs evidence reports
- verifying configured-SDK, source-docs, source-truth docs, and
  discovery-report/source-verification files against recorded metadata
- validating explicit local parser plugin manifests without loading plugin code
- executing one explicitly selected local parser plugin for one explicit local
  source file only when `generate --source --parser-plugin-manifest --format`
  is used, as trusted local code without sandboxing
- refreshing only existing built-in-parser `local-source-docs` and
  `source-truth-local-docs` manifests that already record explicit local source
  paths, then verifying the regenerated manifest outputs
- failing clearly when a requested source, format, parser, permission, or mode
  cannot be used

## Source Evidence For Agent Review

When several explicit candidates exist, the CLI records factual evidence and the
agent reviews source intent, version, project context, and task fit. Discovery
reports may list, group, filter, and deterministically order candidates only by
factual signals such as file type, path, metadata, source URL, hash, freshness
metadata when explicitly observed, parseability, and explicit user-provided
scope. A useful agent review order is:

1. First-party machine-readable specs: OpenAPI, Swagger, OpenRef.
2. First-party docs source: Markdown, MDX, RST, DocC.
3. First-party `llms.txt` and linked Markdown.
4. First-party rendered docs pages via sitemap or canonical URLs.
5. Implementation source files only when the user asks for source-truth
   codebase docs or source-code verification.

The CLI records evidence; the agent owns the final candidate-selection judgment.
If no candidate is authoritative for the user's task, the agent continues
manual investigation, uses another explicit source, or asks the user.

## Freshness And Verification

Configured SDK, local source docs, source-truth docs, and discovery-report
outputs can be checked later:

```bash
llm-docs verify --manifest ./output/swift/v2/manifest.json
llm-docs verify --output-dir ./agent-docs
llm-docs verify --output-dir ./reports/source-truth
llm-docs verify --output-dir ./reports/local-docs
llm-docs verify --output-dir ./reports/source-verification
llm-docs refresh --output-dir ./agent-docs
llm-docs refresh --manifest ./reports/source-truth/manifest.json
```

Verification currently supports `configured-sdk`, `local-source-docs`,
`source-truth-local-docs`, `discovery-report`, and
`source-verification-local-evidence` manifests. Configured SDK verification
checks recorded generator metadata, sdk name/resolvedVersion/displayName,
OpenRef parser metadata, legacy formatter metadata, source path existence,
source content hash and byte size, generated file hashes, byte sizes, and valid
generated output line counts and deterministic estimated token counts when
present. Source-docs verification checks recorded generator metadata, parser
name/version/format,
formatter name/version/format, local source path shape and existence, recorded
source file hashes and byte sizes, generated output paths, hashes, byte sizes,
line counts, deterministic estimated token counts, optional parser plugin
metadata against the recorded plugin manifest contents and manifest hash/byte
size when present, and optional semantic chunk indexes against
`chunks/semantic-chunks.jsonl` when present. Verification parses plugin
manifests as data and does not import or execute parser plugin modules.
Source-truth docs
verification checks the conservative source-truth manifest shape, source file
hashes and byte sizes, generated output hashes, byte sizes, line counts,
deterministic estimated token counts, symlink/path containment, and count
consistency with `source-truth-report.json` when available. Discovery-report
verification checks `discovery-report.json` existence, hash, byte size, line
count, estimated token count, basic report schema/mode/kind/count consistency,
and optional content-free candidate evidence index metadata against the report.
Source-verification manifest checks cover `source-verification-report.json`
existence, hash, byte size, line count, deterministic estimated token count,
report schema/mode/output path consistency, source/docs endpoint provenance
against the report, manifest summary consistency with report metadata, report
summary consistency with body arrays, and `sourceInspection.source`
consistency. These checks do not refresh outputs or sources, inspect
additional source/docs files, perform broad official-docs claim checking,
validate source-code behavior or runtime behavior, decide candidate authority,
task fit, source truth, or source selection, or prove that docs statements are
correct.

Refresh currently supports only existing built-in-parser `local-source-docs`
and `source-truth-local-docs` manifests. Parser-plugin `local-source-docs`
manifests are not refreshed yet; rerun the explicit parser-plugin generate
command instead. For source docs, refresh reads the manifest, uses the recorded
absolute local source path, `source.formatHint`, preset metadata if present,
and whether the prior manifest recorded `semantic-chunks-jsonl`, then
regenerates into the same output directory. For source-truth docs, it uses only
the recorded absolute local source path and regenerates into the same output
directory. After successful regeneration, refresh runs the existing manifest
verifier over the newly written manifest and reports the checked-file count.
This post-refresh check is deterministic manifest/output integrity verification
only; it does not claim freshness, source truth, source-code behavior, or
runtime behavior. Refresh does not support parser-plugin source-docs manifests,
configured SDK manifests, discovery-report manifests, URLs, repo freshness,
broad website crawling, source selection, source-code verification, behavior
validation, remote network work, or source project script execution.

When `generate --source` is run with `--chunks jsonl`, it also writes
`chunks/semantic-chunks.jsonl`. The source-docs manifest records that file as a
generated text output with kind `semantic-chunks-jsonl`, a bounded descriptive
name, hash, byte size, line count, deterministic estimated token count, and a
compact `semanticChunkIndexes` entry derived only from the JSONL records. The
index stores output path, format, chunk count, aggregate hash, per-chunk stable
IDs, order, titles, paths, node paths, content hashes, counts, source metadata, and
warning counts without embedding chunk content.

When `generate --source <path> --preset swift-book` is used, the preset sets
Markdown format defaults, `swift-book` output naming, the Swift Programming
Language title, neutral source-derived system prompt, and non-authoritative
preset provenance in the manifest. It does not infer `TSPL.docc`, select a
repository path, verify source truth, claim completeness, or decide that the
supplied path is the correct source.

## Source-Truth Codebase Docs

When a user asks to document implementation behavior, the agent can choose the
source-truth evidence workflow. In that mode, `llm-docs` extracts conservative
observed facts from selected local TypeScript/JavaScript source files,
`package.json`, and `tsconfig*.json`, then writes evidence docs with file-level
provenance. For files already identified as tests by conservative path or
filename signals, it can also report AST-observed `describe`, `it`, and `test`
labels as local evidence.

This mode is explicit. It is not used just because a repository has source code.
It does not infer runtime behavior, routes, framework identity, or source-code
verification confidence. Test-case labels are observed labels only, not proof
of behavior or correctness, and test bodies, assertions, expected values,
closures, and runtime-derived names are omitted.

## Local Source/Docs Evidence

When an agent already has both an explicit local docs path and an explicit
local implementation source path, it can run:

```bash
llm-docs source-truth verify-docs --source ./src --docs ./docs --output-dir ./reports/source-verification
```

This writes `source-verification-report.json` and `manifest.json`. The report
reuses the conservative `source-truth inspect` source facts and extracts only
Markdown/MDX inline-code identifier references from the explicit docs path.
Exact matches are lexical matches against observed exported names. Unmatched
references are reported as observations for agent review, not correctness
failures. This mode does not fetch network sources, render JavaScript, select
sources, verify broad official docs claims, infer routes/frameworks/runtime
behavior, or decide source authority.

## Failure Reports

Discovery and source-truth runs write useful artifacts when an output directory
is provided and the workflow has enough evidence to report:

```text
output/
  discovery-report.json  # successful discovery
  manifest.json          # successful discovery only
  failure.json           # supported failure modes
```

Discovery writes `discovery-report.json` and a discovery-report `manifest.json`
only when it can complete bounded inspection. Source-truth no-facts paths may
write `failure.json` plus an evidence report. Source/docs evidence paths with
no supported Markdown/MDX files or no inline-code identifier references write
`failure.json` plus `source-verification-report.json`. `generate --source`
failures report honestly on stderr and clean stale source-mode `manifest.json`
/ `llm-docs/` artifacts when present, but they do not currently write
`failure.json`.

Failures explain what was checked, what was skipped, which permissions or
formats were missing, and what the agent can try next. The tool does not invent
low-confidence documentation to make a run appear successful.

## Agent Setup

Use the CLI from this repository while product naming and distribution are
still being finalized:

```bash
npm install
npm run build
npx tsx src/cli.ts capabilities --json
```

Bundled agent context can be inspected with `llm-docs agent context` or
`llm-docs agent context --json`. Read-only packaging diagnostics can be run with
`llm-docs agent doctor` or `llm-docs agent doctor --json`; missing `llm-docs` on
`PATH` is reported as a warning in development. Host installation remains
planned and unsupported.

## For Contributors

Read these files before making changes:

- `NEXT_GEN_PLAN.html` for the completed product architecture
- `AGENT_CONTEXT.md` for the agent intent router and hard rules
- `index.md` for the repository crawl map
- `IMPLEMENTATION.md` for implementation notes

Useful development commands:

```bash
npm install
npm run type-check
npm test
npm run build
```

Good agent documentation is not just shorter documentation. It is structured,
refreshable, verified where requested, and honest about where every claim came
from.
