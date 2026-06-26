# Agent Context For llm-docs-generator

Start here when an AI agent needs to use, extend, or reason about this project.

This project is a Node.js / TypeScript command-line tool. The CLI entry point is
`src/cli.ts`, and the package exposes a `llm-docs` binary after build.

## Product Intent

The next-generation product is an LLM documentation system that helps an AI
agent turn reliable source material into LLM-friendly documentation.

It should support three major user intents:

1. Use official documentation as the source of truth.
2. Use locally provided documentation as the source of truth.
3. Use a cloned repository as the source of truth when the user asks to generate
   source-truth codebase docs from code.

The AI agent must identify the user's intent before choosing a workflow.

## Product Boundary

The AI agent is the intelligent planner. It investigates the user's request,
resolves intent, source, scope, version, path, and candidate when a report
exists, and chooses which command to run.

The CLI is a deterministic, scriptable capability layer for agents. It should
ingest explicit sources, normalize documentation, preserve structure, write
index, manifest, provenance, and freshness metadata when explicitly observed,
validate output, and report honest failures.

Discovery-like CLI behavior must stay bounded, explicit, inspectable, and
deterministic. Acceptable examples include listing files under a provided source
path, inspecting an explicit URL plus fixed same-origin well-known resources,
extracting links from already fetched content, and producing candidate evidence
reports for agent review. Discovery reports may list, group, filter, and
deterministically order candidates only by factual evidence signals: file type,
path, metadata, source URL, hash, freshness metadata when explicitly observed,
parseability, and explicit user-provided scope. The CLI must not silently choose
authoritative sources, guess source-specific documentation rules, crawl
arbitrary links, render JavaScript, or pretend to understand arbitrary websites.

## Current Capability Versus Target Capability

Current implementation:

- Can parse configured OpenRef YAML specs.
- Can parse explicit local OpenAPI 3.x and Swagger 2.0 JSON/YAML files through
  parser modules and convert them to the shared DocNode IR.
- Can parse local Markdown / MDX / DocC-style sources through parser modules.
  MDX is handled as Markdown parser/library support with deterministic cleanup
  outside fenced code; it does not evaluate JSX, execute imports, or add
  source-specific documentation rules.
- Can parse local reStructuredText `.rst` files and directories through parser
  modules. RST support is a deterministic Python-style documentation subset:
  underline headings, paragraphs, simple lists as prose, literal blocks, and
  `code-block` / `code` directives. It does not execute includes, fetch
  content, run Sphinx/docutils transforms, or choose source authority.
- Can parse local static HTML `.html` / `.htm` files and directories through
  parser modules. HTML support is a lower-confidence rendered-HTML fallback:
  title or H1 fallback, H2-H6 hierarchy, paragraphs, simple lists, pre/code
  blocks, and simple tables. It strips scripts/styles/templates, does not
  render JavaScript, does not execute content, does not fetch linked resources,
  and does not infer source authority.
- Can format parsed docs into LLM-friendly text.
- Can chunk existing DocNode IR through a deterministic library API. The
  chunker preserves semantic heading/path context, prose, code fences, and data
  blocks; emits stable path-derived chunk IDs, ordinal order, content hashes,
  source format/path metadata when present, character counts, estimated token
  counts, and warnings for oversized indivisible blocks or malformed tree
  shapes.
- Can opt in to source-docs semantic chunk publication with
  `generate --source ... --chunks jsonl`. This writes
  `chunks/semantic-chunks.jsonl` from the already parsed DocNode tree. It does
  not select sources, crawl, or infer authority. The `local-source-docs`
  manifest records a compact `semanticChunkIndexes` entry for that JSONL file,
  derived only from generated JSONL records and excluding chunk content.
- Has early multi-format architecture.
- Writes scoped manifests for successful configured `generate --sdk` tasks,
  including generator/sdk/parser/formatter metadata, generated output hashes,
  byte sizes, line counts, and deterministic estimated token counts.
- Verifies current `configured-sdk` manifests by checking the recorded
  generator metadata, sdk name/resolvedVersion/displayName, OpenRef parser
  metadata, legacy formatter metadata, configured source, generated output file
  hashes, byte sizes, and valid generated output line counts and estimated
  token counts when present.
- Verifies current `local-source-docs` manifests by checking source manifest
  shape, recorded generator/parser/formatter metadata, local source path
  existence, recorded source file byte sizes and SHA-256 hashes, generated
  output paths, byte sizes, hashes, line counts, and deterministic estimated
  token counts. When optional source-docs semantic chunk index metadata is
  present, verification rebuilds it from
  `chunks/semantic-chunks.jsonl` and fails on malformed JSONL or stale index
  facts.
- Verifies current `source-truth-local-docs` manifests by checking conservative
  source-truth manifest shape, local source path existence/type, recorded
  source file byte sizes and SHA-256 hashes, generated output path containment,
  output kinds, byte sizes, hashes, line counts, deterministic estimated token
  counts, symlink rejection, and count consistency with
  `source-truth-report.json` when available.
