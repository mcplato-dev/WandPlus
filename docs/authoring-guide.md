# Wand authoring guide

> Everything you need to design a production-quality Wand: the manifest reference, phase and
> gate design, tool exposure, and the rules the runtime enforces for you. If you haven't built
> one yet, start with the [Quickstart](./quickstart.md) — this guide assumes you know what a
> Wand, phase, and gate are.

---

## How a Wand differs from a Skill or an MCP server

These are three different primitives. Reach for the right one:

| | MCP server | Skill | **Wand** |
|---|---|---|---|
| What it is | A set of callable tools | A reusable instruction fragment | A **stateful object** crafted on disk |
| State | Stateless | Stateless | Persistent (`.wand.json` + files) |
| Has a workflow | No | No | Yes — phases with gates |
| Constrains writes/tools | No | No | Yes — per phase |
| Authored as | Code | `SKILL.md` prose | `wand.json` + prompts + gates |

If your feature is "let the agent *call* something," that's an MCP tool. If it's "teach the
agent *how* to do something," that's a Skill. If it's "have the agent *build and refine an
object* through stages, with rules about what's valid at each stage," that's a Wand.

---

## Anatomy of a Wand

A Wand is a directory inside a Wand App that a Wand-compatible runtime discovers:

```
<wand-app>/<wand>/
├── wand.json                     # machine contract (required)
├── templates/                    # optional seed files copied on creation
└── wand/
    ├── prompt.md                 # top-level system-prompt fragment (required)
    └── phases/
        └── <phaseId>/
            ├── prompt.md         # injected when this phase is active (required)
            ├── check.js          # gate when phaseGateCheck.mode = "script"
            └── check.md          # gate when phaseGateCheck.mode = "prompt"
```

Two non-negotiable conventions:

1. **The directory is the truth.** A phase's prompt and check paths are *derived* from its
   `id`. There is no field to relocate them. Rename the phase, rename the folder.
2. **Every prompt file is required.** Missing `prompt.md` files don't fail discovery — they
   inject a loud `[warning: missing ...]` block into the prompt so the gap is visible at
   runtime rather than silent.

---

## The manifest (`wand.json`)

### Root fields

