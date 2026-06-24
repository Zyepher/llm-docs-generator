# llm-docs-generator

`llm-docs-generator` builds local, agent-ready documentation packs from explicit
documentation sources, repositories, websites, and existing manifests.

The AI agent is the intelligent planner. It investigates the user's request,
resolves intent, source, scope, version, and path, and decides which workflow to
run. The `llm-docs` CLI is the deterministic capability layer: it inspects
explicit sources, normalizes documentation, preserves structure, writes
provenance, validates output, and reports honest failures.

## What It Produces

A generated docs pack is local, structured, version-aware, and inspectable:

```text
tailwindcss-v3-agent-docs/
  index.md
  full.md
  categories/
    configuration.md
    utilities.md
    responsive-design.md
  manifest.json
  discovery-report.json
  source/
    selected-source.ref.json
    candidate-summary.json
```

The Markdown files are for the AI agent to read. The JSON files are for trust:
they record source URLs or paths, repo commits, tags, content hashes, parser and
formatter versions, freshness checks, warnings, generated files, and any
source-code verification coverage.

## Core Workflow

Humans prompt their AI agent naturally:

```text
Generate agent-optimized docs for Tailwind CSS. Stay on Tailwind 3.
```

The agent resolves the source and scope, then calls deterministic CLI commands:

```bash
llm-docs discover --repo https://github.com/tailwindlabs/tailwindcss --version 3 --output-dir ./reports/tailwind-v3
llm-docs generate --source ./reports/tailwind-v3/discovery-report.json --output-dir ./tailwindcss-v3-agent-docs
llm-docs verify --manifest ./tailwindcss-v3-agent-docs/manifest.json
```

The CLI never silently decides that a source is authoritative. Discovery and
scoring produce inspectable reports for the agent to review. Generation uses an
explicit source, explicit candidate, or explicit manifest.

## Capabilities

`llm-docs` supports the full next-generation docs-pack workflow:

- deterministic inspection of explicit local paths, repository URLs, docs URLs,
  and prior manifests
- external repo caching under a stable cache directory instead of the active
  workspace
- bounded website inspection from provided URLs, including `llms.txt`,
  `sitemap.xml`, canonical links, source links, and allowed crawl scope
- candidate reports with first-party evidence, structure, relevance, freshness,
  parseability, warnings, and skipped paths
- parsers for OpenRef, OpenAPI/Swagger, Markdown, MDX, RST, DocC, and HTML
  fallback extraction
- agent-optimized Markdown output with stable section IDs and semantic chunks
- manifests with source provenance, content hashes, generated file hashes,
  parser/formatter metadata, freshness state, and warnings
- refresh and verify workflows for existing generated docs
- optional source-code verification when the agent requests it and the matching
  implementation source is available
- explicit source-truth codebase docs generation when the user asks to document
  implementation behavior rather than existing docs
- bundled agent context and host setup helpers so AI agents can discover the
  installed CLI from other workspaces

## Command Model

Use `llm-docs capabilities --json` when an agent needs the implemented command
surface in machine-readable form.

Common commands:

```bash
llm-docs capabilities --json

llm-docs discover --source ./docs --output-dir ./reports/local-docs
llm-docs discover --repo https://github.com/supabase/supabase --scope apps/docs --output-dir ./reports/supabase
llm-docs discover --url https://supabase.com/docs/reference/swift --scope same-origin --output-dir ./reports/supabase-swift

llm-docs generate --source ./docs --format markdown --output-dir ./agent-docs
llm-docs generate --source ./openapi.yaml --format openapi --output-dir ./api-agent-docs
llm-docs generate --source ./reports/supabase/discovery-report.json --candidate apps/docs/spec/supabase_swift_v2.yml --output-dir ./supabase-swift-docs

llm-docs verify --manifest ./supabase-swift-docs/manifest.json
llm-docs refresh --manifest ./supabase-swift-docs/manifest.json
llm-docs diff --manifest ./supabase-swift-docs/manifest.json --since previous

llm-docs agent context
llm-docs agent install codex
llm-docs agent doctor
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
- writing Markdown packs, indexes, manifests, discovery reports, source refs,
  freshness metadata, and failure reports
- verifying generated outputs against recorded hashes, commits, and source
  metadata
- failing clearly when a requested source, format, parser, permission, or mode
  cannot be used

## Source Priority

When several explicit candidates exist, the agent should prefer:

1. First-party machine-readable specs: OpenAPI, Swagger, OpenRef.
2. First-party docs source: Markdown, MDX, RST, DocC.
3. First-party `llms.txt` and linked Markdown.
4. First-party rendered docs pages via sitemap or canonical URLs.
5. Implementation source files only when the user asks for source-truth
   codebase docs or source-code verification.

The CLI records evidence; the agent owns the final source-selection judgment.

## Freshness And Verification

Every generated pack can be checked later:

```bash
llm-docs verify --manifest ./docs-pack/manifest.json
llm-docs refresh --manifest ./docs-pack/manifest.json
```

Verification checks manifest shape, source identity, source path existence,
content hashes, repo commit or tag, generated file hashes, parser compatibility,
and recorded warnings. Refresh preserves pinned versions and only updates when
the explicit source has changed or the agent chooses a new source.

## Source-Truth Codebase Docs

When a user asks to document implementation behavior, the agent can choose the
source-truth codebase docs workflow. In that mode, `llm-docs` analyzes the
selected source files, public exports, routes, config, tests, examples, and
behavior constraints, then writes docs with file-level provenance.

This mode is explicit. It is not used just because a repository has source code.
If existing official docs and implementation facts disagree, generated output
preserves the official-doc context, cites the conflicting implementation files,
and marks the conflict in the manifest.

## Failure Reports

Failed discovery or generation still writes useful artifacts when an output
directory is provided:

```text
output/
  discovery-report.json
  failure.json
```

Failures explain what was checked, what was skipped, which permissions or
formats were missing, and what the agent can try next. The tool does not invent
low-confidence documentation to make a run appear successful.

## Agent Setup

Install the CLI where your AI agent can run shell commands:

```bash
npm install -g llm-docs-generator
```

Install bundled agent context for a supported host:

```bash
llm-docs agent install codex
llm-docs agent doctor
```

`agent doctor` checks that the binary is on `PATH`, bundled skills are
available, host skill installation is writable, and installed skill versions
match the CLI.

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
