# llm-docs-generator Index

This is the navigation index for humans and AI agents working with this project.

Read this file first, then follow the links for the task you are doing.

## Project Summary

`llm-docs-generator` is a Node.js / TypeScript CLI and library for producing
LLM-friendly documentation from reliable source material. The agent resolves
intent, source, scope, version, and path; the CLI performs deterministic,
bounded inspection and conversion over explicit inputs.

The next-generation direction is to make the project an agent-aware system that
will be able to:

1. Help agents inspect explicit official documentation candidates.
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
npx tsx src/cli.ts discover --source ./docs --output-dir ./reports/local-docs
npx tsx src/cli.ts discover --repo https://github.com/owner/repo --scope docs --output-dir ./reports/repo-docs
npx tsx src/cli.ts discover --url https://example.com/docs --output-dir ./reports/website
npx tsx src/cli.ts source-truth inspect --source ./src
npx tsx src/cli.ts source-truth generate --source ./src --output-dir ./reports/source-truth
npx tsx src/cli.ts list-sdks
npx tsx src/cli.ts generate --sdk swift --sdk-version v2 --output-dir ./output
npx tsx src/cli.ts verify --output-dir ./output/swift/v2
npx tsx src/cli.ts validate --sdk swift --version v2
```

The current `discover --source` command performs local, explicit, bounded file
inspection for a provided file or directory. It writes `discovery-report.json`
with candidate file hints, deterministic evidence categories and signals,
report order, hashes, traversal settings, and warnings.

The current `discover --repo` command clones or reuses an explicit git repo in
a stable cache, optionally inspects one repo-relative scope path, and writes a
repo discovery report with cache path, commit, dirty state, traversal settings,
candidates, and warnings. For clean matching caches it fetches remote refs but
does not pull or mutate the checked-out commit, and it does not run repo
scripts. Ignored local files in the cache are treated as dirty cache contents,
so fetches are skipped before any update step can risk those files.

The current `discover --url` command performs bounded static inspection for one
explicit HTTP(S) URL. It fetches only the explicit URL, same-origin root
`/llms.txt`, and same-origin root `/sitemap.xml`; it does not render JavaScript
or fetch linked candidates. It writes a website discovery report with inspected
resources, response status/content type/byte counts, crawl policy, extracted
candidate URLs, evidence/provenance, and warnings.

The current `source-truth inspect --source` command accepts one explicit local
file or directory and prints a deterministic JSON evidence report to stdout. It
uses bounded traversal, skips common dependency/build directories, does not
follow symlinks, records hashes for inspected supported files, and extracts
conservative top-level TypeScript/JavaScript export facts plus `package.json`
and `tsconfig*.json` package/config facts with normalized source paths and line
ranges. It does not verify claims, infer runtime behavior, infer framework
identity, decide task fit, summarize behavior, or select authoritative sources.

The current `source-truth generate --source --output-dir` command accepts one
explicit local file or directory, reuses the source-truth inspector, and writes
`source-truth-report.json`, `source-truth.md`, and `manifest.json`. The Markdown
contains observed export facts and package/config facts grouped by normalized
source file. If no export or package/config facts are extractable, the command
exits non-zero and writes `failure.json` referencing the raw evidence report
instead of Markdown. It rejects output directories that are the source path or
inside the source path.

The current CLI does not yet expose general `generate --source`, refresh, or
source verification. It writes
`manifest.json` for successful configured `generate --sdk` tasks and verifies
current configured SDK manifest source and output file hashes and byte sizes
only. Markdown / MDX / DocC, RST, static HTML, and OpenAPI 3.x / Swagger 2.0
parsing exist in parser modules but are not wired as current CLI generation
commands. The Markdown parser accepts local `.md`, `.markdown`, and `.mdx`
files and directories containing them; MDX cleanup is deterministic, preserves
fenced code, and does not evaluate JSX or imports. The RST parser accepts local
`.rst` files and directories containing nested `.rst` files, supports a
documented Python-style subset, and records warnings for unsupported
directives/includes without executing or fetching them. The HTML parser accepts
local `.html` and `.htm` files and directories containing nested HTML files,
strips scripts/styles/templates, never renders JavaScript or fetches links, and
records lower-confidence rendered-HTML fallback metadata. Semantic chunking
exists as a library API for existing DocNode IR: it emits stable semantic chunk
records with path-derived IDs, order, source metadata, hashes, sizes, token
estimates, split metadata, and warnings. Current CLI generation, manifests, and
discovery reports do not yet consume or publish semantic chunks. Discovery
reports do not generate docs, choose sources, assign trust scores, infer
authority, or claim source truth. Discovery candidates are ordered
deterministically for agent review only.

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
  -> candidate report writer
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
  source and output hashes. Current `verify` checks those configured SDK
  manifest file hashes and byte sizes only. Local bounded inspection reports are
  available through `discover --source`, and repo cache/inspection reports are
  available through `discover --repo`. Bounded explicit URL inspection reports
  are available through `discover --url`; bounded local TypeScript/JavaScript
  export and package/config evidence reports are available through
  `source-truth inspect --source`, and evidence-bound Markdown is available
  through `source-truth generate --source --output-dir`. Broader crawling,
  refresh, source-code verification, and behavior-level source documentation
  remain planned.
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
