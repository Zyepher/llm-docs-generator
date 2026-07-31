# llm-docs-generator

**Give your AI coding agent the real docs for the exact library version you use, not its best guess.**

Your coding agent is sharp until it hits a library that has moved on without it. It reaches for the newest API it has seen, or blends three versions together, and writes code that doesn't compile against the version you actually run. `llm-docs-generator` fixes that: it turns a library's real documentation, at the version you choose, into a clean local pack your agent reads, so it codes against the API you actually have. You stay in plain English, your agent drives the tool, and every claim in the pack traces back to where it came from. Library docs are the headline use, not the boundary: the same engine packs any body of text you need an agent to read faithfully, from internal runbooks and API specs to a shelf of textbooks your agent converted from PDF.

You don't run commands or memorize workflows. You talk to your agent. It does the rest.

---

## The problem: your agent is coding from memory

Say your project is on Tailwind CSS v3. You ask your agent to add a custom brand color, and it confidently writes:

```css
/* v4 syntax. Your v3 build has no idea what @theme is. */
@import 'tailwindcss';
@theme {
  --color-brand: #6d28d9;
}
```

Looks current, and it is, for v4. But you're on v3, where that's three `@tailwind` directives plus a `tailwind.config.js`. The agent reached for the newest thing it had seen instead of the version you actually run. Now multiply that across every utility, plugin, and config option that changed between major versions.

The usual workarounds each trade one problem for another:

- **Paste the docs into chat.** You hunt down the right version's pages, they eat your context window, and they're gone by the next session.
- **Let the agent browse the web.** Slow, noisy HTML, JavaScript-rendered pages it can't actually read, and you can never tell which version, or even which page, it ended up using.
- **Dump the whole repo in.** A flood of context, most of it not documentation, and the agent _still_ has to guess what's current.

And when the generated code turns out to be wrong, none of these can answer the only question that matters: **where did the agent get that, and is it still true?**

## The idea: a smart planner and a boringly trustworthy engine

The real mistake is handing one black box two very different jobs: deciding what the right docs are, and turning them into something usable. Then trusting whatever comes out.

`llm-docs-generator` splits those jobs in two:

- **Your AI agent is the planner.** It makes the judgment calls: which source is authoritative, which version you mean, how much to include.
- **`llm-docs` is the engine.** It does the repeatable part perfectly: parse the source, preserve its structure, write clean text your agent can read, and record exactly where every byte came from. It never guesses the source, and it never invents docs to look successful.

What comes back is a **local docs pack**: clean, structured, pinned to the version you asked for, and stamped with a manifest that hashes every source and every output. Docs your agent can read, and docs _you_ can audit, verify, and refresh.

---

## Watch it work

Here's the whole loop for the Tailwind v3 example, written the way you'd actually say it to your agent.

### 1. Prepare the pack

> _"My project is on Tailwind CSS v3, not v4. Use llm-docs-generator to build me a local docs pack for Tailwind v3 so you stop suggesting v4 config that breaks my build."_

Your agent brings the right source itself (the Tailwind v3 docs, pulled down locally), then points the tool at it:

```bash
llm-docs generate --source ./tailwind-v3-docs --output-dir ./agent-docs/tailwind-v3
```

It parses every page, preserves the structure, and writes this:

```text
agent-docs/tailwind-v3/
├── manifest.json                       # provenance: every source file hashed, parser + formatter recorded
└── llm-docs/
    ├── index.md                        # seeded starter map, agent-owned from here on
    └── tailwind-v3-docs-full-llms.txt  # the whole v3 reference, one clean file your agent reads
```

The tool also seeds a small `llm-docs/index.md` next to the pack: a starter map listing each generated file with its token estimate and main sections, so next session your agent scans the index first instead of reloading the whole file. From the moment it exists that index belongs to your agent: it edits and extends it, the tool never overwrites it, and regenerating or refreshing the pack preserves it (the tool only deletes its own outputs, and the index is not part of the verified pack).

The content is the real v3 documentation, including the exact forms v4 changed:

```text
@tailwind base;
@tailwind components;
@tailwind utilities;
```

In v4 those three directives collapse into a single `@import "tailwindcss"`, and `tailwind.config.js` moves into your CSS. Your pinned pack keeps the agent writing the v3 forms your project actually compiles.

### 2. Build against it

