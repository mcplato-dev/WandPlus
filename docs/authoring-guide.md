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

### `allowGlobs` — the write fence *and* the user's table of contents

Each phase should only be able to write what that phase is *for*. In a `collect` phase, fence
to `entries/**`; in `publish`, fence to `CHANGELOG.md`. This does two things: it stops the
agent from corrupting earlier work, and it makes `cleanupOnRewind` safe and predictable.

They also carry a second, user-facing meaning: hosts group an instance's files by the **first
phase (in declaration order) whose globs match** — that grouping is how the end user reads
"this stage's results" in the resource panel, with unmatched files demoted to a collapsed
trailing group (see the [presentation spec](../spec/presentation.md#instance-resources)).
Design the output directory tree first, then write each phase's globs as *what it produces*,
not merely *what it may touch*. By convention, put the final deliverable at the top of
`output/` (e.g. `output/<name>.pptx`) — hosts surface such exports proactively when they land.

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
  + `passCriteria`; user prompt = a bounded window of the recent agent conversation plus the
  `CheckPhase` arguments. It returns the same `{ passed, hint }` shape.
- The conversation window is what makes "the user confirmed X" criteria verifiable — the
  judge checks the conversation (structured question/answer rounds count), and treats the
  `CheckPhase` arguments as the agent's claims to cross-check, not as facts.
- Same 120 s default timeout; same fail-safe rule (model/parse failure ⇒ fail).

Two practices make prompt gates dramatically more usable:

1. **Declare `inputSchema` even for prompt gates.** The generic `CheckPhase` tool accepts
   arbitrary fields, so without a schema the agent has no way to discover what your gate
   expects — it calls `CheckPhase` empty, fails, and guesses. A declared schema (with a
   `description` per field) is surfaced to the agent as the explicit argument list for the
   current phase.
2. **Phrase every criterion so it is verifiable** from the conversation window or the
   arguments, and instruct the judge to name *every* missing item in its hint — a judge that
   reports one missing item per attempt creates the same fix-one-recheck loop as a
   first-match-only script gate.

Prefer `script` when the criterion is mechanical. Reserve `prompt` for genuinely subjective
gates — it's slower, costs a model call, and is less repeatable.

### Writing good hints

The `hint` on a failed gate is returned verbatim to the agent. It's your one channel to steer a
retry. Four rules decide whether the agent can act on it:

1. **Name the file** the violation is in.
2. **Give the location** — a line number or a short quoted snippet.
3. **Report every violation** (or the first ~10 plus a total count), never just the first.
   A first-match-only hint traps the agent in a fix-one-recheck loop: it fixes one
   occurrence, re-runs the gate, gets told about the next one, and burns a full
   round-trip per fix.
4. **Say the next action**, not just what is wrong.

✅ `"CHANGELOG.md has 3 placeholder entries: line 12 \"TBD\", line 40 \"TODO\", line 77 \"TODO\" — replace each with a real entry."`
❌ `"validation failed"`
❌ `"placeholder found in content"` *(which file? where? how many?)*

**Scan only the stage's own outputs.** A gate inspects the paths in its phase's `allowGlobs` —
never seeded assets or templates. If a gate flags text inside a file the agent cannot
legitimately change, the agent will edit the seeded file to silence the gate and corrupt the
Wand.

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

Two mistakes account for most broken Wands in the wild:

- **Invented modes.** The only valid modes are `"allow"` and `"deny"`. There is no
  `"baseline"` mode — baseline-only is expressed by *omitting* the `tools` field. A manifest
  with an invented mode fails validation and cannot be published.
- **Prompts that promise tools the manifest doesn't grant.** If a phase's `prompt.md` tells
  the agent to run a script or an external converter (docx, node, python, …), that phase MUST
  opt in `"Bash"`. The baseline has no shell — the produced Wand simply cannot run that step.

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
runtime view shows *what this instance produced*, live while the agent is working.

Pick the runtime view's shape from the **business**, not the tech:

1. **The artifact IS the view** — when the final deliverable is (or can be) a single-page
   HTML (report, deck, dashboard), declare the artifact's own path as `runtime.entry` and embed
   a small host adapter at the end of the page. The user watches the deliverable assemble itself.
2. **Phase board** — when the product is structured data or many files, ship ONE dedicated page
   with one screen per phase: show that phase's business state (`runtime.readFile` over its
   outputs), switch screens on `state-changed`, and let the final screen embed the deliverable
   via an instance-relative `<iframe>`. You never ship per-phase HTML files.
3. **Skip** — only when the product is genuinely non-visual.

**Hard rule — entry reachability.** `runtime.entry` resolves inside the **instance**, so it must
be either a phase-produced path (covered by that phase's `allowGlobs`) or seeded into every
instance via `directoryContract.initialFiles` (the entry AND every companion file). A page that
exists only in the definition bundle leaves every instance on the placeholder forever.

**Surface the deliverable.** Top-level `output/*.pptx|pdf|docx|xlsx|zip` exports pop the host's
resource panel automatically; HTML deliverables don't — call
`wandHost.openResources({ path: 'output/report.html' })` from the view at its completion moment.

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

### Revising a published Wand

Publishing the same `appId` again upgrades the published bundle in place — that is the
sanctioned revision mechanism. Runtimes with a publishing catalog typically support a
revision entry (`IterateWand`) that pre-seeds a fresh authoring instance with the
published definition and records `iterateSource` in the instance state (see
[lifecycle §1.6](../spec/lifecycle.md)). When authoring an iteration, treat the seeded
definition as the confirmed baseline and confirm only the *change request* with the
user; keep the `appId` unless the user explicitly wants a separate new bundle.

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
- [ ] `tools.mode` is `"allow"` (or legacy `"deny"`) — never an invented value.
- [ ] Every phase whose prompt asks the agent to run a script/converter opts in `"Bash"`.

**Prompts**
- [ ] Prompts tell the agent to use Wand tools, never shell `cp`/`mv`.
- [ ] Each phase prompt ends by telling the agent exactly how to call `CheckPhase`.
- [ ] The final phase's prompt ends with a completion hand-off: tell the user the
      deliverable's exact path and how to view it, then `SaveAndCloseWand`.
- [ ] Multi-step output is written to disk file-by-file as it completes (the files on disk
      are the progress bar), not buffered and dumped at the end.
- [ ] Rule-heavy phases ship their rules as seeded reference files
      (`directoryContract.initialFiles`) the agent can re-read at any time, and the phase
      prompt points at them. Tool results fall out of the agent's context; files on disk
      do not.

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
- **One-violation-at-a-time hints.** A gate that reports only the first match sends the agent
  around the fix-one-recheck loop once per occurrence. Collect them all and report the list.
- **Gates that scan seeded files.** A gate that flags content inside a seeded asset or template
  pushes the agent to edit the seed to silence it. Scan only the phase's own outputs.
- **Silent completion.** The Wand finishes and the agent says "done" without telling the user
  where the deliverable is or how to view it. The runtime does nothing on completion — the
  hand-off is the final phase prompt's job.

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

---

Official site: [wandplus.dev](https://wandplus.dev) · Reference runtime: [MCPlato](https://mcplato.com)
