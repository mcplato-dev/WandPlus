# Host API: `/__wandhost__/` and `window.wandHost`

> **Status:** normative — protocol v2.0
>
> This chapter defines the host-side HTTP route `/__wandhost__/`, the postMessage
> protocol between a view and its host, the `window.wandHost` SDK surface, and the
> security model that governs every interaction. For the two-layer view model and
> the `presentation` manifest block, see [presentation.md](./presentation.md).

---

## Loading model

A wand presentation view is a single-page HTML bundle served over a **local
loopback HTTP origin** inside a **sandboxed iframe**. The host is cross-origin to
the view, so the host cannot inject objects directly into the page. All host
capabilities are delivered through `postMessage` RPC, exposed to the page via the
SDK.

The host MUST mount a reserved route `/__wandhost__/` on the same loopback server
that serves the view. This route MUST serve the following read-only assets:

| Asset | Path | Required |
|-------|------|----------|
| Host SDK | `/__wandhost__/sdk.js` | Yes — establishes `window.wandHost` |
| Visualization toolkit | `/__wandhost__/viz.js` | No — optional; see §viz.js |
| Theme token defaults | `/__wandhost__/theme.css` | No |

The `/__wandhost__/` route MUST serve only these host-bundled assets. It MUST NOT
serve files from `wandDir` or any other author-controlled location. Views load the
SDK with a plain script tag:

```html
<script src="/__wandhost__/sdk.js"></script>
```

The wand bundle MUST NOT embed a copy of `sdk.js` or `viz.js`. Loading them from
`/__wandhost__/` guarantees that a view always uses the version shipped with the
running host, enabling seamless API evolution without forcing authors to update
their bundles.

### iframe sandbox attributes

The host MUST load all presentation views in an iframe with at minimum:

```
sandbox="allow-scripts allow-same-origin"
```

Runtime-layer iframes (mode `"runtime"`) MUST additionally include
`allow-downloads` to support artifact export. The sandbox MUST NOT include
`allow-top-navigation` or `allow-same-origin allow-scripts allow-popups` in any
combination that weakens the postMessage origin boundary.

---

## Handshake

Communication begins with a handshake immediately after `sdk.js` loads. The SDK
sends a `host.ready` request; the host MUST respond with an info object.

**SDK-initiated request:**

```json
{ "__wandhost": true, "id": "wh_…", "type": "request",
  "method": "host.ready", "params": { "sdkVersion": "1.0.0" } }
```

**Host response:**

```jsonc
{
  "__wandhost": true, "id": "wh_…", "type": "response", "ok": true,
  "result": {
    "apiVersion": "1.0.0",           // host contract version
    "mode": "static",                // "static" | "runtime"
    "appId": "com.example.my-app",   // the wand app identity
    "theme": { /* token map */},     // current --wv-* values
    "state": { /* last setState */}  // last persisted view state, or null
  }
}
```

`wandHost.ready` is a Promise that resolves to this info object after a successful
handshake. Views SHOULD `await wandHost.ready` before making other API calls.

### Version negotiation

- `wandHost.version` is the SDK's declared version (currently `"1.0.0"`).
- `result.apiVersion` is the host's contract version.
- If the host's `apiVersion` is higher than the SDK version, the SDK MUST still
  function; new methods silently error on older SDKs.
- If the SDK version is higher than the host's `apiVersion`, the SDK MUST still
  function for the subset of methods the host supports; unknown methods return an
  error response.

Hosts MUST add capabilities only by extending the method whitelist and adding new
events. Existing method signatures and event payload shapes are stable across minor
versions.

---

## Message envelope

All messages in both directions MUST carry `"__wandhost": true` as a namespace
guard, distinguishing them from other `postMessage` traffic (such as iframe resize
coordination). Messages without this field MUST be silently ignored.

### Request (view → host)

```json
{
  "__wandhost": true,
  "id": "<unique string>",
  "type": "request",
  "method": "phase.get",
  "params": { "phaseId": "collect" }
}
```

