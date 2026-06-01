# Build your first Wand

> Get started building your own Wand in about 15 minutes. By the end you'll have a working
> `changelog` Wand that an agent can create, fill out across two phases, and publish — all
> through the Wand tools.

---

## What you'll build

A **Wand** is a stateful object an agent crafts on disk: a directory with its own workflow,
its own tools, and its own rules about what can be written and when. Think of it as the
difference between *asking a model to write a changelog* and *handing the model a changelog
that knows how it's supposed to be built*.

In this tutorial you'll declare a `changelog` Wand with a two-phase linear workflow:

| Phase | Goal | Gate |
|-------|------|------|
| `collect` | Drop raw change entries into `entries/` | At least one non-empty entry exists |
| `publish` | Render a formatted `CHANGELOG.md` | The file contains a `## <version>` heading |

When you're done, an agent will be able to run:

```
CreateWand(kind: "changelog", name: "v1.2.0 release")
  → WandWrite("entries/auth.md", ...)        # collect phase
  → CheckPhase()                              # gate passes → advances to publish
  → WandWrite("CHANGELOG.md", ...)            # publish phase
  → CheckPhase({ version: "1.2.0" })          # gate passes → Wand completes
  → SaveAndCloseWand()
```

> **Note:** Wands ship inside a **Wand App** — a package that bundles one or more Wands and is
> discovered by a Wand-compatible runtime. You don't write any host code; a Wand is *declared*,
> not programmed.

## Core Wand concepts

Three primitives carry the whole system. You'll meet all three in this tutorial:

- **Wand** — the *type* declaration (`wand.json`). Defines the directory contract, the phase
  workflow, and the gate checks. One Wand App can declare many Wands.
- **Phase** — a stage in the workflow. Each phase injects its own instructions, exposes its
  own tools, and constrains which files may be written.
- **Gate check** — the pass/fail test that advances a phase. Either a script you provide
  (`check.js`) or a model judgement (`check.md`).

For the full model — tool exposure, cross-Wand composition, completion semantics — see the
[Authoring guide](./authoring-guide.md).

## Prerequisite knowledge

This guide assumes you're comfortable with:

