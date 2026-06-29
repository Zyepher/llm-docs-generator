# llm-docs-generator

**Give your AI coding agent the real docs for the exact library version you use, not its best guess.**

Your coding agent is sharp until it hits a library that has moved on without it. It reaches for the newest API it has seen, or blends three versions together, and writes code that doesn't compile against the version you actually run. `llm-docs-generator` fixes that: it turns a library's real documentation, at the version you choose, into a clean local pack your agent reads, so it codes against the API you actually have. You stay in plain English, your agent drives the tool, and every claim in the pack traces back to where it came from.

You don't run commands or memorize workflows. You talk to your agent. It does the rest.

---

## The problem: your agent is coding from memory

Say your project is on Tailwind CSS v3. You ask your agent to add a custom brand color, and it confidently writes:

```css
/* v4 syntax. Your v3 build has no idea what @theme is. */
@import "tailwindcss";
@theme {
  --color-brand: #6d28d9;
}
```

Looks current, and it is, for v4. But you're on v3, where that's three `@tailwind` directives plus a `tailwind.config.js`. The agent reached for the newest thing it had seen instead of the version you actually run. Now multiply that across every utility, plugin, and config option that changed between major versions.

The usual workarounds each trade one problem for another:

- **Paste the docs into chat.** You hunt down the right version's pages, they eat your context window, and they're gone by the next session.
- **Let the agent browse the web.** Slow, noisy HTML, JavaScript-rendered pages it can't actually read, and you can never tell which version, or even which page, it ended up using.
- **Dump the whole repo in.** A flood of context, most of it not documentation, and the agent *still* has to guess what's current.

And when the generated code turns out to be wrong, none of these can answer the only question that matters: **where did the agent get that, and is it still true?**

## The idea: a smart planner and a boringly trustworthy engine

The real mistake is handing one black box two very different jobs: deciding what the right docs are, and turning them into something usable. Then trusting whatever comes out.

`llm-docs-generator` splits those jobs in two:

- **Your AI agent is the planner.** It makes the judgment calls: which source is authoritative, which version you mean, how much to include.
- **`llm-docs` is the engine.** It does the repeatable part perfectly: parse the source, preserve its structure, write clean text your agent can read, and record exactly where every byte came from. It never guesses the source, and it never invents docs to look successful.

What comes back is a **local docs pack**: clean, structured, pinned to the version you asked for, and stamped with a manifest that hashes every source and every output. Docs your agent can read, and docs *you* can audit, verify, and refresh.

---

## Watch it work

Here's the whole loop for the Tailwind v3 example, written the way you'd actually say it to your agent.

### 1. Prepare the pack

> *"My project is on Tailwind CSS v3, not v4. Use llm-docs-generator to build me a local docs pack for Tailwind v3 so you stop suggesting v4 config that breaks my build."*

Your agent brings the right source itself (the Tailwind v3 docs, pulled down locally), then points the tool at it:

```bash
llm-docs generate --source ./tailwind-v3-docs --output-dir ./agent-docs/tailwind-v3
```

It parses every page, preserves the structure, and writes this:

```text
agent-docs/tailwind-v3/
├── manifest.json                       # provenance: every source file hashed, parser + formatter recorded
└── llm-docs/
    └── tailwind-v3-docs-full-llms.txt  # the whole v3 reference, one clean file your agent reads
```

Your agent also drops a small `llm-docs/index.md` of its own next to it: a quick map of the pack's main sections, so next session it scans the index first instead of reloading the whole file. (That index is the agent's nav aid, not part of the verified pack.)

The content is the real v3 documentation, including the exact forms v4 changed:

```text
@tailwind base;
@tailwind components;
@tailwind utilities;
```

In v4 those three directives collapse into a single `@import "tailwindcss"`, and `tailwind.config.js` moves into your CSS. Your pinned pack keeps the agent writing the v3 forms your project actually compiles.

### 2. Build against it

> *"Using the Tailwind v3 pack in `./agent-docs/tailwind-v3`, add a dark-mode toggle and a custom brand color. Use v3 config, don't give me v4."*

Now your agent reads the v3 pack from disk and writes a real v3 `tailwind.config.js` (`darkMode: 'class'`, `theme.extend.colors`) instead of v4's CSS-first `@theme`.

### 3. Keep it honest over time

> *"Tailwind shipped a new 3.x release. Rebuild my v3 pack and confirm it's still intact."*

```bash
llm-docs verify  --output-dir ./agent-docs/tailwind-v3   # confirm the pack still matches its manifest
```

`verify` re-hashes every file against the manifest and tells you, deterministically, whether the pack still matches what was generated. Two commands keep a pack trustworthy: `verify` catches drift or corruption, and `llm-docs refresh` rebuilds a pack from the exact source recorded in its manifest. When the upstream docs change, your agent re-fetches that source and regenerates; `refresh` on its own is a deterministic rebuild from what's already recorded.