- `id` MUST be unique within the page session. The SDK generates `wh_<timestamp36>_<seq>`.
- `params` MAY be an empty object `{}` but MUST be present.
- `params` MUST be JSON-serializable. `Blob`, `File`, `ImageData`, and DOM objects
  are not permitted and MUST NOT be sent.

### Response (host → view)

Success:

```json
{
  "__wandhost": true,
  "id": "<same id as request>",
  "type": "response",
  "ok": true,
  "result": { /* method-dependent */ }
}
```

Error:

```json
{
  "__wandhost": true,
  "id": "<same id as request>",
  "type": "response",
  "ok": false,
  "error": "unknown method"
}
```

The SDK rejects the caller's Promise with the `error` string on `ok: false`.

### Call timeout

The SDK MUST time out any call that receives no response within **15 seconds** and
reject the Promise with a timeout error. Hosts SHOULD respond within this window;
slow operations SHOULD return quickly with a status and push an event when complete.

### Event (host → view, unsolicited)

```json
{
  "__wandhost": true,
  "type": "event",
  "event": "files-changed",
  "payload": { "changedPaths": ["images/hero.png"], "truncated": false }
}
```

Events carry no `id`. The host MAY push events at any time after the handshake.
Events MUST be treated as idempotent hints: delivery is not guaranteed, and a view
MUST NOT depend on receiving every event. For authoritative state, use
`wandHost.call('runtime.getState')`.

---

## `window.wandHost` interface

`sdk.js` establishes the following interface on `window.wandHost`. All methods are
available after the script loads; most are only meaningful after `wandHost.ready`
resolves.

```typescript
interface WandHost {
  // --- Core ---
  version: string
  ready: Promise<HandshakeInfo | null>
  info: HandshakeInfo | null        // set after handshake; null until then

  // Invoke a host method. Returns a Promise resolving to the result.
  // Rejects on timeout (15 s), unknown method, or host error.
  call<T>(method: string, params?: object): Promise<T>

  // Subscribe to a host event. Returns an unsubscribe function.
  on(event: string, callback: (payload: unknown) => void): () => void

  // --- View-local persistence ---
  // getState() returns the last value written by setState(), or the value
  // restored from the handshake. Returns synchronously; no round-trip needed.
  getState(): unknown
  // setState() writes to the in-SDK cache and asynchronously persists to the
  // host. The host keys state by (appId, wandId) for runtime views and by
  // appId for static views.
  setState(state: unknown): void

  // --- Theme ---
  // Apply a token map as CSS custom properties on :root. Keys may be bare
  // names (e.g. "bg") or full variable names (e.g. "--wv-bg"); both are
  // normalized to "--wv-<key>". Called automatically on "theme" events.
  applyTheme(tokens: Record<string, string>): void

  // --- Convenience wrappers (= call(...) sugar) ---
  get(): Promise<WandDetail>                      // wand.get
  getPhase(phaseId: string): Promise<PhaseDetail> // phase.get
  openPhaseDrawer(phaseId: string): Promise<void> // ui.openPhaseDrawer
  openDrawer(title: string, markdown: string): Promise<void> // ui.openDrawer
  getRuntimeState(): Promise<RuntimeState>        // runtime.getState

  // --- Convenience wrappers, runtime views only (host rejects in static mode) ---
  listFiles(): Promise<string[]>                  // runtime.listFiles
  readFile(path: string): Promise<string>         // runtime.readFile
  registerNav(spec: { count: number; current: number; labels?: string[] }): Promise<{ ok: true }> // nav.register
  updateNav(current: number): Promise<{ ok: true }>            // nav.update
  registerActions(actions: Array<{ id: string; label: string; icon?: string }>): Promise<{ ok: true }> // actions.register
  toast(level: 'info' | 'success' | 'warning' | 'error', message: string): Promise<{ ok: true }> // ui.toast
  setStatus(state: 'progress' | 'done' | 'error', message?: string): Promise<{ ok: true }>       // ui.setStatus
  openResources(opts?: { phaseId?: string; path?: string }): Promise<{ ok: true }>               // ui.openResources
  closeResources(): Promise<{ ok: true }>                                                        // ui.closeResources
}
```

`HandshakeInfo` shape:

