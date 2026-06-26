---
name: repo-docs-discovery
description: Guide an AI agent through documentation-source investigation for repos, docs URLs, packages, products, or local paths before calling llm-docs with explicit inputs. Use when a user asks to generate, inspect, or prepare agent-ready docs from external or local documentation sources.
---

# repo-docs-discovery

Use this skill to turn a user's documentation goal into explicit CLI inputs. The agent investigates and chooses; `llm-docs` reports deterministic facts and converts only explicit sources.

## Required Boundary

- The agent owns ambiguity resolution, source authority, task fit, version choice, and candidate selection.
- The CLI owns bounded inspection, parsing, formatting, metadata, validation, and honest failure reporting.
- Candidate reports are evidence reports. Deterministic ordering is for review readability, not authority, task-fit judgment, or source selection. Do not generate from the first ordered candidate unless the user selected it, the agent explicitly selected it, or a documented automation flag exists.
- Do not execute repository scripts, docs build scripts, package install hooks, examples, or arbitrary commands from inspected sources.
- Do not store credentials or tokens in manifests, reports, or generated docs.

## Workflow

1. Clarify the user goal only when the source, version, or intent materially changes the result.
2. Determine whether the user wants official docs, local docs, repo docs, source-truth codebase docs, or verification of existing output.
3. Inspect current-state context before assuming support. When working inside
   this repo, read `AGENT_CONTEXT.md` and `index.md`; when using a packaged
   install, run `llm-docs agent context --json` to locate packaged context and
   skill artifact metadata, then read the relevant artifacts.
4. Inspect implemented CLI capabilities before assuming support:

```bash
llm-docs capabilities --json
```

5. Classify the input as a local path, repo URL, docs URL, package name, product name, or prior manifest.
6. Resolve an explicit source boundary before invoking generation:
   - local path: verify the exact file or directory and any requested format
   - repo URL: choose the repo URL and repo-relative scope; if a branch, tag, or commit is required, materialize that checkout outside the active workspace before discovery because `discover --repo` has no ref checkout flag
   - docs URL: choose the explicit URL to inspect and record that current URL discovery is bounded
   - package or product name: the agent resolves package metadata/product identity to explicit repo/docs/source/scope before calling the CLI
7. Run the appropriate implemented discovery command for evidence:

```bash
llm-docs discover --source ./docs --output-dir ./reports/local-docs
llm-docs discover --repo https://github.com/owner/repo --scope docs --output-dir ./reports/repo-docs
llm-docs discover --url https://example.com/docs --output-dir ./reports/site-docs
```

8. Read `discovery-report.json` and its `manifest.json`. Treat `candidateEvidenceIndex` as compact report integrity/index metadata, not a replacement for reading the candidate evidence.
9. Select an explicit source only after checking task fit, source intent, version constraints, provenance, warnings, and skipped candidates.
10. If generation is supported for the selected explicit local file or directory, call `generate --source` with that path. Do not pass a discovery report, package name, repo URL, docs URL, or unresolved candidate to `generate --source`.
11. If no candidate fits, continue investigation with another explicit source or ask the user.

## Discovery Rules

- Local discovery inspects only the provided local file or directory.
- Repo discovery uses an explicit repo URL or local git repo plus optional repo-relative `--scope`. It produces evidence for agent review and does not decide which docs path is authoritative.
- URL discovery fetches only the explicit HTTP(S) URL, same-origin root `/llms.txt`, and same-origin root `/sitemap.xml`. It does not fetch extracted candidate links, render JavaScript, or crawl arbitrary paths.
- Discovery reports factual evidence, warnings, skipped items, and deterministic ordering. The agent must review the report before selecting a source.
- Do not describe candidate order as trust, authority, source truth, freshness, or task-fit proof.

## Cache Rules

- Keep external repo exploration outside the active project workspace. The conventional cache root is under `~/.explore/repos/`; actual CLI cache directory names may include stable suffixes rather than exactly matching `<owner>__<repo>`.
- Reuse a cached checkout only when it matches the intended remote and version/ref requirements.
- Never discard local changes in a cached checkout. If the cache is dirty or contains ignored local files, inspect it as-is, choose a separate cache/worktree, or ask the user.
- If a package or product name resolves to a repo, the agent records that resolution and then calls the CLI with the explicit repo URL, scope, or selected local path. The CLI does not resolve package authority.