- Can run `discover --source <local-file-or-directory>` for explicit local,
  bounded inspection and write `discovery-report.json` plus a discovery-report
  `manifest.json` with candidate file hints, deterministic
  listing/grouping/filtering/report order from factual signals such as file
  type, path, metadata, source URL when present, hashes, freshness metadata when
  explicitly observed, parseability, explicit scope, traversal settings,
  warnings, and a compact content-free `candidateEvidenceIndex` derived from
  `discovery-report.json`.
- Can run `discover --repo <git-url-or-local-git-repo>` with optional
  `--scope <path>`, `--cache-dir <dir>`, and `--output-dir <dir>` for a bounded
  repo inspection report. Repo mode clones missing repos into a stable cache
  outside the active workspace by default, reuses existing caches
  non-destructively, fetches remote refs for clean matching caches without
  pulling into the checkout, records commit and dirty state when available,
  treats ignored local files as dirty cache contents, and inspects only the
  requested repo-relative scope path.
- Can run `discover --url <http-or-https-url>` for bounded explicit website
  inspection. URL mode fetches only the explicit URL, same-origin root
  `/llms.txt`, and same-origin root `/sitemap.xml`; it does not fetch extracted
  candidate links, render JavaScript, or crawl arbitrary website paths. The
  report records inspected resources, response status/content type/byte counts,
  crawl policy, extracted candidate URLs, source resource provenance, and
  warnings. Successful repo and URL discovery also write discovery-report
  manifests beside `discovery-report.json` with compact content-free
  `candidateEvidenceIndex` metadata derived from the report.
- Can run `source-truth inspect --source <local-file-or-directory>` for an
  explicit local source path and print a deterministic JSON evidence report to
  stdout. The report uses bounded traversal, does not follow symlinks, skips
  dependency/build directories, records supported file hashes, warnings, and
  conservative TypeScript/JavaScript export facts plus `package.json` and
  `tsconfig*.json` package/config facts with source file and line ranges. It
  also records path-based test/example context facts for inspected supported
  files whose normalized path or filename matches conservative test, spec,
  example, demo, sample, or docs/examples signals. For files identified as
  test files by that path/filename logic, it also records AST-observed
  `describe`, `it`, and `test` label facts for direct calls and `.only` /
  `.skip` forms when the first argument is a string literal or
  no-substitution template literal. Directly exported top-level
  declarations may include compact AST signature evidence with bodies and
  initializer values omitted. Re-exports, export-all declarations, and export
  assignments remain unresolved. It does not parse assertions, serialize test
  bodies, execute tests, prove claims, infer behavior, infer framework
  identity, decide source selection, or choose task fit.
- Can run `source-truth generate --source <local-file-or-directory>
--output-dir <dir>` to write an evidence-bound Markdown file, the raw
  evidence report, and a manifest with generated output hashes, byte sizes, line
  counts, and deterministic estimated token counts. The command reuses
  `inspectSourceTruth`, accepts only an explicit local source path, and fails
  with `failure.json` referencing `source-truth-report.json` when no
  extractable export or package/config facts or path-based context facts are
  found. It rejects output directories that are the source path or inside the
  source path.
- Can run `source-truth verify-docs --source <local-file-or-directory>
--docs <local-file-or-directory> --output-dir <dir>` for a narrow explicit
  local source/docs evidence report. The command accepts only explicit local
  paths, rejects URL-like/git-like inputs, symlink roots or parents, and output
  directories inside either input tree, reuses `inspectSourceTruth` for source
  export facts, and extracts only Markdown/MDX inline-code identifier evidence
  from the explicit docs path. It writes `source-verification-report.json` and
  a `source-verification-local-evidence` `manifest.json` when docs reference
  evidence exists; no supported docs files or no inline-code identifier
  references produce `failure.json` plus the evidence report. Exact matches are
  lexical matches against observed exported names. Unmatched references are
  observations for agent review, not correctness failures. It does not fetch
  network sources, render JavaScript, select sources, infer routes/frameworks
  or runtime behavior, verify broad official-docs behavior/API claims, or
  decide source authority.
- Can run `generate --source <local-file-or-directory> --output-dir <dir>` for
  deterministic local source docs generation through the registered parser and
  universal formatter. Source mode supports `--format auto`, `markdown`, `mdx`
  through the Markdown parser, `openapi`, `openref`, `rst`, and `html`. It
  accepts local files or directories only, rejects URL-like inputs, missing
  paths, discovery reports, `--source` plus `--sdk`, unsupported `--chunks`
  values, unknown presets, presets without `--source`, presets with `--sdk`,
  and preset-incompatible explicit formats, and does not fetch, crawl, select
  candidates, infer task fit, or decide source selection. Successful source
  generation writes `manifest.json` plus generated docs under `llm-docs/`.
  With `--chunks jsonl`, it also writes `chunks/semantic-chunks.jsonl` and a
  compact source-docs `semanticChunkIndexes` manifest entry. The manifest
  records source file hashes and byte sizes, a deterministic directory
  aggregate hash when applicable, parser/formatter metadata, generated output
  hashes, byte sizes, line counts, deterministic estimated token counts,
  output kind/name metadata, per-chunk index facts without chunk content, and
  warnings.