That is the general path, and it works for almost any library with real docs: your agent finds the right version's source and converts it. A few popular SDKs (Supabase's clients) are wired in as a single `--sdk` command, with no source hunting at all.

---

## Why your agent codes better with it

| Coding from memory | With a docs pack |
| --- | --- |
| Guesses APIs from stale, blended training data | Reads the real API for the version you use |
| Reaches for the newest syntax (v4) in your v3 project | Pinned to the exact version you named |
| Docs pasted in, or the whole repo dumped into context | One clean local pack, read from disk on demand |
| No way to tell where it came from | Every file traces to a source hash in `manifest.json` |
| Docs silently rot | `verify` catches drift; `refresh` rebuilds from the recorded source |
| Web browsing: slow, noisy, non-repeatable | Local, clean, structured, deterministic |

---

## What else you can do with it

- **A Supabase client SDK? Even simpler.** If you use one (JavaScript/TypeScript, Swift, Kotlin, Dart/Flutter, Python, C#), skip the source hunting: it's a single built-in command. *(`llm-docs generate --sdk javascript --sdk-version v2`)*
- **Turn your own docs into a pack.** Point it at a local OpenAPI/Swagger spec, a Markdown/MDX/DocC folder, reStructuredText, or HTML, and get the same clean, manifest-backed output. *(`llm-docs generate --source ./docs --output-dir ./agent-docs`)*
- **Teach it a format it doesn't know.** Docs in a custom or proprietary shape? Write a small parser plugin and it reads your own. (See [`AGENT_CONTEXT.md`](AGENT_CONTEXT.md) for the manifest format.)
- **Document a codebase that has no docs.** The source-truth mode extracts conservative, code-derived facts (exported names, signatures, package/config) with file-level provenance: observations for your agent to build on, never invented behavior.
- **Power a search / RAG tool.** Add `--chunks jsonl` to emit semantic chunks with stable IDs and content hashes.

In every case the shape is the same: **you describe the goal, your agent picks the source and version, the CLI does the deterministic conversion and writes the provenance.**

---

## What it reads, and what it gives back

**Reads:** OpenRef YAML (Supabase specs) · OpenAPI 3.x & Swagger 2.0 · Markdown / MDX / DocC · reStructuredText · HTML (best-effort fallback).

**Writes:**

- `llm-docs/*.txt`: the clean docs your agent reads, a single combined file, plus one file per topic when the source carries its own categories (built-in `--sdk` packs, tagged OpenAPI specs)
- `manifest.json`: the paper trail of source paths and URLs, content hashes, versions, and the exact parser and formatter used
- `chunks/semantic-chunks.jsonl`: optional, for retrieval
- `discovery-report.json` / `failure.json`: bounded evidence, and honest failures when a source can't be used

---

## Getting started

While packaging is being finalized, run it straight from the repo:

```bash
git clone https://github.com/Zyepher/llm-docs-generator
cd llm-docs-generator
npm install
npm run build
```

Then build your first pack:

```bash
# point it at a folder of docs you already have
npx tsx src/cli.ts generate --source ./docs --output-dir ./agent-docs

# …or, with no inputs at all, smoke-test on a built-in SDK
npx tsx src/cli.ts generate --sdk javascript --sdk-version v2 --output-dir ./agent-docs/supabase-js
```

So your agent knows *how* to drive `llm-docs` from plain-English requests, point it at the bundled playbook: [`AGENT_CONTEXT.md`](AGENT_CONTEXT.md) and the drop-in skills under [`skills/`](skills/). Run `llm-docs capabilities --json` any time for the machine-readable list of what's actually implemented, and `llm-docs <command> --help` for options.

---

## Honest by design

The trust comes from what it refuses to do:

- **It won't pick your source for you.** It reports evidence; you and your agent decide what's authoritative.
- **It won't invent docs.** If a source can't be used, it fails out loud and says what it checked, and never fabricates low-confidence text to look successful.
- **It won't silently change your version.** Ask for v3, get v3, even when v4 is what everyone's talking about.
- **It tells you what it didn't do.** Provenance and limitations are written into every manifest.

Good agent documentation isn't just shorter documentation. It's structured, refreshable, verifiable, and honest about where every claim came from.

---

## Going deeper

- **[`AGENT_CONTEXT.md`](AGENT_CONTEXT.md)**: the full agent playbook, intent router, and complete command surface
- **[`skills/`](skills/)**: installable skills that teach an agent to investigate sources and call the CLI
- **`llm-docs capabilities --json`**: the source of truth for what's implemented vs. planned

**For contributors:** see `NEXT_GEN_PLAN.html`, `IMPLEMENTATION.md`, and `index.md`, then:

```bash
npm install
npm run type-check
npm test
npm run build
```

MIT licensed.
