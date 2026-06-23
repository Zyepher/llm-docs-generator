# llm-docs-generator

`llm-docs-generator` is a tool for giving AI agents better documentation context.

Humans should not have to drive the CLI by hand. You tell your AI agent what
docs you need. The agent uses `llm-docs` to find the right sources, extract the
useful documentation, turn it into structured Markdown, and record where every
piece came from.

The result is a local documentation pack your agent can read repeatedly without
guessing, browsing from scratch, or trusting stale memory.

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

This project turns trusted documentation sources into that agent-ready format.

## What It Produces

A generated documentation pack looks like this:

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

The Markdown files are for the AI agent to read. The manifest is for trust. It
records the selected source, version, commit or content hash, generated files,
warnings, and confidence score.

If the source moves, changes, or becomes impossible to verify, the agent can
tell you instead of quietly using stale docs.

## How You Use It

You talk to your AI agent naturally and tell it to use `llm-docs`.

Examples:

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

The human interface is the prompt. The CLI is the tool your agent uses behind
the scenes.

## What the CLI Actually Does

`llm-docs` gives the AI agent a repeatable workflow.

It can:

- discover official docs, source repos, specs, sitemaps, `llms.txt`, and linked
  documentation sources
- crawl or extract the relevant documentation pages
- clone and cache repos when the source lives in GitHub
- choose between candidate sources with an explainable score
- preserve version intent, such as "Tailwind 3" instead of silently choosing
  Tailwind 4
- parse structured sources like OpenAPI, OpenRef, Markdown, MDX, RST, and DocC
- convert the selected source into agent-optimized Markdown
- split output by category while keeping a full combined file
- write manifests so generated docs can be verified or refreshed later
- generate source-truth codebase docs when the user explicitly asks for docs
  from code or asks to verify docs against implementation
- fact-check official docs against source code when the user asks for
  source-truth confidence

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

With this tool, the agent gets source material that is structured, local,
versioned, and refreshable.

## Why This Is More Than a Skill

A skill can tell an AI agent how to search.

`llm-docs-generator` gives the agent machinery:

- a CLI it can run
- a source discovery pipeline
- parsers and formatters
- repo caching
- version checks
- manifests
- stale-doc verification

The skill helps the agent decide what to do. The CLI does the work and writes
the artifact.

## Typical Use Cases

Use it when:

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

If your AI host supports skills, install the bundled agent instructions:

```bash
llm-docs agent install codex
llm-docs agent doctor
```

After that, prompts like "use `llm-docs` for this" should be enough for the
agent to route documentation tasks through the tool.

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
