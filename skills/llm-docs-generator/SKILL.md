---
name: llm-docs-generator
description: Operating playbook for generating and maintaining version-pinned documentation packs with the llm-docs CLI. Use when building, refreshing, or verifying an agent-ready docs pack for a specific installed library version, or when maintaining this repository.
---

# llm-docs-generator

`llm-docs` is a deterministic engine: it parses sources, preserves structure, and records provenance. It makes no judgments. YOU make every judgment — which version, which source tree, what to exclude, how to slice, what the index says. A pack is only as correct as the decisions you feed the engine. The failures this playbook prevents are all judgment failures: unpinned versions, drafts swept in, a 250k-token monolith no agent can load, a pack with no index, a pack that broke when it moved.

Run this workflow in order. Every step states WHY so you can adapt it, not cargo-cult it.

## Division Of Labor (never violate)

- You resolve version, source authority, source tree, exclusions, and slicing. The CLI never reads a vendor nav config, never picks a source, never decides a version.
- `generate --source` takes explicit local files or directories only. Never pass a package name, docs URL, repo URL, or discovery report to `--source`.
- Run `llm-docs capabilities --json` before assuming any command, flag, mode, or output exists; anything not reported there is unavailable unless the installed CLI says otherwise. If a flag in this playbook is missing from the installed contract, treat it as not yet shipped and adapt.
- `llm-docs agent doctor --json` is read-only environment diagnostics. Do not claim `agent install codex` or any other install/lifecycle command unless `capabilities --json` reports it as implemented.
- Parser plugins: treat explicit parser plugin generation as one local source file or opted-in directory plus one explicit local manifest plus one custom format id only. Plugin code is trusted local code and is not sandboxed; `plugins validate` validates manifests only — it never loads or executes plugin code.

## Step 1 — PIN THE VERSION (before anything else)

WHY: the entire value of a pack is that it matches the exact version the consuming project runs. Resolve that version from the project's own package-manager metadata, not from memory or "latest". The metadata source is ecosystem-specific; the rule is not.

1. Read the exact installed version and upstream repo from the package manager's own metadata. npm worked example:

```bash
cat <project>/node_modules/<pkg>/package.json   # read "version" and "repository"
```