## Candidate Report Handling

- Read the report path, discovery kind, inspected input, candidate count, warnings, skipped paths or resources, provenance fields, and manifest integrity facts.
- Use report ordering only to make review deterministic. The agent decides whether a candidate fits the user's intent.
- If multiple candidates remain plausible, explain the difference or ask the user instead of using the first ordered candidate silently.
- Preserve the selected source path/URL, repo commit/ref when known, and warnings in the final response or downstream manifest notes.

## Failure Handling

- If a discovery command exits non-zero, report the command, explicit input/scope, CLI error, and what the agent can try next.
- Successful discovery may still report warnings or skipped candidates in `discovery-report.json`; surface those as evidence, not failure artifacts.
- If a requested command or mode is missing from `capabilities --json`, state that it is planned/unsupported instead of improvising a workflow.
- If a docs URL report finds only remote candidates and the current CLI cannot generate from them directly, stop at the report or obtain an explicit local source through an approved agent workflow before running `generate --source`.
- If evidence is incomplete, say so. Do not invent docs, authority, source truth, or source-code verification.

## Examples

### Repo URL Input

```text
User: Generate LLM docs from https://github.com/owner/project using the docs folder.
Agent: Treat the repo URL as explicit, resolve that the user wants repo docs rather than source-truth codebase docs, choose scope `docs`, then run:
  llm-docs discover --repo https://github.com/owner/project --scope docs --output-dir ./reports/project-repo-docs
Agent: Read the candidate evidence report and warnings. If the agent selects `docs/reference` and it resolves to a local source inside the repo cache, run:
  llm-docs generate --source <explicit-cache-path>/docs/reference --format markdown --output-dir ./agent-docs/project
```

### Docs URL Input

```text
User: Inspect https://example.com/docs and prepare agent-ready docs if possible.
Agent: Treat the docs URL as explicit and run bounded URL discovery:
  llm-docs discover --url https://example.com/docs --output-dir ./reports/example-site-docs
Agent: Review the report. If the selected source is still only a remote URL, do not pass it to `generate --source`; report the candidate evidence or obtain an explicit local source first.
```

### Package Or Product Name Input

```text
User: Generate docs for @scope/widget on the v2 line.
Agent: Resolve the package name as agent work: identify the first-party package metadata, official repo/docs URL, and v2 branch/tag or docs scope. If v2 requires a branch, tag, or commit, prepare an explicit local checkout at that ref outside the active workspace before calling the CLI:
  llm-docs discover --repo <explicit-v2-local-git-checkout> --scope docs --output-dir ./reports/widget-v2
Agent: Review candidate evidence. Only after selecting an explicit local docs path, run:
  llm-docs generate --source <explicit-v2-local-git-checkout>/docs --format markdown --output-dir ./agent-docs/widget-v2
```

```text
User: Generate Tailwind CSS docs, but stay on Tailwind 3.
Agent: Resolve the product name, version intent, official docs/repo, and v3 source scope. If v3 maps to a branch, tag, or commit, materialize that checkout outside `discover --repo`; the CLI is called only after those choices are explicit. It does not decide that Tailwind maps to a package, repo, release line, or source path.
```

### Local Path Input

```text
User: Generate LLM docs from ./docs.
Agent: Verify `./docs` exists. Optional evidence pass:
  llm-docs discover --source ./docs --output-dir ./reports/local-docs
Agent: If `./docs` is still the selected source, run:
  llm-docs generate --source ./docs --output-dir ./agent-docs
```

## Capability Gating

- Use `source-truth inspect` or `source-truth generate` only when the user asks for implementation-source evidence and the installed CLI reports those modes.
- Use configured SDK generation only for supported configured SDKs.
- Treat general `generate --source`, refresh, source-code verification of official docs, broad crawling, and `agent install codex` as unsupported unless `capabilities --json` reports them implemented.
- Use `agent doctor` only as read-only diagnostics when `capabilities --json`
  reports it as implemented; it does not install skills, write user config,
  mutate host skill directories, or prove host registration unless a future
  explicit check reports that fact directly.

## Reporting Back

Return the selected source, inspected scope, warnings, unsupported capabilities, and relevant report and manifest paths. State when evidence is incomplete instead of inventing low-confidence docs.
