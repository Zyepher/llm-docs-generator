# llm-docs-generator Index

This is the navigation index for humans and AI agents working with this project.

Read this file first, then follow the links for the task you are doing.

## Project Summary

`llm-docs-generator` is a Node.js / TypeScript CLI and library for producing
LLM-friendly documentation from reliable source material.

The next-generation direction is to make the project an agent-aware system that
will be able to:

1. Find official documentation.
2. Convert local documentation.
3. Explore cloned repositories when needed.
4. Respect pinned versions.
5. Verify generated docs against source provenance.
6. Fact-check official docs against source code when requested and available.
7. Generate source-truth codebase docs only when a dedicated generator mode
   exists.

Important distribution note:

- Installing the CLI makes `llm-docs` available as a command.
- Installing or registering skills is a separate step unless a future installer
  command performs it for the user's AI host.
- Future commands such as `llm-docs agent install codex` and
  `llm-docs agent doctor` should make this explicit.

## Start Here By Role

### AI Agent

Read:

1. [AGENT_CONTEXT.md](AGENT_CONTEXT.md)
2. [NEXT_GEN_PLAN.html](NEXT_GEN_PLAN.html)
3. [README.md](README.md)

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

| User Intent | First File To Read | Workflow |
|---|---|---|
| Convert a known local docs path | [AGENT_CONTEXT.md](AGENT_CONTEXT.md) | Intent 2: locally provided documentation |
| Generate docs for official product docs | [AGENT_CONTEXT.md](AGENT_CONTEXT.md) | Intent 1: official documentation |
| Verify official docs against source code | [AGENT_CONTEXT.md](AGENT_CONTEXT.md) | Intent 1 plus source verification |
| Generate docs from a GitHub repo | [AGENT_CONTEXT.md](AGENT_CONTEXT.md) | Determine whether user means repo docs or source-truth codebase docs |
| Generate docs from source code | [AGENT_CONTEXT.md](AGENT_CONTEXT.md) | Intent 3: source-truth codebase docs |
| Refresh generated docs | [AGENT_CONTEXT.md](AGENT_CONTEXT.md) | Intent 4: refresh or verify |
| Implement new functionality | [IMPLEMENTATION.md](IMPLEMENTATION.md) | Intent 5: maintain or extend tool |

## Current CLI

Development commands:

```bash
npx tsx src/cli.ts list-sdks
npx tsx src/cli.ts generate --sdk swift --sdk-version v2 --output-dir ./output
npx tsx src/cli.ts validate --sdk swift --version v2
```

The current CLI does not yet expose target-driven discovery, `generate
--source`, manifests, refresh, repo caching, source verification, or
source-truth codebase docs generation. Markdown / DocC parsing exists in parser
modules but is not wired as a current CLI command.

The current CLI is implemented in:

- [src/cli.ts](src/cli.ts)

Package metadata:

- [package.json](package.json)

## Source Map

Core model and formatting:

- [src/core/models.ts](src/core/models.ts)
- [src/core/formatter.ts](src/core/formatter.ts)
- [src/core/universal-formatter.ts](src/core/universal-formatter.ts)
- [src/core/detector.ts](src/core/detector.ts)

Parsers:

- [src/parsers/base.ts](src/parsers/base.ts)
- [src/parsers/openref/index.ts](src/parsers/openref/index.ts)
- [src/parsers/openref/parser.ts](src/parsers/openref/parser.ts)
- [src/parsers/openref/adapter.ts](src/parsers/openref/adapter.ts)
- [src/parsers/markdown/index.ts](src/parsers/markdown/index.ts)
- [src/parsers/markdown/parser.ts](src/parsers/markdown/parser.ts)
- [src/parsers/markdown/adapter.ts](src/parsers/markdown/adapter.ts)

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
target resolver
  -> official docs discovery
  -> repo explorer / cache manager
  -> candidate scorer
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
- Every generated output should eventually include manifest provenance:
  - source URL or path
  - repo URL
  - branch, tag, or commit
  - dirty state
  - source-code verification coverage, when requested
  - conflicts between official docs and implementation
  - content hash
  - parser and formatter
  - generated files
  - warnings and confidence score

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