```typescript
interface HandshakeInfo {
  apiVersion: string
  mode: 'static' | 'runtime'
  appId: string
  theme: Record<string, string>
  state: unknown // last persisted view state, or null
}
```

`RuntimeState` shape:

```typescript
interface RuntimeState {
  wandId: string
  appId: string
  displayName: string
  currentPhase: string | null  // null = wand completed
  phaseLog: Array<{
    phase: string               // phase id
    enteredAt: number           // Unix timestamp, milliseconds
  }>
}
```

---

## Method whitelist

The host MUST process only the methods listed below. Any request for an unlisted
method MUST receive a `{ ok: false, error: "unknown method" }` response. New
capabilities are added by extending this whitelist in future protocol versions.

### Core methods (all modes)

| Method | Params | Returns | Notes |
|--------|--------|---------|-------|
| `host.ready` | `{ sdkVersion }` | `HandshakeInfo` | Handshake; called once by SDK on load |
| `wand.get` | — | `WandDetail` | Full app definition: identity, phases, presentation structure, directory contract |
| `phase.get` | `{ phaseId: string }` | `PhaseDetail` | Single phase detail (prompt, gate type, tools, allow globs) |
| `ui.openPhaseDrawer` | `{ phaseId: string }` | `{ ok: true }` | Opens a native phase-detail drawer; for progressive disclosure of large phase content |
| `ui.openDrawer` | `{ title: string, markdown: string }` | `{ ok: true }` | Opens a general-purpose native drawer with rendered markdown |
| `view.getState` | — | `unknown` | Returns the persisted view state. Prefer `wandHost.getState()` (synchronous, no round-trip) |
| `view.setState` | `{ state: unknown }` | `{ ok: true }` | Persists view state host-side (keyed by appId for static, wandId for runtime). The SDK calls this automatically when the view calls `wandHost.setState()` |

### Runtime-layer methods (mode `"runtime"` only)

These methods are available when `HandshakeInfo.mode === "runtime"`.

| Method | Params | Returns | Notes |
|--------|--------|---------|-------|
| `runtime.getState` | — | `RuntimeState` | Current wand instance state from `.wand.json`: phase, phase log, identity |
| `runtime.listFiles` | — | `string[]` | Paths of all files in `wandDir`, relative to `wandDir`. Excludes runtime-managed files (`.wand.json`, etc.) |
| `runtime.readFile` | `{ path: string }` | `string` | Read a text file from `wandDir`. `path` is wandDir-relative. MUST be validated as under `wandDir` (no symlink traversal). Text only; max 1 MB. Binary assets SHOULD be loaded via relative URL instead |
| `nav.register` | `{ count: number, current: number, labels?: string[] }` | `{ ok: true }` | Declare a navigable unit count. When `shell: true`, the host renders prev/next/jump controls. `count` is total units (e.g. slides), `current` is 0-based index |
| `nav.update` | `{ current: number }` | `{ ok: true }` | Report a navigation event initiated inside the page (keyboard, click). The host MUST keep shell controls in sync. Navigation is bidirectional; the host pushes `navigate` events for shell-initiated navigation |
| `actions.register` | `{ actions: Array<{ id: string, label: string, icon?: string }> }` | `{ ok: true }` | Register custom action buttons. When `shell: true`, the host renders them in a toolbar. Cap: 8 actions maximum. Replaces any previously registered actions |
| `ui.toast` | `{ level: 'info' \| 'success' \| 'warning' \| 'error', message: string }` | `{ ok: true }` | Display a brief transient notification. Host-side rate limit: ≤ 2 toasts per second |
| `ui.setStatus` | `{ state: 'progress' \| 'done' \| 'error', message?: string }` | `{ ok: true }` | Set a persistent status indicator in the shell (or the HUD in shell-less mode). Overrides the default pulse shown on `files-changed`. Cleared automatically on the next `files-changed` cycle unless called again |
| `ui.openResources` | `{ phaseId?: string, path?: string }` | `{ ok: true }` | Open the host's resource panel. `phaseId` focuses that phase's group; `path` highlights one instance file. Views use this to surface deliverables the host does not auto-surface (HTML reports, dashboards) at the business moment — run completed, export landed |
| `ui.closeResources` | — | `{ ok: true }` | Close the resource panel |