- Can run `generate --source <explicit-local-docs-path> --preset swift-book
--output-dir <dir>` for a deterministic Swift Programming Language output
  preset over explicit local Markdown/DocC-style sources. The preset supplies
  Markdown format defaults, `swift-book` output naming, title, neutral
  source-derived system prompt, and non-authoritative preset provenance only. It
  does not infer or append `TSPL.docc`, clone or cache repositories, select
  sources, verify source truth, claim completeness, or perform source-code
  verification. `--chunks jsonl` remains compatible with this preset.
- Can run `refresh --manifest <path>` or `refresh --output-dir <dir>` for
  current `local-source-docs` and `source-truth-local-docs` manifests only.
  Source-docs refresh reads the existing manifest and uses only the recorded
  absolute local `source.resolvedPath`, `source.formatHint`, preset metadata if
  present, and whether the previous manifest contained
  `semantic-chunks-jsonl`; it regenerates into the manifest directory through
  the current local source docs generator, including refreshed chunk index
  metadata. Source-truth refresh reads the existing manifest and uses only the
  recorded absolute local source path, then regenerates through the current
  source-truth docs generator. After regeneration, refresh runs the existing
  manifest verifier against the newly written manifest outputs and reports the
  checked-file count. This is deterministic post-refresh integrity verification
  only; it does not claim freshness, source truth, source-code behavior, or
  runtime behavior. Refresh does not support configured SDK manifests,
  discovery-report manifests, URLs, repo freshness, broad website crawling,
  source selection, source-code verification, behavior validation, remote
  network work, or source project script execution.
- Can run `capabilities --json` to print a deterministic, machine-readable
  contract of implemented commands and planned/unsupported capabilities for
  agents. The contract has schema version `0.1.0`, package name/version
  metadata, product-boundary metadata, implemented command entries, source-truth
  fact-family scope, explicit source-truth limitations, and planned/unsupported
  entries. It intentionally omits `generatedAt` and does not inspect sources,
  load config, write files, or perform network work.
- Can run `agent context` or `agent context --json` to print deterministic
  metadata for packaged `AGENT_CONTEXT.md`, `index.md`, and bundled
  `skills/*/SKILL.md` artifacts. The JSON contract has schema version `0.2.0`,
  package name/version metadata, the `llm-docs` binary name, package-relative
  artifact paths, byte sizes, SHA-256 hashes, intended uses, and explicit
  limitations. It reports packaged context and skill artifact metadata only; it
  does not install or register skills, write user config, probe environment
  state, or perform network work.
- Can run `agent doctor` or `agent doctor --json` for read-only diagnostics.
  The JSON contract has schema version `0.1.0`, package name/version metadata,
  summary counts, packaged context/skill artifact readability and hash facts,
  expected binary metadata, an informational `PATH` check for `llm-docs`, and a
  skipped/not-configured Codex skill-installation check. Missing `llm-docs` on
  `PATH` is a warning and exits successfully; hard failures are reserved for
  packaged artifact read/hash failures or malformed internal package state.
  Doctor does not install/register skills, write user config, mutate host skill
  directories, perform network access, infer source truth, or decide task fit.
- Current CLI commands are limited to local/repo/website `discover`,
  `source-truth inspect`, `source-truth generate`,
  `source-truth verify-docs`, `generate --source`,
  `generate --source --preset swift-book`, `generate --sdk`, `refresh`,
  `verify`, `list-sdks`, `validate --sdk`,
  `capabilities --json`, read-only `agent context`, and read-only
  `agent doctor`.
- Does not yet implement broad website crawling, configured SDK refresh,
  discovery-report refresh, remote freshness refresh, broad official-docs
  behavior/API claim verification, full next-generation manifests, or
  behavior-level source documentation from code.
  Semantic chunking exists as a library capability for existing DocNode IR and
  as an opt-in JSONL export for explicit `generate --source` outputs only;
  source-docs refresh preserves that chunk JSONL output only when the existing
  manifest recorded it. Configured SDK, source-truth docs, and discovery
  reports do not publish semantic chunk records. Current source docs,
  configured SDK, source-truth docs, and discovery-report manifests include
  partial generated-output RAG metadata only (`lineCount` and
  `estimatedTokenCount`) plus source-docs opt-in chunk JSONL file metadata,
  compact chunk indexes when requested, and compact content-free discovery
  candidate evidence indexes. Discovery modes are inspection foundations only;
  they do not generate docs, choose sources, assign trust or authority labels, infer
  authority, or claim source truth.
- Local, repo, and website discovery list, group, filter, and deterministically
  order candidates for agent review only. Ordering is factual report structure,
  based on observed file type, path, metadata, source URL, hash, freshness
  metadata when explicitly observed, parseability, and explicit user-provided
  scope; it is not source-selection, task-fit, correctness, source-truth, or
  authority judgment.

Target next-generation implementation:

