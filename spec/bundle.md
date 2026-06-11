# Bundles: the Kind and the Instance

A wand app has two distinct on-disk forms with different lifecycles:

- **Kind bundle** — the app definition, shipped once, shared by all instances.
- **Instance document package** — one per run, produced by the runtime, owned by the user.

---

## Kind bundle

A kind bundle is a directory that contains `wand.json` and the supporting prompt, gate, and
view files. It is discovered by the runtime under any installed wand app collection.

```
<kindRoot>/
├── wand.json                          # manifest (required)
├── icon.svg                           # optional; identity icon
├── wand/
│   ├── prompt.md                      # global system-prompt fragment (required)
│   └── phases/
│       └── <phaseId>/
│           ├── prompt.md              # injected when this phase is active (required)
│           ├── check.js              # gate script (mode = "script")
│           └── check.md             # gate prompt (mode = "prompt")
├── view/
│   └── static/
│       ├── index.html                 # static presentation view (optional)
│       └── <sibling assets>
└── templates/                         # seed files for initialFiles (optional)
    └── ...
```

**Directory name is a label, not an identity.** The kind bundle directory name is a
human-readable convention (typically the `appId` last segment). Identity is always `appId`
from `wand.json`. The runtime MUST use `appId` as the registry key and MUST NOT derive
identity from the directory name.

**Prompt paths are derived, not declared.** A phase's `prompt.md`, `check.js`, and
`check.md` paths are computed from `phases[].id`. There is no manifest field to relocate
them. If the directory name does not match the phase `id`, the files will not be found.

**Missing prompt files do not fail loading.** A missing `wand/prompt.md` or phase
`prompt.md` MUST NOT prevent the kind from loading. The runtime SHOULD inject a visible
warning block (`[warning: missing wand/phases/<id>/prompt.md]`) into the active prompt so
the gap is surfaced at runtime rather than failing silently.

---

## Instance: the document package

Every time a wand is created (`CreateWand`), the runtime produces one instance — a directory
named `<wandId>.wand` placed under the runtime's data area:

```
wands/<folderName>/<wandId>.wand/
```

where `folderName` comes from `directoryContract.folderName` and `wandId` is 16 lowercase
hexadecimal characters (bare, no prefix).

### Layout

The runtime populates the instance at creation time and manages it throughout the wand
lifecycle. There is no required internal structure beyond the state marker; `directoryContract`
fields (`requiredSubdirs`, `initialFiles`) specify what else the runtime creates on behalf of
the app.

```
<wandId>.wand/
├── .wand.json                         # state marker (runtime-managed, required)
├── .wand-sources.json                 # cross-wand source mounts (runtime-managed, optional)
├── .handoff-cache.json                # prompt handoff cache (runtime-managed, optional)
├── sources/                           # read-only source mounts (runtime-managed, optional)
│   └── <mountName>/  →  <symlink>
├── view/
│   └── runtime/
│       └── index.html                 # runtime view (if declared via initialFiles)
└── <app-defined files…>               # artifact files produced by the agent
```

The `.wand` suffix plus a valid `.wand.json` marker is what makes a directory a document
package. The rest of the layout (beyond reserved files) is app-defined.

---

## The `.wand.json` state marker

`.wand.json` is the authoritative state record for an instance. The runtime writes it
atomically. It MUST be present for the directory to be recognized as a wand document package.

### Fields

| Field | Type | Required for recognition | Description |
|-------|------|:---:|-------------|
| `wandId` | string (16 hex) | yes | Bare 16-character lowercase hex. Instance identity. |
| `appId` | string | yes | The `appId` from the kind's `wand.json`. Links the instance to its app. |
| `displayName` | string | yes | The name given by the user at creation (or updated via rename). |
| `appVersion` | string | no | `appVersion` of the kind at the time of last interaction. |
| `currentPhase` | string \| null | no | Active phase `id`, or `null` when the wand is completed. |
| `phaseLog` | array | no | Append-only record of phase entries. Each entry: `{ phase: string, enteredAt: number }` — `enteredAt` is a Unix timestamp in milliseconds, appended when the phase becomes active. |
| `createdAt` | number | no | Unix timestamp (milliseconds) of instance creation. |
| `updatedAt` | number | no | Unix timestamp (milliseconds) of last state write. |

**Minimum identity for recognition.** A `.wand.json` file MUST contain `wandId`, `appId`,
and `displayName` to be considered valid. A marker that contains `kind` (v1 field) but lacks
`appId` is a v1 marker and MUST NOT be recognized by a v2 runtime.

**Atomic writes.** The runtime MUST write `.wand.json` atomically (write to a temp file, then
rename/move) to prevent partial reads during concurrent access.

**Human-readable, not hand-editable.** `.wand.json` is JSON and intentionally readable, but
MUST NOT be hand-edited by the wand's own logic, gate scripts, or presentation views. It is
a runtime-reserved file (see below).

---

## Runtime-reserved files

The following files inside an instance are reserved and managed exclusively by the runtime.
Wand logic (prompts, gate scripts, `engineeringTools`) and presentation views MUST NOT
read from or write to them directly.

| File | Purpose |
|------|---------|
| `.wand.json` | Instance state marker. Written by the runtime on phase transitions, rewinds, completion, and renames. |
| `.wand-sources.json` | Cross-wand source mount manifest. Written by the runtime when `sources` are attached at creation. |
| `.handoff-cache.json` | Runtime-internal prompt handoff cache. Written and consumed by the runtime session machinery. |

The `sources/` directory and its symlinks are also runtime-managed and MUST NOT be written
through by the agent. The agent MAY read through `sources/` using `WandRead`.

---

## Explorer detection rule

**Detection.** A directory MUST be treated as a wand document package if and only if:

1. Its name ends with `.wand`, **and**
2. It contains a `.wand.json` file that satisfies the minimum identity requirement
   (`wandId`, `appId`, `displayName` all present and non-empty).

Detection applies anywhere in a file tree — the directory need not be inside a
`wands/<folderName>/` structure. Users MAY move or copy `.wand` packages to any location
and they SHOULD still be recognized.

The `.wand` suffix is a fast pre-filter (every candidate directory name can be checked
without reading files). `.wand.json` is the authoritative marker; the suffix alone is not
sufficient.

**Display name.** When a directory is confirmed as a document package, file explorers SHOULD
display the marker's `displayName` value instead of the raw directory name. The raw name
(`<wandId>.wand`) is an opaque identifier; `displayName` is what the user gave the instance.

**Single-opener.** File explorers SHOULD treat a confirmed document package as a single
openable object — analogous to a macOS bundle — and open the wand's runtime view on the
primary open gesture (e.g. double-click), rather than expanding the directory in place.

A "show package contents" escape hatch MUST remain available (e.g. via a secondary gesture
or context menu) so users can inspect or recover individual files.

**No runtime view declared.** If the kind's `wand.json` does not declare
`presentation.runtime`, the single-opener SHOULD still be offered. The runtime displays a
framework placeholder (app icon, phase track, progress pulse) instead of a custom view. All
instances get a single-opener regardless of whether the author declared a runtime view.

---

## `wandId` format

| Property | Value |
|----------|-------|
| Character set | lowercase hexadecimal (`[0-9a-f]`) |
| Length | 16 characters |
| Prefix | none (bare hex) |
| Example | `a3f8c2d1e9b04f72` |
| Instance directory | `a3f8c2d1e9b04f72.wand` |

`wandId` values are generated by the runtime and are globally unique within a data area.
They are opaque; no semantic meaning should be inferred from the hex digits.