| Field | Required | Notes |
|-------|----------|-------|
| `version` | yes | Schema version. Must be `"2.0"`. (v1 manifests using `kind`/`kindVersion` are not recognized.) |
| `appId` | yes | Globally-unique reverse-DNS identifier, exactly 3 segments: `<publisher>.<domain>.<slug>`. The publisher prefix is assigned by the runtime or distribution platform and guarantees global uniqueness — authors never invent it. |
| `appVersion` | yes | Semver of *this app definition*, e.g. `"1.0.0"`. Bump on changes. |
| `displayName` | yes | Provided by the human user at creation time, written verbatim. |
| `description` | yes | The retrieval text — see [Writing the description](#writing-the-description). |
| `developer` | no | Author/organization label (informational). |
| `category` | no | App-store-style category tag (informational). |
| `minPlatformVersion` | no | Required wand platform protocol floor (declared only). |
| `directoryContract` | yes | Where instances live and what they contain. |
| `entitlements` | no | Capability declarations (e.g. `mcpServers`). |
| `workflow` | yes | The phase flow. |
| `engineeringTools` | no | Tools triggered by the host UI/orchestration, **not** exposed to the agent. |

> Wand App-level visibility gating (which workspaces a Wand App is offered in) is configured on
> the Wand App package, not the Wand manifest. Declare it once there; it filters every Wand in
> the app uniformly.

### `directoryContract`

| Field | Required | Notes |
|-------|----------|-------|
| `folderName` | yes | Lowercase kebab slug (`^[a-z][a-z0-9-]*$`). The runtime owns the layout and assembles `wands/<folderName>/<wandId>.wand` under its data area. Never declare a full path template; the `{wandId}` placeholder mechanism is removed in v2. |
| `requiredSubdirs` | no | `mkdir -p`'d on creation. Include `"sources"` to enable [cross-Wand composition](#cross-wand-composition). |
| `initialFiles` | no | `{ path, templatePath }[]` — copied from the Wand's `templates/` into the new instance. |
| `requiredFiles` | no | `{ path }[]` — files that must exist (validation aid). |

### `entitlements`

| Field | Notes |
|-------|-------|
| `mcpServers` | `string[]`. Names of external MCP servers this Wand activates while open (wand-level, constant across phases). The runtime resolves the names to configured servers and keeps them active for the session. Per-phase tool visibility is still governed by `phases[].tools`. |

### Writing the description

`description` is the **only** text the agent reads when choosing a Wand (via `DescribeWand`)
and the only text the UI shows. One field does double duty, so it must state *what the Wand is*
**and** *when to use it*.

✅ **Good** — concrete, includes trigger words:
```
"A release changelog. Two-phase linear flow: collect raw entries, then publish a
formatted CHANGELOG.md. Use when the user wants to assemble or update release notes."
```

❌ **Avoid** — vague, no triggers:
```
"Helps with documents."
```

Keep it under ~200 characters. Lead with the noun (what it produces), then the trigger.

---

## Designing phases

### Linear vs. free

`workflow.phaseFlowMode` picks the transition semantics:

- **`linear`** — `phases[]` order *is* the flow. `CheckPhase()` (no `next_phase`) advances to
  the next phase; passing the last phase completes the Wand. Use this for the common case: a
  fixed pipeline (`collect → publish`, `outline → draft → review`).
- **`free`** — phases have no fixed order. `CheckPhase` **must** pass `next_phase`, valued as a
  phase `id` or the literal `"__FINAL__"` to complete. Use this only when the route genuinely
  branches (a router phase that dispatches to one of several specialized phases).

Default to `linear`. Free mode trades the runtime's automatic progression — and the `RewindWand`
tool, which is suppressed in free mode — for routing flexibility you usually don't need.

### PhaseDef fields

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | `^[a-z][a-z0-9_-]*$`. Must match the `wand/phases/<id>/` folder name. |
| `phaseGateCheck` | yes | The pass test. See [Phase gate checks](#phase-gate-checks). |
| `tools` | no | Tool opt-in for this phase. See [Tool exposure](#tool-exposure). |
| `allowGlobs` | no | Write fence (picomatch) relative to the Wand root. |
| `cleanupOnRewind` | no | Globs trashed when this phase is skipped by a rewind (linear only). |

### How many phases?

A phase earns its place when it has a **distinct gate** — a checkpoint where "done enough to
move on" is meaningfully testable. If two stages share the same success criteria, they're one
phase. Don't split for narration; split for verification.

### `allowGlobs` — the write fence

Each phase should only be able to write what that phase is *for*. In a `collect` phase, fence
to `entries/**`; in `publish`, fence to `CHANGELOG.md`. This does two things: it stops the
agent from corrupting earlier work, and it makes `cleanupOnRewind` safe and predictable.

Runtime-owned paths are **always** rejected regardless of globs: `.wand.json`,
`.wand-sources.json`, the handoff cache, and everything under `sources/`. You never need to
exclude them.

---

## Phase gate checks

A gate is the only way a phase advances. Every gate is **fail-safe**: anything the runtime
can't positively confirm as a pass — a missing script, a crash, a timeout, an unparseable
result, a model error — is treated as a fail. "Couldn't tell" never means "pass."

`phaseGateCheck.mode` is `"script"` or `"prompt"`.

### `mode: "script"` — deterministic checks

For anything you can verify in code: a file exists, JSON parses, a value matches.

- File: `wand/phases/<id>/check.js`.
- `inputSchema` (JSON Schema) is **validated before** the script runs — bad arguments never
  reach your code.
- **Input:** a JSON object on stdin — `{ phase, args, wandDir, wandRoot }`.
- **Env:** `WAND_DIR`, `WAND_APP_ID`, `WAND_PHASE`, `WAND_ROOT`.
- **Output:** the **last line of stdout** must be `{ "passed": boolean, "hint"?: string }`.
- **Runtime:** the runtime's bundled Node.js (not the system `PATH`); `cwd` is the Wand
  instance directory.
- **Timeout:** 120 s default; override with `phaseGateCheck.timeout`. A timeout is a fail.

If your script `require`s a dependency, **validate it yourself** and return
`{ passed: false, hint }` if it's missing — don't let the script crash, because a crash is an
opaque fail with no useful hint.

### `mode: "prompt"` — judgement checks

For criteria only a model can assess ("the draft addresses every point in the brief").

- File: `wand/phases/<id>/check.md` — instructions for the judge.
- `passCriteria` (string, required) — natural-language pass condition.
- The judge runs as an isolated evaluation: system prompt = framework preamble + your `check.md`
  + `passCriteria`; user prompt = the `CheckPhase` arguments. It returns the same
  `{ passed, hint }` shape.
- Same 120 s default timeout; same fail-safe rule (model/parse failure ⇒ fail).

Prefer `script` when the criterion is mechanical. Reserve `prompt` for genuinely subjective
gates — it's slower, costs a model call, and is less repeatable.

### Writing good hints

The `hint` on a failed gate is returned verbatim to the agent. It's your one channel to steer a
retry. Name the specific thing that's wrong and, when you can, the fix:

✅ `"CHANGELOG.md must contain a \"## 1.2.0\" heading."`
❌ `"validation failed"`

---

## Tool exposure

This is where authors most often over- or under-reach. The model is **baseline + opt-in**.

### The baseline (free, always on in active phases)

Every active phase exposes these without you declaring anything:

```
WandRead  WandWrite  WandEdit  CheckPhase
SaveAndCloseWand  CopyWand  TodoWrite  AskUserQuestion
```

A Wand that only reads and writes its own files — like the Quickstart's `changelog` — needs
**no `tools` block at all**.

### Opting in

Declare `tools` on a phase only to add tools *on top of* the baseline. The runtime enforces
your list against the **whole** tool catalog — anything not baseline and not opted-in is hidden
while the Wand is active.

```json
"tools": {
  "mode": "allow",
  "items": ["Bash", "mcp__image-tools__"]
}
```

`items` entries may be:

| Entry form | Example | Effect |
|------------|---------|--------|
| Base/native tool name | `"Bash"`, `"Read"`, `"WebFetch"` | Exposes that tool |
| MCP tool short name | `"GenerateImage"` | Exposes that one MCP tool |
| MCP family prefix token | `"mcp__image-tools__"` | Exposes every tool of that server |
| `"RewindWand"` | — | Opt-in; honored in **linear** mode only |

> `mode: "deny"` exists for backward compatibility and operates only over the Wand-tool
> universe. New Wands should use `mode: "allow"`.

### Per-tool prompt overrides

Tighten a tool's description for a phase with `overrides`. The override lands on the tool the
phase actually keeps — baseline or opted-in — so you don't have to re-list it in `items`:

```json
"tools": {
  "mode": "allow",
  "items": ["Bash"],
  "overrides": [
    { "name": "WandWrite", "prompt": "Write only files under output/. Never touch entries/." }
  ]
}
```

### Completion collapses the surface

When the last phase passes, `currentPhase` becomes `null` and the baseline turns **off**. The
tool surface collapses to a fixed read-only whitelist — `WandRead`, `SaveAndCloseWand`,
`CopyWand` — and the prompt gains a "completed" notice. A completed Wand is sealed; the way to
change it is `CopyWand` to derive a new version.

---

## The presentation layer

A Wand is an **app**, not just a prompt. Beyond logic, it can ship its own custom view so
it doesn't look like every other generic workflow. Declare it in the manifest:

```jsonc
{
  "icon": "wand-2",
  "presentation": {
    "static": { "entry": "view/static/index.html" }
  }
}
```

The static view shows *what this Wand is* at a glance — a single-page HTML bundle running in a
sandboxed iframe, communicating with the host through the **wand-host SDK**. The optional
runtime view shows *what this instance produced*, live while the agent is working, and can point
directly at the artifact's own HTML.

For the full API contract, container options (`full-page`, `shell`, `HUD`), live-refresh
protocol, and starter templates, see:

- **[Presentation spec](../spec/presentation.md)** — view lifecycle, manifest fields, and
  design rules.
- **[Host API spec](../spec/host-api.md)** — the complete `window.wandHost` surface and event
  reference.

---

## Lifecycle semantics you should design around

### Completion

`currentPhase: null` means done. `CheckPhase`, `WandWrite`, `WandEdit`, and `RewindWand` are all
rejected. Design your final phase as a true terminal — the Wand won't be edited again in place.

### Rewind (linear only)

`RewindWand(target_phase)` rolls a linear Wand back to an earlier phase it actually visited.
Files matched by the skipped phases' `cleanupOnRewind` globs are moved to the system recycle bin
(never hard-deleted; runtime files and `sources/` are always spared). Opt `RewindWand` into
non-final phases when a craft mistake should be recoverable; leave it out of the final phase
(use `CopyWand` instead).

`cleanupOnRewind` should target exactly the files a phase *produces*, so rewinding to before it
leaves no stale output. In the Quickstart, `publish` sets `cleanupOnRewind: ["CHANGELOG.md"]`.

### Copy

`CopyWand` deep-copies an instance, resets it to the initial phase, and auto-versions the name
(`Foo` → `Foo v2`). It's available in every phase and in the completed state — it's the
sanctioned "start a new version from this one" move.

---

## Cross-Wand composition (`sources`)

When one Wand is built *from* others (a video from scenes, a report from datasets), declare
`"sources"` in `requiredSubdirs`. That unlocks the `sources` argument on `CreateWand`:

```
CreateWand(app_id: "acme.analysis.report", name: "Q3", sources: [{ wand_id: "a3f8c2d1e9b04f72" }])
```

The runtime mounts each source as a **read-only symlink** under `sources/<mountName>/`. The
agent can `WandRead("sources/<mount>/...")` through the link but can never write there. The mount
truth is recorded in `.wand-sources.json` (runtime-owned). Passing `sources` to a Wand that
didn't declare `"sources"` is an error, not a silent ignore.

---

## Pre-ship checklist

Before you publish a Wand, confirm:

**Contract**
- [ ] `description` states what it is *and* when to use it, with trigger words.
- [ ] `wand.json` validates against the [schema](../schema/wand.schema.json).
- [ ] Every phase `id` has a matching `wand/phases/<id>/` folder.
- [ ] `wand/prompt.md` and every phase `prompt.md` exist.

**Gates**
- [ ] Each phase has a `check.js` *or* `check.md` matching its `phaseGateCheck.mode`.
- [ ] Every gate returns a useful `hint` on failure.
- [ ] Script gates validate their own dependencies and never crash on bad input.
- [ ] You ran each gate by hand and confirmed the last stdout line is valid JSON.

**Fences**
- [ ] Each phase's `allowGlobs` permits exactly what that phase writes — no more.
- [ ] `cleanupOnRewind` (if used) targets only that phase's own output.

**Tools**
- [ ] No `tools` block unless the phase genuinely needs a non-baseline tool.
- [ ] Opted-in tools are the minimum the phase requires.

**Prompts**
- [ ] Prompts tell the agent to use Wand tools, never shell `cp`/`mv`.
- [ ] Each phase prompt ends by telling the agent exactly how to call `CheckPhase`.

---

## Anti-patterns

- **Phases without distinct gates.** If two phases pass on the same condition, merge them.
- **Vague gate hints.** `"failed"` strands the agent; name the missing thing.
- **Over-fencing or under-fencing writes.** Too tight and the agent can't do its job; too loose
  (`**`) and rewind/cleanup become unsafe.
- **Opting into `Bash` to copy files into the Wand.** Use `WandWrite` with `source_path` for
  binaries; shell writes into the Wand dir are a contract violation.
- **Free mode by default.** If the flow doesn't branch, it's linear. Free mode loses automatic
  progression and rewind for nothing.
- **Encyclopedic prompts.** `prompt.md` is shared context on every turn. Say what the agent
  doesn't already know; link out for the rest.

## Reference

### The Wand tools

| Tool | Needs open Wand | Purpose |
|------|:-:|---------|
| `CreateWand(app_id, name, sources?)` | no | Create a new instance, enter Wand mode |
| `OpenWand(wand_id)` | no | Resume an existing instance |
| `ListWands(dir)` | no | Recursively list instances under a directory |
| `DescribeWand(app_id)` | no | Inspect a Wand's phases/contract without creating one |
| `CopyWand(wand_id, display_name?)` | no | Fork to a fresh, versioned instance |
| `WandWrite(file_path, content? \| source_path?)` | yes | Write text, or copy a binary in |
| `WandEdit(file_path, old_string, new_string)` | yes | String-replace edit |
| `WandRead(file_path)` | yes | Read a file (reads through `sources/` links) |
| `CheckPhase(...)` | yes | Run the gate; advance on pass |
| `SaveAndCloseWand()` | yes | Persist and exit Wand mode |
| `RewindWand(target_phase, reason?)` | yes | Roll a linear Wand back |

### Constants

| Constant | Value |
|----------|-------|
| Phase id pattern | `^[a-z][a-z0-9_-]*$` |
| Free-mode completion sentinel | `"__FINAL__"` |
| Default gate timeout | 120 000 ms |
| Wand id format | bare 16 hex; instance directory `<wandId>.wand` |
| Instance discovery max depth | 20 |
| appId pattern | `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2}$` (exactly 3 segments) |

## Next steps

- **[Quickstart](./quickstart.md)** — build a Wand end to end if you haven't yet.
- **[Manifest spec](../spec/manifest.md)** — normative field reference.
- **[Bundle spec](../spec/bundle.md)** — how Wand Apps are packaged and discovered.
- **[Lifecycle spec](../spec/lifecycle.md)** — phase transitions, state file format, rewind semantics.
- **[Presentation spec](../spec/presentation.md)** — custom views, iframe sandbox, view containers.
- **[Host API spec](../spec/host-api.md)** — complete `window.wandHost` surface.
- **[Manifest schema](../schema/wand.schema.json)** — the canonical contract your `wand.json`
  is checked against.
- **[`examples/changelog`](../examples/changelog)** — a complete, runnable reference Wand.
