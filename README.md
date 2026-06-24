# llm-docs-generator

`llm-docs-generator` is a tool for giving AI agents better documentation context.

The current CLI is a compatibility implementation for configured Supabase
OpenRef specs. It can list configured SDKs, generate LLM-optimized text from
those configured specs, write a scoped generation manifest, and validate a
configured SDK/version pair. It can also verify the current configured SDK
manifest's recorded file hashes and byte sizes.

The next-generation roadmap is broader: humans should be able to tell an AI
agent what docs they need, and the agent should use `llm-docs` to find the right
sources, extract useful documentation, turn it into structured Markdown, and
record where every piece came from.

## The Problem

Official docs are written for humans in a browser.

They are often split across many pages, mixed with navigation UI, hidden behind
generated sites, duplicated across versions, and hard to cite back to a precise
source. They may be correct, but they are not shaped like stable working memory
for an AI agent.

An AI agent needs something different:

- clean Markdown files
- stable sections
- preserved code examples
- version-aware output
- source links and provenance
- a manifest that says what was generated from where
- a way to verify whether the docs are stale later

The current implementation covers the OpenRef conversion foundation and writes
a scoped manifest for successful configured SDK generation. The current
`verify` command checks only that manifest's configured source and generated
output files by hash and byte size. Discovery, refresh, repo provenance, and
source-code verification are planned next-generation capabilities, not current
CLI behavior.

## What It Produces

A target next-generation documentation pack should look like this:

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
```

The Markdown files are for the AI agent to read. The manifest is for trust. In
the target design, it records the selected source, version, commit or content
hash, generated files, warnings, and confidence score.

The current configured SDK generation path writes
`<output-dir>/<sdk>/<resolvedVersion>/manifest.json` with the configured source,
resolved spec path, source hash, parser and formatter metadata, and generated
file hashes. `llm-docs verify --manifest <path>` or
`llm-docs verify --output-dir <dir>` verifies those recorded hashes and sizes
for current `configured-sdk` manifests. Discovery reports, stale-source
verification, refresh, repo provenance, and source-code verification are not
implemented yet.

## How You Use It

Today, use the compatibility CLI directly for configured Supabase SDK specs:

```bash
llm-docs list-sdks
llm-docs generate --sdk swift --sdk-version v2 --output-dir ./output
llm-docs verify --output-dir ./output/swift/v2
llm-docs validate --sdk swift --version v2
```

The target agent workflow is prompt-driven: you talk to your AI agent naturally
and tell it to use `llm-docs`.

Target next-generation examples:

```text
Use `llm-docs` to generate agent-optimized docs for Tailwind CSS.
Stay on Tailwind 3.
```

```text
Use `llm-docs` to crawl the official Supabase Swift docs and create local
Markdown docs my agent can use.
```

```text
Use `llm-docs` to generate docs for https://github.com/supabase/supabase.
If the existing docs are incomplete, use the source code as truth and generate
or verify the missing sections with source-file provenance.
```

```text
Use `llm-docs` to convert the official Supabase Swift docs, but verify API
signatures and behavior against the source code.
```

```text
Use `llm-docs` to check whether the generated docs in ./docs/generated are stale.
Do not upgrade pinned versions.
```

```text
Use `llm-docs` to turn this local docs folder into an agent-readable docs pack:
./docs
```

The intended human interface is the prompt. The current CLI is the conversion
tool your agent can use for the implemented compatibility workflow.

## What the CLI Actually Does

`llm-docs` currently provides the repeatable compatibility workflow.

Current CLI capabilities:

- list configured SDKs from `config/sdks.json`
- generate LLM-optimized text from configured OpenRef YAML specs
- write `manifest.json` for each successful configured SDK/version generation
- verify current configured SDK manifests by recorded source/output hashes and
  byte sizes
- validate a configured OpenRef SDK/version pair
- preserve the existing Supabase/OpenRef command surface while the next-gen
  resolver is built

Current library/parser capabilities:

- parse OpenRef YAML into the legacy model and the shared DocNode model
- parse local Markdown / DocC-style files through the parser modules
- format parsed docs into LLM-friendly text

Planned next-generation capabilities:

- discover official docs, source repos, specs, sitemaps, `llms.txt`, and linked
  documentation sources
- crawl or extract relevant documentation pages
- clone and cache repos when the source lives in GitHub
- choose between candidate sources with an explainable score
- preserve version intent, such as "Tailwind 3" instead of silently choosing
  Tailwind 4
- parse additional structured sources such as OpenAPI, MDX, RST, and HTML
- convert selected sources into agent-optimized Markdown packs
- extend manifests to cover discovered sources, repo commits, refresh, and
  verification
- generate source-truth codebase docs only after that explicit mode exists
- fact-check official docs against source code only after source verification is
  implemented

The point is not to replace official docs. The point is to convert official docs
into a local, structured, verifiable form that an AI agent can use well.

## Why This Is Better Than Just Browsing

Browsing is temporary. A generated docs pack is durable.

Without this tool, an agent may:

- read the wrong version
- miss pages hidden behind navigation
- mix official docs with community posts
- forget where a claim came from
- repeat expensive discovery work
- keep using stale context

With the target next-generation implementation, the agent gets source material
that is structured, local, versioned, and refreshable.

## Why This Is More Than a Skill

A skill can tell an AI agent how to search.

`llm-docs-generator` gives the agent machinery that is being built in layers:

- implemented now: a CLI it can run for configured OpenRef specs
- implemented now: OpenRef and Markdown/DocC parser modules
- implemented now: LLM-oriented formatters
- implemented now: scoped manifests for successful configured SDK generation
- implemented now: hash and byte-size verification for current configured SDK
  manifests
- planned: a source discovery pipeline
- planned: repo caching
- planned: version/freshness checks beyond configured SDK versions
- planned: discovered-source and verification manifest expansion
- planned: stale-doc verification

The skill helps the agent decide what to do. For implemented workflows, the CLI
does the deterministic conversion work and writes the artifact.

## Typical Use Cases

Use the current CLI when:

- you need the configured Supabase/OpenRef compatibility workflow
- you want to list, generate, or validate configured SDK specs
- you are extending the parser/formatter foundation toward the next-gen plan

The target next-generation product is intended for:

- you want your agent to work from official docs, but in local Markdown
- you need docs pinned to a specific major version
- a repo has docs scattered across a monorepo
- you want to regenerate docs only when the source changed
- you need a manifest showing where generated docs came from
- you want official docs checked against implementation source code
- existing docs are incomplete and you want source-truth codebase docs

Do not use it as a generic summarizer. The goal is not to make docs shorter at
all costs. The goal is to preserve source facts and examples while removing the
browser-shaped noise that makes docs hard for agents to use.

## Agent Setup

Install the CLI where your AI agent can run shell commands:

```bash
npm install -g llm-docs-generator
```

Bundled agent setup commands are planned but not implemented yet:

```bash
llm-docs agent install codex
llm-docs agent doctor
```

Until those commands exist, prompts like "use `llm-docs` for this" require the
agent to read `AGENT_CONTEXT.md` and verify current CLI support before running
commands.

## For Contributors

The product architecture and edge cases are in `NEXT_GEN_PLAN.html`.

Agent-facing routing rules are in `AGENT_CONTEXT.md`.

The crawl map for humans and agents is in `index.md`.

Useful development commands:

```bash
npm install
npm run type-check
npm run test
npm run build
```

Good agent documentation is not just shorter documentation. It is verified,
structured, refreshable, and honest about where it came from.
