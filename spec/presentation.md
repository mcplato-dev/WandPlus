# Presentation: the Two-Layer View Model

> **Status:** normative — protocol v2.0
>
> This chapter defines the `presentation` block of `wand.json` and the lifecycle
> semantics hosts MUST implement. For the host-side API that views call into, see
> [host-api.md](./host-api.md). For the manifest field reference, see
> [../schema/wand.schema.json](../schema/wand.schema.json).

---

## Overview

A wand app MAY ship its own presentation layer: one or more single-page HTML
bundles that the host loads in a sandboxed iframe. The presentation is split into
two independent layers with different lifetimes and purposes:

| Layer | Scope | Purpose |
|-------|-------|---------|
| **static** | kind (shared across all instances) | "What this app is" — visualizes the workflow definition |
| **runtime** | instance (one per wand instance) | "What this instance has produced" — visualizes the artifact |

Both layers are declared in the `presentation` block of `wand.json` (see
[`../schema/wand.schema.json`](../schema/wand.schema.json)):

```jsonc
"presentation": {
  "static": {
    "entry": "view/static/index.html"     // kindRoot-relative; this is the default
  },
  "runtime": {
    "entry": "index.html",                // wandDir-relative; required
    "watch": ["**/*.html", "images/**"],  // glob filter for live refresh
    "autoOpen": true,                     // document-package single-opener
    "shell": false                        // host native chrome (see §Shell)
  }
}
```

Either sub-block MAY be omitted. A wand without a `presentation` block altogether
MUST still receive the placeholder view described in §Instance lifecycle.

---

## Static layer

### What it is

The static layer visualizes the **kind definition** — its phases, gate types, tools,
and global rules. It is the same for every instance of the app and is shipped as
part of the kind bundle alongside `wand.json`.

### Declaration

`presentation.static.entry` MUST be a path relative to the **kind root directory**
(the directory containing `wand.json`). The default value is
`view/static/index.html`.

The host MUST serve the static view with the **directory of the entry file** as the
HTTP root, so sibling assets (CSS, JS, images) are reachable via relative URLs.

### Behavior

The static view is shown when a user opens the app definition itself — for example,
browsing the installed app catalog. The host MUST fall back to a built-in
flow/steps view if the entry file does not exist or fails to load.

A static view SHOULD use `wandHost.get()` to fetch the `WandDetail` structure and
render it. It MAY call `wandHost.openPhaseDrawer(phaseId)` to delegate large phase
content to a native drawer, keeping the view itself compact (progressive
disclosure).

---

## Runtime layer

### What it is

The runtime layer visualizes the **instance artifact** — whatever files the agent
has produced in the wand directory during its session. Unlike the static layer, the
runtime view lives inside each instance and evolves as the agent works.

### Declaration

`presentation.runtime` MUST declare at minimum an `entry` path, relative to the
**wand instance directory** (`wandDir`). The entry MAY point directly at the
artifact's primary HTML file (for example, `index.html` for a slide deck whose
product is the page itself) or at a dedicated view file such as
`view/runtime/index.html`.

The host MUST serve the runtime view with **`wandDir` as the HTTP root**. This
means the view can reference any file in the instance directory via relative URLs —
including production artifacts in subdirectories — without any additional
configuration.

### `watch` globs

`presentation.runtime.watch` is an array of glob patterns (picomatch, relative to
`wandDir`) that the host uses to decide which file-system changes are relevant to
this view. When omitted, all changes inside `wandDir` are treated as relevant.

The host MUST filter `files-changed` events through these globs before pushing them
to the view. The globs are evaluated by the host; the view author does not need to
implement any filtering.

### `autoOpen`

When `presentation.runtime.autoOpen` is `true`, the runtime SHOULD treat each
instance directory as a **document package** — a directory that acts like a single
file in the explorer. Double-clicking (or the equivalent gesture) on the instance
directory MUST open the runtime view rather than expanding the directory tree.

Instances without `autoOpen: true` MAY still be opened by explicit user action; the
document-package behaviour is not the only way to reach the runtime view.

### `shell`

`presentation.runtime.shell` controls whether the host wraps the view in a native
chrome layer:

- `shell: false` (default) — the iframe occupies the full panel. The host MUST NOT
  inject any chrome inside the iframe. A minimal resource-access control SHOULD
  still be provided outside the iframe.
- `shell: true` — the host MUST render a native wrapper outside the iframe
  containing: a phase progress track driven by `state-changed` / `runtime.getState`;
  a real-time status indicator driven by `files-changed`; navigation controls
  wired to `nav.register` / `nav.update` / the `navigate` event; an action toolbar
  wired to `actions.register` / the `action` event; and a resource/export drawer.

---

## Instance lifecycle (three states)

Every runtime view tab has a three-state lifecycle driven by the presence of the
entry file on disk:

```
[placeholder] ──(entry file appears)──► [ready] ──(entry changes)──► reload cycle
      ▲                                                                      │
      └──────────────────(entry file removed)──────────────────────────────┘
```

### Placeholder state

**Condition:** the `entry` file does not yet exist in `wandDir`.

