---
name: repo-docs-discovery
description: Guide an AI agent through documentation-source investigation for repos, docs URLs, packages, products, or local paths before calling llm-docs with explicit inputs. Use when a user asks to generate, inspect, or prepare agent-ready docs from external or local documentation sources.
---

# repo-docs-discovery

Use this skill to turn a user's documentation goal into explicit CLI inputs. The agent investigates and chooses; `llm-docs` reports deterministic facts and converts only explicit sources.

## Required Boundary

- The agent owns ambiguity resolution, source authority, task fit, version choice, and candidate selection.
- The CLI owns bounded inspection, parsing, formatting, metadata, validation, and honest failure reporting.
- Candidate reports are evidence reports. Do not generate from a top candidate unless the user selected it, the agent explicitly selected it, or a documented automation flag exists.
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

5. Resolve an explicit source: local path, repo URL plus scope, docs URL, or prior manifest.
6. Run the appropriate implemented discovery command for evidence:

```bash
llm-docs discover --source ./docs --output-dir ./reports/local-docs
llm-docs discover --repo https://github.com/owner/repo --scope docs --output-dir ./reports/repo-docs
llm-docs discover --url https://example.com/docs --output-dir ./reports/site-docs
```

7. Read the report and select a source only after checking task fit, source intent, version constraints, and provenance.
8. If no candidate fits, continue investigation with another explicit source or ask the user.

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