> _"Using the Tailwind v3 pack in `./agent-docs/tailwind-v3`, add a dark-mode toggle and a custom brand color. Use v3 config, don't give me v4."_

Now your agent reads the v3 pack from disk and writes a real v3 `tailwind.config.js` (`darkMode: 'class'`, `theme.extend.colors`) instead of v4's CSS-first `@theme`.

### 3. Keep it honest over time

> _"Tailwind shipped a new 3.x release. Rebuild my v3 pack and confirm it's still intact."_

```bash
llm-docs verify  --output-dir ./agent-docs/tailwind-v3   # confirm the pack still matches its manifest
```

`verify` re-hashes every file the manifest lists, reports any file in the pack it does not cover, and tells you, deterministically, whether the pack still matches what was generated. It checks in both directions: an unlisted file that imitates the tool's own output naming fails verification, and files added to the pinned source directory since generation fail the source tier with the exact paths named. Anything else unlisted (the agent-owned `llm-docs/index.md`, a stray `.DS_Store`) is listed informationally and never fails the pack. Two commands keep a pack trustworthy: `verify` catches drift or corruption, and `llm-docs refresh` rebuilds the pack from the exact source and options recorded in its manifest, same filenames, same splits, same exclusions, byte-identical when nothing upstream changed. When the upstream docs do change, your agent re-fetches that source and regenerates.

That is the general path, and it works for almost any library with real docs: your agent finds the right version's source and converts it. A few popular SDKs (Supabase's clients) are wired in as a single `--sdk` command, with no source hunting at all.

---

## Why your agent codes better with it

| Coding from memory                                    | With a docs pack                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| Guesses APIs from stale, blended training data        | Reads the real API for the version you use                          |
| Reaches for the newest syntax (v4) in your v3 project | Pinned to the exact version you named                               |
| Docs pasted in, or the whole repo dumped into context | One clean local pack, read from disk on demand                      |
| No way to tell where it came from                     | Every file traces to a source hash in `manifest.json`               |
| Claims float free of the text                         | Every chunk cites its source file and line range, hash-bound        |
| Docs silently rot                                     | `verify` catches drift; `refresh` rebuilds from the recorded source |
| Web browsing: slow, noisy, non-repeatable             | Local, clean, structured, deterministic                             |

---

## What else you can do with it