The host MUST display a placeholder that includes at minimum: the wand app icon,
the instance `displayName`, and a phase-progress track reading from
`.wand.json` (showing `currentPhase` and `phaseLog`). The placeholder MUST be
shown even when `shell: false`, because there is no page yet to show.

The host MUST watch the instance directory. When the `entry` file appears, the host
MUST transition automatically to the ready state without requiring user action.

Wand instances that declare no `presentation.runtime` block MUST also receive a
placeholder view, so that the phase track is universally available for all instances.

### Ready state

**Condition:** the `entry` file exists.

The host renders the iframe. If `shell: true`, the host also renders the native
wrapper. The view enters the live-refresh contract described in §Dual-track refresh.

### Updating state

**Condition:** a `files-changed` event arrives while the view is ready.

This is a transient sub-state. The host or view SHOULD provide a brief visual
indication (pulse or status chip) that new content is incoming. The indication MUST
clear automatically; `ui.setStatus` MAY override it.

---

## Dual-track refresh

Because the agent both edits production assets (images, data files) and rewrites
the entry HTML itself, the host distinguishes two refresh paths. Authors MUST
design their views with both in mind.

### Track A — asset changes (hot apply)

**Trigger:** watched files changed; none of the changed paths is the `entry` file
itself.

The host MUST push a `files-changed` event into the iframe with the list of changed
paths. The view SHOULD hot-apply the changes without a full page reload — for
example, by appending a cache-busting query parameter (`?wv=<n>`) to image `src`
attributes, or by calling `runtime.readFile` to re-fetch changed data.

The view MUST NOT require a full reload to apply asset changes.

### Track B — entry file changes (stateful reload)

**Trigger:** the `entry` file itself is among the changed paths.

Because the running page is the old version of the entry, the host MUST drive the
reload rather than expecting the page to self-update. The reload contract is:

1. **Before reload:** the host retains the view state last written by
   `wandHost.setState()`, keyed to the instance (`wandId`).
2. **Double-buffered load:** the host MUST load the new entry in a hidden background
   frame (with a cache-busting URL parameter), wait for it to finish loading, then
   swap the visible frame. This MUST prevent the user from seeing a blank/white
   frame during the transition; the old content MUST remain visible until the new
   content is ready.
3. **State restore:** the `host.ready` handshake payload for the new page includes
   the retained state. The view MUST read it from `wandHost.getState()` (which
   returns the cached value synchronously after handshake) and restore its position
   (current page, scroll offset, etc.).

The view SHOULD call `wandHost.setState({ slide: currentIndex, ... })` (or
equivalent) whenever its navigable position changes, so that stateful reload
restores the user to where they were.

---

## HUD — zero-code status chip

Views that use `shell: false` (full-page) can still surface runtime status without
implementing any UI code by using `viz.js`.

Annotate any element with `data-wv-hud`:

```html
<div data-wv-hud></div>
```

Or call `wandViz.hud()` programmatically. The viz runtime MUST render a floating
chip in the corner of the view that:

- Reads `runtime.getState` on load to show the current phase.
- Updates on `state-changed` events.
- Pulses briefly on `files-changed` events.
- Marks completed wands with a distinct "done" style.
- Themes automatically via `--wv-*` CSS custom properties.

The HUD is an opt-in convenience; it MUST NOT be injected automatically unless the
author has marked an element or called the API.

---

## Authoring constraints

A conforming wand presentation view MUST satisfy all of the following:

1. **Single-page.** One HTML entry file. No build step is required; the page MAY
   use inline scripts and styles or load same-origin assets via relative URLs.
2. **CSP-clean.** The page MUST NOT load scripts, styles, or other resources from
   remote origins. All assets MUST be served from the same loopback origin (relative
   URL) or from `/__wandhost__/`. The default Content-Security-Policy in the host
   sandbox enforces `script-src 'self'`; views SHOULD include a matching `<meta>`
   CSP tag.
3. **No SDK bundling.** The page MUST load `sdk.js` (and optionally `viz.js`) via
   `<script src="/__wandhost__/sdk.js">` rather than bundling them. The host
   serves these files; bundling a stale copy breaks version negotiation.
4. **Theme via tokens.** Color, typography, and spacing MUST use `--wv-*` CSS
   custom properties rather than hard-coded values. The host pushes token values
   as part of the `host.ready` handshake and on subsequent theme changes.
5. **Responsive to container.** The view MUST adapt to the width and height of the
   iframe container. Minimum supported container size is 320×240 logical pixels.
6. **State persistence.** Views with navigable positions SHOULD call
   `wandHost.setState()` on every position change and restore from `wandHost.getState()`
   after `wandHost.ready` resolves, to support stateful reload.

---

## Cross-references

- [host-api.md](./host-api.md) — the `window.wandHost` API and message protocol
- [manifest.md](./manifest.md) — full `wand.json` field reference
- [bundle.md](./bundle.md) — kind bundle layout (`view/static/`, `templates/runtime/`)
- [lifecycle.md](./lifecycle.md) — wand instance lifecycle and phase progression
- [`../examples/changelog/`](../examples/changelog/) — a complete reference wand
- [`../sdk/`](../sdk/) — reference implementation of `sdk.js` and `viz.js`