The `repository` field gives you `url` (the monorepo) and often `directory` (the package's subpath inside it). Both are primary evidence — use them, do not guess the repo. Other ecosystems publish the same two facts elsewhere (see the non-npm reference below); resolve version and repo from whatever metadata the package manager installed, never from memory.

2. Resolve the git tag for that exact version and its commit:

```bash
git ls-remote --tags <repository.url> | grep -E '<pkg>@<version>|v<version>'
```

Record repo URL + tag + commit. That commit is what you clone and what the label cites.

3. Monorepo release-model nuance (decide explicitly, do not assume):
   - Some monorepos release in **lockstep** — every package shares one commit per version (e.g. TanStack/query). One tag covers all packages.
   - Others release **independently** — per-package tags land at different commits (e.g. TanStack/router). `<pkgA>@x` and `<pkgB>@y` are different commits.
   - When one pack must cover multiple packages from the same repo, check whether the shared docs tree actually differs across the relevant tags before picking one commit:

```bash
git rev-parse <tagA>:<docs-path>   # tree hash of the docs subtree at tag A
git rev-parse <tagB>:<docs-path>   # tree hash at tag B
# identical hash => docs are byte-identical; either tag is fine.
# different => diff them, then choose the newest tag whose differences are acceptable.
```

State the tag you chose and why. `repo-docs-discovery` covers deeper package→repo→docs-tree resolution (e.g. a package whose docs live in a _different_ package's repo); use it when resolution is not obvious.

## Step 2 — CLONE PINNED

WHY: you generate from an immutable, known commit, never from a moving branch or a dirty working tree.

```bash
git clone --filter=blob:none <repository.url> <clone-dir>   # blobless keeps it fast
git -C <clone-dir> checkout <commit>                        # exact commit, not a branch name
git -C <clone-dir> rev-parse HEAD                           # confirm; this is your label commit
```

Keep the clone outside the consuming project's workspace. The manifest will auto-record `source.git {remoteUrl, commit, tags, dirty, sourceRootFromRepo}` when you generate from this checkout — so a clean checkout is what makes provenance trustworthy.

## Step 3 — INSPECT BEFORE GENERATING (mandatory)

WHY: the engine faithfully converts whatever you point it at. If drafts, a wrong framework subtree, or non-markdown noise are in scope, they land in the pack. Decide exclusions and slicing NOW, before the first `generate`.

Walk the docs tree at the pinned commit and look for:

- **Draft content** — `*.draft.md`, `drafts/` directories, `DRAFT`/`WIP` in frontmatter titles. These are not shipped docs; exclude them.
- **Docs-site nav config** — e.g. `config.json`, `docs.json`, sidebar/nav manifests. This carries the _authoritative category structure_ the vendor publishes. You will translate it into a `--categories` file in Step 4. The engine will not read it for you.
- **Non-markdown files** — images, scripts, JSON fixtures. The engine skips them and records a warning; know what you are dropping.
- **Multi-framework subtrees** — e.g. `docs/framework/react` vs `docs/framework/vue`, or `docs/start/framework/react`. Point `--source` at the exact framework subtree you want. Never point it at the whole docs root blindly — that is how a pack balloons to a multi-framework monolith.

Output of this step: the exact `--source` path, the `--exclude` globs, and the slicing plan.

## Step 4 — GENERATE

WHY: explicit flags make the pack reproducible and self-describing. Every flag below encodes a Step 1–3 decision.

```bash
llm-docs generate \
  --source <clone-dir>/<framework-subtree> \
  --format <explicit-format> \
  --label "<pkg>@<version> @ <commit7>" \
  --exclude '<glob>' [--exclude '<glob>' ...] \
  --split-by dirs \
  --output-dir <project>/agent-docs/<pkg>
```

Rules:

- **Always pass `--format` explicitly.** Do not rely on auto-detect for a real pack; ambiguity should fail loudly, not guess (see Troubleshooting).
- **Always pass `--label "<pkg>@<version> @ <commit7>"`.** It is recorded verbatim in `manifest.source.label` and stamped into the pack's `<SYSTEM>` header — this is how a future reader (or you) knows what version the pack is without trusting the directory name.
- **`--exclude` for every draft/unwanted subtree** you found in Step 3. Excluded files are recorded in the manifest, so exclusions stay auditable.
- **Slice large or multi-topic docs.** Two options:
  - `--split-by dirs` — one output file per top-level docs directory. Fast, structural.
  - `--categories <file.json>` — YOU author this by translating the vendor nav config from Step 3. Shape: `{"categories":[{"id","title","include":["glob"]}],"fallback":"misc"}`, **first-match-wins** ordering. This translation is your judgment; the engine cannot infer it. Prefer this when the nav config's grouping is better than raw directory layout.
  - Both modes still write the combined `-full` file alongside the per-topic files. A monolith with no split is a known failure — slice unless the pack is genuinely small.
- **One output dir per pack.** The filename prefix derives from the source dir _basename_: two sources both named `react` (e.g. router's and query's) produce identical filenames and will collide. Keep each pack in its own `--output-dir`, or set a distinct prefix, so `router-react-*` and `query-react-*` never overwrite each other.

The pack the engine writes embeds: frontmatter titles as headings, `[source: <relpath>]` markers per section, a `<prefix>-toc-llms.txt` table-of-contents artifact, `pack:<relpath>` internal links, and commit-pinned GitHub URLs for external links — all traceable back to the pinned commit.

## Step 5 — VERIFY + READ THE WARNINGS

WHY: `verify` proves the pack matches its manifest; `warnings[]` is the engine handing you facts it noticed but is not allowed to judge. Every warning is a decision you now owe.

```bash
llm-docs verify --output-dir <project>/agent-docs/<pkg>
```

Then open `manifest.json` and act on every `warnings[]` entry:

- **Skipped non-md files** — confirm you meant to drop them.
- **Draft-pattern files** — if one slipped through, add an `--exclude` and regenerate.
- **Unresolved links** — a `pack:` or external link that did not resolve; fix the source scope or accept it consciously.

If `manifest.source.git.dirty` is `true`, stop — you generated from a modified checkout; re-clone clean and regenerate (see Troubleshooting).

If the pack will live **away from the clone** (the normal case — packs ship inside the consuming project, the clone is disposable), verify after relocation with:

```bash
llm-docs verify --outputs-only --output-dir <project>/agent-docs/<pkg>
```

WHY `--outputs-only`: once relocated, the recorded source paths no longer exist; this checks output integrity against the manifest without re-reading vanished sources.

## Step 6 — REVIEW AND EXTEND THE INDEX (mandatory, yours)

WHY: without a good index, the next session reloads the whole pack into context — the exact waste this tool exists to prevent. `generate` seeds a starter `llm-docs/index.md` when none exists (file inventory, token estimates, top-level sections, pinned git provenance) and never touches it again: from that moment the map is yours. The seed is structure, not judgment — review it and extend it.

Make sure `llm-docs/index.md` carries:

- Versions covered, and for each: repo URL + commit + tag. The seed records the pinned remote@commit when git provenance was captured; add the rest.
- A table of the generated packs/categories (the `*-llms.txt` files and, if sliced, each topic file) with a one-line **what-to-grep-for** hint per row, so a later agent loads only the slice it needs. The seed lists files, token estimates, and section headings; the grep hints are your judgment.
- Any exclusions or known gaps worth remembering.

This file is a navigation aid, not a verified artifact: it is not in `manifest.json`, `verify` reports it as unmanaged and never fails it, and `generate`/`refresh` seed it only when absent and otherwise preserve it (they delete only tool-owned outputs — the `*-llms.txt` files, the `-toc-llms.txt`, and the chunks output). Keep it accurate to the files actually present.

## Step 7 — MAINTAIN

WHY: a pinned pack goes stale when upstream ships. Refresh is a deterministic rebuild from the recorded commit — not a version bump. Version bumps are a conscious re-pin.

On an upstream release:

1. Re-run Step 1 to re-resolve the new tag/commit for the newly installed version.
2. Re-clone at the new commit (Step 2).
3. Regenerate with the **same explicit flags** (same `--format`, `--exclude`, `--split-by`/`--categories`), and **bump `--label`** to the new `<pkg>@<version> @ <commit7>`.
4. Update `index.md` (Step 6).

For a deterministic rebuild from the already-recorded source (no version change):

```bash
llm-docs refresh --output-dir <project>/agent-docs/<pkg>
```

`refresh` **fails by default when the source HEAD != the recorded commit** (drift). That failure is a signal, not a bug: either re-obtain the exact recorded commit, or, if you have consciously decided the drift is acceptable, pass `--accept-drift`. Never `--accept-drift` reflexively — it silently accepts whatever the source now says.

## Non-npm Worked Reference (Python + RST)

The same pin → clone → inspect → generate flow on a non-npm ecosystem, to show the playbook is not npm-shaped. Only the metadata source and the format change; every WHY above still holds.

- **PIN (Step 1).** Resolve the installed version and repo from Python's own package metadata instead of `node_modules`:

```bash
python -c "import importlib.metadata as m; print(m.version('<dist>'))"  # installed version
pip show <dist>                                                          # version + summary
```

Read the repo from the project's `pyproject.toml` `[project.urls]` (e.g. `Repository`/`Source`) — the equivalent of npm's `repository` field.

- **CLONE (Step 2).** `git clone --filter=blob:none <repo>` and `checkout` the tag/commit for that exact version, identical to the npm flow.
- **INSPECT (Step 3).** Sphinx/RST projects keep docs under `docs/` as an RST tree (often topic- or framework-split) with a `conf.py`/`index.rst` nav; find drafts and non-doc files before generating.
- **GENERATE (Step 4).** Point `--source` at the RST subtree and pass `--format rst`:

```bash
llm-docs generate \
  --source <clone-dir>/docs \
  --format rst \
  --label "<dist>@<version> @ <commit7>" \
  --split-by dirs \
  --output-dir <project>/agent-docs/<dist>
```

Verify, author the index, and maintain exactly as Steps 5–7.

## Troubleshooting

- **Ambiguous-format error on `generate`** — the engine is refusing to guess the parser, not failing. Pass `--format` explicitly (`markdown`, `mdx`, `openapi`, `openref`, `rst`, `html`). This is Step 4's rule; treat auto-detect ambiguity as a prompt to be explicit.
- **`manifest.source.git.dirty: true`** — you generated from a modified or uncommitted checkout, so the recorded commit does not describe the actual bytes. Re-clone clean, `checkout <commit>`, confirm `git status` is empty, and regenerate.
- **Filename collision between two packs** — both sources share a basename (the prefix source). Put them in separate `--output-dir`s or set distinct prefixes; do not co-locate.
- **`verify` fails after moving the pack** — you moved it away from its source clone; use `verify --outputs-only`.
- **`refresh` fails with a drift error** — source HEAD moved off the recorded commit. Re-obtain the recorded commit, or `--accept-drift` only if you have decided the new source is acceptable.

## Maintaining This Repository

When you are modifying llm-docs-generator itself (not generating a pack):

1. Read `AGENT_CONTEXT.md`, `index.md`, and the relevant source/tests first.
2. Define acceptance criteria before editing.
3. Keep the CLI behavior, `capabilities --json` contract, tests, and these docs aligned — they are one contract.
4. Preserve the product boundary: the agent judges, the CLI stays deterministic and honest about failure. Reject any change that makes the CLI decide source authority, version, task fit, or "top candidate".
5. Run focused tests, typecheck, build, and a relevant CLI smoke before claiming completion.
