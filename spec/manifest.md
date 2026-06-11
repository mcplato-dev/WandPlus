# The Manifest (`wand.json`)

> **Protocol version**: 2.0
>
> **Clean break**: any manifest with `"version": "1.0"` (fields `kind`, `kindVersion`,
> `subdirTemplate`) is **not recognized** by a v2 runtime — the registry scanner skips it and
> file-explorer detection ignores it. Migrate before moving to a v2 runtime.

The manifest is the machine-readable declaration of a wand app. It combines what iOS calls an
`Info.plist` and an entitlements file: identity, capability declarations, directory structure,
workflow, and presentation — all in one place. The canonical schema is at
[`../schema/wand.schema.json`](../schema/wand.schema.json).

---

## Annotated example

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/mcplato-dev/WandPlus/main/schema/wand.schema.json",
  "version": "2.0",

  // ── Identity (required trio) ──────────────────────────────────────────────
  "appId": "acme.docs.changelog",       // reverse-DNS, exactly 3 segments
  "appVersion": "1.2.0",               // semver of this app definition
  "displayName": "Release Changelog",  // written verbatim from user input

  // ── Identity (description required; rest optional) ───────────────────────
  "description": "Two-phase changelog. Collects raw entries, then publishes a formatted CHANGELOG.md. Use when assembling or updating release notes.",
  "alias": "",                          // user rename; overrides displayName in UI
  "developer": "Acme Corp",
  "category": "productivity",
  "minPlatformVersion": "2.0",
  "icon": "icon.svg",                   // kindRoot-relative path or lucide name

  // ── Entitlements ──────────────────────────────────────────────────────────
  "entitlements": {
    "mcpServers": ["github-tools"]      // wand-level; per-phase visibility via phases[].tools
  },

  // ── Directory contract ────────────────────────────────────────────────────
  "directoryContract": {
    "folderName": "changelog",          // groups instances: wands/changelog/<wandId>.wand
    "requiredSubdirs": ["entries"],
    "requiredFiles": [
      { "path": "CHANGELOG.md" }
    ],
    "initialFiles": [
      { "path": "CHANGELOG.md", "templatePath": "templates/CHANGELOG.md" }
    ]
  },

  // ── Workflow ───────────────────────────────────────────────────────────────
  "workflow": {
    "phaseFlowMode": "linear",
    "initialPhase": "collect",
    "phases": [
      {
        "id": "collect",
        "allowGlobs": ["entries/**"],
        "cleanupOnRewind": ["entries/**"],
        "phaseGateCheck": { "mode": "script" }
      },
      {
        "id": "publish",
        "tools": { "mode": "allow", "items": [] },
        "allowGlobs": ["CHANGELOG.md"],
        "cleanupOnRewind": ["CHANGELOG.md"],
        "phaseGateCheck": { "mode": "script" }
      }
    ]
  },

  // ── Presentation (optional) ────────────────────────────────────────────────
  "presentation": {
    "static": { "entry": "view/static/index.html" },
    "runtime": {
      "entry": "index.html",
      "watch": ["CHANGELOG.md"],
      "autoOpen": true,
      "shell": false
    }
  }
}
```

---

## Field reference

### `version`

| | |
|---|---|
| **Required** | yes |
| **Type** | `string` |
| **Allowed value** | `"2.0"` |

MUST be `"2.0"`. Any other value — including `"1.0"` — causes the manifest to be rejected
by a v2 runtime. There is no version fallback or compatibility shim.

---

### `appId`

| | |
|---|---|
| **Required** | yes |
| **Type** | `string` |
| **Pattern** | `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2}$` |

The globally-unique machine identity for this app. Modelled on reverse-DNS notation with
**exactly three segments**: `<publisher>.<domain>.<slug>`.

**Publisher prefix.** The first segment is a publisher prefix assigned by the runtime or
distribution platform at publish time. It encodes the authoring entity and guarantees global
uniqueness. Authors MUST NOT invent a publisher prefix themselves; it is provided by the
publication workflow. Example assigned prefixes: `acme`, `org42`, `devjane`. The prefix is
opaque to the wand's own logic.

**Built-in vs. user-authored.** The distribution platform reserves certain prefixes for
platform-owned wands. All other prefixes identify individual publishers. The assignment
mechanism is platform-defined.

**Immutability.** `appId` MUST NOT change across versions of the same app. Changing `appId`
creates a new, distinct app. Version the content by bumping `appVersion` instead.

**Identity throughout the system.** `appId` is used as the registry map key, the `@`-mention
identifier (`wand:<appId>`), the `CreateWand` / `DescribeWand` argument, the gate script
environment variable `WAND_APP_ID`, and the `.wand.json` marker field. The kind bundle
directory name is a human-readable label only and is never parsed for identity.

---

### `appVersion`

| | |
|---|---|
| **Required** | yes |
| **Type** | `string` |
| **Pattern** | `^\d+\.\d+\.\d+$` (semver) |

The semantic version of this app definition. MUST be bumped whenever the app's prompts,
phases, gates, tools, or directory contract change in a way that could affect existing
instances. Publishing a higher `appVersion` over the same `appId` is an update; the runtime
MAY offer to migrate open instances.

---

### `displayName`

| | |
|---|---|
| **Required** | yes |
| **Type** | `string` |

The human-readable name displayed in lists, headers, and mention search. `displayName` is
provided by the human user at creation time and MUST be written verbatim into the manifest
exactly as entered. Authoring tools MUST NOT generate, invent, or silently alter it.

Display priority in the UI: `alias` (if set) > `displayName`.

---

### `alias`

| | |
|---|---|
| **Required** | no |
| **Type** | `string` |

A user-set rename that overrides `displayName` in lists and mention search without changing
the machine identity (`appId`). When present and non-empty, the runtime SHOULD display `alias`
everywhere `displayName` would otherwise appear.

---

### `description`

| | |
|---|---|
| **Required** | yes (schema-required) |
| **Type** | `string` |

Short description used for UI display and agent retrieval (`DescribeWand`). It MUST state
both what the app produces and when an agent should reach for it. Keep it under ~200
characters. Lead with a noun.

---

### `developer`

| | |
|---|---|
| **Required** | no |
| **Type** | `string` |

Informational author or organization label. Not used for identity or routing.

---

### `category`

| | |
|---|---|
| **Required** | no |
| **Type** | `string` |

App-store-style category tag (e.g. `"productivity"`, `"engineering"`, `"creative"`).
Informational; used for filtering and display in distribution surfaces.

---

### `minPlatformVersion`

| | |
|---|---|
| **Required** | no |
| **Type** | `string` |

Declares the minimum wand platform protocol version the app requires. Currently declarative
only — a v2 runtime notes the value but does not enforce it. Future runtimes MAY enforce it.

---

### `icon`

| | |
|---|---|
| **Required** | no |
| **Type** | `string` |

The app identity icon. May be:

- A path relative to the kind root (e.g. `"icon.svg"`, `"assets/logo.png"`).
- A named icon from the runtime's built-in icon set (e.g. `"wand-2"`). The icon set follows
  the [Lucide](https://lucide.dev) naming convention.

When absent, the runtime provides a default wand icon. Used in app headers, cards, file
explorer entries, and the document-package opener.

---

### `directoryContract`

| | |
|---|---|
| **Required** | yes |
| **Type** | `object` |

Declares the grouping name and structure for instances of this app. The runtime owns all path
assembly; the manifest declares only the fields below.

#### `directoryContract.folderName`

| | |
|---|---|
| **Required** | yes |
| **Type** | `string` |
| **Pattern** | `^[a-z][a-z0-9-]*$` |

A slug that identifies the grouping folder for all instances of this app. The runtime
assembles the full instance path as:

```
wands/<folderName>/<wandId>.wand
```

under its data area. Authors MUST NOT declare the full path or use path-template syntax
(the `{wandId}` placeholder mechanism from v1 is removed). The manifest declares only the
folder name; the runtime owns layout.

#### `directoryContract.requiredFiles`

| | |
|---|---|
| **Required** | no |
| **Type** | `Array<{ path: string, managedByBuiltin?: boolean }>` |

Files that MUST exist in every valid instance (validation aid). `path` is relative to the
instance root. `managedByBuiltin: true` marks files managed by the runtime infrastructure.

#### `directoryContract.requiredSubdirs`

| | |
|---|---|
| **Required** | no |
| **Type** | `string[]` |

Subdirectories created (`mkdir -p`) in every new instance. Include `"sources"` to enable
cross-wand composition (see [authoring guide](../docs/authoring-guide.md)).

#### `directoryContract.initialFiles`

| | |
|---|---|
| **Required** | no |
| **Type** | `Array<{ path: string, templatePath: string }>` |

Files copied from the kind bundle into each new instance on creation. `templatePath` is
relative to the kind root; `path` is the destination relative to the instance root.

---

### `workflow`

| | |
|---|---|
| **Required** | yes |
| **Type** | `object` |

The phase-based execution workflow. See [./lifecycle.md](./lifecycle.md) for full phase
semantics, gate execution, and completion/rewind rules. Brief reference below.

#### `workflow.phaseFlowMode`

| | |
|---|---|
| **Required** | yes |
| **Allowed values** | `"linear"` \| `"free"` |

`"linear"` — `phases[]` order is the execution flow; `CheckPhase` without `next_phase`
advances automatically. Supports `RewindWand`. Prefer this for all fixed pipelines.

`"free"` — no fixed order; `CheckPhase` MUST supply `next_phase` (a phase `id` or
`"__FINAL__"` to complete). `RewindWand` is suppressed. Use only when flow genuinely branches.

#### `workflow.initialPhase`

| | |
|---|---|
| **Required** | yes |
| **Type** | `string` |

The `id` of the first phase entered when a new instance is created.

#### `workflow.phases`

| | |
|---|---|
| **Required** | yes |
| **Type** | `PhaseDef[]` |
| **Min items** | 1 |

Ordered list of phase definitions (order is authoritative for `linear` mode).

Each `PhaseDef`:

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | `^[a-z][a-z0-9_-]*$`. MUST match the `wand/phases/<id>/` directory name. |
| `phaseGateCheck` | yes | Pass criterion. `mode: "script"` or `mode: "prompt"`. See [./lifecycle.md](./lifecycle.md). |
| `tools` | no | Tool opt-in/override for this phase. See [authoring guide](../docs/authoring-guide.md). |
| `allowGlobs` | no | Write fence (picomatch globs, instance-root-relative). |
| `cleanupOnRewind` | no | Globs of files to remove when this phase is skipped on rewind (linear only). |

Phase prompt and gate script paths are **derived** from `id`:
- Prompt: `wand/phases/<id>/prompt.md`
- Script gate: `wand/phases/<id>/check.js`
- Prompt gate: `wand/phases/<id>/check.md`

No field relocates these paths.

---

### `entitlements`

| | |
|---|---|
| **Required** | no |
| **Type** | `object` |

Capability declarations for the app — the iOS entitlements analog. Everything the app may
reach beyond its per-phase tool/file sandbox MUST be declared here. The block is auditable at
publish and install time.

#### `entitlements.mcpServers`

| | |
|---|---|
| **Required** | no |
| **Type** | `string[]` |

Names of external MCP servers this app activates while open. Wand-level and constant across
all phases. The runtime resolves names to configured servers. Per-phase tool visibility is
still governed by `phases[].tools`.

This field replaces the v1 top-level `mcpServers` field.

**Extensibility.** Additional capability keys (`network`, `filesystem`, etc.) MAY be added
to `entitlements` in future protocol revisions. Unknown keys SHOULD be tolerated (the schema
root allows `additionalProperties`).

---

### `presentation`

| | |
|---|---|
| **Required** | no |
| **Type** | `object` |

Declares the app's custom view(s). Views are single-page HTML bundles loaded in a sandboxed
iframe over loopback HTTP, communicating with the host via the wand-host SDK
(`/__wandhost__/sdk.js`). Full specification: [./presentation.md](./presentation.md) and
[./host-api.md](./host-api.md).

#### `presentation.static`

Kind-level view — "what this wand is." Shipped with the kind bundle. Entry path is relative
to the kind root. The runtime displays this in the app viewer alongside built-in Flow / Steps
views.

#### `presentation.runtime`

Instance-level view — the produced artifact. Entry path is relative to the instance
directory (`wandDir`). The instance dir is the HTTP service root so relative sibling
references always resolve. Fields:

| Field | Required | Description |
|-------|----------|-------------|
| `entry` | yes | `wandDir`-relative path to the entry HTML. MAY be the artifact itself (e.g. a deck's `index.html`). |
| `watch` | no | Globs (instance-relative) whose changes cause a view refresh. Unset = all changes pass through. |
| `autoOpen` | no | When `true`, the file explorer treats the instance as a document package and opens this view on click. |
| `shell` | no | When `true`, the host wraps the view in a native chrome shell (phase track, status bar, nav, actions, export). Default `false` = full-page. |

---

### `engineeringTools`

| | |
|---|---|
| **Required** | no |
| **Type** | `EngineeringToolDef[]` |

Tools triggered by the host UI or orchestration layer, **not** exposed to the agent. Use for
export pipelines, rendering steps, or any operation the user triggers explicitly rather than
the agent.

Each `EngineeringToolDef`:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Tool identifier. |
| `handler` | yes | `"script"` or `"binary"`. |
| `scriptPath` | no | Handler path relative to the kind root (for `handler: "script"`). |
| `inputSchema` | no | JSON Schema for tool input, validated before invocation. |
| `errorSurface` | no | `"llm_on_unrecoverable"` \| `"silent"` \| `"ui"`. |

---

## Quick-reference table

| Field | Required | Schema type |
|-------|----------|-------------|
| `version` | yes | `"2.0"` enum |
| `appId` | yes | string, pattern |
| `appVersion` | yes | string, semver pattern |
| `displayName` | yes | string |
| `description` | yes | string |
| `directoryContract` | yes | object |
| `workflow` | yes | object |
| `alias` | no | string |
| `developer` | no | string |
| `category` | no | string |
| `minPlatformVersion` | no | string |
| `icon` | no | string |
| `entitlements` | no | object |
| `presentation` | no | object |
| `engineeringTools` | no | array |

Additional fields at the root level are tolerated (`additionalProperties: true`) for
forward-compatibility with future protocol extensions.
