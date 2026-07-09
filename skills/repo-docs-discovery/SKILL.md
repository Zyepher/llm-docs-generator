---
name: repo-docs-discovery
description: Upstream-resolution playbook for turning an installed package into an explicit pinned docs source before calling llm-docs generate. Use to resolve a package to its repo, tag, commit, and docs tree, especially across monorepos where a package's docs live under another package's tree.
---

# repo-docs-discovery

This skill resolves the question Step 1 of the `llm-docs-generator` playbook asks: *for the exact version this project runs, where is the authoritative docs tree, at which commit?* You investigate and decide; `llm-docs` only converts the explicit local path you hand it. Hand generation a concrete answer: **repo URL + tag + commit + docs subtree path**, plus notes on anything non-obvious (drafts, framework subtrees, docs that live in another package's repo).

Every step states WHY so you can adapt it to a repo whose layout differs from the examples.

## Division Of Labor (never violate)

- You own version choice, source authority, docs-tree selection, and task fit.
- The CLI owns bounded inspection, parsing, formatting, and honest failure. It never decides which repo, tag, or docs path is authoritative.
- Never pass a package name, repo URL, docs URL, or discovery report to `generate --source`. Resolve it to an explicit local path first.
- Run `llm-docs capabilities --json` before assuming a discovery mode exists; modes not reported there are unavailable unless the installed CLI says otherwise. `llm-docs agent doctor --json` is read-only diagnostics; do not claim `agent install codex` or other lifecycle commands unless capabilities reports them.
- Never store credentials or tokens in reports, manifests, or notes.
- Do not execute repository scripts, docs-build scripts, or install hooks from an inspected source.

## Step 1 — Package → Repo (primary evidence: the installed package's own metadata)

WHY: the package the project actually installed names its own upstream repo in its installed metadata. That is stronger evidence than a web search or memory. The metadata store is ecosystem-specific; the rule — resolve version and repo from what the package manager installed — is not.

npm worked example — read the installed `package.json`:

```bash
cat <project>/node_modules/<pkg>/package.json
```

Read three fields:

- `version` — the exact version you must match.
- `repository.url` — the upstream repo (often a monorepo hosting many packages).
- `repository.directory` — the package's subpath *inside* that repo when present (e.g. `packages/react-query`). This tells you where the package lives, which is the anchor for finding its docs.

Cross-check the repo by confirming a tag exists for this version:

```bash
git ls-remote --tags <repository.url> | grep -E '<pkg>@<version>|v<version>'
```

If `repository.url` and the tag listing agree, the repo is resolved. If `package.json` lacks `repository`, fall back to the registry's `repository` field for that exact version — but the installed metadata is the primary evidence.

Non-npm ecosystems expose the same two facts elsewhere. Python worked example — resolve the version from installed metadata and the repo from the project's `pyproject.toml`:

```bash
python -c "import importlib.metadata as m; print(m.version('<dist>'))"  # installed version
pip show <dist>                                                          # version + summary
# repo: read [project.urls] (Repository/Source) in the project's pyproject.toml
```

Whatever the ecosystem, the rule holds: take version and repo from the metadata the package manager installed, then cross-check the tag on the resolved repo.

## Step 2 — Locate The Docs Tree Inside The Repo

WHY: a monorepo rarely puts a package's docs next to its code. Docs are usually centralized and often split by framework, so `repository.directory` (the code path) is not the docs path.

Clone at the pinned commit (blobless is enough for inspection), then look for the docs root and any framework split:

```bash
git clone --filter=blob:none <repository.url> <clone-dir>
git -C <clone-dir> checkout <commit>
git -C <clone-dir> ls-files 'docs/*' | head -50
```

Common shapes to recognize:

- **Root `docs/`** — a single docs tree for one product.
- **Framework-split subtrees** — `docs/framework/react`, `docs/framework/vue`, or nested product+framework like `docs/start/framework/react` vs `docs/router/framework/react`. Pick the exact subtree for the package and framework you are packing; a whole-`docs/` source pulls in every framework and every product.
- **A docs-site nav config** (`config.json`, `docs.json`, sidebar manifest) — note its path; the generation step translates it into a `--categories` file. It also confirms which pages the vendor actually ships (anything not in the nav is often a draft or internal page).

Record the exact docs subtree path relative to the repo root. That path is what generation points `--source` at.

## Step 3 — Confirm The Ref Covers ALL Target Packages

WHY: two general facts about monorepos break the naive "one package, one repo, one tag" assumption, and either can ship docs from the wrong commit or miss a package entirely. A package's docs may live in *another* package's repo/tree; and a monorepo may release either in **lockstep** (one commit per version across all packages) or **independently** (per-package tags at different commits). Prove which before you pin. (TanStack is the worked example below: `@tanstack/react-start`'s docs live in `TanStack/router`, `TanStack/router` releases independently, and `TanStack/query` releases lockstep.)

Two concrete traps to check:

1. **Docs that ship inside another package's tree.** Example: `@tanstack/react-start` documentation lives in the `TanStack/router` repo, not a `react-start` repo. So `node_modules/@tanstack/react-start/package.json` may point at `TanStack/router`, and the docs subtree is under router's tree. When a package's docs live under a *different* package's tree, verify it explicitly and **write it into the discovery notes** you hand to generation — do not let the generation step assume one package == one repo.

2. **Independent release commits with byte-identical docs.** In an independently-released monorepo (e.g. `TanStack/router`), `<pkgA>@x` and `<pkgB>@y` are different tags at different commits. Their shared or adjacent doc files (devtools, ssr, `@tanstack/ssr-query`) may nonetheless be **byte-identical** across those tags. Do not eyeball it or assume they differ — prove it:

```bash
# tree hash of the docs subtree at each relevant tag
git rev-parse <tagA>:<docs-subtree>
git rev-parse <tagB>:<docs-subtree>

# or a single shared file's blob hash across tags
git rev-parse <tagA>:<docs-subtree>/<file>.md
git rev-parse <tagB>:<docs-subtree>/<file>.md
```

Identical hash => the docs are the same bytes at both tags; you can safely cover both from one commit. Different => diff them and choose the newest tag whose differences are acceptable, or generate each package from its own tag. State the choice.

For lockstep-released monorepos (e.g. `TanStack/query`, one commit per version across all packages) this check is trivial — one tag covers everything — but still confirm the release model rather than assuming it.

## Step 4 — Hand Off Explicit, Annotated Inputs

WHY: the generation step (the `llm-docs-generator` playbook) is deterministic from here. Ambiguity you leave unresolved becomes a wrong pack.

Return, per target package:

- Repo URL, tag, and commit (the pinned ref).
- The exact docs subtree path to use as `--source`.
- **Explicit note when a package's docs live in another package's repo/tree** (the react-start-in-router case), so generation points at the right subtree.
- Whether the repo releases in lockstep or independently, and the tree/blob-hash evidence behind covering multiple packages from one commit.
- Drafts / framework subtrees / non-markdown noise seen, so generation sets `--exclude` and the right subtree.
- The nav-config path, if one exists, for `--categories` translation.

If evidence is incomplete or two candidate docs trees are equally plausible, say so and ask rather than guessing. Never silently pick the first thing found, silently upgrade a pinned version, or trust a stale docs path over the pinned ref.

## Optional: Bounded CLI Inspection

WHY: the CLI can produce a deterministic evidence report to review, but it never selects the source — its ordering is readability, not authority.

```bash
llm-docs discover --repo <repo-url> --scope <docs-subtree> --output-dir ./reports/<pkg>
```

Read `discovery-report.json` and its `manifest.json` as candidate evidence. Report order is not authority, freshness, or task-fit proof; you still decide. Run `llm-docs capabilities --json` first if unsure a discovery mode is implemented.
