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
resolves intent, source, scope, version, and path, and chooses which command to
run.

The CLI is a deterministic, scriptable capability layer for agents. It should
ingest explicit sources, normalize documentation, preserve structure, write
index, manifest, provenance, and freshness metadata, validate output, and report
honest failures.

Discovery-like CLI behavior must stay bounded, explicit, inspectable, and
deterministic. Acceptable examples include listing files under a provided source
path, inspecting an explicit URL plus fixed same-origin well-known resources,
extracting links from already fetched content, and producing discovery reports
for agent review. The CLI must not silently choose authoritative sources, guess
source-specific documentation rules, crawl arbitrary links, render JavaScript,
or pretend to understand arbitrary websites.

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
- Has early multi-format architecture.
- Writes scoped manifests for successful configured `generate --sdk` tasks.
- Verifies current `configured-sdk` manifests by checking the recorded
  configured source and generated output file hashes and byte sizes.
- Can run `discover --source <local-file-or-directory>` for explicit local,
  bounded inspection and write `discovery-report.json` with candidate file
  hints, deterministic evidence categories and signals, report order, hashes,
  traversal settings, and warnings.
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
  warnings.
- Current CLI commands are limited to local/repo/website `discover`,
  `generate --sdk`, `verify`, `list-sdks`, and `validate --sdk`.
- Does not yet implement broad website crawling, refresh, source verification,
  full next-generation manifests, or source-truth codebase documentation
  generation. Discovery modes are inspection foundations only; they do not
  generate docs, choose sources, assign trust scores, infer authority, or claim
  source truth.
- Local and repo discovery order candidates by deterministic evidence category
  and normalized path for agent review. Website discovery orders extracted
  candidate URLs by deterministic observation order and aggregates evidence from
  the inspected resources. These orders are not source-selection or authority
  judgments.

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
workflow needs discovery, repo caching, refresh, source verification,
source-truth codebase docs generation, or manifest data beyond the current
configured SDK generation manifest hash and size checks, treat it as planned
work unless source and tests prove it has been implemented.

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
5. Review candidate reports by first-party evidence, structure, relevance,
   freshness, and parseability.
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
4. Run source conversion directly when a CLI mode exists, or use this as the
   next implementation step if only parser modules support the format.
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
5. If source-truth codebase docs mode exists, run it to generate structured
   facts from implementation source files.
6. Feed verified structured facts into the LLM-friendly formatter.
7. Write provenance with repo URL, commit/tag, source files analyzed, and
   confidence warnings.

Important current-state rule:

If source-truth codebase docs mode is not implemented yet, do not claim this
project can generate accurate docs from code. A repo discovery report is only
inspectable evidence for agent review. Tell the user the generation mode is
planned and identify the missing implementation.

### Intent 4: Refresh Or Verify Existing Generated Docs

User signals:

- "Refresh these docs"
- "Check if generated docs are stale"
- "Update to latest"
- "Stay on version 3"
- "Regenerate from the same source"

Agent workflow:

1. Read the prior manifest if available.
2. Re-resolve source URL, repo, path, branch, tag, or commit.
3. Compare old source identity against current source identity.
4. If user pinned a version, stay pinned.
5. If user requested latest, fetch remote metadata and compare.
6. Regenerate only when source hash, commit, or parser output changes.
7. Report what changed.

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

Reviewers must flag:

- CLI behavior or docs that imply discovery decides authority, correctness,
  source truth, or task fit.
- Candidate reports described as trust scoring, preferred-source selection, or
  hidden source-specific guessing instead of factual evidence reports.
- Generation from a top or first ordered candidate unless the user or agent
  supplies that candidate explicitly, or a documented automation flag requires
  it.
- Claims that source-truth codebase docs, source verification, manifests,
  freshness, or discovery are implemented when code, tests, CLI behavior, and
  docs do not all agree.

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

An npm package can include the CLI, agent context files, and bundled skill files,
but an AI host will not necessarily load those skills automatically.

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

Target helper commands:

```bash
llm-docs agent context
llm-docs agent install codex
llm-docs agent doctor
llm-docs capabilities --json
```

Expected behavior:

- `llm-docs agent context` prints agent-readable usage and intent routing.
- `llm-docs agent install codex` copies bundled skills into the Codex skill
  directory when supported.
- `llm-docs agent doctor` checks whether the binary is on `PATH`, bundled
  skills are available, host skill installation exists, and versions match.
- `llm-docs capabilities --json` reports implemented modes so agents do not
  assume planned features exist.

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

The current configured SDK generation path writes a scoped
`manifest.json` with configured source details, hashes, parser and formatter
metadata, and generated file hashes. The current `verify` command checks those
configured SDK manifest file hashes and byte sizes only; it does not perform
refresh, discovery report validation, repo freshness verification, or
source-code verification. Future implementations should extend manifest
coverage to the broader provenance fields above.

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
- Do not generate from a top or first ordered candidate unless the user or
  agent has explicitly selected that candidate or a documented automation flag
  requires it.
- Do not claim source-truth codebase docs are supported unless that mode exists.
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
Agent: Resolve official docs/repo, decide latest or requested version, review a
bounded inspection report when needed, convert the selected source, and write
provenance.
```

Verified official docs:

```text
User: Generate docs from the official Supabase docs and verify facts against
the source code.
Agent: Convert the official docs, inspect the matching implementation version,
verify API and behavior claims, and flag conflicts in the manifest.
```

Local docs:

```text
User: Generate LLM docs from ./docs.
Agent: Verify path, detect format, convert directly.
```

Source-truth codebase docs:

```text
User: Generate docs from this repo and verify against source code.
Agent: Use repo exploration, resolve version, run source-truth codebase docs
mode if implemented, then format verified facts with source-file provenance.
```

Pinned version:

```text
User: Generate Tailwind docs but stay on Tailwind 3.
Agent: Resolve latest v3 tag/branch, avoid Tailwind 4, record pinned version in
manifest.
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
llm-docs generate --sdk swift --sdk-version v2
llm-docs generate --sdk all --sdk-version all
llm-docs verify --output-dir ./output/swift/v2
llm-docs list-sdks
llm-docs validate --sdk swift --version v2
```

Future target-driven commands may supersede these, but they should remain
available as stable commands or compatibility aliases until an intentional
deprecation path exists.
