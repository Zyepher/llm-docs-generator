---
name: llm-docs-generator
description: Maintain or use llm-docs-generator as a deterministic documentation-pack CLI. Use when working in this repository, checking implemented CLI capabilities, planning future slices, or generating evidence-bound local docs with the current command surface.
---

# llm-docs-generator

Use this skill when the task is about this repository or about calling the installed `llm-docs` CLI from another workspace.

## Ground Rules

- Treat the AI agent as the planner and the CLI as the deterministic capability layer.
- Read `index.md` and `AGENT_CONTEXT.md` before promising support.
- Run `llm-docs capabilities --json` before assuming a command, mode, output file, or verification feature exists.
- Source-docs semantic chunk export is implemented as `generate --source ... --chunks jsonl`. Do not claim `agent install codex`, broad crawling, or broad source-code verification unless `capabilities --json` reports it as implemented.
- Treat `agent doctor` as read-only diagnostics only when `capabilities --json`
  reports it as implemented; it must not be described as installing/registering
  skills, writing user config, mutating host skill directories, or proving
  source truth or task fit.
- Do not claim refresh beyond the explicit local-manifest modes reported by
  `capabilities --json`; parser-plugin source-docs refresh, repo/URL
  discovery-report refresh, remote freshness refresh, crawling, and
  source-code verification remain unsupported unless the installed CLI says
  otherwise. Refresh must not fetch remote sources or run source project
  scripts.
- Treat parser plugin support as manifest validation only unless
  `capabilities --json` reports execution or custom parser generation as
  implemented. `plugins validate` must not be described as loading, importing,
  executing, trusting, or selecting plugin code.
- If `capabilities --json` reports explicit parser plugin generation as
  implemented, treat it as one local source file or opted-in directory plus
  one explicit local manifest plus one custom format id only. Directory sources
  require `directorySupport: true` on the selected manifest format. Plugin
  code is trusted local code executed for generation and is not sandboxed. Do
  not claim plugin discovery, installation, package resolution, auto-selection,
  or sandboxing unless capabilities reports those features separately.
- Do not treat discovery reports as source-selection decisions. They are candidate evidence reports for agent review, and report order is not authority, source truth, freshness, or task-fit proof.
- Reject unsupported candidate scoring, CLI source-selection, authority/source-truth, correctness, source-intent, task-fit, or "top candidate" claims in docs or code review. Do not add numeric candidate scores; report ordering is readability only. Require explicit user/agent candidate input or a documented automation flag before generation from discovery candidates.

## Current Safe Workflow

1. Resolve the user's intent: official docs, local docs, repo docs, source-truth codebase docs, or tool maintenance.
2. Resolve explicit source, scope, version, and output path before invoking the CLI.
3. Inspect implemented modes:

```bash
llm-docs capabilities --json
llm-docs agent context --json
llm-docs agent doctor --json
```

4. Use only implemented deterministic commands for the task.
5. Report warnings, planned/unsupported capabilities, and incomplete evidence honestly.

## Pack Navigation (Agent-Authored Index)

After generating a source-docs pack, write a short `llm-docs/index.md` that maps the pack's contents: the generated `*-llms.txt` file(s) and the main topics or sections inside, with a one-line note for each. The goal is that in a later session you read the index first and load only what you need, instead of pulling the whole pack into context.

This index is your navigation aid, not a CLI output: it is not recorded in `manifest.json` and `verify` ignores it, and `generate`/`refresh` preserve it (they delete only tool-owned outputs: the `*-llms.txt` files and the chunks output). Keep it accurate to the files actually present; the verified pack content remains the source of truth.

## External Target Workflow

When the user's input is a repo URL, docs URL, package name, product name, or local path, use the `repo-docs-discovery` skill for source investigation. Keep these boundaries:

- Package and product names are resolved by the agent before CLI calls. Convert them to explicit repo URLs, docs URLs, scopes, versions, or local paths first.
- Repo and URL discovery produce candidate evidence reports for agent review. They do not choose package authority, source truth, task fit, or the final source.
- `generate --source` currently takes explicit local files or directories. Do not pass package names, docs URLs, repo URLs, or discovery reports as `--source`.
- If URL or repo discovery cannot produce an explicit local source suitable for an implemented generation mode, report the evidence and limitation instead of inventing a conversion.

Example boundaries:

```text
Repo URL: agent chooses repo intent and scope -> llm-docs discover --repo <url> --scope <scope> -> agent reviews report -> llm-docs generate --source <explicit-local-path>
Docs URL: agent chooses URL to inspect -> llm-docs discover --url <url> -> agent reviews report; generation needs an explicit local source.
Package/product: agent resolves official package/product identity, version, repo/docs, and scope -> CLI receives only explicit repo/docs/local inputs.
Local path: agent verifies the path -> optional llm-docs discover --source <path> -> llm-docs generate --source <path>
```

## Maintenance Workflow

When modifying this repository:

1. Read `NEXT_GEN_PLAN.html`, `AGENT_CONTEXT.md`, `IMPLEMENTATION.md`, and relevant source/tests.
2. Define acceptance criteria before editing.
3. Keep docs, CLI behavior, tests, and capability contracts aligned.
4. Preserve the product boundary in code and wording.
5. Run focused tests, typecheck, build, and relevant CLI smokes before claiming completion.

## Current CLI Boundary

Implemented modes may include local/repo/URL discovery evidence reports with integrity manifests, conservative source-truth evidence extraction/generation and source-truth docs manifest verification, local source docs generation with optional source-only chunk JSONL export and manifest verification, explicit local parser plugin generation for one source file or an opted-in directory with trusted non-sandboxed execution when `capabilities --json` reports it, configured SDK generation and verification, discovery-report verification, explicit local-manifest refresh for current built-in-parser local source docs, source-truth docs, configured SDK (with a recorded local OpenRef spec), source discovery-report, and source-verification local evidence manifests, read-only parser plugin manifest validation, `capabilities --json`, read-only `agent context` metadata, and read-only `agent doctor` diagnostics. Treat parser plugin discovery, installation, package resolution, auto-selection, parser-plugin source-docs refresh, sandboxing, custom parser generation, and any broader lifecycle command as unavailable unless the installed CLI says otherwise.