- JSON and JSON Schema (the manifest and gate inputs are validated against it)
- Basic Node.js (gate-check scripts run on the runtime's bundled Node)
- Packaging a Wand App (a directory the runtime can discover)

## Before you start: the one rule

> **Files inside a Wand are written *only* through the Wand tools** (`WandWrite` / `WandEdit`).
> A shell `cp` or `mv` into the Wand directory is a contract violation — the runtime enforces
> path, phase, and write-glob rules that bypass the shell entirely. Your prompts must tell the
> agent this explicitly, because it's the single most common authoring mistake.

---

## Step 1 — Scaffold the Wand

A Wand is a directory inside your Wand App. Create this layout:

```
changelog/
├── wand.json                     # the manifest (machine contract)
└── wand/
    ├── prompt.md                 # top-level instructions (required)
    └── phases/
        ├── collect/
        │   ├── prompt.md         # phase instructions (required)
        │   └── check.js          # phase gate (script)
        └── publish/
            ├── prompt.md
            └── check.js
```

The **directory is the source of truth**: the runtime derives a phase's prompt and check
paths from its `id`. There are no path fields to point them elsewhere — name the folder
`collect` and the runtime looks for `wand/phases/collect/prompt.md`.

## Step 2 — Write the manifest (`wand.json`)

This is the machine contract. Every field below is required except where noted.

```json
{
  "$schema": "https://wandplus.dev/schema/v1/wand.schema.json",
  "version": "1.0",
  "kind": "changelog",
  "kindVersion": "1.0.0",
  "displayName": "Changelog",
  "description": "A release changelog. Two-phase linear flow: collect raw entries, then publish a formatted CHANGELOG.md. Use when the user wants to assemble or update a changelog or release notes.",
  "directoryContract": {
    "subdirTemplate": "wands/changelog/{wandId}",
    "requiredSubdirs": ["entries"]
  },
  "workflow": {
    "phaseFlowMode": "linear",
    "initialPhase": "collect",
    "phases": [
      {
        "id": "collect",
        "allowGlobs": ["entries/**"],
        "phaseGateCheck": {
          "mode": "script",
          "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }
      },
      {
        "id": "publish",
        "allowGlobs": ["CHANGELOG.md"],
        "phaseGateCheck": {
          "mode": "script",
          "inputSchema": {
            "type": "object",
            "properties": { "version": { "type": "string" } },
            "required": ["version"],
            "additionalProperties": false
          }
        }
      }
    ]
  }
}
```

A few things to notice — each maps to a concept you'll reuse in every Wand:

- **`description`** is the only text the agent sees when deciding whether to use this Wand
  (via `DescribeWand`) and the only text shown in the UI list. Say *what it is* **and**
  *when to reach for it*. Keep it under ~200 characters.
- **`directoryContract.subdirTemplate`** decides where instances land. `{wandId}` is
  substituted at creation time (`wands/changelog/wand_1a2b3c4d`). The path is relative to the
  runtime's working sandbox.
- **`requiredSubdirs`** are `mkdir -p`'d on creation, so `entries/` exists before the agent
  writes to it.
- **No `tools` block.** That's deliberate. Every active phase gets a fixed **baseline** for
  free — `WandRead`, `WandWrite`, `WandEdit`, `CheckPhase`, `SaveAndCloseWand`, `CopyWand`,
  plus `TodoWrite` and `AskUserQuestion`. A minimal Wand needs nothing more. You only declare
  `tools` to *opt in* to extra tools like `Bash` or an image generator. See the
  [authoring guide](./authoring-guide.md#tool-exposure).
- **`allowGlobs`** is the write fence for the phase. In `collect` the agent can write under
  `entries/`; in `publish` it can write `CHANGELOG.md`. A write outside the fence is rejected
  with a clear error.

## Step 3 — Write the instructions

**`wand/prompt.md`** — injected in every phase. Keep it short; it's shared context.

```markdown
You are assembling a release changelog.

Always write files with the Wand tools (WandWrite / WandEdit). Never use shell copy or
move for files inside this Wand.

Work in two stages: first collect raw change entries, then publish a single formatted
CHANGELOG.md. Keep entries terse — one bullet per change.
```

**`wand/phases/collect/prompt.md`** — injected when the `collect` phase is active.

```markdown
Phase goal: gather the raw material.

For each notable change, write a short markdown file under `entries/`, e.g.
`entries/auth.md` containing a line like `- Added SSO login`.

When you have at least one entry, call `CheckPhase()` (no arguments) to advance.
```

**`wand/phases/publish/prompt.md`** — injected when the `publish` phase is active.

```markdown
Phase goal: produce the final changelog.

Read everything under `entries/`, then write `CHANGELOG.md` with a version heading
and grouped bullets:

    ## 1.2.0

    ### Added
    - ...

When the file is ready, call `CheckPhase({ "version": "1.2.0" })` using the real
version number. On pass, the Wand is complete.
```

## Step 4 — Write the gate checks

A script gate reads the agent's `CheckPhase` arguments and the files on disk, then prints a
verdict. The contract is small and fixed:

- It receives a JSON object on **stdin**: `{ phase, args, wandDir, wandRoot }`.
- `WAND_DIR`, `WAND_KIND`, `WAND_PHASE`, `WAND_ROOT` are in the **env**.
- It must print a JSON object as its **last line of stdout**: `{ "passed": boolean, "hint"?: string }`.
- Exit code `0`. Any crash, non-zero exit, or unparseable output is treated as **`passed: false`** —
  gates are fail-safe by design.

**`wand/phases/collect/check.js`**

```js
#!/usr/bin/env node
'use strict'
const fs = require('fs/promises')
const path = require('path')

function emit(passed, hint) {
  console.log(JSON.stringify(hint ? { passed, hint } : { passed }))
  process.exit(0)
}

;(async () => {
  try {
    const dir = path.join(process.env.WAND_DIR, 'entries')
    let files
    try {
      files = await fs.readdir(dir)
    } catch {
      return emit(false, 'No entries/ directory yet. Write at least one entry first.')
    }
    const md = files.filter((f) => f.endsWith('.md'))
    if (md.length === 0) {
      return emit(false, 'No .md files in entries/. Add at least one change entry.')
    }
    for (const f of md) {
      const text = await fs.readFile(path.join(dir, f), 'utf8')
      if (text.trim().length > 0) return emit(true)
    }
    emit(false, 'entries/ files are all empty. Add at least one change line.')
  } catch (err) {
    emit(false, `collect check error: ${err.message}`)
  }
})()
```

**`wand/phases/publish/check.js`**

```js
#!/usr/bin/env node
'use strict'
const fs = require('fs/promises')
const path = require('path')

function readStdin() {
  return new Promise((resolve) => {
    let raw = ''
    process.stdin.on('data', (c) => (raw += c))
    process.stdin.on('end', () => resolve(raw))
  })
}

function emit(passed, hint) {
  console.log(JSON.stringify(hint ? { passed, hint } : { passed }))
  process.exit(0)
}

;(async () => {
  try {
    const input = JSON.parse((await readStdin()) || '{}')
    const version = (input.args || {}).version
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      return emit(false, 'Pass a semver version, e.g. CheckPhase({ version: "1.2.0" }).')
    }
    let body
    try {
      body = await fs.readFile(path.join(process.env.WAND_DIR, 'CHANGELOG.md'), 'utf8')
    } catch {
      return emit(false, 'CHANGELOG.md not found. Write it before checking.')
    }
    if (!body.includes(`## ${version}`)) {
      return emit(false, `CHANGELOG.md must contain a "## ${version}" heading.`)
    }
    emit(true)
  } catch (err) {
    emit(false, `publish check error: ${err.message}`)
  }
})()
```

> **Why hints matter:** the `hint` on a failed gate is fed straight back to the agent as the
> tool error. A good hint ("CHANGELOG.md must contain a `## 1.2.0` heading") lets the agent
> self-correct and retry without a human. A bad hint ("invalid") strands it. Write hints the
> way you'd write a helpful compiler error.

