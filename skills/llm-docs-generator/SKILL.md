---
name: llm-docs-generator
description: Maintain or use llm-docs-generator as a deterministic documentation-pack CLI. Use when working in this repository, checking implemented CLI capabilities, planning next-gen slices, or generating evidence-bound local docs with the current command surface.
---

# llm-docs-generator

Use this skill when the task is about this repository or about calling the installed `llm-docs` CLI from another workspace.

## Ground Rules

- Treat the AI agent as the planner and the CLI as the deterministic capability layer.
- Read `index.md` and `AGENT_CONTEXT.md` before promising support.
- Run `llm-docs capabilities --json` before assuming a command, mode, output file, or verification feature exists.
- Do not claim `agent install codex`, `agent doctor`, refresh, broad crawling, source-code verification, or source-docs chunk export support unless `capabilities --json` reports it as implemented.
- Do not treat discovery reports as source-selection decisions. They are candidate evidence reports for agent review.

## Current Safe Workflow

1. Resolve the user's intent: official docs, local docs, repo docs, source-truth codebase docs, or tool maintenance.
2. Resolve explicit source, scope, version, and output path before invoking the CLI.
3. Inspect implemented modes:

```bash
llm-docs capabilities --json
llm-docs agent context --json
```

4. Use only implemented deterministic commands for the task.
5. Report warnings, planned/unsupported capabilities, and incomplete evidence honestly.

## Maintenance Workflow

When modifying this repository:

1. Read `NEXT_GEN_PLAN.html`, `AGENT_CONTEXT.md`, `IMPLEMENTATION.md`, and relevant source/tests.
2. Define acceptance criteria before editing.
3. Keep docs, CLI behavior, tests, and capability contracts aligned.
4. Preserve the product boundary in code and wording.
5. Run focused tests, typecheck, build, and relevant CLI smokes before claiming completion.

## Current CLI Boundary

Implemented modes may include local/repo/URL discovery evidence reports with integrity manifests, conservative source-truth evidence extraction/generation, local source docs generation with optional source-only chunk JSONL export and manifest verification, configured SDK generation and verification, discovery-report verification, `capabilities --json`, and read-only `agent context` metadata. Treat any broader lifecycle command as unavailable unless the installed CLI says otherwise.