- Produce bounded inspection reports from explicit repo links, docs URLs,
  package metadata, source paths, or agent-approved scopes.
- Convert official or local docs into LLM-friendly output.
- Clone and cache repositories outside the active workspace.
- Compare cached clones against remote state to determine freshness.
- Respect user-pinned versions such as Tailwind 3 even if Tailwind 4 is latest.
- Verify official documentation claims against source code when the user asks for
  source-truth confidence and the implementation is available.
- Generate docs from source code when an explicit source-truth codebase docs
  mode exists.
- Write manifests so every output is traceable to docs, repo commits, tags,
  versions, and content hashes.

Agents must not pretend target capabilities are implemented when the codebase
does not yet contain them. If a requested mode is planned but missing, say so
and either implement it or provide the next engineering step.

## Intent Router

Use this router before running commands.

The workflows below describe the approved next-generation product direction.
When using the current CLI, verify that the needed command exists first. If the
workflow needs discovery, repo caching, refresh beyond current local
explicit-manifest source-docs/source-truth modes, source verification beyond
the narrow explicit-local `source-truth verify-docs` evidence report,
behavior-level source documentation, or manifest data beyond the current source
docs, configured SDK, source-truth docs, discovery-report, and
source-verification manifests, treat it as planned work unless source and tests
prove it has been implemented.

### Intent 1: Official Documentation To LLM-Friendly Docs

User signals:

- "Generate LLM docs for Tailwind"
- "Use the official Supabase docs"
- "Make docs for this SDK"
- "Use this docs website"
- "Find the official docs and convert them"
- User provides a product name, docs URL, package name, or repo URL but does not
  provide a specific local docs path

Agent workflow:

1. Resolve the official source as the agent.
2. Prefer first-party sources over community mirrors.
3. Check for machine-readable entry points:
   - `llms.txt`
   - `sitemap.xml`
   - OpenAPI / Swagger
   - OpenRef YAML
   - Markdown / MDX / RST source files
   - DocC directories
   - GitHub source links from docs pages
4. If a source repo is discovered, use the repo exploration workflow.
5. Review candidate evidence reports in light of the user task, project
   context, version constraints, source/provenance evidence, source intent,
   explicit scope/version/product matches, freshness metadata when explicitly
   observed, and parseability; treat this as agent judgment, not a CLI judgment.
6. Run this project's parser/formatter on the agent-selected source.
7. If the user asks for source-truth confidence and a source repo is available,
   verify API signatures, config defaults, routes, exported types, and behavior
   claims against implementation source files.
8. Report provenance, confidence, and any source-code conflicts.

Use this project as the conversion engine after the agent selects an explicit
source from user input or a bounded inspection report.
Official docs remain the preferred source for explanations and intended usage,
but source code wins when implementation-verifiable facts conflict.

### Intent 2: Locally Provided Documentation To LLM-Friendly Docs

User signals:

- "Generate from this local docs folder"
- "Parse this markdown"
- "Use this OpenAPI/OpenRef file"
- "Convert ./docs"
- User provides an explicit local file or directory

Agent workflow:

1. Verify the path exists.
2. Optionally run `llm-docs discover --source <path> --output-dir <dir>` to
   produce a bounded local inspection report for agent review.
3. Detect the format or honor the user's requested format.
4. Run `llm-docs generate --source <path> --output-dir <dir>` with `--format`
   omitted for auto-detection or set to a supported parser hint. Do not pass a
   discovery report as `--source`; review the report as candidate evidence and
   pass the selected local file or directory explicitly.
5. Report generated output files and source path. If only discovery was run,
   report the `discovery-report.json` path and candidate count instead.

Do not clone external repositories unless the user also asks for discovery or
verification.

### Intent 3: Source-Truth Codebase Docs From A Repository

User signals:

- "Generate docs from this repo"
- "There are no docs, use the source code"
- "Verify facts from the implementation"
- "Document this codebase"
- "Generate LLM docs from cloned source"
- User expects implementation behavior, API signatures, exported types, routes,
  config, or examples to be inferred from code

Agent workflow:

1. Use the repo exploration workflow or `llm-docs discover --repo <repo>` to
   clone or fetch the repository cache and write a bounded inspection report.
2. Resolve the intended version:
   - If user says latest, compare the cached clone with the remote default
     branch or latest stable release, depending on project conventions.
   - If user pins a version, tag, branch, or commit, honor that exactly.
   - If user says "Tailwind 3" or similar, find the latest compatible v3 tag or
     branch instead of migrating to v4.
3. Inspect repository metadata before source-truth codebase generation:
   - README
   - package manifests
   - build config
   - source directories
   - tests
   - examples
   - public exports
   - existing docs
4. Prefer existing official docs when present, but verify claims against source
   code when the user asks for source-truth codebase docs.
5. If the agent has resolved an explicit local source path, it may run
   `llm-docs source-truth inspect --source <path>` to obtain bounded factual
   TypeScript/JavaScript export and package/config evidence for review.
