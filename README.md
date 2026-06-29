# llm-docs-generator

**Give your AI coding agent the real, current docs for a library — not its best guess.**

Your coding agent is brilliant right up until it hits a library it only half‑remembers. Then it invents methods, blends versions together, and writes code that doesn't compile. `llm-docs-generator` fixes that: it turns a library's *actual* documentation into a clean, version‑pinned pack your agent reads locally, so it codes against the real API. You stay in plain English, your agent drives the tool, and every line of the pack traces back to where it came from.

You don't run commands or memorize workflows. You talk to your agent. It does the rest.

---

## The problem: your agent is coding from memory

Say you're building a native iOS app on [`supabase-swift`](https://github.com/supabase/supabase-swift). You ask your agent to wire up email‑and‑password auth, and it confidently writes something like:

```swift
// Looks right. Compiles against the wrong version — or another SDK's shape entirely.
let user = try await supabase.auth.signUp(email, password)
```

Plausible. Wrong. The agent is recalling `supabase-swift` from training data that's frozen at its cutoff, blurred together with five other languages' Supabase SDKs, and stale by however many releases have shipped since.

The usual workarounds each trade one problem for another:

- **Paste the docs into chat.** You hunt them down, they eat your context window, and they're gone by the next session.
- **Let the agent browse the web.** Slow, noisy HTML, JavaScript‑rendered pages it can't actually read — and you can never tell which version, or even which page, it ended up using.
- **Dump the whole repo in.** Tens of thousands of tokens, most of it not documentation, and the agent *still* has to guess what's current.

And when the generated code turns out to be wrong, none of these can answer the only question that matters: **where did the agent get that, and is it still true?**

## The idea: a smart planner and a boringly trustworthy engine

The real mistake is handing one black box two very different jobs — *decide what the right docs are* **and** *turn them into something usable* — then trusting whatever comes out.

`llm-docs-generator` splits those jobs in two:

- **Your AI agent is the planner.** It makes the judgment calls: which source is authoritative, which version you mean, how much to include.
- **`llm-docs` is the engine.** It does the repeatable part perfectly: parse the source, preserve its structure, write clean text your agent can read, and record exactly where every byte came from. It never guesses the source, and it never invents docs to look successful.

What comes back is a **local docs pack**: clean, structured, pinned to the version you asked for, split by topic so it's cheap to load, and stamped with a manifest that hashes every source and every output. Docs your agent can read — and docs *you* can audit, verify, and refresh.

---

## Watch it work

Here's the whole loop for the `supabase-swift` example — written the way you'd actually say it to your agent.

### 1. Prepare the pack

> *"I'm building a native iOS app on supabase-swift (the v2 line). Use llm-docs-generator to build a local, agent‑ready docs pack for the Supabase Swift SDK v2 in `./agent-docs`, so you have its exact current API to work from."*

Under the hood, your agent runs a single command:

```bash
llm-docs generate --sdk swift --sdk-version v2 --output-dir ./agent-docs/supabase-swift
```

It fetches the official Supabase OpenRef spec, parses it, and writes this:

```text
agent-docs/supabase-swift/swift/v2/
├── manifest.json                              # provenance: source URL, hashes, versions, parser/formatter
├── parsed/
│   └── swift-v2-spec.json                     # the normalized structure
└── llm-docs/
    ├── supabase-swift-v2-full-llms.txt        # everything            (~4,900 lines)
    ├── supabase-swift-v2-auth-llms.txt        # authentication        (~1,200 lines)
    ├── supabase-swift-v2-database-llms.txt    # database / queries    (~2,500 lines)
    ├── supabase-swift-v2-realtime-llms.txt    # realtime subscriptions
    ├── supabase-swift-v2-storage-llms.txt     # storage
    ├── supabase-swift-v2-edge-functions-llms.txt
    └── supabase-swift-v2-initializing-llms.txt
```

Notice it's **split by topic**. When your agent works on auth, it loads the ~1,200‑line auth file — not the full ~4,900‑line reference. And the content is the real thing, including the iOS‑specific bits the agent would otherwise fumble:

```text
<SYSTEM>This is the developer documentation for the Supabase Swift SDK v2 — Authentication.</SYSTEM>

# Supabase Swift SDK v2 — Authentication

## Handling deep links (SwiftUI app lifecycle)

    SomeView()
      .onOpenURL { url in
        supabase.auth.handle(url)
      }
```

### 2. Build against it

> *"Using the Supabase Swift v2 pack in `./agent-docs/supabase-swift`, write a `SupabaseManager` that signs a user in with email + password and subscribes to realtime changes on a `messages` table. Match the v2 API exactly — don't guess."*

Now your agent reads `…-auth-llms.txt` and `…-realtime-llms.txt` from disk and writes code against method shapes that actually exist in the version you pinned.

### 3. Keep it honest over time