---

## Events

The host MUST push events to the view iframe using the event envelope format. All
events MUST be treated as idempotent hints (see §Message envelope).

### `theme`

Pushed immediately after the handshake and whenever the user changes the application
theme.

```json
{
  "event": "theme",
  "payload": {
    "--wv-bg": "#1a1a1a",
    "--wv-text": "#e0e0e0",
    "--wv-accent": "#4a9eff"
  }
}
```

The SDK MUST apply the token map as CSS custom properties on `:root` automatically.
Views that use `--wv-*` variables update visually without additional code.

### `state-changed`

Pushed when the wand instance's phase state changes (phase advance, rewind, or
completion). The host MUST push this event in response to any write to `.wand.json`
that changes `currentPhase` or `phaseLog`.

```json
{
  "event": "state-changed",
  "payload": {
    "currentPhase": "review",
    "previousPhase": "draft",
    "phaseLog": [ /* RuntimeState.phaseLog */ ]
  }
}
```

Views that display runtime progress SHOULD subscribe to this event and also call
`runtime.getState` on load to initialize without waiting for the first event.

### `files-changed`

Pushed when files in `wandDir` change, filtered by `presentation.runtime.watch`
globs (if declared). The host MUST NOT include the entry file itself in
`changedPaths` when the change is being handled as a stateful reload (Track B in
[presentation.md §Dual-track refresh](./presentation.md)).

```json
{
  "event": "files-changed",
  "payload": {
    "changedPaths": ["images/chart.svg", "data/summary.json"],
    "truncated": false
  }
}
```

`truncated: true` indicates that more files changed than can be reported (cap: 100
paths). Views that receive a truncated event SHOULD perform a full soft-refresh
rather than attempting selective updates.

### `navigate`

Pushed when the user activates a navigation control in the host shell (prev, next,
or jump-to-index). Only meaningful after `nav.register` has been called.

```json
{
  "event": "navigate",
  "payload": { "index": 2 }
}
```

The view MUST respond by navigating to the indicated index and calling
`nav.update({ current: index })` to confirm. The host MUST NOT assume the navigation
succeeded until `nav.update` is received.

### `action`

Pushed when the user activates a custom action button registered via
`actions.register`.

```json
{
  "event": "action",
  "payload": { "id": "export-pdf" }
}
```

The `id` MUST match one of the `id` values in the most recent `actions.register`
call.

---

## viz.js — optional visualization toolkit

`/__wandhost__/viz.js` is a zero-dependency optional library that provides
ready-made visualization modes and a runtime HUD for wand presentation views. Views
are not required to use it; it is available as a convenience.

Load it after `sdk.js`:

```html
<script src="/__wandhost__/sdk.js"></script>
<script src="/__wandhost__/viz.js"></script>
```

`viz.js` establishes `window.wandViz`.

### Declarative modes

Any element with a `data-wv-mode` attribute is automatically mounted on
`DOMContentLoaded`:

```html
<div id="app" class="wv-root" data-wv-mode="mindmap"></div>
```

| `data-wv-mode` value | Description |
|----------------------|-------------|
| `mindmap` | Radial map: center node = the wand; branch nodes = phases and meta facets (Outputs, Capabilities, Identity, Global rules); leaf nodes = per-phase details. Phase branches show a flowing animated connector in linear mode. |
| `flow` | Sequential vertical chain of phase cards with animated directional edges. |
| `cards` | Responsive grid of phase cards; no canvas, no pan/zoom. |

All canvas modes (mindmap, flow) include pan and zoom via drag and scroll wheel, a
+/−/fit toolbar, and opaque node backing that prevents edge bleed-through. Phase
nodes are clickable and call `wandHost.openPhaseDrawer(id)` for progressive
disclosure.

### Imperative canvas API

Advanced views that need custom layout or nodes beyond the built-in modes MAY use
the canvas directly:

```javascript
const canvas = wandViz.canvas(document.getElementById('app'))
// canvas.viewport — the SVG <g> to append nodes and edges to
// canvas.setBBox({ x, y, w, h }) — set the content bounding box for fit()
// canvas.fit() — animate viewport to fit content
// canvas.dragged() — returns true if the pointer just finished a pan gesture
```

### HUD — floating status chip

The HUD is a floating chip that shows the current phase and pulses on file changes.
It is designed for `shell: false` views that still want visible runtime status
without implementing custom UI.

Opt in with an attribute:

```html
<div data-wv-hud></div>
```

Or imperatively:

```javascript
const chip = wandViz.hud() // appends to document.body
// Or: wandViz.hud(document.getElementById('hud-container'))
```

The HUD MUST:

- Call `runtime.getState` on mount and display the `currentPhase` value.
- Subscribe to `state-changed` and update the displayed phase.
- Subscribe to `files-changed` and show a brief pulse animation.
- Display a "done" indicator when `currentPhase` is `null`.
- Color itself using `--wv-*` CSS custom properties and update automatically on
  `theme` events.

The HUD is silently inert in static views (where `runtime.getState` is unavailable).

### Theme integration

Both `wandViz.mount()` and the HUD use `--wv-*` CSS custom properties for all
colors, fonts, and radii. The SDK applies theme tokens to `:root` automatically on
handshake and on theme changes, so `viz.js` elements re-color live without any view
code.

---

## Security model

The security model is **capability-based**: the page may only perform operations
that the host has explicitly whitelisted. Origin and source validation happen on
every message; no capability is granted implicitly.

| Boundary | Mechanism |
|----------|-----------|
| **Origin isolation** | The view is served from a loopback HTTP origin distinct from the host app's renderer origin. The host MUST validate `event.origin` against the loopback server's origin on every incoming message. Messages from unexpected origins MUST be silently dropped. |
| **Source validation** | The host MUST also validate `event.source === iframe.contentWindow` for every message. Messages from other frames (including child iframes the page may create) MUST be silently dropped. |
| **Method whitelist** | Only the methods listed in §Method whitelist are served. Any unrecognized method MUST return `{ ok: false, error: "unknown method" }`. New capabilities arrive as new entries in the whitelist in future protocol versions; they are never granted by default. |
| **Payload serialization** | All payloads MUST be JSON-serializable plain objects. The host MUST NOT accept `Blob`, `File`, `ImageData`, or other non-JSON-serializable types, and MUST NOT pass them to the view. Structured-clone transfer is not used. |
| **Data exposure** | Methods return only read-only projections of wand data. The host MUST NOT expose raw IPC primitives, file-system handles, network sockets, or any other host runtime primitive to the view. |
| **File access bounds** | `runtime.readFile` and `runtime.listFiles` MUST operate exclusively within `wandDir`. The host MUST resolve the requested path with `realpath` and verify it is under `wandDir` before reading. Symbolic links that escape `wandDir` MUST be rejected. |
| **Content-Security-Policy** | The view's own CSP (set via `<meta>`) SHOULD restrict `script-src` to `'self'` (which includes `/__wandhost__/` since it is same-origin). The host MAY additionally set a response-header CSP on the served HTML. In either case, loading scripts from remote origins MUST be prevented. |
| **Rate limiting** | `ui.toast` is capped at 2 calls per second. `actions.register` is capped at 8 actions. `nav.update` and `ui.setStatus` are debounced host-side. These limits prevent the view from flooding the host UI. |
| **Session influence** | A view MUST NOT be able to directly inject content into the agent session or send messages to the language model. `session.suggestPrompt` (a future capability) presents a suggestion chip that requires explicit user confirmation before any text enters the session. |

---

## Cross-references

- [presentation.md](./presentation.md) — two-layer view model, lifecycle, dual-track refresh
- [manifest.md](./manifest.md) — `wand.json` field reference including the `presentation` block
- [bundle.md](./bundle.md) — kind bundle layout and view file locations
- [`../sdk/`](../sdk/) — reference implementation (`sdk.js`, `viz.js`) served by the first reference runtime
- [`../examples/changelog/`](../examples/changelog/) — a complete reference wand