6. If explicit source-truth codebase docs are requested, run
   `llm-docs source-truth generate --source <path> --output-dir <dir>` to
   generate conservative evidence Markdown and provenance files from the
   inspected implementation and config files.
7. If the agent also has an explicit local docs path and wants lexical evidence
   comparing docs references with observed exports, it may run
   `llm-docs source-truth verify-docs --source <path> --docs <docs-path>
--output-dir <dir>`. Treat unmatched references as observations, not
   correctness failures.
8. Feed inspected structured facts into the LLM-friendly formatter.
9. Write provenance with repo URL, commit/tag, source files analyzed, and
   confidence warnings.

Important current-state rule:

Do not claim this project can generate accurate or behavior-complete docs from
code. `source-truth inspect` extracts conservative TypeScript/JavaScript export
facts, optional direct-declaration AST signature evidence, and `package.json` /
`tsconfig*.json` package/config facts from an explicit local source path. It
also extracts file-level test/example context facts from explicit path and
filename signals plus AST-observed test-case label facts from files already
identified as tests. Test-case names are labels only, not proof of behavior or
correctness, and test bodies, assertion text, expected values, closures, and
runtime-derived names are omitted. `source-truth generate` formats only those
observed facts into Markdown and provenance files. `source-truth verify-docs` only compares
Markdown/MDX inline-code identifier references from an explicit local docs path
against observed exported names from the same conservative inspector. These
modes do not parse assertions, execute tests, prove claims, summarize runtime
behavior, infer framework identity, decide source selection, choose task fit,
or resolve re-export targets beyond existing source-truth facts.

### Intent 4: Refresh Or Verify Existing Generated Docs

User signals:

- "Refresh these docs"
- "Check if generated docs are stale"
- "Update to latest"
- "Stay on version 3"
- "Regenerate from the same source"

Agent workflow:

1. Read the prior manifest if available.
2. If the manifest mode is `local-source-docs`, the current CLI can run
   `llm-docs refresh --manifest <path>` or `--output-dir <dir>` and will use
   only the recorded local source path, format hint, preset metadata if present,
   and prior chunk-output presence, then verify the regenerated manifest
   outputs.
3. If the manifest mode is `source-truth-local-docs`, the current CLI can run
   `llm-docs refresh --manifest <path>` or `--output-dir <dir>` and will use
   only the recorded local source path, then verify the regenerated manifest
   outputs.
4. If the manifest is `configured-sdk`, `discovery-report`,
   `source-verification-local-evidence`, URL/repo/website, or requires
   freshness/source-code verification, treat refresh as planned and unsupported
   in the CLI.
5. For future remote/freshness workflows, re-resolve source URL, repo, path,
   branch, tag, or commit as the agent, respect pinned versions, and report
   what changed before regenerating.

### Intent 5: Maintain Or Extend This Tool

User signals:

- "Implement discover"
- "Add OpenAPI support"
- "Improve AGENT_CONTEXT.md"
- "Fix the CLI"
- "Add source-truth codebase docs mode"

Agent workflow:

1. Inspect the current implementation.
2. Make narrowly scoped code or documentation changes.
3. Run relevant checks such as `npm run type-check` and `npm run test`.
4. Report current limitations and what was verified.

For future worker or reviewer prompts that touch CLI source ingestion,
discovery-like inspection, manifests, freshness, provenance, or docs contracts,
include an explicit reminder to align with the Product Boundary above.

Reviewers must allow:

- Deterministic CLI listing, grouping, filtering, and ordering of observed
  candidates when based only on factual evidence signals such as file type,
  path, metadata, source URL, hash, freshness metadata when explicitly
  observed, parseability, and explicit user-provided scope. This is report
  readability, not source selection.

Reviewers must reject:

- CLI behavior or docs that imply discovery decides authority, correctness,
  source truth, source-truth confidence, or task fit.
- Discovery or candidate changes that add or imply source rating, trust
  rating, authority rating, hidden preferred-source logic, authority/trust
  scoring or ratings, or numeric task-fit ordering.
- Candidate evidence reports framed as ratings, hidden preferred-source logic,
  hidden source-specific guessing, or anything other than factual evidence
  reports.
- CLI selection of a discovery-report candidate, generation from a report's first
  entry or implied leading entry, hidden preferred-source logic,
  authority/trust scoring or ratings, or unsupported discovery claims unless
  the user or agent supplies that candidate explicitly or a documented
  automation flag requires it.
- Hidden source-specific guesses, such as inferring product-specific docs paths,
  release lines, package identity, or framework behavior without explicit
  source evidence.
- Claims that source-truth codebase docs, source verification, manifests,
  freshness, or discovery are implemented beyond the narrow code, tests, CLI
  behavior, and docs that actually agree.

## Repo Exploration Workflow

Use a repo-explorer skill or equivalent workflow when the target repository is
not already the active workspace and the user asks to discover, inspect, compare,
generate, or verify docs for that external repository.

Cache location:

```text
~/.explore/repos/<owner>__<repo>
```

Rules:

1. List cache contents before cloning.
2. Reuse an existing checkout when it matches the same remote.
3. If an existing checkout points to a different remote, create a separate
   cache directory.