> **Runtime footnote:** the standard names the gate environment variables `WAND_*`. The first
> reference runtime (MCPlato) currently still emits the legacy `ARTIFACT_*` names for the same
> values. If you're targeting that runtime today, read `process.env.WAND_DIR || process.env.ARTIFACT_DIR`
> until it catches up. This is the only place the old name surfaces.

## Step 5 — Run it

Package the `changelog/` directory into a Wand App and load it into a Wand-compatible runtime
(MCPlato is the first reference runtime). Then, in a workspace, ask the agent to use it — e.g.
*"Start a changelog for the 1.2.0 release."* The agent discovers the Wand from its
`description`, calls `CreateWand`, and the runtime will:

1. Generate an id (`wand_<8 hex>`) and create `wands/changelog/<id>/entries/`.
2. Write the instance state file `.wand.json` with `currentPhase: "collect"`.
3. Enter **Wand mode** — from now until the Wand closes, the agent's system prompt carries
   your `prompt.md` + the `collect` phase prompt, and its tools collapse to your baseline.

Drive it through both phases. On the final `CheckPhase` pass, `currentPhase` becomes `null`
(completed) and the tool surface collapses to read-only.

## What's happening under the hood

Now that you've seen it work, here's the cycle each `CheckPhase` runs through:

1. The agent calls `CheckPhase` with arguments matching your phase's `inputSchema`.
2. The runtime **validates** those arguments against the schema *before* running anything.
3. It spawns your `check.js`, `cwd` = the Wand instance directory, piping
   `{ phase, args, wandDir, wandRoot }` on stdin.
4. It reads the last stdout line as the verdict.
5. **On pass (linear mode):** `currentPhase` advances to the next phase in declaration order;
   after the last phase it becomes `null` (completed). The new phase's prompt and tools are
   swapped in atomically.
6. **On fail:** state is unchanged, the `hint` is returned to the agent, and it can fix its
   output and retry — there's no retry limit.

The phase history lives in `.wand.json`'s append-only `phaseLog` — that array's order *is* the
workflow history, and it's what powers handoff and rewind later.

## Troubleshooting

<details>
<summary>The agent never offers to create my Wand</summary>

The Wand is discovered by its `description`. Make it specific and include the trigger words a
user would say ("changelog", "release notes"). Also confirm your Wand App is loaded into the
runtime and visible in the current workspace.
</details>

<details>
<summary>CheckPhase always fails, even when the files look right</summary>

Run your `check.js` by hand to see what it prints:

```bash
echo '{"phase":"collect","args":{},"wandDir":"/abs/path/to/instance","wandRoot":"/abs/path/to/changelog"}' \
  | WAND_DIR=/abs/path/to/instance node wand/phases/collect/check.js
```

The **last line** of stdout must be valid JSON `{ "passed": true }`. A `console.log` for
debugging earlier in the script is fine, but a non-JSON *last* line reads as a fail. Remember
gates are fail-safe: a crash or non-zero exit is `passed: false`.
</details>

<details>
<summary>WandWrite is rejected with "not allowed in phase"</summary>

The path didn't match the phase's `allowGlobs`. In `collect` only `entries/**` is writable;
`CHANGELOG.md` only becomes writable in `publish`. Either widen the glob or move the write to
the right phase. Runtime-owned files (`.wand.json`, anything under `sources/`) are never
writable regardless of globs.
</details>

<details>
<summary>A phase prompt shows a "[warning: missing ...]" block</summary>

`wand/prompt.md` and every `wand/phases/<id>/prompt.md` are required. When one is missing the
runtime injects a loud warning into the system prompt instead of failing silently. Create the
file; the folder name must match the phase `id` exactly.
</details>

## Next steps

- **[Authoring guide](./authoring-guide.md)** — phase design, the full manifest reference,
  script vs. prompt gates, tool opt-in, and the pre-ship checklist.
- **[Manifest schema](../schema/wand.schema.json)** — the canonical JSON Schema your `wand.json`
  is validated against.
- **[`examples/changelog`](../examples/changelog)** — the full Wand you just built, ready to run.
