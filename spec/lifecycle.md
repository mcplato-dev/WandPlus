# Lifecycle: Phases, Gates, Tools

> **WandPlus Protocol Specification — Chapter: Lifecycle**
>
> This chapter is normative. Conformant runtimes MUST implement every MUST-level
> requirement. SHOULD-level items represent strong best-practice guidance. MAY-level items
> are optional extensions.
>
> Related chapters: [Manifest](./manifest.md) · [Bundle](./bundle.md) ·
> [Presentation](./presentation.md) · [Authoring Guide](../docs/authoring-guide.md) ·
> [Quickstart](../docs/quickstart.md)

---

## Table of contents

1. [Phase model](#1-phase-model)
2. [The write fence](#2-the-write-fence)
3. [Gate checks](#3-gate-checks)
4. [Tool exposure](#4-tool-exposure)
5. [Rewind](#5-rewind)
6. [Copy](#6-copy)
7. [Cross-wand composition](#7-cross-wand-composition)
8. [Reference: wand tools](#8-reference-wand-tools)
9. [Reference: constants](#9-reference-constants)

---

## 1. Phase model

### 1.1 Overview

Every wand instance progresses through one or more **phases**, each representing a
distinct stage of construction with its own write fence, tool surface, and gate check.
The runtime tracks the instance's current phase in `.wand.json` as the field
`currentPhase`. A value of `null` means the wand is **completed** (see §1.5).

Phases are declared under `workflow.phases[]` in the manifest. Each phase's `id` MUST
satisfy the pattern `^[a-z][a-z0-9_-]*$` and MUST match the folder name
`wand/phases/<id>/` in the wand definition package. If the folder is absent the runtime
MUST NOT silently ignore the phase; it SHOULD inject a visible warning into the agent's
context so the gap is apparent rather than silent.

### 1.2 `phaseFlowMode`

`workflow.phaseFlowMode` MUST be one of `"linear"` or `"free"`. It governs how
`CheckPhase` advances the instance.

#### `linear`

The `phases[]` array order is the flow. When `CheckPhase` passes:

- If the current phase is not the last in the array, the runtime MUST advance
  `currentPhase` to the next entry.
- If the current phase is the last entry, the runtime MUST set `currentPhase` to `null`
  (completed state).

`CheckPhase` in linear mode MUST NOT accept a `next_phase` argument; the runtime MUST
reject it with an error if one is supplied.

**Default recommendation.** Authors SHOULD default to `linear`. It provides automatic
progression, enables the `RewindWand` tool, and requires no routing logic in gate checks.

#### `free`

Phases have no fixed order. `CheckPhase` MUST carry a `next_phase` argument whose value
is either:

- A phase `id` declared in `workflow.phases[]`, or
- The sentinel string `"__FINAL__"` to move the instance to the completed state.

The runtime MUST validate `next_phase` before invoking the gate check. An unrecognized
`next_phase` value MUST cause `CheckPhase` to return an error immediately without running
the gate.

Free mode MUST suppress the `RewindWand` tool regardless of phase-level `tools`
configuration. An attempt to call `RewindWand` in free mode MUST return an error.

Authors SHOULD use free mode only when the workflow genuinely branches — for example, a
router phase that dispatches to one of several specialized phases. Free mode trades
automatic progression and rewind capability for routing flexibility.

### 1.3 `initialPhase`

`workflow.initialPhase` MUST be the `id` of the phase the instance enters on creation.
It MUST be present in `workflow.phases[]`. The runtime MUST set `currentPhase =
initialPhase` when creating a new instance and MUST record the first `phaseLog` entry
at that time.

### 1.4 `phaseLog`

`phaseLog` is an append-only array of `{phase, enteredAt}` entries in `.wand.json`.
The runtime MUST append one entry every time `currentPhase` changes — on initial
creation, on successful `CheckPhase`, and on `RewindWand`. The log is a complete
ordered history; which phases have been visited is derived as
`new Set(phaseLog.map(e => e.phase))` and MUST NOT be stored as a separate field.

### 1.5 Completed state (`currentPhase: null`)

After the last phase passes (linear) or `CheckPhase` is called with
`next_phase: "__FINAL__"` (free), the runtime MUST set `currentPhase` to `null`.

In the completed state:

- The runtime MUST reject calls to `CheckPhase`, `WandWrite`, `WandEdit`, and
  `RewindWand`, returning an error for each.
- The tool surface MUST collapse to the **completion whitelist**: `WandRead`,
  `SaveAndCloseWand`, `CopyWand` (see §4.4).
- The runtime SHOULD append a visible notice to the agent's context indicating that the
  wand is sealed and that `CopyWand` is the mechanism for deriving a new version.

---

## 2. The write fence

### 2.1 `allowGlobs`

Each `PhaseDef` MAY declare an `allowGlobs` field: an array of
[picomatch](https://github.com/micromatch/picomatch) glob patterns relative to the wand
instance root. When `allowGlobs` is present, the runtime MUST reject any `WandWrite` or
`WandEdit` call whose resolved file path does not match at least one pattern in the
array.

When `allowGlobs` is absent, no glob restriction applies (the only active restrictions
are the path rules in §2.2).

Authors SHOULD fence each phase to exactly the files that phase produces. Tight fences
prevent the agent from corrupting work from earlier phases and make `cleanupOnRewind`
reliable (see §5.2).

**Example**: a `collect` phase fenced to `entries/**` and a `publish` phase fenced to
`CHANGELOG.md` prevent the agent from mutating each other's output.

### 2.2 Runtime-reserved paths

Regardless of `allowGlobs`, the runtime MUST reject writes to the following paths:

| Path | Purpose |
|------|---------|
| `.wand.json` | Instance state |
| `.wand-sources.json` | Cross-wand source mount record |
| `.handoff-cache.json` | Save/open resumption snapshot |
| `sources/` (and all descendants) | Read-only source mounts |

These paths are owned exclusively by the runtime. Authors MUST NOT declare them in
`allowGlobs` or `cleanupOnRewind`; the runtime MUST ignore any such declaration rather
than honor it.

### 2.3 Path traversal

The runtime MUST reject any file path that, after normalization, resolves outside the
wand instance directory. Paths containing `..` components that escape the instance root
MUST be rejected with an error.

---

## 3. Gate checks

A gate is the **only** mechanism by which a phase advances. The gate contract is
**fail-safe**: any condition the runtime cannot positively confirm as a pass — a missing
script, a crash, a timeout, unparseable output, or an inference failure — MUST be
treated as a failure. "Could not determine" is never a pass.

`phaseGateCheck.mode` MUST be `"script"` or `"prompt"`.

### 3.1 Script gates (`mode: "script"`)

Script gates execute a bundled Node.js file and inspect its output. Use script gates for
criteria that can be verified mechanically: file existence, JSON validity, field values,
word counts.

#### 3.1.1 Script location

The runtime MUST resolve the gate script at:

```
wand/phases/<phaseId>/check.js
```

relative to the wand definition root (`kindRoot`). If the file is absent the gate MUST
fail (fail-safe) without attempting to run anything.

#### 3.1.2 Input

The runtime MUST pass a single JSON object to the script's **stdin**:

```json
{
  "phase":   "<current phase id>",
  "args":    { /* CheckPhase arguments, pre-validated against inputSchema */ },
  "wandDir": "<absolute path to the wand instance directory>",
  "kindRoot": "<absolute path to the wand definition root>"
}
```

`args` MUST be validated against `phaseGateCheck.inputSchema` (if declared) before the
script is invoked. A schema validation failure MUST cause `CheckPhase` to return an
error without running the gate script.

#### 3.1.3 Environment

The runtime MUST set the following environment variables for the script process:

| Variable | Value |
|----------|-------|
| `WAND_DIR` | Absolute path to the wand instance directory |
| `WAND_ROOT` | Absolute path to the wand definition root |
| `WAND_APP_ID` | The wand's `appId` |
| `WAND_PHASE` | The current phase id |

The script's working directory (`cwd`) MUST be the wand instance directory.

#### 3.1.4 Runtime

The runtime MUST execute the script using its own bundled Node.js interpreter, not any
Node.js binary present in the system `PATH`. This ensures consistent behaviour across
environments where Node.js may be absent or at a different version.

#### 3.1.5 Output contract

The runtime MUST interpret the **last line of stdout** as the gate result. That line
MUST be a JSON object conforming to:

```json
{ "passed": <boolean>, "hint": "<optional string>" }
```

The runtime MUST treat the gate as failed if:

- The process exits with a non-zero exit code.
- The last stdout line is absent, is not valid JSON, or does not contain a boolean
  `passed` field.
- The process exceeds the timeout (default 120 000 ms; overridable per phase with
  `phaseGateCheck.timeout`).

The `hint` field, when present, MUST be returned verbatim to the agent as the failure
reason.

#### 3.1.6 Dependency handling

Script authors MUST validate any runtime dependencies (e.g., `require`d modules) inside
the script itself and emit `{ "passed": false, "hint": "..." }` if a dependency is
missing. Authors MUST NOT allow the script to throw an uncaught exception in this case:
a crash produces an opaque failure with no actionable hint for the agent.

Diagnostic output on lines before the last line is permitted and ignored by the runtime,
which reads only the final line for the result.

#### 3.1.7 Manual testing recipe

To confirm a gate locally before publishing:

```sh
# Set working directory to the wand instance
cd /path/to/my.wand

# Pipe the expected stdin JSON and inspect the last line
echo '{"phase":"collect","args":{"summary":"done"},"wandDir":".","kindRoot":"/path/to/kind"}' \
  | node /path/to/kind/wand/phases/collect/check.js \
  | tail -1 | python3 -m json.tool
```

The `tail -1` isolates the result line; `python3 -m json.tool` validates it parses.
A well-formed result looks like:

```json
{ "passed": true }
```

or, on failure:

```json
{ "passed": false, "hint": "CHANGELOG.md is missing a ## 1.2.0 heading." }
```

### 3.2 Prompt gates (`mode: "prompt"`)

Prompt gates delegate evaluation to an inference loop. Use prompt gates for criteria
that require judgement rather than mechanical verification: "the draft addresses every
point in the brief," "the image matches the style guide."

#### 3.2.1 Gate files

The gate MUST include:

- `wand/phases/<phaseId>/check.md` — instructions for the judge, relative to the wand
  definition root. The runtime MUST fail the gate if this file is absent.
- `phaseGateCheck.passCriteria` (manifest field, required for `mode: "prompt"`) — a
  natural-language pass condition.

#### 3.2.2 Evaluation

The runtime MUST run the judge as an **isolated inference session** (separate from the
active agent conversation). The system prompt MUST include:

1. A framework preamble describing the judge's role and output format.
2. The contents of `check.md`.
3. The `passCriteria` string.

The user prompt MUST be the `CheckPhase` arguments (after `inputSchema` validation).

The judge MUST produce a result in the same shape as a script gate:

```json
{ "passed": <boolean>, "hint": "<optional string>" }
```

The runtime MUST apply the same fail-safe rule: inference failure, timeout (default
120 000 ms), or output that cannot be parsed into the required shape MUST all be treated
as failure (`passed: false`).

#### 3.2.3 Guidance

Authors SHOULD prefer script gates whenever the criterion is mechanical. Prompt gates
are slower, consume an inference call, and are less deterministic across identical
inputs. Reserve prompt mode for genuinely subjective criteria.

### 3.3 Gate design requirements

All gates MUST satisfy the following properties:

**Fail-safe.** Any state the runtime cannot positively confirm as a pass MUST be a
failure. There is no "unknown" outcome.

**Read-only.** Gates MUST NOT mutate files in the wand instance directory or elsewhere.
A gate that modifies files is a contract violation and may corrupt the instance.

**Deterministic and idempotent.** Given the same wand state and the same arguments, a
gate MUST produce the same result. Agents rely on this to know that fixing the failing
condition will allow the gate to pass on retry.

**Actionable hints.** When a gate fails, `hint` MUST name the specific problem and,
where possible, the fix. A hint of `"validation failed"` is insufficient; a hint of
`"CHANGELOG.md must contain a \"## 1.2.0\" heading."` is actionable.

---

## 4. Tool exposure

### 4.1 Baseline tools

Every active phase (i.e., `currentPhase !== null`) MUST expose the following tools
without any declaration in the phase's `tools` configuration:

```
WandRead    WandWrite     WandEdit      CheckPhase
SaveAndCloseWand          CopyWand      TodoWrite     AskUserQuestion
```

This is the **baseline**. A wand that only reads and writes its own files requires no
`tools` block at all.

### 4.2 Phase-level opt-in (`tools` configuration)

A phase MAY declare a `tools` object to extend the tool surface beyond the baseline.
The runtime MUST enforce the resulting surface against the complete tool catalog:
any tool that is neither baseline nor opted-in MUST be hidden from the agent while
the wand is active.

```json
"tools": {
  "mode": "allow",
  "items": ["Bash", "mcp__image-tools__"],
  "overrides": [
    { "name": "WandWrite", "prompt": "Write only files under output/. Never touch entries/." }
  ]
}
```

`mode` MUST be `"allow"` or `"deny"`. New wand definitions SHOULD use `"allow"`. The
`"deny"` mode is retained for backward compatibility and operates only over the wand
tool universe; it MUST NOT be used to restrict baseline tools.

`items` entries take the following forms:

| Entry form | Example | Effect |
|------------|---------|--------|
| Native tool name | `"Bash"`, `"Read"`, `"WebFetch"` | Exposes that tool |
| MCP tool short name | `"GenerateImage"` | Exposes that one MCP tool |
| MCP server prefix token | `"mcp__image-tools__"` | Exposes every tool from that server |
| `"RewindWand"` | — | Opt-in; honored in linear mode only |

`RewindWand` MUST be opted-in explicitly and MUST be suppressed by the runtime in free
mode regardless of the `items` declaration (see §1.2 and §5.1).

### 4.3 Per-tool prompt overrides

`overrides` is an optional array of `{ name, prompt }` objects. Each entry replaces the
runtime's default description text for the named tool, for the duration of this phase.
The override applies to tools in the active surface (baseline or opted-in); the `name`
MUST refer to a tool the phase actually exposes, otherwise the runtime SHOULD emit a
warning and ignore the entry.

Prompt overrides allow authors to focus a tool's description for a specific phase
without re-listing it in `items`.

### 4.4 Completed state: tool surface collapse

When `currentPhase` becomes `null`, the phase-level `tools` configuration is
disregarded. The runtime MUST restrict the tool surface to the **completion whitelist**:

```
WandRead    SaveAndCloseWand    CopyWand
```

No other tools are available in the completed state. This restriction is absolute and
cannot be overridden by any phase or manifest configuration.

### 4.5 Entry/discovery tools

The following tools operate outside an open wand instance and are available regardless
of wand state:

```
CreateWand    OpenWand    ListWands    DescribeWand
```

`CopyWand` is also available regardless of wand state (both active and completed).

---

## 5. Rewind

### 5.1 Applicability

`RewindWand` is available only in **linear** wands and only in an **active** (non-null)
`currentPhase`. The runtime MUST suppress `RewindWand` from the tool surface in free
mode and in the completed state (see §1.2 and §4.4).

### 5.2 Semantics

`RewindWand(target_phase, reason?)` rolls the instance back to an earlier phase.

The runtime MUST validate:

1. `target_phase` is provided; if absent, return an error.
2. `target_phase` is declared in `workflow.phases[]`; if not, return an error.
3. `target_phase` is not the current phase; if it is, return an error.
4. `target_phase` appears in `phaseLog` (i.e., the instance has actually entered it);
   if not, return an error.

### 5.3 `cleanupOnRewind` — file cleanup

Each `PhaseDef` MAY declare `cleanupOnRewind`: an array of picomatch glob patterns
relative to the instance root. When rewinding to `target_phase`, the runtime MUST
collect the union of `cleanupOnRewind` globs from every phase that is **skipped**
(all phases between `target_phase` and the current phase, inclusive of the current
phase) and move all matching files to the system trash / recycle bin.

The runtime MUST use a recoverable trash operation (e.g., system recycle bin) rather
than hard deletion. Files MUST NOT be permanently destroyed by a rewind.

The runtime-reserved paths listed in §2.2 MUST be excluded from cleanup regardless of
glob patterns. A glob of `**` MUST NOT cause runtime-reserved files to be trashed.

Per-file cleanup failures SHOULD be recorded and reported to the agent but MUST NOT
abort the rewind; remaining files should still be processed.

### 5.4 State update

After a successful rewind the runtime MUST:

1. Set `currentPhase` to `target_phase`.
2. Append `{ phase: target_phase, enteredAt: <now> }` to `phaseLog`.

The `reason` argument (if provided) is informational and MUST NOT be persisted to
`.wand.json`. Runtimes MAY surface it to the host application's UI.

### 5.5 Design guidance

Authors SHOULD opt `RewindWand` into non-final phases to allow recovery from craft
mistakes. The final phase SHOULD NOT expose `RewindWand` (the appropriate mechanism for
creating a new version is `CopyWand`).

`cleanupOnRewind` SHOULD target exactly the files a phase produces — no more. This
ensures a rewind leaves no stale output while preserving work from phases that will be
re-entered.

---

## 6. Copy

`CopyWand(wand_id, display_name?)` forks an existing wand instance into a new,
independent instance. It is available in any phase and in the completed state.

The runtime MUST:

1. Generate a new wand instance id (16 lowercase hex characters, see §9).
2. Deep-copy the source instance directory to the new instance's location in the
   runtime's data area.
3. Exclude `.wand.json`, `.wand-sources.json`, and `.handoff-cache.json` from the
   file copy; these are re-created fresh for the new instance.
4. Set `currentPhase` of the new instance to `workflow.initialPhase`.
5. Initialize `phaseLog` with a single entry for `initialPhase` at the current time.
6. Derive `displayName` for the new instance: if `display_name` is provided, use it;
   otherwise append a version suffix automatically (e.g., `"Report"` → `"Report v2"`,
   `"Report v2"` → `"Report v3"`).
7. Enter the new instance in wand mode (the source instance is left unchanged in its
   current state).

Cross-wand source mounts (§7) are NOT carried over to the copy. The copy begins as
a standalone instance at the initial phase without source bindings. Authors who need
the copy to inherit sources MUST re-supply `sources` at creation via `CreateWand`.

---

## 7. Cross-wand composition

### 7.1 Declaring the capability

A wand that is built from other wand instances MUST declare `"sources"` in
`directoryContract.requiredSubdirs`. This declaration is the gate: the runtime MUST
reject the `sources` argument on `CreateWand` for any wand that did not declare
`"sources"` in its manifest. The rejection MUST be an explicit error, not a silent
ignore.

### 7.2 Mounting sources

When `CreateWand(app_id, name, sources: [{wand_id, mount_as?}])` is called on a wand
that declared `"sources"`, the runtime MUST:

1. For each source entry, locate the source instance by `wand_id` in the runtime's data
   area.
2. Mount the source instance directory as a read-only mount under
   `<newInstance>/sources/<mountName>/`.
3. Record all mounts in the runtime-reserved file `.wand-sources.json` inside the new
   instance (see §7.4).

The mount mechanism (symlink, bind mount, or equivalent) is an implementation detail of
the runtime. The protocol guarantee is the directory path and the read-only constraint.
Mount failures MUST abort instance creation entirely; the runtime MUST NOT create a
partial instance.

### 7.3 Mount naming

The mount name is determined as follows:

1. If `mount_as` is provided by the caller, that name MUST be used. It MUST NOT contain
   `/` or `\`, MUST NOT begin with `.`, and MUST NOT exceed 32 characters. Violations
   MUST return an error.
2. If `mount_as` is absent, the runtime MUST derive a name deterministically from the
   source's `appId` last segment, a slug of its `displayName`, and a suffix from its
   wand id.

Duplicate mount names within a single instance MUST be rejected with an error.

### 7.4 `.wand-sources.json`

The runtime MUST maintain `.wand-sources.json` in each instance that has sources
mounted. This file is runtime-owned and MUST NOT be writable by the agent (see §2.2).
It records the source bindings as the machine truth; the agent MUST NOT be relied upon
to remember or reconstruct mount names.

### 7.5 Read and write behaviour

`WandRead` MUST read through source mounts: `WandRead("sources/<mount>/path/to/file")`
MUST return the content of that file from the source instance.

All write operations (`WandWrite`, `WandEdit`) to any path beginning with `sources/`
MUST be rejected. This restriction applies even if `allowGlobs` would otherwise permit
the path.

---

## 8. Reference: wand tools

The following table lists all 11 wand tools plus the `CopyWand` tool, with their
availability context and one-line purpose.

| Tool | Active wand required | Purpose |
|------|:--------------------:|---------|
| `CreateWand(app_id, name, sources?)` | No | Create a new instance and enter wand mode |
| `OpenWand(wand_id)` | No | Resume an existing instance and enter wand mode |
| `ListWands(dir?)` | No | Recursively list wand instances under a directory |
| `DescribeWand(app_id)` | No | Inspect an app's phases and contract without creating an instance |
| `CopyWand(wand_id, display_name?)` | No | Fork an instance to a new instance reset to the initial phase |
| `WandWrite(file_path, content? \| source_path?)` | Yes | Write a text file, or copy a binary file into the instance |
| `WandEdit(file_path, old_string, new_string)` | Yes | Perform a string-replacement edit on a file |
| `WandRead(file_path)` | Yes | Read a file (reads through `sources/` mounts) |
| `CheckPhase(...)` | Yes | Run the gate; advance to the next phase on pass |
| `SaveAndCloseWand()` | Yes | Persist the handoff snapshot and exit wand mode |
| `RewindWand(target_phase, reason?)` | Yes | Roll a linear wand back to an earlier visited phase |

**Notes:**

- Tools marked "active wand required" MUST return an error if called when no wand
  instance is open in the current session.
- `CopyWand` is available in all states including the completed state.
- `RewindWand` is suppressed in free-mode wands and in the completed state regardless
  of phase-level tool configuration.
- `CreateWand`, `OpenWand`, `ListWands`, and `DescribeWand` are **entry/discovery
  tools** available at all times and do not require an open instance.

---

## 9. Reference: constants

| Constant | Value | Notes |
|----------|-------|-------|
| Phase id pattern | `^[a-z][a-z0-9_-]*$` | Applied to `workflow.phases[].id` |
| App id pattern | `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2}$` | Exactly 3 reverse-DNS segments |
| Free-mode completion sentinel | `"__FINAL__"` | Passed as `next_phase` to complete a free-mode wand; cannot conflict with valid phase ids (the pattern prohibits leading `_`) |
| Wand instance id format | 16 lowercase hexadecimal characters | Bare; no prefix. Instance directory is `<16hex>.wand` under the runtime's data area |
| Default gate timeout | 120 000 ms | Applies to both `mode: "script"` and `mode: "prompt"`; overridable per phase with `phaseGateCheck.timeout` |
| Completion whitelist | `WandRead`, `SaveAndCloseWand`, `CopyWand` | The only tools exposed in the completed (`currentPhase: null`) state |
| Instance discovery max depth | 20 | Maximum directory depth the runtime walks when searching for instances |
| Mount name max length | 32 characters | Applies to `sources` mount names |

---

*End of chapter.*