> *"A new supabase-swift release shipped. Regenerate my pack from the latest official spec, verify it, and tell me what changed in the auth API."*

```bash
llm-docs generate --sdk swift --sdk-version v2 --output-dir ./agent-docs/supabase-swift  # rebuild from upstream
llm-docs verify   --output-dir ./agent-docs/supabase-swift/swift/v2                       # nothing drifted or got corrupted
```

`verify` re‑hashes every file against the manifest and tells you, deterministically, whether the pack still matches what was generated. Your agent can diff the regenerated files and summarize what moved.

---

## Why your agent codes better with it

| Coding from memory | With a docs pack |
| --- | --- |
| Guesses APIs from stale, blended training data | Reads the library's current, real API |
| Confuses v1 and v2 method shapes | Pinned to the exact version you named |
| 46K tokens of spec dumped into context | Split by topic — load just `auth` when you need auth |
| "Where did it get that?" — no way to know | Every file traces to a source hash in `manifest.json` |
| Docs silently rot | `verify` catches drift; `refresh` rebuilds from the recorded source |
| Web browsing: slow, noisy, non‑repeatable | Local, clean, structured, deterministic |

---

## What else you can do with it

- **Any Supabase client SDK, in one command.** Swift, JavaScript/TypeScript, Kotlin, Dart/Flutter, Python, and C# are configured out of the box — across their released versions. (`llm-docs list-sdks`)
- **Pin a framework version.** *"Make me a Tailwind pack, but stay on Tailwind 3."* Your agent resolves the v3 source and converts that — it won't quietly hand you v4.
- **Turn your own docs into a pack.** Point it at a local OpenAPI/Swagger spec, a Markdown/MDX/DocC folder, reStructuredText, or HTML, and get the same clean, manifest‑backed output. *(`llm-docs generate --source ./docs --output-dir ./agent-docs`)*
- **Document a codebase that has no docs.** The source‑truth mode extracts conservative, code‑derived facts (exported names, signatures, package/config) with file‑level provenance — observations for your agent to build on, never invented behavior.
- **Power a search / RAG tool.** Add `--chunks jsonl` to emit semantic chunks with stable IDs and content hashes.

In every case the shape is the same: **you describe the goal, your agent picks the source and version, the CLI does the deterministic conversion and writes the provenance.**

---

## What it reads, and what it gives back

**Reads:** OpenRef YAML (Supabase specs) · OpenAPI 3.x & Swagger 2.0 · Markdown / MDX / DocC · reStructuredText · HTML (best‑effort fallback).

**Writes:**

- `llm-docs/*.txt` — the clean docs your agent reads, often split by topic
- `manifest.json` — the paper trail: source paths/URLs, content hashes, versions, and the exact parser/formatter used
- `parsed/*.json` — the normalized structure (configured SDKs)
- `chunks/semantic-chunks.jsonl` — optional, for retrieval
- `discovery-report.json` / `failure.json` — bounded evidence, and honest failures when a source can't be used

---

## Getting started

While packaging is being finalized, run it straight from the repo:

```bash
git clone https://github.com/Zyepher/llm-docs-generator
cd llm-docs-generator
npm install
npm run build
```

Then generate your first pack:

```bash
# from inside the repo
npx tsx src/cli.ts generate --sdk swift --sdk-version v2 --output-dir ./agent-docs/supabase-swift

# …or, after `npm link`, as the `llm-docs` binary from anywhere
llm-docs generate --sdk swift --sdk-version v2 --output-dir ./agent-docs/supabase-swift
```

So your agent knows *how* to drive `llm-docs` from plain‑English requests, point it at the bundled playbook — [`AGENT_CONTEXT.md`](AGENT_CONTEXT.md) and the drop‑in skills under [`skills/`](skills/). Run `llm-docs capabilities --json` any time for the machine‑readable list of what's actually implemented, and `llm-docs <command> --help` for options.

---

## Honest by design

The trust comes from what it refuses to do:

- **It won't pick your source for you.** It reports evidence; you and your agent decide what's authoritative.
- **It won't invent docs.** If a source can't be used, it fails out loud and says what it checked — it never fabricates low‑confidence text to look successful.
- **It won't silently change your version.** Pin v2, get v2.
- **It tells you what it didn't do.** Provenance and limitations are written into every manifest.

Good agent documentation isn't just shorter documentation. It's structured, refreshable, verifiable, and honest about where every claim came from.

---

## Going deeper

- **[`AGENT_CONTEXT.md`](AGENT_CONTEXT.md)** — the full agent playbook, intent router, and complete command surface
- **[`skills/`](skills/)** — installable skills that teach an agent to investigate sources and call the CLI
- **`llm-docs capabilities --json`** — the source of truth for what's implemented vs. planned

**For contributors:** see `NEXT_GEN_PLAN.html`, `IMPLEMENTATION.md`, and `index.md`, then:

```bash
npm install
npm run type-check
npm test
npm run build
```

MIT licensed.