- **A Supabase client SDK? Even simpler.** If you use one (JavaScript/TypeScript, Swift, Kotlin, Dart/Flutter, Python, C#), skip the source hunting: it's a single built-in command. _(`llm-docs generate --sdk javascript --sdk-version v2 --output-dir ./agent-docs`)_ Pass `--output-dir`; without it, `--sdk` writes to its legacy monorepo default (`../../public/llms-openref`, outside your project).
- **Turn your own docs into a pack.** Point it at a local OpenAPI/Swagger spec, a Markdown/MDX/DocC folder, reStructuredText, or HTML, and get the same clean, manifest-backed output. _(`llm-docs generate --source ./docs --output-dir ./agent-docs`)_
- **Teach it a format it doesn't know.** Docs in a custom or proprietary shape? Write a small parser plugin and it reads your own. (See [`index.md`](index.md) for the plugin manifest format and [`AGENT_CONTEXT.md`](AGENT_CONTEXT.md) for the plugin workflow.)
- **Teach it a private marker syntax.** Docs that embed tab switchers or other directive comments in an explicit marker syntax? Add a small markdown _directive dialect_ — a deterministic transform keyed to that exact marker. (See [`AGENT_CONTEXT.md`](AGENT_CONTEXT.md), _Adding a markdown directive dialect_.)
- **Document a codebase that has no docs.** The source-truth mode extracts conservative, code-derived facts (exported names, signatures, member rosters, package/config) with file-level provenance: observations for your agent to build on, never invented behavior.
- **Power a search / RAG tool.** Add `--chunks jsonl` to emit semantic chunks with stable IDs, content hashes, root-relative source paths, and (for markdown-family sources) original-file line ranges.

In every case the shape is the same: **you describe the goal, your agent picks the source and version, the CLI does the deterministic conversion and writes the provenance.**

---

## Beyond library docs: anything an agent should quote instead of half-remember

The engine doesn't know it's reading a changelog. It knows structure, hashes, and provenance, which means the same loop works for any long text where "roughly what the model remembers" isn't good enough: internal runbooks, compliance policies, hardware manuals, course notes, textbooks.

Say you have ten textbooks as PDFs and want a study partner that argues from the actual text. Your agent converts each book to Markdown, embedding page markers as it goes so page numbers survive into the pack, and the engine packs the conversions exactly like a docs folder: one manifest hashing every file, a seeded index mapping every book, and chunks that carry file and line ranges. From there the agent teaches from the book, cites `thermodynamics.md` lines 840 to 872 with a hash that proves those lines are what you packed, and `verify` will tell you if the material ever drifts.

Two limits worth knowing before you commit an evening to it. The pack is only as faithful as the conversion: dense math and complex layouts are the hard part, and that quality question belongs to the agent, not the engine. And a pack is navigation, not search: your agent finds things through the index, the headings, and grep, which works well at this scale; if you want semantic retrieval, the chunks JSONL is the clean handoff to a real retrieval system.

---

## What it reads, and what it gives back

**Reads:** OpenRef YAML (Supabase specs) · OpenAPI 3.x & Swagger 2.0 · Markdown / MDX / DocC · reStructuredText · HTML (best-effort fallback).

PDFs are deliberately absent from that list. Extracting a PDF is judgment work, so your agent does the conversion to Markdown, and the engine packs, hashes, and verifies the conversion like any other source.

**Writes:**

- `llm-docs/*.txt`: the clean docs your agent reads, a single combined file, plus per-topic slices when the source declares structure to cut along (directory layout via `--split-by dirs`, an explicit `--categories` taxonomy from your agent, spec tags, built-in `--sdk` catalogs)
- `llm-docs/index.md`: a seeded starter map (each file, its token estimate, its main sections), written only when absent; from then on it belongs to your agent and is never overwritten
- `manifest.json`: the paper trail of source paths and URLs, content hashes, versions, the exact parser and formatter used, and every generation option needed to rebuild the same pack
- `chunks/semantic-chunks.jsonl`: optional, for retrieval; stable IDs, content hashes, root-relative source paths, and original-file line ranges for markdown-family sources
- `discovery-report.json`: bounded evidence from `discover`; and `failure.json`, the honest failure record `source-truth generate` / `verify-docs` write when a source yields no usable evidence (rather than a misleading empty pack)

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

# …or smoke-test on a built-in SDK (this one downloads its spec, so it needs
# network; --sdk swift --sdk-version v2 uses the spec vendored in config/ and
# works offline)
npx tsx src/cli.ts generate --sdk javascript --sdk-version v2 --output-dir ./agent-docs/supabase-js
```

So your agent knows _how_ to drive `llm-docs` from plain-English requests, point it at the bundled playbook: [`AGENT_CONTEXT.md`](AGENT_CONTEXT.md) and the drop-in skills under [`skills/`](skills/). Run `llm-docs capabilities --json` any time for the machine-readable list of what's actually implemented, and `llm-docs <command> --help` for options.

---

## Honest by design

The trust comes from what it refuses to do:

- **It won't pick your source for you.** It reports evidence; you and your agent decide what's authoritative.
- **It won't invent docs.** If a source can't be used, it fails out loud and says what it checked, and never fabricates low-confidence text to look successful.
- **It won't silently change your version.** Ask for v3, get v3, even when v4 is what everyone's talking about.
- **It won't fabricate a citation.** A cross-reference is rewritten only to a file proven to exist, in the pack or in the repository; anything unprovable is left as written and counted, and no rewritten link can point outside the repository it claims to cite.
- **It won't lose content silently.** A value too large to inline is visibly marked as omitted, a skipped file (say, a `.pdf` in the source folder) is counted in the manifest warnings, and every unrewritten link is tallied by reason.
- **It tells you what it didn't do.** Provenance and limitations are written into every manifest.

Good agent documentation isn't just shorter documentation. It's structured, refreshable, verifiable, and honest about where every claim came from.

---

## Going deeper

- **[`AGENT_CONTEXT.md`](AGENT_CONTEXT.md)**: the full agent playbook, intent router, and complete command surface
- **[`skills/`](skills/)**: installable skills that teach an agent to investigate sources and call the CLI
- **`llm-docs capabilities --json`**: the source of truth for what's implemented vs. planned

**For contributors:** see `index.md`, then:

```bash
npm install
npm run type-check
npm test
npm run build
```

MIT licensed.
