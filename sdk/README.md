# Host SDK — reference implementation

These are the reference implementations of the two host assets a Wand runtime
serves to presentation-layer views on the reserved `/__wandhost__/` route:

| File | Route | Required | Purpose |
|---|---|---|---|
| `sdk.js` | `/__wandhost__/sdk.js` | Yes | Establishes `window.wandHost` — the page-side half of the postMessage RPC contract ([spec/host-api.md](../spec/host-api.md)) |
| `viz.js` | `/__wandhost__/viz.js` | Optional | Visualization kit: declarative `data-wv-mode` renderers (mindmap / flow / cards), the infinite-canvas API, and the zero-code HUD |
| `theme.css` | `/__wandhost__/theme.css` | Optional | Default values for the `--wv-*` theme tokens, so a view renders correctly before (and without) the host `theme` event |

A view never bundles these files — it loads them from the host:

```html
<script src="/__wandhost__/sdk.js"></script>
<script src="/__wandhost__/viz.js"></script><!-- optional -->
```

Any runtime implementing the Wand standard MUST serve an `sdk.js` that is
wire-compatible with the message envelope and `window.wandHost` interface
defined in [spec/host-api.md](../spec/host-api.md). Shipping these files
verbatim is the easiest way to comply; they have zero dependencies and no
build step.

`viz.js` is optional but recommended: it gives every wand view consistent
theming, canvas interactions, and a phase-status HUD without per-wand code.