4. Fetch remote refs before deciding whether it is current.
5. Never discard local changes in a cached checkout.
6. If the cached checkout has local changes or ignored files, avoid destructive
   updates. The current `discover --repo` command warns and inspects what is
   present; clean matching caches fetch remote refs but do not pull into the
   checkout. An agent may choose a separate cache or worktree outside this CLI
   command when it needs a clean comparison.
7. Store source provenance in the generated manifest.
8. Do not clone external repos into this project's active workspace by default.

Freshness checks:

```bash
git remote get-url origin
git fetch --tags --prune origin
git rev-parse HEAD
git rev-parse origin/HEAD
git status --short
```

Version policy:

- "latest" means the latest verified source according to the target's release
  conventions, not blindly the newest branch.
- A user-pinned major version must remain pinned.
- A tag, branch, or commit supplied by the user is binding unless it cannot be
  fetched or verified.
- If the repo has multiple release channels, ask or report ambiguity.

## Skill Orchestration Model

This project should provide enough context for an AI agent to choose the correct
skill or workflow.

Recommended skills:

- `official-docs-discovery`: find official docs, specs, source links, llms.txt,
  and sitemaps.
- `repo-explorer`: clone, cache, compare, and inspect external repositories.
- `docs-converter`: run this project's parser and formatter.
- `source-truth-codebase-docs`: analyze implementation source files, extract
  structured facts, and verify existing documentation claims against code when
  the user asks for source-truth codebase docs.
- `source-verification`: compare selected official documentation claims against
  implementation source files and report conflicts with file-level provenance.

The CLI should remain deterministic. Skills guide the agent's decisions; the CLI
should do the repeatable bounded inspection, parsing, formatting, verification,
and manifest writing as those target capabilities are implemented.

## Distribution Model

Installing the CLI and installing/registering skills are separate concerns.

This npm package includes the CLI, agent context files, and bundled skill files,
but an AI host will not load those skills automatically.

Target package layout:

```text
dist/
bin/
  llm-docs
agent/
  index.md
  AGENT_CONTEXT.md
skills/
  llm-docs-generator/
    SKILL.md
  repo-docs-discovery/
    SKILL.md
```

Current helper commands:

```bash
llm-docs agent context
llm-docs agent context --json
llm-docs agent doctor
llm-docs agent doctor --json
llm-docs capabilities --json
```

Planned/unsupported helper commands:

```bash
llm-docs agent install codex
```

Expected behavior:

- `llm-docs agent context` currently prints read-only metadata for the packaged
  context and skill artifacts and points humans to `--json`.
- `llm-docs agent context --json` currently prints a deterministic metadata
  contract for packaged context and skill artifacts only. It includes
  `AGENT_CONTEXT.md`, `index.md`, `skills/llm-docs-generator/SKILL.md`, and
  `skills/repo-docs-discovery/SKILL.md`. It does not install/register skills,
  write user config, probe the environment, or perform network work.
- `llm-docs agent doctor` currently prints concise read-only diagnostics and
  points humans to `--json`.
- `llm-docs agent doctor --json` currently prints a deterministic diagnostics
  contract with schema version `0.1.0`, generator/package metadata, summary
  counts, packaged artifact readability/hash facts aligned with
  `agent context`, the expected binary name `llm-docs`, an informational PATH
  lookup result, skipped/not-configured Codex skill-installation status, and
  limitations. Missing `llm-docs` on PATH is a warning, not a hard failure.
  The command does not install/register skills, write user config, mutate host
  skill directories, perform network access, infer source truth, or decide task
  fit.
- `llm-docs agent install codex` is planned/unsupported. A future
  implementation may copy bundled skills into the Codex skill directory when
  supported.
- `llm-docs capabilities --json` reports implemented modes so agents do not
  assume planned features exist. This command is currently implemented as a
  static deterministic contract and does not perform hidden environment probing.

When an agent is in another directory and receives a prompt such as "Generate
LLM docs for Tailwind CSS," the installed skill is what should tell the agent to
investigate source and scope, then call the globally available `llm-docs` CLI
with explicit inputs. The CLI then performs the deterministic work.

## Source Evidence Categories

The agent should review sources in this order, using CLI reports as evidence
rather than hidden authority decisions. This is agent guidance, not CLI
permission to decide source truth or task fit:

1. First-party machine-readable specs: OpenAPI, Swagger, OpenRef.
2. First-party docs source: Markdown, MDX, RST, DocC.
3. First-party `llms.txt` and linked markdown.
4. First-party docs website via sitemap/canonical pages.
5. Source-truth codebase docs generation, only when explicitly requested or
   when no docs exist and the feature is implemented.

Never prefer stale source hints over verified current sources.
When official docs and source code disagree on implementation-verifiable facts,
preserve the official docs as context but mark the conflict and prefer source
code for API signatures, config defaults, routes, exported types, and runtime
behavior.

## Provenance Requirements

Every generated output should be traceable.

Record at minimum:

- user input
- resolved intent
- selected workflow
- source type
- source URL or local path
- repo URL, branch, tag, commit, and dirty state when applicable
- docs path or implementation source files analyzed
- source-code verification coverage, when requested
- conflicts between official docs and implementation
- content hash
- parser and formatter used
- generated output paths
- warnings and skipped candidates

The current explicit local source generation path writes a source-mode
`manifest.json` with source path/type, format hint, resolved format,
parser/formatter metadata, source file paths, source file formats, hashes and
byte sizes, a deterministic directory aggregate hash when applicable, generated
file hashes, byte sizes, line counts, deterministic estimated token counts,
output kind/name metadata, optional `chunks/semantic-chunks.jsonl` metadata when
`--chunks jsonl` is requested, optional compact semantic chunk manifest indexes
derived from the JSONL records, and warnings. The current
configured SDK generation path writes a scoped `manifest.json` with configured
source details, hashes, generator/sdk/parser/formatter metadata, generated file
hashes, byte sizes, line counts, and deterministic estimated token counts. The
current discovery commands write a scoped `manifest.json` beside
`discovery-report.json` with discovery kind, report path, report schema/mode,
factual counts, and report file hash, byte size, line count, deterministic
estimated token count, and compact content-free candidate evidence index
metadata derived from the report. The current `verify` command supports
`configured-sdk`,
`local-source-docs`, `source-truth-local-docs`, `discovery-report`, and
`source-verification-local-evidence` manifests.
For configured SDK manifests, it checks source and generated output hashes,
byte sizes, recorded generator/sdk/parser/formatter metadata, and valid
generated output line/token metadata when present, and rejects malformed
metadata before file checks. For source-mode manifests, it checks recorded
generator/parser/formatter metadata,
local source path shape and existence, source file hashes and byte sizes,
generated output paths, hashes, byte sizes, line counts, and deterministic
estimated token counts; when optional semantic chunk manifest indexes are
present, it also rebuilds them from source-docs JSONL records and checks for
malformed or stale index data. For source-truth docs
manifests, it checks source input/resolved path/type shape, local source path
existence/type, source file path containment for directory sources, source file
hashes and byte sizes, generated output path containment, allowed source-truth
output kinds, generated output hashes, byte sizes, line counts, deterministic
estimated token counts, symlink rejection, inspection schema/mode/traversal
shape, and count consistency with `source-truth-report.json` when available. For
discovery-report manifests, it checks `discovery-report.json` existence, hash,
byte size, line count, deterministic estimated token count, and basic report
schema/mode/kind/count consistency. When optional candidate evidence index
metadata is present, it rebuilds that metadata from `discovery-report.json` and
fails on malformed or stale index data. For source-verification manifests, it
checks `source-verification-report.json` existence, hash, byte size, line count,
deterministic estimated token count, report schema/mode/output path
consistency, source/docs endpoint provenance against the report, manifest
summary consistency with report metadata, report summary consistency with body
arrays, and `sourceInspection.source` consistency. It does not perform refresh,
inspect additional source/docs files, verify repo freshness, perform broad
official-docs claim verification, validate source-code behavior, make
candidate selection, task-fit judgments, source truth resolutions, or source
selection decisions, or prove docs correctness. The current
`refresh` command
supports only `local-source-docs` and `source-truth-local-docs` manifests that
already record an absolute local source path. It regenerates into the existing
manifest directory, preserves source-docs chunk JSONL output only when the
previous manifest recorded `semantic-chunks-jsonl`, regenerates source-docs
chunk index metadata through the current source generator, and preserves
source-docs preset metadata when present. After successful regeneration, it
runs the existing manifest verifier over the newly written manifest outputs and
reports the checked-file count. This is deterministic manifest/output integrity
verification only, not freshness, source truth, source-code behavior, or runtime
behavior verification. It does not refresh configured SDK manifests, discovery
reports, URLs, repos, websites, remote freshness, source-code verification,
task-fit decisions, source truth resolution, or behavior validation. It
performs no remote network work and runs no source project scripts. Future
implementations should extend manifest coverage to the broader
provenance fields above.

## Clarifying Questions

Ask a concise question when choosing incorrectly would materially change the
result.

Ask when:

- A product name maps to multiple official repos.
- Multiple docs candidates have similar evidence and the agent cannot resolve
  source intent, version, or task fit from the report.
- The user requested "latest" but the project has multiple release channels.
- The user requested a major version with ambiguous tags.
- The target requires authentication and local credentials are unavailable.
- The user says "generate docs from repo" but it is unclear whether they mean
  existing docs in the repo or source-truth docs inferred from code.
- The user asks for source verification but the source repository cannot be
  found or requires unavailable credentials.

Do not ask when:

- The user provides a direct local docs path.
- The agent has verified one clear first-party source and no material ambiguity
  remains.
- The user explicitly pins a tag, branch, commit, docs URL, or source path.

## Hard Rules

- Do not execute package scripts, docs build scripts, examples, or arbitrary
  repository commands during discovery or parsing.
