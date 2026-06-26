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
parser and formatter versions, warnings, and generated files.

## Core Workflow

Humans prompt their AI agent naturally:

```text
Generate agent-optimized docs for Tailwind CSS. Stay on Tailwind 3.
```

The agent resolves the source and scope, then calls deterministic CLI commands:

```bash
llm-docs discover --source ./docs --output-dir ./reports/local-docs
llm-docs generate --source ./docs --format markdown --output-dir ./agent-docs
```

The CLI never silently decides that a source is authoritative. Discovery
produces candidate evidence reports for the agent to review. Generation uses an
explicit local file or directory selected by the agent.

## Capabilities

Current implemented capabilities include:

- deterministic inspection of explicit local paths, repository URLs, docs URLs,
  and packaged agent context
- external repo caching under a stable cache directory instead of the active
  workspace
- bounded website inspection from provided URLs, the same-origin `/llms.txt`,
  and the same-origin `/sitemap.xml`
- candidate reports with deterministic evidence, warnings, skipped paths, and
  discovery report integrity manifests
- parsers for OpenRef, OpenAPI/Swagger, Markdown, MDX, RST, DocC, and HTML
  fallback extraction from explicit local sources
- agent-optimized Markdown output for explicit local source generation
- a scoped `swift-book` preset that adds deterministic Markdown output
  defaults only when the agent or user supplies the exact local source path
- opt-in semantic chunk JSONL output for explicit local source generation
- manifests with source or discovery provenance, content hashes, generated file
  hashes, parser/formatter metadata, and warnings
- configured OpenRef SDK generation plus configured-SDK, source-docs,
  source-truth docs, and discovery-report manifest verification
- explicit-manifest refresh for local source docs and source-truth docs that
  already record a local source path
- conservative source-truth evidence inspection and evidence Markdown for local
  TypeScript/JavaScript/package/config files
- read-only bundled agent context metadata

Planned capabilities such as configured SDK refresh, discovery report refresh,
remote freshness checks, diff, host setup helpers, broad crawling, automatic
source selection, source-code verification, and additional presets are not
implemented in the current CLI.

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

llm-docs source-truth inspect --source ./src
llm-docs source-truth generate --source ./src --output-dir ./reports/source-truth

llm-docs refresh --output-dir ./agent-docs
llm-docs refresh --manifest ./reports/source-truth/manifest.json

llm-docs agent context
```

Compatibility commands remain available for configured Supabase/OpenRef specs:

```bash
llm-docs list-sdks
llm-docs generate --sdk swift --sdk-version v2 --output-dir ./output
llm-docs verify --output-dir ./output/swift/v2
llm-docs validate --sdk swift --version v2
```

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
  and source-truth failure reports
- verifying configured-SDK, source-docs, source-truth docs, and
  discovery-report files against recorded metadata
- refreshing only existing `local-source-docs` and `source-truth-local-docs`
  manifests that already record explicit local source paths
- failing clearly when a requested source, format, parser, permission, or mode
  cannot be used

## Source Evidence For Agent Review

When several explicit candidates exist, the CLI records factual evidence and the
agent reviews source intent, version, project context, and task fit. A useful
review order is:

1. First-party machine-readable specs: OpenAPI, Swagger, OpenRef.
2. First-party docs source: Markdown, MDX, RST, DocC.
3. First-party `llms.txt` and linked Markdown.
4. First-party rendered docs pages via sitemap or canonical URLs.
5. Implementation source files only when the user asks for source-truth
   codebase docs or source-code verification.

The CLI records evidence; the agent owns the final source-selection judgment.

## Freshness And Verification

Configured SDK, local source docs, source-truth docs, and discovery-report
outputs can be checked later:

```bash
llm-docs verify --manifest ./output/swift/v2/manifest.json
llm-docs verify --output-dir ./agent-docs
llm-docs verify --output-dir ./reports/source-truth
llm-docs verify --output-dir ./reports/local-docs
llm-docs refresh --output-dir ./agent-docs
llm-docs refresh --manifest ./reports/source-truth/manifest.json
```

Verification currently supports `configured-sdk`, `local-source-docs`,
`source-truth-local-docs`, and `discovery-report` manifests. Configured SDK
verification checks manifest shape, source path existence, source content hash
and byte size, and generated file hashes and byte sizes. Source-docs
verification checks local source path shape and existence, recorded source file
hashes and byte sizes, generated output paths, hashes, byte sizes, line counts,
and deterministic estimated token counts. Source-truth docs verification checks
the conservative source-truth manifest shape, source file hashes and byte
sizes, generated output hashes, byte sizes, line counts, deterministic
estimated token counts, symlink/path containment, and count consistency with
`source-truth-report.json` when available. Discovery-report verification checks
`discovery-report.json` existence, hash, byte size, line count, estimated token
count, and basic report schema/mode/kind/count consistency. It does not judge
candidate authority, task fit, source truth, freshness, source-code behavior, or
runtime behavior.

Refresh currently supports only existing `local-source-docs` and
`source-truth-local-docs` manifests. For source docs, it reads the manifest,
uses the recorded absolute local source path, `source.formatHint`, preset
metadata if present, and whether the prior manifest recorded
`semantic-chunks-jsonl`, then regenerates into the same output directory. For
source-truth docs, it uses only the recorded absolute local source path and
regenerates into the same output directory. Refresh does not support configured
SDK manifests, discovery-report manifests, URLs, repo freshness, broad website
crawling, source selection, source-code verification, behavior validation,
remote network work, or source project script execution.

When `generate --source` is run with `--chunks jsonl`, it also writes
`chunks/semantic-chunks.jsonl`. The source-docs manifest records that file as a
generated text output with kind `semantic-chunks-jsonl`, a bounded descriptive
name, hash, byte size, line count, and deterministic estimated token count.

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
provenance.

This mode is explicit. It is not used just because a repository has source code.
It does not infer runtime behavior, routes, framework identity, or source-code
verification confidence.

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
write `failure.json` plus an evidence report. `generate --source` failures
report honestly on stderr and clean stale source-mode `manifest.json` /
`llm-docs/` artifacts when present, but they do not currently write
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
`llm-docs agent context --json`. Host installation and doctor commands are
planned but not implemented.

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
