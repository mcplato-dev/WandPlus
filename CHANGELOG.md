# Changelog

All notable changes to the **Wand protocol** are documented here. Versions
refer to the manifest `version` field, not to this repository.

## 2.0

Protocol v2 is a **clean break**: runtimes do not recognize v1 manifests or
v1 instance markers.

### Spec corrections (2026-06-11)

Aligned the spec with shipped runtime behavior — no protocol change:

- `.wand.json` timestamps (`createdAt`, `updatedAt`) and `phaseLog[].enteredAt`
  are **Unix milliseconds (number)**, not ISO 8601 strings; `phaseLog` entries
  are `{ phase, enteredAt }` (previously documented inconsistently as
  `{ phase, completedAt }` in bundle.md and `{ phaseId, enteredAt, passedAt? }`
  in host-api.md).
- `RuntimeState` includes `displayName`.
- The SDK now ships named convenience wrappers for the runtime methods
  (`listFiles`, `readFile`, `registerNav`, `updateNav`, `registerActions`,
  `toast`, `setStatus`) — pure `call()` sugar, host surface unchanged.

### Identity — App-Store model

- **`appId` replaces `kind`.** Apps are identified by a globally-unique
  3-segment reverse-DNS id (`<publisher>.<domain>.<slug>`). The publisher
  prefix is assigned by the runtime or distribution platform and enforced at
  publish time. Directory names are labels only — identity is always `appId`.
- **`appVersion` replaces `kindVersion`** (semver, unchanged format).
- **`displayName` is provided by the human user at creation time** and written
  verbatim into the manifest.
- New informational fields: `developer`, `category`, `minPlatformVersion`.

### Entitlements

- New top-level `entitlements` block (iOS-entitlements analog). The v1
  top-level `mcpServers` array moved to `entitlements.mcpServers`. Future
  capabilities (network, filesystem, …) arrive as new keys here.

### Instances — document packages

- Instance ids are bare **16-hex** strings (`wand_<8hex>` is gone), and every
  instance directory is named **`<wandId>.wand`** — a document package.
- `directoryContract.subdirTemplate` is **removed**. The manifest declares only
  `directoryContract.folderName`; the runtime owns the layout and always
  assembles `wands/<folderName>/<wandId>.wand` under its data area.
- The `.wand.json` marker now carries the identity triple
  (`wandId`, `appId`, `displayName`) plus `appVersion`; markers with the v1
  `kind` field are not recognized.
- **Detection is location-independent**: any directory ending in `.wand` with a
  valid marker is a wand document package, wherever it sits. File explorers
  display the marker's `displayName` and open the package with a single opener.

### Presentation — two-layer views (new)

- `presentation.static` — a kind-shipped HTML view ("what this app is").
- `presentation.runtime` — an instance-level view over the produced artifact,
  with `watch` globs, `autoOpen` (document-package opener) and `shell` (native
  chrome) flags.
- Views load the host SDK from the reserved `/__wandhost__/` route and talk to
  the host exclusively through `window.wandHost` (postMessage RPC). See
  [spec/presentation.md](./spec/presentation.md) and
  [spec/host-api.md](./spec/host-api.md); reference `sdk.js` / `viz.js` /
  `theme.css` ship in [sdk/](./sdk).

### Gate checks

- The gate environment variable `WAND_KIND` is renamed **`WAND_APP_ID`**
  (carries the `appId`). `WAND_DIR`, `WAND_ROOT`, `WAND_PHASE` are unchanged.

### Repository

- The normative spec now lives in [spec/](./spec) (manifest, bundle,
  lifecycle, presentation, host-api); [docs/](./docs) keeps the tutorial
  quickstart and authoring guide.

## 1.0

Initial public draft: `kind`/`kindVersion` identity,
`directoryContract.subdirTemplate`, `wand_<8hex>` instance directories,
phase workflow + script/prompt gates, baseline tool set.