- Do not silently trust stale source hints.
- Do not silently upgrade pinned versions.
- Do not let CLI discovery make hidden authority decisions; it must produce
  inspectable deterministic evidence and ordering for agent review.
- Do not generate from a discovery-report candidate unless the user or agent has
  explicitly selected that candidate or a documented automation flag requires
  it.
- Do not claim source-truth codebase docs go beyond observed export/signature,
  package/config, path/filename test/example context evidence, and observed
  test-case labels unless the implementation actually inspects and proves that
  broader evidence. These
  facts must not be treated as behavior, correctness, authority, task fit, or
  source-selection proof.
- Do not mark official docs as source-verified unless implementation files were
  actually inspected.
- Do not mix unrelated products or SDKs from a monorepo into one output.
- Do not store authentication tokens in manifests.
- Do not use cached source content as fresh output unless verification succeeds.

## Examples

These examples describe target agent behavior. Before executing them with the
current CLI, verify that the corresponding mode is implemented.

Official docs:

```text
User: Generate LLM docs for Tailwind CSS.
Agent: Resolve the product name to the official docs/repo, decide latest or
requested version, choose explicit source/scope, review a bounded inspection
report when needed, convert the selected local source, and write provenance.
The CLI does not decide that Tailwind maps to a package, repo, release line, or
source path.
```

Repo URL input:

```text
User: Generate LLM docs from https://github.com/owner/project using the docs folder.
Agent: Resolve intent as repo docs, choose explicit scope `docs`, then run
`llm-docs discover --repo https://github.com/owner/project --scope docs
--output-dir <report-dir>`. Review `discovery-report.json` as candidate
evidence. If the selected source is an explicit local docs path in the repo
cache, run `llm-docs generate --source <cache-path>/docs --output-dir <dir>`.
```

Docs URL input:

```text
User: Inspect https://example.com/docs and generate docs if the source is usable.
Agent: Run bounded URL discovery for that explicit URL. Review the report and
warnings. Do not pass the URL or discovery report to `generate --source`; either
select an explicit local source obtained through an approved workflow or report
that current generation cannot proceed from the remote candidate alone.
```

Package name input:

```text
User: Generate docs for @scope/widget on v2.
Agent: Resolve package identity, official repo/docs, version/ref, and source
scope as agent work. Then call discovery with the explicit repo/docs URL or
local path. The CLI reports evidence only; it does not resolve package
authority, source truth, or task fit.
```

Verified official docs:

```text
User: Generate docs from the official Supabase docs and verify facts against
the source code.
Agent: Convert the selected official docs source. Run source-code verification
only when `capabilities --json` reports the requested mode and explicit source
and docs paths are available; otherwise report that broad official-docs
behavior/API claim verification remains planned.
```

Local docs:

```text
User: Generate LLM docs from ./docs.
Agent: Verify path, then run llm-docs generate --source ./docs --output-dir <dir>
with an explicit format hint when useful.

User: Generate Swift book docs from this local TSPL.docc folder.
Agent: Verify the exact path supplied by the user, then run llm-docs generate
--source <explicit-local-docs-path> --preset swift-book --output-dir <dir>.
Do not infer or append TSPL.docc.
```

Source-truth codebase docs:

```text
User: Generate docs from this repo and verify against source code.
Agent: Use repo exploration, resolve version, run `source-truth generate` for
observed export facts, and use `source-truth verify-docs` only when explicit
local docs and source paths are available for lexical reference evidence.
Broader claim checks remain planned unless code and tests show otherwise.
```

Pinned version:

```text
User: Generate Tailwind docs but stay on Tailwind 3.
Agent: Resolve latest v3 tag/branch or docs source as agent work, avoid
Tailwind 4, choose the explicit source/scope before calling the CLI, and record
pinned version in provenance.
```

Ambiguous repo request:

```text
User: Generate docs from this repo.
Agent: If the repo contains both docs and implementation source files, ask
whether to convert existing docs or infer and verify facts from source code when
the user's wording is unclear.
```

## Compatibility Baseline

Do not break the current Supabase/OpenRef workflow while adding next-generation
discovery.

The following commands are the current regression baseline:

```bash
llm-docs discover --source ./docs --output-dir ./reports/local-docs
llm-docs discover --repo https://github.com/owner/repo --scope docs --output-dir ./reports/repo-docs
llm-docs discover --url https://example.com/docs --output-dir ./reports/website
llm-docs capabilities --json
llm-docs agent doctor --json
llm-docs source-truth inspect --source ./src
llm-docs source-truth verify-docs --source ./src --docs ./docs --output-dir ./reports/source-verification
llm-docs generate --source ./TSPL.docc --preset swift-book --output-dir ./swift-book-agent-docs
llm-docs generate --sdk swift --sdk-version v2
llm-docs generate --sdk all --sdk-version all
llm-docs verify --output-dir ./output/swift/v2
llm-docs list-sdks
llm-docs validate --sdk swift --version v2
```

Future target-driven commands may supersede these, but they should remain
available as stable commands or compatibility aliases until an intentional
deprecation path exists.
