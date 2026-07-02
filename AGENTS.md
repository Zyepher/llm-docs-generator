# AGENTS.md

Standing instructions for any AI coding agent working in this repository. Read this
before making changes. For a specific in-flight task, also read the task brief the human
points you to (for example a HANDOFF.md), which takes precedence for scope.

## Project

`llm-docs-generator` is a Node ESM TypeScript CLI that turns a library's real
documentation, at an explicit version, into a clean local docs pack an AI coding agent
can read, with a manifest that hashes every source and output so the pack can be verified
and refreshed. The design boundary is strict: the human or their agent chooses the source
and version (the planner), and the CLI does the deterministic conversion and records
provenance (the engine). The CLI never selects sources, judges authority, crawls, renders
JavaScript, or invents documentation.

## Working conventions (non-negotiable)

- Commits carry NO AI or tool attribution. No `Co-Authored-By`, no "Generated with", no
  assistant credit in the message body or trailers. Write messages as a human engineer
  would.
- Commit messages are comprehensive: a conventional-commit subject (`fix:`, `refactor:`,
  `docs:`, `build:`, `chore:`, matching the existing history) plus a body explaining what
  changed and why when the change is not trivial.
- Prose everywhere (code comments, commit messages, docs, PR text, reports) uses NO
  em-dashes. Use commas, colons, or parentheses. Do not brag about line counts or LOC.
- Favor Locality of Behaviour. Do not over-split or over-abstract. Prefer the existing
  shared helpers over new indirection layers, and keep related logic together. When a
  split is genuinely warranted, keep it minimal.

## TypeScript quality bar

- Strict mode is on (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noUnusedLocals`, `noUnusedParameters`). Keep it green.
- No `as any`, no `as unknown as`, no `@ts-ignore` / `@ts-expect-error`. The codebase
  currently has zero of these; do not introduce them.
- Non-null assertions (`!`) only when an adjacent bounds check proves safety; prefer
  narrowing or `.at()` with a guard.
- Reuse the shared utilities instead of re-implementing them:
  - `errorMessage()` (src/utils/guards.ts) for error-to-string, not inline
    `err instanceof Error ? err.message : String(err)`.
  - `writeJsonFileSafely` / `readJsonFile` (src/utils/json.ts), `writeTextFileSafely`
    (src/utils/safe-write.ts) for atomic writes and reads.
  - `sha256Hex` / `sha256File` / `sha256Prefixed` (src/utils/hash.ts) for hashing.
  - `isSameOrDescendant` / `isParentRelativePath` / `resolveEffectiveOutputPath`
    (src/utils/fs-path.ts) for path containment.
  - `isRecord` / `isNonEmptyString` / `isNonNegativeInteger` / `isFileNotFoundError`
    (src/utils/guards.ts) for guards.
- Comments explain non-obvious constraints only. Do not narrate the diff or address the
  reviewer.
- Anything you add (option, field, export) must be used; anything you remove must be
  verified dead across `src/` and `tests/`, respecting barrel re-exports
  (src/index.ts, src/parsers/index.ts, src/core/manifest.ts).

## Build, lint, and test

- `npm run type-check` (`tsc --noEmit`)
- `npm run lint` (Biome) and `npm run format:check` (Prettier)
- `npm run build` (tsup)
- `npm test` (Vitest, full suite; `tests/unit/cli.test.ts` spawns a real subprocess per
  test and mutates then restores a few repo files in-process, so it is slow and must not
  be killed mid-run)
- Before committing a nontrivial change, run type-check, lint, build, and the full test
  suite, and exercise the affected CLI flow against a throwaway fixture with
  `node dist/cli.js` (never against real data).

## Git workflow

- Work on a feature branch. Commit in logical units.
- Do not push to `origin` or delete remote branches unless the human explicitly asks.
  Local merges and local branch cleanup are fine when the task calls for them.

## Local-only files (do not commit)

`OPUS_REVIEW.md`, `HANDOFF.md`, and `GPT_PROMPT.md` are local working notes and are
git-ignored. Do not commit them and do not include them in the published package.
